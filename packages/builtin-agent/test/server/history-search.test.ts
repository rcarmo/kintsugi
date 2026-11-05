import { workspaceDurableJournalDirectory } from "../../src/server/durable-storage.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, cp, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, AssistantEntry, UserEntry, ToolResultEntry, type ConversationId } from "@earendil-works/pi-durable";
import { openDurableWorkspace, WorkspaceAgents, type DurableWorkspace } from "../../src/server/durable-workspace.ts";
import { searchCommittedHistory, stripTerminalEscapes, createHistorySearchTool } from "../../src/server/history-search.ts";
import { codemodeCallEntry } from "../../src/server/codemode-call.ts";
const context = BACKGROUND_CONTEXT;
const directories: string[] = [], workspaces: DurableWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(item => item.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const path = await mkdtemp(join(tmpdir(), "kintsugi-search-")); directories.push(path);
  const options = { models: createModels(), registry: createRegistry() };
  const owner = await openDurableWorkspace(path, "workspace", options); workspaces.push(owner);
  const conversation = await owner.agent({ agentId: "first", label: "Agent 1", title: "Searchable work" });
  const search = (query: string, scope: "all" | "history" | "output" = "all") => searchCommittedHistory(owner.harness, path, "workspace", { query, scope }, async () => ({ status: "unavailable" }));
  async function user(text: string, id: ConversationId = conversation.id) {
    return owner.harness.commit(tx => tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: text, timestamp: 100 }] }), context);
  }
  async function output(text: string, name = "bash", path?: string) {
    await owner.harness.commit(tx => tx.appendEntry(ToolResultEntry, conversation.id, { data: { diagnostics: [] }, model: [{ role: "toolResult", toolCallId: "call", toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 120, details: path ? { fullOutputPath: path } : {} }] }), context);
  }
  return { path, options, owner, conversation, search, user, output };
}
test("FTS searches committed messages and output with scopes, bounded snippets and native references", async () => {
  const f = await setup();
  await f.user("We agreed to deploy the amber service");
  await f.output("Build diagnostic: cerulean passed");
  const before = await readFile(join(f.path, "main.jsonl"), "utf8");
  expect((await f.search("amber", "history")).results[0]).toMatchObject({ agentId: "first", branch: Number(f.conversation.id), kind: "history", role: "user", title: "Searchable work", reference: { workspaceId: "workspace" } });
  expect((await f.search("cerulean", "output")).results[0]).toMatchObject({ kind: "output", tool: "bash" });
  expect((await f.search("cerulean", "history")).results).toEqual([]);
  expect((await f.search("amber", "output")).results).toEqual([]);
  expect(await readFile(join(f.path, "main.jsonl"), "utf8")).toBe(before);
});
test("hidden reasoning, system configuration, uncommitted sidecars and the search tool's own output are excluded", async () => {
  const f = await setup();
  await f.owner.harness.commit(tx => tx.appendEntry(AssistantEntry, f.conversation.id, { model: [fauxAssistantMessage([{ type: "thinking", thinking: "hiddenviolet" }, { type: "text", text: "Visible jade answer" }])] }), context);
  await f.output("recursivepearl", "search_history");
  await writeFile(join(f.path, "doc-uncommitted.jsonl"), '{"text":"orphanvermillion"}\n');
  for (const query of ["hiddenviolet", "recursivepearl", "orphanvermillion"]) expect((await f.search(query)).results).toEqual([]);
  expect((await f.search("jade")).results).toHaveLength(1);
});
test("old context across reset and new entries are incrementally indexed without duplication", async () => {
  const f = await setup();
  await f.user("before reset peridot");
  await f.conversation.reset(undefined, context);
  await f.user("after reset obsidian");
  expect((await f.search("peridot")).results).toHaveLength(1);
  const first = await f.search("obsidian");
  expect(first.results).toHaveLength(1);
  expect((await f.search("obsidian")).coverage.documentCount).toBe(first.coverage.documentCount);
  await f.user("later quartz");
  expect((await f.search("quartz")).results).toHaveLength(1);
});
test("filters cannot select a foreign agent, branch or workspace; separate indexes stay separate", async () => {
  const f = await setup(); await f.user("sharedword garnet");
  const second = await f.owner.agent({ agentId: "second", label: "Agent 2", title: "Second" });
  await f.user("sharedword ruby", second.id);
  expect((await searchCommittedHistory(f.owner.harness, f.path, "workspace", { query: "sharedword", agentId: "second" })).results.map(row => row.agentId)).toEqual(["second"]);
  expect((await searchCommittedHistory(f.owner.harness, f.path, "workspace", { query: "sharedword", branch: 999999 })).results).toEqual([]);
  await expect(searchCommittedHistory(f.owner.harness, f.path, "foreign", { query: "garnet" })).rejects.toThrow("identity");
  const foreign = await setup(); await foreign.user("foreignsecret sapphire");
  expect((await f.search("foreignsecret")).results).toEqual([]);
});
test("retained forks are indexed and removal from the catalog removes derived results", async () => {
  const f = await setup();
  const boundary = await f.user("branchword topaz");
  const fork = await f.conversation.fork(boundary.id, { ownership: { kind: "ownerless" } }, context);
  await f.user("forkword tourmaline", fork.id);
  await f.owner.harness.commit(async tx => {
    const record = (await tx.doc(WorkspaceAgents)).agents[0]!;
    record.branches = [record.durableId, fork.id];
  }, context);
  expect((await f.search("tourmaline")).results[0]?.branch).toBe(Number(fork.id));
  await f.owner.harness.commit(async tx => { (await tx.doc(WorkspaceAgents)).agents[0]!.branches = [f.conversation.id]; }, context);
  expect((await f.search("tourmaline")).results).toEqual([]);
});
test("saved output prefixes are indexed lazily with provenance and explicit truncation", async () => {
  const f = await setup(); await f.output("retained tail", "bash", "/fixture/output.log");
  const pending = await f.search("nephrite", "output");
  expect(pending.coverage.savedOutputsPending).toBe(1);
  let reads = 0;
  const run = () => searchCommittedHistory(f.owner.harness, f.path, "workspace", { query: "nephrite", scope: "output" }, async path => {
    expect(path).toBe("/fixture/output.log"); reads++;
    return { status: "available", text: "\x1b[31mnephrite\x1b[0m appears only in saved output", truncated: true };
  });
  const result = await run();
  expect(result.results[0]).toMatchObject({ path: "/fixture/output.log", kind: "output", truncated: true, offset: 0 });
  expect(result.coverage.savedOutputsPending).toBe(0);
  await run(); expect(reads).toBe(1);
});
test("nested Code Mode output is searchable without indexing nested arguments or self-search results", async () => {
  const f = await setup();
  await f.owner.harness.commit(async tx => {
    await tx.appendEntry(codemodeCallEntry, f.conversation.id, { data: { callId: "outer", key: "0", phase: "start", name: "bash", arguments: { command: "hiddenargumentstone" } } });
    await tx.appendEntry(codemodeCallEntry, f.conversation.id, { data: { callId: "outer", key: "0", phase: "end", isError: false, cancelled: false, output: "nestedlapis diagnostic" } });
    await tx.appendEntry(codemodeCallEntry, f.conversation.id, { data: { callId: "outer", key: "1", phase: "start", name: "search_history" } });
    await tx.appendEntry(codemodeCallEntry, f.conversation.id, { data: { callId: "outer", key: "1", phase: "end", isError: false, cancelled: false, output: "selfsearchstone" } });
  }, context);
  expect((await f.search("nestedlapis")).results[0]?.tool).toBe("bash");
  expect((await f.search("hiddenargumentstone")).results).toEqual([]);
  expect((await f.search("selfsearchstone")).results).toEqual([]);
});
test("FTS supports phrases, prefixes, OR and safe plain queries; malformed syntax is an input error", async () => {
  const f = await setup(); await f.user("yellow zircon and blue diamond");
  const search = (query: string) => searchCommittedHistory(f.owner.harness, f.path, "workspace", { query, syntax: "fts" });
  for (const query of ['"yellow zircon"', "diam*", "missing OR zircon"]) expect((await search(query)).results.length).toBeGreaterThan(0);
  await expect(search('"unterminated')).rejects.toThrow("Invalid FTS");
  expect((await f.search("zircon'; DROP TABLE documents;--")).results).toEqual([]);
  expect((await f.search("zircon")).results).toHaveLength(1);
});
test("cancellation stops indexing and search index can be rebuilt without changing the journal", async () => {
  const f = await setup(); await f.user("rebuildword amethyst");
  const abort = new AbortController(); abort.abort(new Error("Search cancelled"));
  await expect(searchCommittedHistory(f.owner.harness, f.path, "workspace", { query: "amethyst" }, undefined, abort.signal)).rejects.toThrow("cancelled");
  expect((await f.search("amethyst")).results).toHaveLength(1);
  const journal = await readFile(join(f.path, "main.jsonl"), "utf8");
  await rm(join(f.path, "search-v1.sqlite"));
  expect((await f.search("amethyst")).results).toHaveLength(1);
  expect(await readFile(join(f.path, "main.jsonl"), "utf8")).toBe(journal);
});
test("index persists across runtime restart and limits result count and excerpt length", async () => {
  const f = await setup(); for (let i = 0; i < 25; i++) await f.user(`spinel ${"word ".repeat(1000)} ${i}`);
  const result = await searchCommittedHistory(f.owner.harness, f.path, "workspace", { query: "spinel", limit: 3 });
  expect(result.results).toHaveLength(3);
  expect(result.results.every(row => row.excerpt.length <= 1000)).toBe(true);
  await f.owner.close();
  const reopened = await openDurableWorkspace(f.path, "workspace", f.options); workspaces.push(reopened);
  expect((await searchCommittedHistory(reopened.harness, f.path, "workspace", { query: "spinel", limit: 3 })).coverage.documentCount).toBe(result.coverage.documentCount);
  const db = new Database(join(f.path, "search-v1.sqlite"));
  expect(db.query("SELECT count(*) AS n FROM search").get()).toMatchObject({ n: 25 }); db.close();
});
test("terminal escape stripping removes colour and hyperlink controls", () => {
  expect(stripTerminalEscapes("\x1b[31mred\x1b[0m \x1b]8;;https://example.com\x07link\x1b]8;;\x07\r\n")).toBe("red link\n");
});
test("offline journal rollback invalidates stale indexed entries", async () => {
  const f = await setup(); await f.user("preservedopal");
  const backup = await mkdtemp(join(tmpdir(), "search-rollback-")); directories.push(backup);
  await cp(f.path, backup, { recursive: true });
  await f.user("rolledbackemerald");
  expect((await f.search("rolledbackemerald")).results).toHaveLength(1);
  await f.owner.close();
  for (const name of await readdir(f.path)) if (name.endsWith(".jsonl")) await rm(join(f.path, name));
  for (const name of await readdir(backup)) if (name.endsWith(".jsonl")) await copyFile(join(backup, name), join(f.path, name));
  const reopened = await openDurableWorkspace(f.path, "workspace", f.options); workspaces.push(reopened);
  expect((await searchCommittedHistory(reopened.harness, f.path, "workspace", { query: "rolledbackemerald" })).results).toEqual([]);
  expect((await searchCommittedHistory(reopened.harness, f.path, "workspace", { query: "preservedopal" })).results).toHaveLength(1);
});
test("native Harness executes the search tool without deadlock, inference beyond the fixture or history mutation", async () => {
  const previous = process.env.KINTSUGI_DATA_DIR;
  const dataDir = await mkdtemp(join(tmpdir(), "search-native-tool-")); directories.push(dataDir);
  process.env.KINTSUGI_DATA_DIR = dataDir;
  try {
    const directory = await workspaceDurableJournalDirectory("tool-workspace");
    const models = createModels(), faux = fauxProvider({ tokensPerSecond: 100_000 }); models.setProvider(faux.provider);
    const registry = createRegistry(); let workspace: DurableWorkspace;
    registry.install(defineExtension({ name: "search-fixture", tools: [createHistorySearchTool("tool-workspace", () => workspace.harness)] }));
    workspace = await openDurableWorkspace(directory, "tool-workspace", { models, registry }); workspaces.push(workspace);
    const conversation = await workspace.agent({ agentId: "search-agent", title: "Native search", label: "Agent" }, { model: { provider: "faux", modelId: "faux-1" } });
    await workspace.harness.commit(tx => tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: "Earlier decision: celestite", timestamp: 100 }] }), context);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("search_history", { query: "celestite" })], { stopReason: "toolUse" }), fauxAssistantMessage("Found the earlier decision")]);
    await (await conversation.submit({ type: "input", content: "Search the earlier decision", requestId: "search" }, context)).wait(context);
    const result = (await conversation.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []).find(message => message.role === "toolResult" && message.toolName === "search_history");
    expect(result?.role).toBe("toolResult");
    if (result?.role !== "toolResult") throw new Error("Missing native tool result");
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("celestite");
    expect(faux.state.callCount).toBe(2);
  } finally { if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous; }
});
