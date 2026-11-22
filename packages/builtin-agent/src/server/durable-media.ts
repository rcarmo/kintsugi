import { storedAttachmentSchema } from "./durable-upload-store.ts";
import { optimizerEntryBytes, optimizerHistoryRead, optimizerOversizedEntry } from "./optimizer-history-budget.ts";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { JsonValue } from "@earendil-works/chord/json";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";

const imageSchema = Type.Object({ type: Type.Literal("image"), mimeType: Type.String(), data: Type.String() });
const attachmentSchema = Type.Object({ type: Type.Literal("attachment"), filename: Type.String(), mimeType: Type.String(), data: Type.String() });
const binarySchema = Type.Union([imageSchema, attachmentSchema]);
const dataOpSchema = Type.Tuple([Type.Union([Type.Literal("s"), Type.Literal("a")]), Type.Array(Type.Union([Type.String(),Type.Number()])), Type.String()]);
const referenceSchema = Type.Object({ __kintsugi_media: Type.String({ pattern: "^[a-f0-9]{64}$" }), token: Type.String({ pattern: "^[a-f0-9-]{36}$" }) }, { additionalProperties: false });
const literalSchema = Type.Object({ __kintsugi_literal: Type.String() }, {additionalProperties:false});
const recordSchema = Type.Object({ id: Type.Integer() });
const stringSchema = Type.String();
const marker = "__kintsugi_media";
type Media = { id: string; token: string; mimeType: string; filename: string; bytes: Buffer; recordId: number | null };

/** Media bytes are content-addressed; every encoded occurrence has its own unguessable link token. */
export async function initializeDurableMedia(db: SqliteExecutor) {
  await db.exec(`CREATE TABLE IF NOT EXISTS media_staging(token TEXT PRIMARY KEY,media_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS media_staging_media ON media_staging(media_id);
    CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,filename TEXT NOT NULL,content_type TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,metadata TEXT NOT NULL,thumbnail BLOB,data BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS media_links(token TEXT PRIMARY KEY,media_id TEXT NOT NULL,record_type TEXT NOT NULL,record_id INTEGER);
    CREATE INDEX IF NOT EXISTS media_links_record ON media_links(record_type,record_id,media_id);
    CREATE INDEX IF NOT EXISTS media_links_media ON media_links(media_id);`);
}
function encode(text: string, recordType: string) {
  const media: Media[] = [],attachments: {id:string;recordId:number|null}[] = [];
  if ((!text.includes('"data"') && !text.includes(marker) && !text.includes("__kintsugi_literal") && !text.includes('"mediaId"')) || !["{", "["].includes(text[0] ?? "")) return { text, media,attachments };
  let value;
  try {value = JSON.parse(text);} catch {return { text, media,attachments };}
  let changed = false;
  const recordId = Value.Check(recordSchema, value) ? value.id : null;
  const encoded = JSON.parse(text, (_key, value: JsonValue) => {
    // User/tool JSON can contain any keys. Escape storage-shaped objects instead of interpreting them or refusing the commit.
    if (Value.Check(referenceSchema,value) || Value.Check(literalSchema,value)) {changed = true;return {__kintsugi_literal:JSON.stringify(value)};}
    if (Value.Check(storedAttachmentSchema,value)) attachments.push({id:value.mediaId,recordId});
    const operation = Value.Check(dataOpSchema, value) && value[1].at(-1) === "data" ? value : undefined;
    const binary = Value.Check(binarySchema, value) ? value : undefined;
    const data = binary?.data ?? operation?.[2];
    if (data === undefined) return value;
    const bytes = Buffer.from(data, "base64");
    // Preserve malformed/noncanonical image data exactly; storage is not a new image validator or normaliser.
    if (bytes.toString("base64") !== data) return value;
    const id = createHash("sha256").update(bytes).digest("hex"), token = crypto.randomUUID();
    changed = true;
    media.push({ id, token, mimeType: binary?.mimeType ?? "application/octet-stream", filename: Value.Check(attachmentSchema, binary) ? binary.filename : "image", bytes, recordId });
    const reference = { __kintsugi_media: id, token };
    return operation ? [operation[0],operation[1],reference] : { ...binary!, data: reference };
  });
  // Avoid reserialising ordinary records; stable stored JSON also makes index-watermark checks cheap.
  return { text: changed ? JSON.stringify(encoded) : text, attachments,media: media.map(item => ({ ...item, recordId: recordType ? item.recordId : null })) };
}
async function encodeParams(executor: SqliteExecutor, sql: string, params: SqliteValue[]) {
  const insert = /^INSERT INTO (timeline_[a-z_]+) \(([^)]+)\)/.exec(sql);
  if (!insert) return params;
  const recordType = insert[1]!,columns = insert[2]!.split(",").map(column=>column.trim());
  const jsonColumns = new Set(columns.flatMap((column,index)=>column === "record" || column === "content" ? [index] : []));
  if (!jsonColumns.size) return params;
  const encoded: SqliteValue[] = [];
  for (const [parameter,param] of params.entries()) {
    if (!Value.Check(stringSchema, param)) {encoded.push(param);continue;}
    const pending: Media[] = [],links: {id:string;recordId:number|null}[] = [];
    if (sql.includes("FROM json_each(?) AS item")) {
      // Pi Durable batches small rows as JSON arrays whose JSON record columns are themselves strings.
      // Parse that one transport layer before encoding the record, rather than overlooking small attachments.
      const rows: SqliteValue[][] = JSON.parse(param);
      for (const row of rows) for (let column = 0; column < row.length; column++) {
        const cell = row[column];if (!jsonColumns.has(column) || !Value.Check(stringSchema,cell)) continue;
        const result = encode(cell,recordType);row[column] = result.text;pending.push(...result.media);links.push(...result.attachments);
      }
      encoded.push(JSON.stringify(rows));
    } else if (jsonColumns.has(parameter % columns.length)) {
      const result = encode(param,recordType);encoded.push(result.text);pending.push(...result.media);links.push(...result.attachments);
    }
    else encoded.push(param);
    for (const link of links) await executor.run("INSERT INTO media_links(token,media_id,record_type,record_id) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM media WHERE id=?)",crypto.randomUUID(),link.id,recordType,link.recordId,link.id);
    for (const media of pending) {
      await executor.run("INSERT OR IGNORE INTO media(id,filename,content_type,bytes,created_at,metadata,data) VALUES(?,?,?,?,?,?,?)", media.id, media.filename, media.mimeType, media.bytes.byteLength, Date.now(), "{}", media.bytes);
      await executor.run("INSERT INTO media_links VALUES(?,?,?,?)", media.token, media.id, recordType, media.recordId);
    }
  }
  return encoded;
}
async function decode(executor: SqliteExecutor, text: string) {
  if ((!text.includes(marker) && !text.includes("__kintsugi_literal")) || !["{", "["].includes(text[0] ?? "")) return text;
  const tokens = new Map<string, string>();
  JSON.parse(text, (_key, value: JsonValue) => {if (Value.Check(referenceSchema, value)) tokens.set(value.token, value.__kintsugi_media);return value;});
  if (!tokens.size && !text.includes("__kintsugi_literal")) return text;
  const values = new Map<string, string>();
  for (const [token, id] of tokens) {
    const row = await executor.get<{ data: Uint8Array }>("SELECT m.data FROM media_links l JOIN media m ON m.id=l.media_id WHERE l.token=? AND l.media_id=?", token, id);
    if (!row) throw new Error("Missing durable media attachment");
    values.set(token, Buffer.from(row.data).toString("base64"));
  }
  return JSON.stringify(JSON.parse(text, (_key, value: JsonValue) => Value.Check(referenceSchema, value) ? values.get(value.token)! : Value.Check(literalSchema,value) ? JSON.parse(value.__kintsugi_literal) : value));
}
async function decodeRow<T extends object>(executor: SqliteExecutor, row: T): Promise<T> {
  const fields: [string, SqliteValue][] = [];
  for (const [key, value] of Object.entries(row)) fields.push([key, (key === "record" || key === "content") && Value.Check(stringSchema, value) ? await decode(executor, value) : value]);
  // SAFETY: this codec replaces only JSON strings with equivalent hydrated JSON strings; SQLite row keys/types are unchanged.
  return Object.fromEntries(fields) as T;
}
function mediaExecutor(executor: SqliteExecutor): SqliteExecutor {
  return {
    exec: executor.exec.bind(executor),
    run: async (sql, ...params) => executor.run(sql, ...await encodeParams(executor, sql, params)),
    runCounted: async (sql, ...params) => executor.runCounted(sql, ...await encodeParams(executor, sql, params)),
    async get<T extends object>(sql: string, ...params: SqliteValue[]) {
      if (optimizerHistoryRead.getStore() === "analysis" && sql === "SELECT record FROM timeline_tasks WHERE id = ?") {
        return executor.get<T>(`SELECT CASE WHEN octet_length(record) <= ${optimizerEntryBytes} THEN record ELSE json_object('kind','${optimizerOversizedEntry}') END AS record FROM timeline_tasks WHERE id = ?`, ...params);
      }
      const row = await executor.get<T>(sql, ...params);return row ? decodeRow(executor, row) : undefined;
    },
    async all<T extends object>(sql: string, ...params: SqliteValue[]) {
      const mode = optimizerHistoryRead.getStore();
      if (mode && /^SELECT record FROM timeline_entries WHERE .+ ORDER BY id (?:ASC|DESC) LIMIT \?$/.test(sql)) {
        // octet_length on the column uses SQLite's record metadata without reading the
        // payload. Keep cursor IDs and don't hydrate image bytes for text-only analysis.
        const omitted = `json_object('id',id,'conversationId',conversation_id,'kind','${optimizerOversizedEntry}')`;
        const projection = mode === "id" ? omitted : `CASE WHEN octet_length(record) <= ${optimizerEntryBytes} THEN record ELSE ${omitted} END`;
        return executor.all<T>(sql.replace("SELECT record ", `SELECT ${projection} AS record `), ...params);
      }
      const rows = await executor.all<T>(sql, ...params);const decoded: T[] = [];for (const row of rows) decoded.push(await decodeRow(executor, row));return decoded;
    },
  };
}
/**
 * Pi Durable always sees original provider messages and document deltas. Only SQLite's JSON representation contains
 * media links. Binary/link inserts use the same transaction handle as the record write: rollback cannot orphan a copy.
 */
export function durableMediaDatabase(database: SqliteDatabase): SqliteDatabase {
  return { exec:database.exec.bind(database), close: database.close.bind(database),
    // Hydration can issue several reads. Hold the queue/snapshot until all of them finish, including during close.
    get: <T extends object>(sql:string,...params:SqliteValue[]) => database.transaction(tx=>mediaExecutor(tx).get<T>(sql,...params)),
    all: <T extends object>(sql:string,...params:SqliteValue[]) => database.transaction(tx=>mediaExecutor(tx).all<T>(sql,...params)),
    transaction: callback => database.transaction(tx => callback(mediaExecutor(tx))),
    run: (sql, ...params) => database.transaction(tx => mediaExecutor(tx).run(sql, ...params)),
    runCounted: (sql, ...params) => database.transaction(tx => mediaExecutor(tx).runCounted(sql, ...params)),
  };
}


/** Only the exclusive workspace opener calls this, before admitting new work after a crash. */
export async function clearAbandonedDurableUploads(db: SqliteDatabase) {
  await db.transaction(async tx=>{
    await tx.run("DELETE FROM media WHERE id IN (SELECT media_id FROM media_staging) AND NOT EXISTS(SELECT 1 FROM media_links l WHERE l.media_id=media.id)");
    await tx.run("DELETE FROM media_staging");
  });
}
