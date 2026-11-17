import { afterAll, describe, expect, it, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { openBunSqliteDatabase } from "@kintsugi/core/bun-sqlite";

const directory = await mkdtemp(join(tmpdir(), "bun-sqlite-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
let next = 0;
// Pi Durable's own storage contract, run against its SQLite storage on Bun's SQLite, with and without a table prefix.
for (const prefix of [undefined, "pi_"]) registerStorageConformance({ describe, expect, it }, `Bun SQLite${prefix ? " (prefixed)" : ""}`, async use => {
  const storage = await SqliteStorage.open(await openBunSqliteDatabase(join(directory, `conformance-${next++}.sqlite`)), { prefix });
  try {await use(storage);} finally {await storage.close(BACKGROUND_CONTEXT);}
});

test("file databases use WAL with a synced log on every commit, and owner-only files", async () => {
  const path = join(directory, "durability.sqlite"), database = await openBunSqliteDatabase(path);
  expect(await database.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
  expect(await database.get("PRAGMA synchronous")).toEqual({ synchronous: 2 });
  await database.exec("CREATE TABLE t(x)");await database.run("INSERT INTO t VALUES(?)", 1);await database.checkpoint();
  expect((await Bun.file(path).stat()).mode & 0o777).toBe(0o600);
  await database.close();
  const reader = await openBunSqliteDatabase(path, { mode: "read-only" });
  expect(await reader.all("SELECT x FROM t")).toEqual([{ x: 1 }]);
  await expect(reader.run("INSERT INTO t VALUES(2)")).rejects.toThrow();await reader.close();
});

test("a failed transaction rolls back and later operations keep their order", async () => {
  const database = await openBunSqliteDatabase(":memory:");await database.exec("CREATE TABLE t(x)");
  await expect(database.transaction(async tx => {await tx.run("INSERT INTO t VALUES(1)");throw new Error("stop");})).rejects.toThrow("stop");
  const order: number[] = [];
  await Promise.all([database.transaction(async tx => {await tx.run("INSERT INTO t VALUES(2)");order.push(1);}), database.run("INSERT INTO t VALUES(3)").then(() => order.push(2))]);
  expect(order).toEqual([1, 2]);expect(await database.all("SELECT x FROM t ORDER BY x")).toEqual([{ x: 2 }, { x: 3 }]);
  expect(await database.get("SELECT x FROM t WHERE x=?", 9)).toBeUndefined();expect(await database.runCounted("DELETE FROM t")).toBe(2);
  await database.close();
});

test("expired transaction handles cannot run SQL; rollback failure poisons the connection", async () => {
  const database = await openBunSqliteDatabase(":memory:");
  let stale: Parameters<Parameters<typeof database.transaction>[0]>[0] | undefined;
  await database.transaction(async tx => {stale = tx;});
  await expect(stale!.exec("CREATE TABLE forbidden(x)")).rejects.toThrow("no longer active");
  await expect(database.transaction(async tx => {await tx.exec("ROLLBACK");throw new Error("original");})).rejects.toBeInstanceOf(AggregateError);
  await expect(database.get("SELECT 1")).rejects.toThrow("rollback failed");
  await database.close();await database.close();
  await expect(database.exec("SELECT 1")).rejects.toThrow();
});

test("committed WAL survives process death without close or checkpoint; incomplete transaction does not", async () => {
  const path = join(directory, "crash.sqlite");
  // Use the repository export rather than import resolution relative to a temporary script.
  const modulePath = new URL("../../../core/src/bun-sqlite.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `
    import {openBunSqliteDatabase} from ${JSON.stringify(modulePath)};
    const db=await openBunSqliteDatabase(${JSON.stringify(path)}, {walAutoCheckpointPages:0});
    await db.exec("CREATE TABLE t(x)");
    await db.run("INSERT INTO t VALUES(1)");
    await db.transaction(async tx=>{await tx.run("INSERT INTO t VALUES(2)");console.log("ready");await new Promise(()=>{});});
  `], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    child.kill("SIGKILL");await child.exited;
    const database = await openBunSqliteDatabase(path);
    try {expect(await database.all("SELECT x FROM t")).toEqual([{ x: 1 }]);} finally {await database.close();}
  } finally {child.kill();await child.exited;}
});

test("close does not wait on another connection's snapshot, and leaves committed WAL data recoverable",async()=>{
  const path=join(directory,"busy-reader.sqlite"),writer=await openBunSqliteDatabase(path);
  await writer.exec("CREATE TABLE t(x); INSERT INTO t VALUES(1)");await writer.checkpoint();
  const reader=await openBunSqliteDatabase(path,{mode:"read-only"}),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
  const held=reader.transaction(async tx=>{expect(await tx.all("SELECT x FROM t")).toEqual([{x:1}]);entered.resolve();await finish.promise;});
  await entered.promise;
  try {
    await writer.run("INSERT INTO t VALUES(2)");const start=performance.now();await writer.close();
    expect(performance.now()-start).toBeLessThan(2000);
    const reopened=await openBunSqliteDatabase(path,{mode:"read-only"});
    try {expect(await reopened.all("SELECT x FROM t ORDER BY x")).toEqual([{x:1},{x:2}]);} finally {await reopened.close();}
  } finally {finish.resolve();await held;await reader.close();await writer.close();}
});
