import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, contentText } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { agentPlanStore } from "@kintsugi/agent/server/plan";
import { createNativePlanExtension, durablePlanContextEntry } from "../../src/server/durable-plan.ts";
import { openDurableWorkspace, WorkspaceAgents, type DurableWorkspace } from "../../src/server/durable-workspace.ts";
const context = BACKGROUND_CONTEXT;
const original = process.env.ATELIER_DATA_DIR;
let directory: string, workspace: DurableWorkspace;
afterEach(async () => { await workspace?.close(); if (original === undefined) delete process.env.ATELIER_DATA_DIR; else process.env.ATELIER_DATA_DIR = original; if (directory) await rm(directory, { recursive: true, force: true }); });
async function setup(retry = false) {
  directory = await mkdtemp(join(tmpdir(), "durable-plan-")); process.env.ATELIER_DATA_DIR = directory;
  const models = createModels(), faux = fauxProvider({ tokensPerSecond: 100_000 }); models.setProvider(faux.provider);
  const registry = createRegistry(); registry.install(createNativePlanExtension("w", () => workspace.harness));
  const seen: string[][] = [];
  registry.install(defineExtension({ name: "observe-plan-context", hooks: [hook(GenerationTask, { beforeRequest(request) { seen.push(request.messages.map(message => contentText(message.content))); } })] }));
  workspace = await openDurableWorkspace(join(directory, "journal"), "w", { models, registry, settings: { retry: { enabled: retry, baseDelayMs: 1, maxRetries: 1 } } });
  const a = await workspace.agent({ agentId: "a", title: "A", label: "Agent 1" }, { model: { provider: "faux", modelId: "faux-1" } });
  const b = await workspace.agent({ agentId: "b", title: "B", label: "Agent 2" }, { model: { provider: "faux", modelId: "faux-1" } });
  return { faux, seen, a, b, async reopen() {
    await workspace.close();
    workspace = await openDurableWorkspace(join(directory, "journal"), "w", { models, registry });
    return workspace.agent({ agentId: "a", title: "A", label: "Agent 1" });
  } };
}
test("native tools and append-only plan context bind to the calling Agent; ordinary edits do not start work", async () => {
  const { faux, seen, a } = await setup();
  agentPlanStore().change("w", "a", { action: "write", markdown: "- [-] Inspect\n- [ ] Verify" });
  agentPlanStore().change("w", "b", { action: "write", markdown: "- [ ] Foreign private plan" });
  expect(faux.state.callCount).toBe(0);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("plan", { action: "patch", patches: [{ operation: "update", match: "Inspect", status: "completed" }, { operation: "update", match: "Verify", status: "in_progress" }] })], { stopReason: "toolUse" }), fauxAssistantMessage("Progress recorded")]);
  await (await a.submit({ type: "input", content: "Continue the approved work", requestId: "one" }, context)).wait(context);
  expect(agentPlanStore().read("w", "a").markdown).toBe("- [x] Inspect\n- [-] Verify");
  expect(agentPlanStore().read("w", "b").markdown).toBe("- [ ] Foreign private plan");
  expect(seen[0]?.at(-1)).toContain("- [-] Inspect");
  expect(seen[1]?.at(-1)).toContain("- [x] Inspect");
  expect(seen.flat().join("\n")).not.toContain("Foreign private plan");
  const entries = (await a.entries({}, 100, undefined, context)).items;
  const messages = entries.filter(entry => !durablePlanContextEntry.is(entry)).flatMap(entry => entry.model ?? []);
  expect(messages.filter(message => message.role === "user").map(message => contentText(message.content))).toEqual(["Continue the approved work"]);
  expect(entries.filter(durablePlanContextEntry.is).map(entry => entry.data.revision).sort()).toEqual([1, 2]);
  expect(seen[1]!.slice(0, seen[0]!.length)).toEqual(seen[0]!);
  expect(messages.find(message => message.role === "toolResult")).toMatchObject({ toolName: "plan", isError: false });
});
test("new sessions and rewinds retain the Agent's plan; children have independent plans", async () => {
  const { a, faux } = await setup();
  agentPlanStore().change("w", "a", { action: "write", markdown: "- [-] Root objective" });
  faux.setResponses([fauxAssistantMessage("First answer")]);
  await (await a.submit({ type: "input", content: "First", requestId: "first" }, context)).wait(context);
  const boundary = (await a.entries({}, 100, undefined, context)).items.at(-1)!;
  const fork = await a.fork(boundary.id, { ownership: { kind: "ownerless" } }, context);
  await workspace.harness.commit(async tx => { (await tx.doc(WorkspaceAgents)).agents[0]!.branches = [a.id, fork.id]; }, context);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("plan", { action: "patch", patches: [{ operation: "add", step: "Fork continuation" }] })], { stopReason: "toolUse" }), fauxAssistantMessage("Fork recorded")]);
  await (await fork.submit({ type: "input", content: "Continue here", requestId: "fork" }, context)).wait(context);
  expect(agentPlanStore().read("w", "a").markdown).toContain("Fork continuation");
  await a.reset(undefined, context);
  expect(agentPlanStore().read("w", "a").markdown).toContain("Root objective");
  const child = await workspace.agent({ agentId: "child", parentId: "a", rootId: "a", taskName: "Review", title: "Child", label: "Child" }, { model: { provider: "faux", modelId: "faux-1" } });
  faux.setResponses([fauxAssistantMessage([fauxToolCall("plan", { action: "write", markdown: "- [ ] Child review" })], { stopReason: "toolUse" }), fauxAssistantMessage("Child plan recorded")]);
  await (await child.submit({ type: "input", content: "Review", requestId: "child" }, context)).wait(context);
  expect(agentPlanStore().read("w", "child").markdown).toBe("- [ ] Child review");
  expect(agentPlanStore().read("w", "a").markdown).not.toContain("Child review");
});
test("model arguments cannot choose another Agent's plan and invalid mutations have no effect", async () => {
  const { faux, a } = await setup();
  faux.setResponses([fauxAssistantMessage([fauxToolCall("plan", { action: "write", markdown: "overwrite", agentId: "b" })], { stopReason: "toolUse" }), fauxAssistantMessage("Denied")]);
  await (await a.submit({ type: "input", content: "Attempt invalid target", requestId: "invalid" }, context)).wait(context);
  expect(agentPlanStore().read("w", "a").revision).toBe(0); expect(agentPlanStore().read("w", "b").revision).toBe(0);
  const result = (await a.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []).find(message => message.role === "toolResult");
  expect(result).toMatchObject({ isError: true });
});

test("unchanged plans stay canonical across reopen; edits and clearing append snapshots", async () => {
  const { a, faux, seen, reopen } = await setup();
  agentPlanStore().change("w", "a", { action: "write", markdown: "- [ ] Original" });
  faux.setResponses([fauxAssistantMessage("One"), fauxAssistantMessage("Two"), fauxAssistantMessage("Three"), fauxAssistantMessage("Four")]);
  await (await a.submit({ type: "input", content: "First", requestId: "first" }, context)).wait(context);
  const restored = await reopen();
  await (await restored.submit({ type: "input", content: "Second", requestId: "second" }, context)).wait(context);
  expect(seen[1]!.slice(0, seen[0]!.length)).toEqual(seen[0]!);
  expect((await restored.entries({}, 100, undefined, context)).items.filter(durablePlanContextEntry.is)).toHaveLength(1);
  agentPlanStore().change("w", "a", { action: "write", markdown: "- [ ] Changed by user" });
  await (await restored.submit({ type: "input", content: "Third", requestId: "third" }, context)).wait(context);
  expect(seen[2]!.slice(0, seen[1]!.length)).toEqual(seen[1]!);
  agentPlanStore().change("w", "a", { action: "write", markdown: "" });
  await (await restored.submit({ type: "input", content: "Fourth", requestId: "fourth" }, context)).wait(context);
  expect(seen[3]!.at(-1)).toContain("The editable plan is empty.");
  expect((await restored.entries({}, 100, undefined, context)).items.filter(durablePlanContextEntry.is)).toHaveLength(3);
});

test("snapshots are hidden context, not user turn boundaries; reset reintroduces the current snapshot", async () => {
  const { projectDurableTranscript } = await import("../../src/server/durable-transcript.ts");
  const { a, faux, seen } = await setup();
  agentPlanStore().change("w", "a", { action: "write", markdown: "- [ ] Current" });
  faux.setResponses([fauxAssistantMessage("Answer"), fauxAssistantMessage("After reset")]);
  await (await a.submit({ type: "input", content: "Visible input", requestId: "first" }, context)).wait(context);
  const watch = await a.watch(context);
  try {
    const items = projectDurableTranscript(watch.value);
    expect(JSON.stringify(items)).not.toContain("Current editable plan for this Agent");
    expect(JSON.stringify(items)).toContain("Visible input");
  } finally { await watch.stop(); }
  await a.reset(undefined, context);
  await (await a.submit({ type: "input", content: "New session", requestId: "new-session" }, context)).wait(context);
  expect(seen[1]!.at(-1)).toContain("- [ ] Current");
  expect(seen[1]!.join("\n")).not.toContain("Visible input");
});

test("a retry keeps its pinned plan and does not append a duplicate; the next request sees edits", async () => {
  const { a, faux, seen } = await setup(true);
  agentPlanStore().change("w", "a", { action: "write", markdown: "- [ ] Pinned" });
  faux.setResponses([() => {
    agentPlanStore().change("w", "a", { action: "write", markdown: "- [ ] Edited during retry" });
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" });
  }, fauxAssistantMessage("Retried"), fauxAssistantMessage("Next")]);
  await (await a.submit({ type: "input", content: "First", requestId: "first" }, context)).wait(context);
  expect(seen).toHaveLength(2);
  expect(seen[1]).toEqual(seen[0]);
  expect(seen[1]!.at(-1)).toContain("Pinned");
  expect((await a.entries({}, 100, undefined, context)).items.filter(durablePlanContextEntry.is)).toHaveLength(1);
  await (await a.submit({ type: "input", content: "Next", requestId: "next" }, context)).wait(context);
  expect(seen[2]!.at(-1)).toContain("Edited during retry");
  expect((await a.entries({}, 100, undefined, context)).items.filter(durablePlanContextEntry.is)).toHaveLength(2);
});
