import { durableMediaDatabase, initializeDurableMedia } from "./durable-media.ts";
import { isDeepStrictEqual } from "node:util";
import { apply } from "@earendil-works/chord/delta";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openBunSqliteDatabase } from "@kintsugi/core/bun-sqlite";
import { durableSqlitePrefix } from "./durable-sqlite.ts";

const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const storedRecord = Type.Object({id:integer},{additionalProperties:true});
const documentRecord = Type.Object({id:integer,scope:Type.Object({kind:Type.String()}),history:Type.Optional(Type.String())},{additionalProperties:true});
const terminalTask = Type.Object({id:integer,state:Type.Object({status:Type.Literal("terminal")},{additionalProperties:true})},{additionalProperties:true});
const liveTask = Type.Object({id:integer,state:Type.Object({status:Type.Union([Type.Literal("pending"),Type.Literal("running"),Type.Literal("waiting"),Type.Literal("sleeping"),Type.Literal("completing")])},{additionalProperties:true})},{additionalProperties:true});
const operation = Type.Union([
  Type.Object({type:Type.Literal("conversation"),value:storedRecord}),
  Type.Object({type:Type.Literal("entry"),value:storedRecord}),
  Type.Object({type:Type.Literal("submission"),value:storedRecord}),
  Type.Object({type:Type.Literal("task"),value:terminalTask}),
  Type.Object({type:Type.Literal("task.sidecar"),id:integer,ordinal:integer}),
  Type.Object({type:Type.Literal("document.create"),record:documentRecord,ordinal:integer}),
  Type.Object({type:Type.Literal("document.change"),id:integer,ordinal:integer}),
  Type.Object({type:Type.Literal("document.retire"),id:integer}),
]);
const markerSchema = Type.Object({ format: Type.Literal(1), type: Type.Literal("commit"), seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), writes: Type.Array(operation) });
const sidecarSchema = Type.Object({ format: Type.Literal(1), type: Type.Literal("record"), seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), ordinal: integer, payload: Type.Union([
  Type.Object({ type: Type.Literal("task"), value: liveTask }),
  Type.Object({ type: Type.Literal("document"), id: integer, content: Type.Union([
    Type.Object({ kind: Type.Literal("base"), version: Type.Integer({ minimum: 1 }), value: Type.Record(Type.String(), Type.Unknown()) }),
    Type.Object({ kind: Type.Literal("delta"), version: Type.Integer({ minimum: 1 }), ops: Type.Array(Type.Unknown()) }),
  ]) }),
]) });

const markerValidator = Compile(markerSchema), sidecarValidator = Compile(sidecarSchema);

/** Bounded by the largest physical line, not journal size. Like JSONL recovery, ignore an incomplete final line. */
async function* lines(path: string) {
  const parts: Buffer[] = [];let size = 0;
  const decoder = new TextDecoder("utf-8",{fatal:true});
  for await (const chunk of createReadStream(path)) {
    let start = 0;
    for (let end = chunk.indexOf(10);end !== -1;end = chunk.indexOf(10,start)) {
      const last = chunk.subarray(start,end);
      yield decoder.decode(parts.length ? Buffer.concat([...parts,last],size+last.length) : last);
      parts.length = 0;size = 0;start = end+1;
    }
    if (start < chunk.length) {const tail = chunk.subarray(start);parts.push(tail);size += tail.length;}
  }
}
/** Bound each SQL transaction by both line count and source bytes. */
async function* batches(source: AsyncIterable<string>) {
  let batch: string[] = [], bytes = 0;
  for await (const text of source) {
    batch.push(text);bytes += text.length;
    if (batch.length >= 128 || bytes >= 1024 * 1024) {yield batch;batch = [];bytes = 0;}
  }
  if (batch.length) yield batch;
}
export type JsonlImportFile = {name: string; bytes: number; sha256: string};
async function fingerprint(directory: string, files: string[]) {
  const hash = createHash("sha256"), manifest: JsonlImportFile[] = [];
  for (const name of files) {
    hash.update(name);const digest = createHash("sha256");let size = 0;
    for await (const bytes of createReadStream(join(directory, name))) {hash.update(bytes);digest.update(bytes);size += bytes.length;}
    manifest.push({name,bytes:size,sha256:digest.digest("hex")});
  }
  return {digest:hash.digest("hex"),files:manifest};
}

/**
 * One-shot import into a new file. Caller holds the workspace writer lease. Never opens or repairs the source using
 * JSONL storage: recovery there may truncate tails or reclaim sidecars. Staging indexes live on disk, not in JS maps.
 * Source files remain untouched; the caller archives them only after its readers have switched to SQLite.
 */
export async function importDurableJsonlInline(directory: string, destination: string) {
  const parentPid = process.connected ? process.ppid : undefined;
  const files = (await readdir(directory)).filter(file => file === "main.jsonl" || /^(doc|task)-(0|[1-9]\d*)\.jsonl$/.test(file)).sort();
  if (!files.includes("main.jsonl")) throw new Error("No JSONL journal to import");
  const before = await fingerprint(directory, files);
  // Never overwrite an existing store, including one left by a successful prior cutover.
  const temporary = `${destination}.import-${crypto.randomUUID()}`;
  const db = await openBunSqliteDatabase(temporary);
  let storage: SqliteStorage | undefined;
  try {
    await initializeDurableMedia(db);
    const mediaDb = durableMediaDatabase(db);
    storage = await SqliteStorage.open(mediaDb, { prefix: durableSqlitePrefix });
    await db.exec(`CREATE TABLE import_sidecars(file TEXT,seq INTEGER,ordinal INTEGER,payload TEXT,confirmed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(file,seq,ordinal));
      CREATE TABLE import_documents(id INTEGER PRIMARY KEY,currentOnly INTEGER NOT NULL,retired INTEGER NOT NULL DEFAULT 0,baseSeq INTEGER,baseOrdinal INTEGER);
      CREATE TABLE import_tasks(id INTEGER PRIMARY KEY,live INTEGER NOT NULL);
      CREATE TABLE import_records(type TEXT,id INTEGER,seq INTEGER,record TEXT,PRIMARY KEY(type,id));
      CREATE TABLE import_document_values(id INTEGER PRIMARY KEY,version INTEGER NOT NULL,value TEXT NOT NULL);
      CREATE TABLE timeline_import_receipt(sourceDigest TEXT NOT NULL,commits INTEGER NOT NULL,files TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0);`);
    for (const file of files.filter(file => file !== "main.jsonl")) {
      let previousSeq = 0, previousOrdinal = -1;
      for await (const batch of batches(lines(join(directory, file)))) await db.transaction(async tx => {
        for (const text of batch) {
        const row = sidecarValidator.Parse(JSON.parse(text));
        if (row.seq < previousSeq || row.seq === previousSeq && row.ordinal <= previousOrdinal) throw new Error(`Out-of-order sidecar: ${file}`);
        previousSeq = row.seq;previousOrdinal = row.ordinal;
        const id = row.payload.type === "task" ? row.payload.value.id : row.payload.id;
        if (file !== `${row.payload.type === "task" ? "task" : "doc"}-${id}.jsonl`) throw new Error(`Sidecar identity mismatch: ${file}`);
        await tx.run("INSERT INTO import_sidecars(file,seq,ordinal,payload) VALUES(?,?,?,?)", file, row.seq, row.ordinal, JSON.stringify(row.payload));
      }
      });
    }
    let lastSeq = 0, commits = 0;
    // Discover reclaimed current-only document ranges and terminal tasks before replaying older commits.
    for await (const batch of batches(lines(join(directory, "main.jsonl")))) await db.transaction(async tx => {
      for (const text of batch) {
      const marker = markerValidator.Parse(JSON.parse(text));
      if (marker.seq <= lastSeq) throw new Error("Out-of-order JSONL commit sequence");
      lastSeq = marker.seq;commits++;
      for (const write of marker.writes) {
        if (write.type === "document.create") {
          if (!write.record) throw new Error("Missing document record");
          await tx.run("INSERT INTO import_documents(id,currentOnly) VALUES(?,?)", write.record.id, Number(write.record.scope.kind !== "conversation" || write.record.history === "latest"));
        } else if (write.type === "document.retire") await tx.run("UPDATE import_documents SET retired=1 WHERE id=?", write.id!);
        else if (write.type === "task" || write.type === "task.sidecar") await tx.run("INSERT INTO import_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET live=excluded.live", write.type === "task" ? write.value!.id : write.id!, Number(write.type === "task.sidecar"));
        if (write.type === "document.create" || write.type === "document.change") {
          const id = write.type === "document.create" ? write.record.id : write.id;
          const base = await tx.get<{ payload: string }>("SELECT payload FROM import_sidecars WHERE file=? AND seq=? AND ordinal=?", `doc-${id}.jsonl`, marker.seq, write.ordinal!);
          if (base && JSON.parse(base.payload).content.kind === "base") await tx.run("UPDATE import_documents SET baseSeq=?,baseOrdinal=? WHERE id=? AND currentOnly=1", marker.seq, write.ordinal!, id);
        }
      }
    }
    });
    let replay: {seq: number; writes: StorageWrite[]}[] = [], replayChars = 0;
    const confirmations: {file: string;seq: number;ordinal: number}[] = [];
    async function flushReplay() {
      if (!replay.length) return;
      await db.transaction(async tx => {
        for (const ref of confirmations) {
          const changed = await tx.runCounted("UPDATE import_sidecars SET confirmed=1 WHERE file=? AND seq=? AND ordinal=? AND confirmed=0", ref.file, ref.seq, ref.ordinal);
          if (changed !== 1) throw new Error("Sidecar confirmed twice");
        }
        await tx.run("UPDATE timeline_durable_metadata SET next_seq=? WHERE singleton=1", replay[0]!.seq);
      });
      confirmations.length = 0;
      const result = await storage!.commit(replay.map(row => row.writes), (index, seq) => {
        if (Number(seq) !== replay[index]!.seq) throw new Error("Imported sequence changed");
      }, BACKGROUND_CONTEXT);
      if (result.stored !== replay.length) throw new Error("Imported batch refused", {cause: result.refused});
      await db.transaction(async tx => {
        for (const batch of replay) for (const write of batch.writes) {
          if (write.type === "conversation" || write.type === "entry" || write.type === "submission" || write.type === "task") {
            await tx.run("INSERT INTO import_records VALUES(?,?,?,?) ON CONFLICT(type,id) DO UPDATE SET seq=excluded.seq,record=excluded.record",write.type,Number(write.value.id),batch.seq,JSON.stringify(write.value));
          } else if (write.type === "document.create" || write.type === "document.change") {
            const id = write.type === "document.create" ? write.record.id : write.id;
            const previous = await tx.get<{value:string}>("SELECT value FROM import_document_values WHERE id=?",Number(id));
            // SAFETY: this content has passed the storage commit validation; Chord's delta engine validates each operation.
            const value = write.content.kind === "base" ? write.content.value : apply(JSON.parse(previous!.value),write.content.ops);
            await tx.run("INSERT INTO import_document_values VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,value=excluded.value",Number(id),write.content.version,JSON.stringify(value));
          } else if (write.type === "document.retire") await tx.run("DELETE FROM import_document_values WHERE id=?",Number(write.id));
        }
      });
      replay = [];replayChars = 0;
    }
    for await (const text of lines(join(directory, "main.jsonl"))) {
      const marker = markerValidator.Parse(JSON.parse(text)), writes: StorageWrite[] = [];
      let materializedChars = 0;
      if (replay.length && marker.seq !== replay.at(-1)!.seq + 1) await flushReplay();
      for (const write of marker.writes) {
        if (write.type === "conversation" || write.type === "entry" || write.type === "submission" || write.type === "task" || write.type === "document.retire") {
          // SAFETY: marker shape is checked above; SqliteStorage validates record ownership and document actions at commit.
          writes.push(write as StorageWrite);continue;
        }
        if (!["document.create", "document.change", "task.sidecar"].includes(write.type)) throw new Error(`Unknown JSONL write: ${write.type}`);
        if (write.ordinal === undefined) throw new Error("Missing sidecar ordinal");
        const id = write.type === "document.create" ? write.record.id : write.id;
        const doc = await db.get<{ currentOnly: number; retired: number; baseSeq: number | null; baseOrdinal: number | null }>("SELECT * FROM import_documents WHERE id=?", id);
        const reclaimed = write.type !== "task.sidecar" && !!doc?.currentOnly && (!!doc.retired || doc.baseSeq !== null && (marker.seq < doc.baseSeq || marker.seq === doc.baseSeq && write.ordinal < doc.baseOrdinal!));
        const terminal = write.type === "task.sidecar" && (await db.get<{ live: number }>("SELECT live FROM import_tasks WHERE id=?", id))?.live === 0;
        const file = `${write.type === "task.sidecar" ? "task" : "doc"}-${id}.jsonl`;
        const sidecar = await db.get<{ payload: string; confirmed: number }>("SELECT payload,confirmed FROM import_sidecars WHERE file=? AND seq=? AND ordinal=?", file, marker.seq, write.ordinal);
        if (!sidecar && !reclaimed && !terminal) throw new Error(`Missing confirmed sidecar ${file} at ${marker.seq}:${write.ordinal}`);
        if (sidecar?.confirmed) throw new Error("Sidecar confirmed twice");
        if (sidecar) confirmations.push({file,seq:marker.seq,ordinal:write.ordinal});
        const payload = sidecar ? JSON.parse(sidecar.payload) : undefined;
        materializedChars += sidecar?.payload.length ?? 0;
        if (payload?.type === "document" && payload.content.kind === "delta") materializedChars += (await db.get<{n:number}>("SELECT length(value) n FROM import_document_values WHERE id=?",id))?.n ?? 0;
        if (write.type === "task.sidecar") {if (!terminal) writes.push({ type: "task", value: payload.value });}
        else if (write.type === "document.create") {
          if (payload && payload.content.kind !== "base") throw new Error("Document creation requires a base");
          // SAFETY: checked JSONL document record; storage validates its lifecycle, scope and global ID.
          writes.push({ type: "document.create", record: write.record!, content: reclaimed ? { kind: "base", version: 1, value: {} } : payload.content } as StorageWrite);
        } else if (!reclaimed) {
          // SAFETY: the imported ID and sidecar document content are checked before replay; commit checks the revision.
          writes.push({ type: "document.change", id, content: payload.content } as StorageWrite);
        }
      }
      // JSONL gaps were flushed before staging this commit; never renumber them.
      replay.push({seq: marker.seq,writes});replayChars += text.length + materializedChars;
      if (replay.length >= 128 || replayChars >= 1024 * 1024) await flushReplay();
    }
    await flushReplay();
    const invalidTail = await db.get("SELECT 1 FROM import_sidecars a JOIN import_sidecars b ON a.file=b.file WHERE a.confirmed=0 AND b.confirmed=1 AND (a.seq<b.seq OR a.seq=b.seq AND a.ordinal<b.ordinal) LIMIT 1");
    if (invalidTail) throw new Error("Confirmed sidecar record follows an unconfirmed tail");
    const afterFiles = (await readdir(directory)).filter(file => file === "main.jsonl" || /^(doc|task)-(0|[1-9]\d*)\.jsonl$/.test(file)).sort();
    if (JSON.stringify(afterFiles) !== JSON.stringify(files) || (await fingerprint(directory, files)).digest !== before.digest) throw new Error("Source journal changed during import");
    // Independently compare final record state and immutable entry commit sequences, in bounded pages.
    for (const [type,table] of [["conversation","conversations"],["entry","entries"],["submission","submissions"],["task","tasks"]]) {
      const expected = await db.get<{n:number}>("SELECT count(*) n FROM import_records WHERE type=?",type!);
      if ((await db.get<{n:number}>(`SELECT count(*) n FROM timeline_${table}`))?.n !== expected?.n) throw new Error(`Imported ${type} count differs`);
      let after = -1;
      for (;;) {
        const page = await db.all<{id:number;seq:number;record:string}>("SELECT id,seq,record FROM import_records WHERE type=? AND id>? ORDER BY id LIMIT 16",type!,after);
        if (!page.length) break;
        for (const row of page) {
          const actual = await mediaDb.get<{record:string;commit_seq?:number}>(`SELECT * FROM timeline_${table} WHERE id=?`,row.id);
          if (!actual || !isDeepStrictEqual(JSON.parse(actual.record),JSON.parse(row.record)) || type === "entry" && actual.commit_seq !== row.seq) throw new Error(`Imported ${type} ${row.id} differs`);
          after = row.id;
        }
      }
    }
    let afterDocument = -1;
    for (;;) {
      const page = await db.all<{id:number;version:number;value:string}>("SELECT * FROM import_document_values WHERE id>? ORDER BY id LIMIT 16",afterDocument);
      if (!page.length) break;
      for (const row of page) {
        // SAFETY: staged IDs came from successfully committed document writes in this storage.
        const actual = await storage.document(row.id as Parameters<SqliteStorage["document"]>[0],"current",BACKGROUND_CONTEXT);
        if (!actual || actual.version !== row.version || !isDeepStrictEqual(actual.value,JSON.parse(row.value))) throw new Error(`Imported document ${row.id} differs`);
        afterDocument = row.id;
      }
    }
    await db.run("INSERT INTO timeline_import_receipt(sourceDigest,commits,files) VALUES(?,?,?)", before.digest, commits, JSON.stringify(before.files));
    await db.exec("DROP TABLE import_sidecars; DROP TABLE import_documents; DROP TABLE import_tasks; DROP TABLE import_records; DROP TABLE import_document_values;");
    if ((await db.get<{ integrity_check: string }>("PRAGMA integrity_check"))?.integrity_check !== "ok") throw new Error("Imported SQLite integrity check failed");
    // Reclaim staging pages before publishing; do not retain a second raw journal in the live database.
    await db.exec("VACUUM");
    await storage.close(BACKGROUND_CONTEXT);storage = undefined;
    await Bun.sleep(0);
    if (parentPid !== undefined && (!process.connected || process.ppid !== parentPid)) throw new Error("Import parent exited before publication");
    await link(temporary, destination);
    const parent = await open(join(destination, ".."), "r");try {await parent.sync();} finally {await parent.close();}
    return { commits, lastSeq, sourceDigest: before.digest };
  } finally {
    try {if (storage) await storage.close(BACKGROUND_CONTEXT);else await db.close();}
    finally {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(temporary + suffix, { force: true });
    }
  }
}

const resultValidator = Compile(Type.Object({commits:Type.Integer({minimum:0}),lastSeq:Type.Integer({minimum:0}),sourceDigest:Type.String({pattern:"^[a-f0-9]{64}$"}),workerPeakRssKiB:Type.Number({minimum:0})}));
let previousImport:Promise<void> = Promise.resolve();
/** Only one memory-bounded importer runs at a time; the parent event loop keeps every workspace lease alive. */
export function importDurableJsonl(directory:string,destination:string) {
  const result = previousImport.then(async()=>{
    const script = `process.on("disconnect",()=>process.exit(1));
      try {
        const {importDurableJsonlInline}=await import(${JSON.stringify(import.meta.url)});
        const result=await importDurableJsonlInline(${JSON.stringify(directory)},${JSON.stringify(destination)});
        await Bun.write(Bun.stdout,JSON.stringify({...result,workerPeakRssKiB:process.resourceUsage().maxRSS}));process.exit(0);
      } catch(error) {console.error(error instanceof Error ? error.message : String(error));process.exit(1);}`;
    const child = Bun.spawn([process.execPath,"--smol","-e",script],{stdin:"ignore",stdout:"pipe",stderr:"pipe",ipc:()=>{},serialization:"json"});
    const errorText = (async()=>{let text="";for await(const chunk of child.stderr)if(text.length<16_000)text+=new TextDecoder().decode(chunk).slice(0,16_000-text.length);return text;})();
    const [code,output,errors]=await Promise.all([child.exited,new Response(child.stdout).text(),errorText]);
    if(code!==0)throw new Error(`JSONL SQLite import failed (exit ${code}): ${errors.trim()}`);
    return resultValidator.Parse(JSON.parse(output));
  });
  previousImport=result.then(()=>{},()=>{});return result;
}
