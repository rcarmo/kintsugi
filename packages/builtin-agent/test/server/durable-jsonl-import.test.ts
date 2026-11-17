import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openBunDurableStorage } from "../../src/server/durable-sqlite.ts";
import { importDurableJsonl } from "../../src/server/durable-jsonl-import.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "timeline-import-"));cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ tokensPerSecond: 100_000 }), models = createModels();models.setProvider(faux.provider);
  const registry = createRegistry();
  const Session = defineDoc({ kind: "import.session", version: 1, scope: "session", checkpointWhen: () => false, initial: () => ({ value: "initial" }) });
  const History = defineDoc({ kind: "import.history", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", checkpointWhen: () => false, initial: () => ({ value: "initial" }) });
  const source = await openNodeJsonlStorage(directory, context, { fsync: true });
  const harness = await Harness.open(source, { models, registry }, context);cleanup.push(() => harness.close(context));
  const root = await harness.root(context);
  await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
  await harness.commit(async tx => {(await tx.doc(Session)).value = "session-one";(await tx.doc(History, root.id)).value = "history-one";}, context);
  faux.setResponses([fauxAssistantMessage("committed answer")]);
  await (await root.submit({ type: "input", content: "committed prompt", requestId: "request" }, context)).wait(context);
  await harness.commit(async tx => {(await tx.doc(Session)).value = "session-two";(await tx.doc(History, root.id)).value = "history-two";}, context);
  const expected = await source.scanEntries({ conversationId: root.id }, 1000, undefined, context), session = await harness.snapshot(Session, context), history = await harness.snapshot(History, root.id, context);
  await harness.close(context);
  const files = (await readdir(directory)).filter(file => file.endsWith(".jsonl"));
  const bytes = await Promise.all(files.map(file => readFile(join(directory, file))));
  return { directory, files, bytes, models, registry, root, expected, session, history, Session, History };
}

test("streaming import preserves IDs, entries, model messages, documents, submissions and commit sequences without changing JSONL", async () => {
  const f = await fixture(), destination = join(f.directory, "agent.sqlite");
  const receipt = await importDurableJsonl(f.directory, destination);
  expect(receipt.commits).toBeGreaterThan(5);
  const storage = await openBunDurableStorage(destination);
  const restored = await Harness.open(storage, { models: f.models, registry: f.registry }, context);cleanup.push(() => restored.close(context));
  const root = (await restored.conversation(f.root.id, context))!;
  expect(await storage.scanEntries({ conversationId: root.id }, 1000, undefined, context)).toEqual(f.expected);
  expect(await restored.snapshot(f.Session, context)).toEqual(f.session);
  expect(await restored.snapshot(f.History, f.root.id, context)).toEqual(f.history);
  const old = await openNodeJsonlStorage(f.directory, context, { readOnly: true });
  try {
    const entries = await old.scanEntries({ conversationId: f.root.id }, 1000, undefined, context);
    for (const entry of entries.items) expect(await storage.entry(entry.id, context)).toEqual(await old.entry(entry.id, context));
    expect(await storage.scanSubmissions({}, 1000, undefined, context)).toEqual(await old.scanSubmissions({}, 1000, undefined, context));
    const documents = await old.scanDocuments({ scope: { kind: "conversation", conversationId: f.root.id }, at: "current" }, 1000, undefined, context);
    expect(await storage.scanDocuments({ scope: { kind: "conversation", conversationId: f.root.id }, at: "current" }, 1000, undefined, context)).toEqual(documents);
    for (const doc of documents.items) {
      expect(await storage.document(doc.id, "current", context)).toEqual(await old.document(doc.id, "current", context));
      if (doc.scope.kind === "conversation" && doc.history === "rewindable") {
        for (const entry of entries.items) {
          const at = (await old.entry(entry.id, context))!.commitSeq;
          expect(await storage.document(doc.id, at, context)).toEqual(await old.document(doc.id, at, context));
        }
      }
    }
  } finally {await old.close(context);}
  for (const [index, file] of f.files.entries()) expect(await readFile(join(f.directory, file))).toEqual(f.bytes[index]);
  await expect(importDurableJsonl(f.directory, destination)).rejects.toThrow();
  expect(await storage.scanEntries({ conversationId: root.id }, 1000, undefined, context)).toEqual(f.expected);
});

test("torn final lines and unconfirmed sidecar tails are ignored, never repaired in the source", async () => {
  const f = await fixture();
  await appendFile(join(f.directory, "main.jsonl"), '{"torn":');
  const doc = f.files.find(file => file.startsWith("doc-"))!;
  const row = JSON.parse((await readFile(join(f.directory, doc), "utf8")).trim().split("\n").at(-1)!);
  row.seq += 10000;
  await appendFile(join(f.directory, doc), JSON.stringify(row) + '\n{"torn":');
  const main = await readFile(join(f.directory, "main.jsonl"));
  await importDurableJsonl(f.directory, join(f.directory, "agent.sqlite"));
  expect(await readFile(join(f.directory, "main.jsonl"))).toEqual(main);
});

test("a malformed complete line refuses cutover and removes only the incomplete SQLite file", async () => {
  const f = await fixture(), destination = join(f.directory, "agent.sqlite");
  await appendFile(join(f.directory, "main.jsonl"), '{"invalid":true}\n');
  await expect(importDurableJsonl(f.directory, destination)).rejects.toThrow();
  expect(await Bun.file(destination).exists()).toBe(false);
  expect((await readdir(f.directory)).filter(name => name.includes(".import-"))).toEqual([]);
  expect(await Bun.file(join(f.directory, "main.jsonl")).exists()).toBe(true);
});

test("missing confirmed sidecars are corruption, not empty document state", async () => {
  const f = await fixture();
  const file = f.files.find(file => file.startsWith("doc-") && f.bytes[f.files.indexOf(file)]!.includes("history-one"))!;
  await writeFile(join(f.directory, file), "");
  await expect(importDurableJsonl(f.directory, join(f.directory, "agent.sqlite"))).rejects.toThrow("Missing confirmed sidecar");
});

test("sequence gaps and empty commits retain their original sequence numbers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-gaps-"));cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "main.jsonl"), [1, 3, 9].map(seq => JSON.stringify({ format: 1, type: "commit", seq, writes: [] })).join("\n") + "\n");
  const receipt = await importDurableJsonl(directory, join(directory, "agent.sqlite"));
  expect(receipt).toMatchObject({ commits: 3, lastSeq: 9 });
  const storage = await openBunDurableStorage(join(directory, "agent.sqlite"));
  try {
    let next = 0;
    await storage.commit([[]], (_index, seq) => {next = Number(seq);}, context);
    expect(next).toBe(10);
  } finally {await storage.close(context);}
});

test("a confirmed sidecar after an unconfirmed record rejects cutover", async () => {
  const f = await fixture();
  const file = f.files.find(file => file.startsWith("doc-") && f.bytes[f.files.indexOf(file)]!.includes("history-one"))!;
  const rows = (await readFile(join(f.directory, file), "utf8")).trim().split("\n");
  const unconfirmed = JSON.parse(rows[0]!);unconfirmed.ordinal++;
  rows.splice(1, 0, JSON.stringify(unconfirmed));
  await writeFile(join(f.directory, file), rows.join("\n") + "\n");
  await expect(importDurableJsonl(f.directory, join(f.directory, "agent.sqlite"))).rejects.toThrow("Confirmed sidecar record follows an unconfirmed tail");
});

test("startup cuts over once, archives verified sources, and reopens without replay", async () => {
  const f = await fixture();
  const { openDurableWorkspace } = await import("../../src/server/durable-workspace.ts");
  const workspace = await openDurableWorkspace(f.directory, "fixture", { models: f.models, registry: f.registry });
  cleanup.push(() => workspace.close());
  for (const [index, file] of f.files.entries()) {
    expect(await Bun.file(join(f.directory, file)).exists()).toBe(false);
    expect(await readFile(join(f.directory, "jsonl-backup", file))).toEqual(f.bytes[index]);
  }
  expect((await workspace.harness.conversation(f.root.id, context))!.id).toBe(f.root.id);
  await workspace.close();
  const reopened = await openDurableWorkspace(f.directory, "fixture", { models: f.models, registry: f.registry });cleanup.push(() => reopened.close());
  expect(await reopened.harness.snapshot(f.History, f.root.id, context)).toEqual(f.history);
});

test("startup resumes a backup interrupted after some renames and cleans unpublished staging files", async () => {
  const f = await fixture();
  await importDurableJsonl(f.directory, join(f.directory, "agent.sqlite"));
  const { mkdir, rename } = await import("node:fs/promises");
  await mkdir(join(f.directory, "jsonl-backup"));
  await rename(join(f.directory, f.files[0]!), join(f.directory, "jsonl-backup", f.files[0]!));
  const abandoned = `agent.sqlite.import-${crypto.randomUUID()}`;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await writeFile(join(f.directory, abandoned + suffix), "unpublished");
  const { prepareDurableSqlite } = await import("../../src/server/durable-migration.ts");
  await prepareDurableSqlite(f.directory);
  for (const file of f.files) expect(await Bun.file(join(f.directory, "jsonl-backup", file)).exists()).toBe(true);
  expect((await readdir(f.directory)).filter(file => file.includes(".import-"))).toEqual([]);
  await prepareDurableSqlite(f.directory);
});

test("changed sources refuse archiving and existing non-timeline SQLite is never replaced", async () => {
  const f = await fixture();
  const { prepareDurableSqlite } = await import("../../src/server/durable-migration.ts");
  await importDurableJsonl(f.directory, join(f.directory, "agent.sqlite"));
  await appendFile(join(f.directory, "main.jsonl"), "\n");
  await expect(prepareDurableSqlite(f.directory)).rejects.toThrow("backup changed");
  for (const file of f.files) expect(await Bun.file(join(f.directory, file)).exists()).toBe(true);
  const second = await fixture();
  const { openBunSqliteDatabase } = await import("@kintsugi/core/bun-sqlite");
  const database = await openBunSqliteDatabase(join(second.directory, "agent.sqlite"));await database.exec("CREATE TABLE precious(x); INSERT INTO precious VALUES(42)");await database.close();
  await expect(prepareDurableSqlite(second.directory)).rejects.toThrow("no durable timeline");
  const read = await openBunSqliteDatabase(join(second.directory, "agent.sqlite"), { mode: "read-only" });
  try {expect(await read.get("SELECT x FROM precious")).toEqual({ x: 42 });} finally {await read.close();}
});

test("SIGKILL during an unpublished import leaves sources intact and startup retries from a clean staging file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-import-crash-"));cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const source = Array.from({ length: 10_000 }, (_, i) => JSON.stringify({ format: 1, type: "commit", seq: i + 1, writes: [] })).join("\n") + "\n";
  await writeFile(join(directory, "main.jsonl"), source);
  const module = new URL("../../src/server/durable-jsonl-import.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "--smol", "-e", `import {importDurableJsonl} from ${JSON.stringify(module)};await importDurableJsonl(${JSON.stringify(directory)},${JSON.stringify(join(directory, "agent.sqlite"))});`], { stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 3000;
    while (!(await readdir(directory)).some(name => name.includes(".import-"))) {
      if (Date.now() > deadline) throw new Error("Import never reached staging");
      await Bun.sleep(5);
    }
    child.kill("SIGKILL");await child.exited;
    await Bun.sleep(1500);
    expect(await Bun.file(join(directory, "agent.sqlite")).exists()).toBe(false);
    expect(await readFile(join(directory, "main.jsonl"), "utf8")).toBe(source);
    const { prepareDurableSqlite } = await import("../../src/server/durable-migration.ts");
    await prepareDurableSqlite(directory);
    expect((await readdir(directory)).filter(name => name.includes(".import-"))).toEqual([]);
    expect(await readFile(join(directory, "jsonl-backup", "main.jsonl"), "utf8")).toBe(source);
  } finally {child.kill();await child.exited;}
}, 15_000);

test("retained JSONL views share a streamed immutable snapshot, preserve all source bytes and refresh after source changes", async () => {
  const f = await fixture();
  const { acquireDurableHistorySnapshot, retireDurableHistorySnapshots } = await import("../../src/server/durable-history-snapshot.ts");
  const [one, two] = await Promise.all([acquireDurableHistorySnapshot(f.directory), acquireDurableHistorySnapshot(f.directory)]);
  try {
    expect(one.path).toBe(two.path);
    expect(await Bun.file(join(f.directory, "agent.sqlite")).exists()).toBe(false);
    for (const [index, file] of f.files.entries()) expect(await readFile(join(f.directory, file))).toEqual(f.bytes[index]);
    const { openReadOnlyDurableStorage } = await import("../../src/server/durable-sqlite.ts");
    const storage = await openReadOnlyDurableStorage(one.path);
    try {expect(await storage.scanEntries({ conversationId: f.root.id }, 1000, undefined, context)).toEqual(f.expected);} finally {await storage.close(context);}
    const main = (await readFile(join(f.directory, "main.jsonl"), "utf8")).trim().split("\n"), last = JSON.parse(main.at(-1)!);
    await appendFile(join(f.directory, "main.jsonl"), JSON.stringify({ format: 1, type: "commit", seq: last.seq + 1, writes: [] }) + "\n");
    const refreshed = await acquireDurableHistorySnapshot(f.directory);
    try {
      expect(refreshed.path).not.toBe(one.path);
      // A newer source cannot invalidate files already owned by another reader.
      expect(await Bun.file(one.path).exists()).toBe(true);
    } finally {await refreshed.release();}
    retireDurableHistorySnapshots();
    expect(await Bun.file(one.path).exists()).toBe(true);
  } finally {await one.release();await two.release();retireDurableHistorySnapshots();}
  expect(await Bun.file(one.path).exists()).toBe(false);
});

test("malformed main task placement and terminal task sidecars are rejected as JSONL corruption",async()=>{
  const f=await fixture(),destination=join(f.directory,"agent.sqlite");
  await writeFile(join(f.directory,"main.jsonl"),JSON.stringify({format:1,type:"commit",seq:1,writes:[{type:"task",value:{id:5,state:{status:"pending"}}}]})+"\n");
  await expect(importDurableJsonl(f.directory,destination)).rejects.toThrow();
  expect(await Bun.file(destination).exists()).toBe(false);
  await writeFile(join(f.directory,"main.jsonl"),JSON.stringify({format:1,type:"commit",seq:1,writes:[]})+"\n");
  await writeFile(join(f.directory,"task-5.jsonl"),JSON.stringify({format:1,type:"record",seq:1,ordinal:0,payload:{type:"task",value:{id:5,state:{status:"terminal"}}}})+"\n");
  await expect(importDurableJsonl(f.directory,destination)).rejects.toThrow();
});
test("a JSONL journal reappearing after a completed cutover is refused, never silently ignored",async()=>{
  const f=await fixture(),{prepareDurableSqlite}=await import("../../src/server/durable-migration.ts");
  await prepareDurableSqlite(f.directory);
  await writeFile(join(f.directory,"main.jsonl"),f.bytes[f.files.indexOf("main.jsonl")]!);
  await expect(prepareDurableSqlite(f.directory)).rejects.toThrow("appeared after SQLite cutover");
});

test("a failed first-time SQLite schema bootstrap never publishes a half-created workspace database",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"timeline-schema-failure-"));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const child=Bun.spawn([process.execPath,"-e",`
    import {mock,expect} from "bun:test";
    import {SqliteStorage} from "@earendil-works/pi-durable/storage/sqlite";
    const original=SqliteStorage.open.bind(SqliteStorage);let fail=true;
    mock.module("@earendil-works/pi-durable/storage/sqlite",()=>({SqliteStorage:{async open(db,options){if(fail){await db.exec("CREATE TABLE partial(x)");throw new Error("schema interrupted");}return original(db,options);}}}));
    const {prepareDurableSqlite}=await import("./src/server/durable-migration.ts");
    const {readdir}=await import("node:fs/promises");
    const directory=${JSON.stringify(directory)};
    await expect(prepareDurableSqlite(directory)).rejects.toThrow("schema interrupted");
    expect(await Bun.file(directory+"/agent.sqlite").exists()).toBe(false);
    expect((await readdir(directory)).filter(name=>name.includes(".import-"))).toEqual([]);
    fail=false;await prepareDurableSqlite(directory);expect(await Bun.file(directory+"/agent.sqlite").exists()).toBe(true);
  `],{cwd:join(import.meta.dir,"../.."),stdout:"pipe",stderr:"pipe"});
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,stdout,stderr}).toEqual({code:0,stdout:"",stderr:""});
});

test("imports are globally serialised while the parent event loop stays responsive",async()=>{
  const dirs=await Promise.all([0,1].map(async()=>{const dir=await mkdtemp(join(tmpdir(),"timeline-import-queue-"));cleanup.push(()=>rm(dir,{recursive:true,force:true}));return dir;}));
  const source=Array.from({length:10_000},(_,i)=>JSON.stringify({format:1,type:"commit",seq:i+1,writes:[]})).join("\n")+"\n";
  for(const dir of dirs)await writeFile(join(dir,"main.jsonl"),source);
  let ticks=0;const timer=setInterval(()=>ticks++,5);
  const one=importDurableJsonl(dirs[0]!,join(dirs[0]!,"agent.sqlite")),two=importDurableJsonl(dirs[1]!,join(dirs[1]!,"agent.sqlite"));
  try {
    const deadline=Date.now()+5000;
    while(!(await readdir(dirs[0]!)).some(name=>name.includes(".import-"))){if(Date.now()>deadline)throw new Error("First import did not start");await Bun.sleep(5);}
    expect((await readdir(dirs[1]!)).some(name=>name.includes(".import-"))).toBe(false);
    await Promise.all([one,two]);expect(ticks).toBeGreaterThan(2);
  }finally{clearInterval(timer);await Promise.allSettled([one,two]);}
},15_000);
