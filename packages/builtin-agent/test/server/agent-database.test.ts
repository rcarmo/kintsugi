import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentDatabase, closeAgentDatabaseFile } from "../../src/server/agent-database.ts";
import { createToolOutputStore } from "../../src/server/tool-output-store.ts";
import { openDurableWorkspace } from "../../src/server/durable-workspace.ts";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "shared-agent-database-")), file = join(directory, "agent.sqlite");
  cleanups.push(async () => {await closeAgentDatabaseFile(file);await rm(directory, { recursive: true, force: true });});
  return { directory, file, database: agentDatabase(async () => file) };
}
test("durable and derived stores share one FULL/WAL connection; cache work waits outside rollback", async () => {
  const f = await fixture(), workspace = await openDurableWorkspace(f.directory, "fixture", { models: createModels(), registry: createRegistry() });
  cleanups.push(() => workspace.close());
  const db = await f.database(), store = createToolOutputStore(f.database);
  expect(await db.get("PRAGMA synchronous")).toEqual({ synchronous: 2 });
  expect(await db.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
  expect(await db.get("SELECT 1 n FROM timeline_durable_metadata")).toEqual({ n: 1 });
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const transaction = db.transaction(async tx => {
    await tx.exec("CREATE TABLE rolled_back(x)");entered.resolve();await finish.promise;throw new Error("rollback");
  });
  await entered.promise;
  let saved = false;
  const copy = store.save({ id: "out_" + "a".repeat(32), owner: "agent", conversation: 7, after: 10, tool: "bash", label: "fixture", text: "needle", complete: true, retentionMs: 60_000 }).then(result => {saved = true;return result;});
  await Bun.sleep(10);expect(saved).toBe(false);
  finish.resolve();await expect(transaction).rejects.toThrow("rollback");await copy;
  expect(await db.get("SELECT 1 FROM sqlite_master WHERE name='rolled_back'")).toBeUndefined();
  expect(await store.search({ owner: "agent", lineage: [{ conversationId: 7, before: null }] }, { query: "needle" })).toHaveLength(1);
  await workspace.close();
  const next = await f.database();expect(next).not.toBe(db);
  expect(await next.get("SELECT count(*) n FROM tool_outputs")).toEqual({ n: 1 });
});
test("closing drains admitted work and acquisitions wait for it before reopening", async () => {
  const f = await fixture(), db = await f.database();await db.exec("CREATE TABLE t(x)");
  const finish = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const transaction = db.transaction(async tx => {await tx.run("INSERT INTO t VALUES(1)");entered.resolve();await finish.promise;});
  await entered.promise;
  const closing = closeAgentDatabaseFile(f.file), same = closeAgentDatabaseFile(f.file);
  expect(same).toBe(closing);
  let acquired = false;
  const reopening = f.database().then(next => {acquired = true;return next;});
  await Bun.sleep(10);expect(acquired).toBe(false);
  finish.resolve();await transaction;await closing;
  const next = await reopening;expect(next).not.toBe(db);expect(await next.all("SELECT x FROM t")).toEqual([{ x: 1 }]);
  await expect(db.all("SELECT x FROM t")).rejects.toThrow("closed");
});

test("an asynchronous connection callback cannot leak work past the shared queue",async()=>{
  const f=await fixture(),db=await f.database(),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
  const work=db.withSync(async raw=>{raw.exec("BEGIN; CREATE TABLE pending(x)");entered.resolve();await finish.promise;raw.exec("INSERT INTO pending VALUES(1); COMMIT");});
  await entered.promise;let read=false;
  const next=db.all("SELECT x FROM pending").then(rows=>{read=true;return rows;});
  await Bun.sleep(5);expect(read).toBe(false);finish.resolve();await work;
  expect(await next).toEqual([{x:1}]);
});
