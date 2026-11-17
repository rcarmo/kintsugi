import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { initializeDurableMedia,durableMediaDatabase } from "./durable-media.ts";
import { durableSqlitePrefix } from "./durable-sqlite.ts";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, link } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { openBunSqliteDatabase } from "@kintsugi/core/bun-sqlite";
import { durableSqliteName } from "./durable-sqlite.ts";
import { importDurableJsonl, type JsonlImportFile } from "./durable-jsonl-import.ts";

const manifestSchema = Type.Array(Type.Object({ name: Type.String({ pattern: "^(main|(?:doc|task)-(?:0|[1-9][0-9]*))\\.jsonl$" }), bytes: Type.Integer({ minimum: 0 }), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) }));
async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");try {await handle.sync();} finally {await handle.close();}
}
async function matches(path: string, file: JsonlImportFile) {
  if (!await Bun.file(path).exists()) return false;
  const hash = createHash("sha256");let size = 0;
  for await (const bytes of createReadStream(path)) {hash.update(bytes);size += bytes.length;}
  if (size !== file.bytes || hash.digest("hex") !== file.sha256) throw new Error(`Imported JSONL backup changed: ${path}`);
  return true;
}
/** Publish a new store only after its complete schema is durable, so a failed first open can be retried. */
async function createFreshStore(directory:string,destination:string) {
  const temporary = `${destination}.import-${crypto.randomUUID()}`,db = await openBunSqliteDatabase(temporary);
  try {
    await initializeDurableMedia(db);
    const storage = await SqliteStorage.open(durableMediaDatabase(db),{prefix:durableSqlitePrefix});
    await storage.close(BACKGROUND_CONTEXT);
    await link(temporary,destination);await syncDirectory(directory);
  } finally {
    try {await db.close();} finally {for(const suffix of ["","-wal","-shm","-journal"])await rm(temporary+suffix,{force:true});}
  }
}
/** Caller holds the workspace lease. Resumes safely after a crash between individual backup renames. */
export async function prepareDurableSqlite(directory: string) {
  const destination = join(directory, durableSqliteName);
  // An interrupted importer never published its staging file. Only discard our exact private staging names.
  for (const name of await readdir(directory)) if (/^agent\.sqlite\.import-[a-f0-9-]{36}(?:-wal|-shm|-journal)?$/.test(name)) await rm(join(directory, name));
  if (!await Bun.file(destination).exists() && await Bun.file(join(directory, "main.jsonl")).exists()) await importDurableJsonl(directory, destination);
  if (!await Bun.file(destination).exists()) await createFreshStore(directory,destination);
  const db = await openBunSqliteDatabase(destination);
  try {
    if (!await db.get("SELECT 1 FROM sqlite_master WHERE name='timeline_durable_metadata'")) throw new Error("Agent SQLite file has no durable timeline; refusing to replace existing data");
    if (!await db.get("SELECT 1 FROM sqlite_master WHERE name='timeline_import_receipt'")) {
      if (await Bun.file(join(directory, "main.jsonl")).exists()) throw new Error("SQLite and JSONL journals coexist without a verified import receipt");
      return destination;
    }
    const receipt = await db.get<{ files: string; archived: number }>("SELECT files,archived FROM timeline_import_receipt");
    if (!receipt) throw new Error("Missing JSONL import receipt");
    if (receipt.archived) {
      if (await Bun.file(join(directory,"main.jsonl")).exists()) throw new Error("JSONL journal appeared after SQLite cutover; refusing ambiguous history");
      return destination;
    }
    const files = Value.Parse(manifestSchema, JSON.parse(receipt.files)), backup = join(directory, "jsonl-backup");
    await mkdir(backup, { recursive: true, mode: 0o700 });await syncDirectory(directory);
    // Validate the entire source/backup set before moving any more files.
    for (const file of files) {
      const source = await matches(join(directory, file.name), file), saved = await matches(join(backup, file.name), file);
      if (!source && !saved) throw new Error(`Missing imported JSONL source and backup: ${file.name}`);
      if (source && saved) throw new Error(`Duplicate JSONL backup: ${file.name}`);
    }
    for (const file of files) if (await Bun.file(join(directory, file.name)).exists()) {
      await rename(join(directory, file.name), join(backup, file.name));
      await syncDirectory(backup);await syncDirectory(directory);
    }
    await db.run("UPDATE timeline_import_receipt SET archived=1");
    return destination;
  } finally {await db.close();}
}
