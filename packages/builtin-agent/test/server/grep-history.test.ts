import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, UserEntry, ToolResultEntry, createRegistry, type ConversationId } from "@earendil-works/pi-durable";
import { openDurableWorkspace, WorkspaceAgents } from "../../src/server/durable-workspace.ts";
import { grepCommittedHistory, grepTrigramQuery, type GrepHistoryInput } from "../../src/server/grep-history.ts";
import { codemodeCallEntry } from "../../src/server/codemode-call.ts";
import { conversationLineage } from "../../src/server/agent-database.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "grep-history-"));cleanup.push(() => rm(path, { recursive: true, force: true }));
  const workspace = await openDurableWorkspace(path, "workspace", { models: createModels(), registry: createRegistry() });cleanup.push(() => workspace.close());
  const root = await workspace.agent({ agentId: "first", title: "First", label: "Agent 1" });
  const user = (text: string, id: ConversationId = root.id) => workspace.harness.commit(tx => tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: text, timestamp: 1 }] }), context);
  const grep = (input: GrepHistoryInput) => grepCommittedHistory(workspace.harness, path, "workspace", input);
  return { path, workspace, root, user, grep };
}
test("grep supports regex, fixed strings, case, line context and native references without reasoning or self-output", async () => {
  const f = await fixture();
  const entry = await f.user("before\nNeedle [42]\nafter\nNEEDLE 13");
  await f.workspace.harness.commit(tx => tx.appendEntry(AssistantEntry, f.root.id, { model: [fauxAssistantMessage([{ type: "thinking", thinking: "secretneedle" }, { type: "text", text: "visible answer" }])] }), context);
  for (const name of ["search_history", "grep_history"]) await f.workspace.harness.commit(tx => tx.appendEntry(ToolResultEntry, f.root.id, { data: { diagnostics: [] }, model: [{ role: "toolResult", toolName: name, toolCallId: "call", content: [{ type: "text", text: "recursive" }], isError: false, timestamp: 1 }] }), context);
  const result = await f.grep({ pattern: "Needle \\[42\\]", context: 1 });
  expect(result.results[0]).toMatchObject({ entryId: entry.id, agentId: "first", line: 2, startLine: 1, lines: ["before", "Needle [42]", "after"], reference: { workspaceId: "workspace", branch: f.root.id } });
  expect((await f.grep({ pattern: "needle", fixed: true, ignoreCase: true })).results).toHaveLength(2);
  expect((await f.grep({ pattern: "[42]", fixed: true })).results).toHaveLength(1);
  for (const pattern of ["secretneedle", "recursive"]) expect((await f.grep({ pattern })).results).toEqual([]);
});
test("prefilters never narrow regex alternatives, Unicode, punctuation or short matches", async () => {
  const f = await fixture();await f.user("alpha\nbeta\nλambda\n[x]\nz");
  for (const pattern of ["alpha|beta", "λ", "\\[x\\]", "z"]) expect((await f.grep({ pattern })).results.length).toBeGreaterThan(0);
  expect((await f.grep({ pattern: "alpha", fixed: true })).coverage.prefilter).toBe("trigram");
  expect(grepTrigramQuery({ pattern: "alpha|beta" })).toBeUndefined();
  expect(grepTrigramQuery({ pattern: "λambda", fixed: true })).toBeUndefined();
  await expect(f.grep({ pattern: "(a)\\1" })).rejects.toThrow("Invalid RE2");
  await expect(f.grep({ pattern: "(?=alpha)" })).rejects.toThrow("Invalid RE2");
});
test("filters are workspace/Agent/fork scoped, including a nested fork before its parent's fork point", async () => {
  const f = await fixture(), early = await f.user("earlygarnet"), later = await f.user("lategarnet");
  const parent = await f.root.fork(later.id, { ownership: { kind: "ownerless" } }, context);
  const child = await parent.fork(early.id, { ownership: { kind: "ownerless" } }, context);
  await f.user("childgarnet", child.id);
  await f.workspace.harness.commit(async tx => {(await tx.doc(WorkspaceAgents)).agents[0]!.branches = [f.root.id, parent.id, child.id];}, context);
  const lineage = await conversationLineage(f.workspace.harness, child.id, context);
  expect(lineage.find(item => item.conversationId === Number(f.root.id))?.before).toBe(Number(early.id));
  expect((await f.grep({ pattern: "lategarnet", branch: Number(child.id) })).results).toEqual([]);
  expect((await f.grep({ pattern: "earlygarnet", branch: Number(child.id) })).results).toHaveLength(1);
  expect((await f.grep({ pattern: "childgarnet", branch: Number(f.root.id) })).results).toEqual([]);
  expect((await f.grep({ pattern: "garnet", agentId: "unknown" })).results).toEqual([]);
  await expect(grepCommittedHistory(f.workspace.harness, f.path, "foreign", { pattern: "garnet" })).rejects.toThrow("identity");
});
test("completed nested tools are indexed with names but neither their arguments nor partial progress", async () => {
  const f = await fixture();
  await f.workspace.harness.commit(async tx => {
    await tx.appendEntry(codemodeCallEntry, f.root.id, { data: { phase: "start", callId: "outer", key: "0", name: "bash", arguments: { command: "hiddenargument" } } });
    await tx.appendEntry(codemodeCallEntry, f.root.id, { data: { phase: "end", callId: "outer", key: "0", output: "nestedneedle", cancelled: false, isError: false } });
  }, context);
  expect((await f.grep({ pattern: "nestedneedle", tool: "bash", role: "tool" })).results).toHaveLength(1);
  expect((await f.grep({ pattern: "nestedneedle", role: "user" })).results).toEqual([]);
  expect((await f.grep({ pattern: "hiddenargument" })).results).toEqual([]);
});
test("match limits and cursors resume within documents without missing or repeating lines", async () => {
  const f = await fixture();await f.user(Array.from({ length: 60 }, (_, i) => `needle ${i}`).join("\n"));
  const lines: number[] = [];let cursor: GrepHistoryInput["cursor"];
  for (let page = 0; page < 10; page++) {
    const result = await f.grep({ pattern: "needle", limit: 7, cursor });
    expect(result.results.length).toBeLessThanOrEqual(7);
    lines.push(...result.results.map(row => row.line));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  expect(lines).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  await f.user("after-index needle");
  expect((await f.grep({ pattern: "after-index needle" })).results).toHaveLength(1);
});

test("Unicode simple-case variants remain searchable without an unsafe ASCII prefilter", async () => {
  const f = await fixture();await f.user("Kelvin\nſearch\nKELVIN\nsearch");
  expect(grepTrigramQuery({ pattern: "kelvin", fixed: true, ignoreCase: true })).toBeUndefined();
  expect((await f.grep({ pattern: "kelvin", fixed: true, ignoreCase: true })).results).toHaveLength(2);
  expect((await f.grep({ pattern: "search", ignoreCase: true })).results).toHaveLength(2);
});
test("cancellation, huge context lines and invalidated cursors remain bounded and explicit", async () => {
  const f = await fixture();
  await f.user(Array.from({ length: 25 }, () => "needle " + "x".repeat(5000)).join("\n"));
  const result = await f.grep({ pattern: "needle", context: 10, limit: 50 });
  expect(result.results.flatMap(item => item.lines).join("").length).toBeLessThanOrEqual(16_000);
  expect(result.results[0]!.shortened).toBe(true);
  const abort = new AbortController();abort.abort(new Error("cancelled"));
  await expect(grepCommittedHistory(f.workspace.harness, f.path, "workspace", { pattern: "needle" }, abort.signal)).rejects.toThrow("cancelled");
  const { agentDatabase } = await import("../../src/server/agent-database.ts");
  const db = await agentDatabase(async () => join(f.path, "agent.sqlite"))();
  await db.run("DELETE FROM timeline_entries WHERE id=(SELECT max(id) FROM timeline_entries)");
  await expect(f.grep({ pattern: "needle", cursor: result.nextCursor! })).rejects.toThrow("index changed");
  expect((await f.grep({ pattern: "needle" })).results).toEqual([]);
});
test("native Harness can call grep_history on the shared SQLite connection without enabling other work", async () => {
  const path = await mkdtemp(join(tmpdir(), "grep-native-"));cleanup.push(() => rm(path, { recursive: true, force: true }));
  const { fauxProvider, fauxToolCall } = await import("@earendil-works/pi-ai");
  const { defineExtension } = await import("@earendil-works/pi-durable");
  const { createGrepHistoryTool } = await import("../../src/server/grep-history.ts");
  const { workspaceDurableJournalDirectory } = await import("../../src/server/durable-storage.ts");
  const previous = process.env.KINTSUGI_DATA_DIR;process.env.KINTSUGI_DATA_DIR = path;
  try {
    const models = createModels(), faux = fauxProvider({ tokensPerSecond: 100_000 });models.setProvider(faux.provider);
    const registry = createRegistry();let workspace: Awaited<ReturnType<typeof openDurableWorkspace>>;
    registry.install(defineExtension({ name: "grep-fixture", tools: [createGrepHistoryTool("fixture", () => workspace.harness)] }));
    workspace = await openDurableWorkspace(await workspaceDurableJournalDirectory("fixture"), "fixture", { models, registry });cleanup.push(() => workspace.close());
    const root = await workspace.agent({ agentId: "first", title: "First", label: "Agent 1" }, { model: { provider: "faux", modelId: "faux-1" } });
    await workspace.harness.commit(tx => tx.appendEntry(UserEntry, root.id, { model: [{ role: "user", content: "pastdecision garnet", timestamp: 1 }] }), context);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("grep_history", { pattern: "pastdecision" })], { stopReason: "toolUse" }), fauxAssistantMessage("Found")]);
    await (await root.submit({ type: "input", content: "Find the decision", requestId: "grep" }, context)).wait(context);
    const messages = (await root.entries({}, 100, undefined, context)).items.flatMap(item => item.model ?? []);
    const result = messages.find(message => message.role === "toolResult" && message.toolName === "grep_history");
    expect(result?.role === "toolResult" && result.isError).toBe(false);expect(JSON.stringify(result)).toContain("pastdecision garnet");expect(faux.state.callCount).toBe(2);
  } finally {if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR = previous;}
});

test("mandatory literal prefixes accelerate anchored/wildcard regex without narrowing alternatives or optional groups", async () => {
  const f = await fixture();await f.user("alpha middle beta\nbeta only\nALPHA middle beta\nz");
  for (const pattern of ["^alpha", "alpha.*beta", "^alpha.+beta$", "^alpha$"]) {
    const result = await f.grep({ pattern });
    if (pattern === "^alpha$") expect(result.results).toHaveLength(0);
    else expect(result.results).toHaveLength(1);
  }
  expect(grepTrigramQuery({ pattern: "alpha.*beta" })).toBe('"alpha"');
  for (const pattern of ["alpha.*beta|z", "(alpha)?beta", "(?i)alpha.*beta"]) expect(grepTrigramQuery({ pattern })).toBeUndefined();
  expect((await f.grep({ pattern: "alpha.*beta|z" })).results).toHaveLength(2);
});

test("large Agent catalogs do not hit SQLite expression-depth or bound-parameter limits", async () => {
  const f = await fixture();await f.user("catalog-boundary garnet");
  await f.workspace.harness.commit(async tx => {
    const catalog = await tx.doc(WorkspaceAgents);
    for (let index = 0; index < 1000; index++) {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      catalog.agents.push({ agentId: `empty-${index}`, durableId: conversation.id, title: "Empty", label: "Empty" });
    }
  }, context);
  expect((await f.grep({ pattern: "catalog-boundary garnet", fixed: true })).results).toHaveLength(1);
}, 20_000);

test("out-of-range line cursors make progress, and changed query filters cannot reuse a cursor",async()=>{
  const f=await fixture();await f.user("needle\nneedle");await f.user("needle later");
  const page=await f.grep({pattern:"needle",limit:1});
  expect(page.nextCursor).not.toBeNull();
  const next=await f.grep({pattern:"needle",cursor:{...page.nextCursor!,line:999999}});
  expect(next.results.some(row=>row.lines.includes("needle later"))).toBe(true);
  await expect(f.grep({pattern:"later",cursor:page.nextCursor!})).rejects.toThrow("filters changed");
});

test("trigram literal filtering agrees with unfiltered RE2 for punctuation and whitespace",async()=>{
  const f=await fixture();await f.user('   \n"""\na b\na-b\na_b\n???\n[x]\na"b\n] a\nnone');
  const {RE2JS}=await import("re2js");
  for(const pattern of ['   ','"""','a b','a-b','a_b','???','[x]','a"b','] a']){
    const indexed=await f.grep({pattern,fixed:true}),raw=await f.grep({pattern:`(?:${RE2JS.quote(pattern)})`});
    expect(indexed.results.map(row=>[row.entryId,row.line,row.lines])).toEqual(raw.results.map(row=>[row.entryId,row.line,row.lines]));
  }
});
