import { durableMediaDatabase, initializeDurableMedia, clearAbandonedDurableUploads } from "./durable-media.ts";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { agentDatabase, agentDatabaseName, closeAgentDatabaseFile } from "./agent-database.ts";

/** Durable tables never collide with the derived history, output and recall tables. */
export const durableSqlitePrefix = "timeline_";
export const durableSqliteName = agentDatabaseName;
export async function openBunDurableStorage(path: string) {
  const db = await agentDatabase(async () => path)();
  try {
  await initializeDurableMedia(db);
  await clearAbandonedDurableUploads(db);
  // Storage owns the shared file's lifetime; all cache operations use this same queue.
  const storage = await SqliteStorage.open(durableMediaDatabase({
    exec: db.exec.bind(db), run: db.run.bind(db), runCounted: db.runCounted.bind(db),
    get: db.get.bind(db), all: db.all.bind(db), transaction: db.transaction.bind(db),
    close: () => closeAgentDatabaseFile(path),
  }), { prefix: durableSqlitePrefix });
  return storage;
  } catch (error) {await closeAgentDatabaseFile(path);throw error;}
}

/**
 * Pi Durable runs its migration bootstrap even at the current schema version. For a read-only reader, verify that
 * metadata exists and skip only its two idempotent bootstrap writes. All other SQL uses Bun's read-only connection.
 */
export async function openReadOnlyDurableStorage(path: string) {
  const { openBunSqliteDatabase } = await import("@kintsugi/core/bun-sqlite");
  const db = await openBunSqliteDatabase(path, { mode: "read-only" });
  let bootstrapping = true;
  try {
    if (!await db.get("SELECT version FROM timeline_durable_schema WHERE singleton=1")) throw new Error("Missing durable schema metadata");
    const storage = await SqliteStorage.open(durableMediaDatabase({
      exec: db.exec.bind(db), run: db.run.bind(db), runCounted: db.runCounted.bind(db), get: db.get.bind(db), all: db.all.bind(db), close: db.close.bind(db),
      transaction: callback => db.transaction(tx => callback({
        exec: sql => bootstrapping && sql === `CREATE TABLE IF NOT EXISTS timeline_durable_schema (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT` ? Promise.resolve() : tx.exec(sql),
        run: (sql, ...params) => bootstrapping && sql === "INSERT OR IGNORE INTO timeline_durable_schema (singleton, version) VALUES (1, 0)" ? Promise.resolve() : tx.run(sql, ...params),
        runCounted: tx.runCounted.bind(tx), get: tx.get.bind(tx), all: tx.all.bind(tx),
      })),
    }), { prefix: durableSqlitePrefix });
    bootstrapping = false;return storage;
  } catch (error) {await db.close();throw error;}
}
