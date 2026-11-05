import { createKintsugiEventBus, type JsonObject } from "@kintsugi/core";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentPlanStore, AgentPlanConflict, agentPlanStore, createAgentPlanTool, registerPlanAgentResolver } from "../../src/server/plan.ts";
import { defaultAgentPlan, normalizeAgentPlan, parseAgentPlan, structuredAgentPlan, patchAgentPlan, editAgentPlan } from "../../src/server/plan-model.ts";
import { handlePlanRequest, planChannel } from "../../src/server/plan-web.ts";
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "agent-plan-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
test("plans are persisted per Agent and workspace; defaults are passive and empty plans remain empty", async () => {
  const store = createAgentPlanStore(directory);
  expect(store.read("workspace", "a")).toMatchObject({ markdown: defaultAgentPlan, revision: 0, updatedAt: null });
  expect(await Bun.file(join(directory, "workspaces/workspace/metadata/agent-plans.json")).exists()).toBe(false);
  const a = store.change("workspace", "a", { action: "write", markdown: "- [-] Work on A" });
  store.change("workspace", "b", { action: "write", markdown: "- [x] Work on B" });
  store.change("other", "a", { action: "write", markdown: "- [ ] Different workspace" });
  expect(createAgentPlanStore(directory).read("workspace", "a")).toEqual(a);
  expect(store.read("workspace", "b").markdown).toContain("Work on B");
  expect(store.read("other", "a").markdown).toContain("Different workspace");
  store.change("workspace", "a", { action: "write", markdown: "", expectedRevision: a.revision });
  expect(createAgentPlanStore(directory).read("workspace", "a").markdown).toBe("");
  store.delete("workspace"); expect(store.read("workspace", "a").revision).toBe(0);
});
test("all mutation paths share canonical statuses and reject two in-progress items atomically", async () => {
  const store = createAgentPlanStore(directory), input = { action: "write" as const, markdown: "> Reason\r\n\r\n* [X] Inspect\r\n1. [-] Implement\r\n- [ ] Test" };
  const first = store.change("w", "a", input);
  expect(first.plan).toEqual([{ step: "Inspect", status: "completed" }, { step: "Implement", status: "in_progress" }, { step: "Test", status: "pending" }]);
  expect(first.markdown).not.toContain("\r"); expect(first.explanation).toBe("Reason");
  const before = await readFile(join(directory, "workspaces/w/metadata/agent-plans.json"), "utf8");
  for (const mutation of [
    { action: "write" as const, markdown: "- [-] One\n- [-] Two" },
    { action: "update" as const, plan: [{ step: "One", status: "in_progress" as const }, { step: "Two", status: "in_progress" as const }] },
    { action: "patch" as const, patches: [{ operation: "update" as const, match: "Test", status: "in_progress" as const }] },
    { action: "edit" as const, edits: [{ oldText: "- [ ] Test", newText: "- [-] Test" }] },
  ]) { expect(() => store.change("w", "a", mutation)).toThrow("at most one"); expect(await readFile(join(directory, "workspaces/w/metadata/agent-plans.json"), "utf8")).toBe(before); }
});
test("patch operations are sequential, 1-based and unambiguous; structured updates preserve explanation", () => {
  const markdown = "> Current objective\n\n- [ ] Inspect\n- [-] Implement\n- [ ] Verify";
  const changed = patchAgentPlan(markdown, [{ operation: "update", index: 2, status: "completed" }, { operation: "update", match: "Verify", status: "in_progress" }, { operation: "add", before: "Verify", step: "Review diff" }, { operation: "remove", match: "Inspect" }]);
  expect(changed).toBe("> Current objective\n\n- [x] Implement\n- [ ] Review diff\n- [-] Verify");
  expect(() => patchAgentPlan("- [ ] Inspect A\n- [ ] Inspect B", [{ operation: "remove", match: "Inspect" }])).toThrow("exactly one");
  expect(() => patchAgentPlan(markdown, [{ operation: "remove", index: 99 }])).toThrow("out of range");
  expect(structuredAgentPlan([{ step: "  Normalise\n   spaces ", status: "pending" }], "One\nTwo")).toBe("> One\n> Two\n\n- [ ] Normalise spaces");
});
test("raw edits use original exact anchors, support inserts and reject overlap or ambiguity", () => {
  const original = "# Notes\n- [ ] Inspect\n- [ ] Test\nObsolete";
  const next = editAgentPlan(original, [{ oldText: "- [ ] Inspect", newText: "- [x] Inspect" }, { operation: "insert_after", anchorText: "- [ ] Test", text: "\n- [ ] Report" }, { operation: "delete", oldText: "\nObsolete" }, { operation: "prepend", text: "> Objective\n" }, { operation: "append", text: "\nFooter" }]);
  expect(next).toBe("> Objective\n# Notes\n- [x] Inspect\n- [ ] Test\n- [ ] Report\nFooter");
  expect(() => editAgentPlan("repeat repeat", [{ oldText: "repeat", newText: "new" }])).toThrow("exactly once");
  expect(() => editAgentPlan(original, [{ oldText: "Inspect", newText: "Done" }, { oldText: "[ ] Inspect", newText: "[x] Done" }])).toThrow("overlap");
});
test("revision checks prevent stale replacement, errors do not publish, reset uses the same store", () => {
  const store = createAgentPlanStore(directory), notices: string[] = [];
  const stop = store.subscribe((workspace, agent) => notices.push(`${workspace}:${agent}`));
  const first = store.change("w", "a", { action: "update", plan: [{ step: "First", status: "pending" }] });
  store.change("w", "a", { action: "patch", patches: [{ operation: "add", step: "Second" }] });
  expect(() => store.change("w", "a", { action: "write", markdown: "old", expectedRevision: first.revision })).toThrow(AgentPlanConflict);
  expect(notices).toEqual(["w:a", "w:a"]); stop();
  expect(store.change("w", "a", { action: "reset" }).markdown).toBe(defaultAgentPlan);
});
test("identifiers, payload limits and foreign target selectors are rejected", () => {
  const store = createAgentPlanStore(directory);
  for (const id of ["../other", "..", "/root", "a/b", ""]) expect(() => store.read(id, "a")).toThrow();
  expect(() => normalizeAgentPlan("x".repeat(65537))).toThrow();
  expect(() => normalizeAgentPlan(Array.from({ length: 501 }, () => "- [ ] Item").join("\n"))).toThrow();
  // External JSON is validated by the mutation boundary, including unknown target fields.
  expect(() => store.change("w", "a", JSON.parse('{"action":"read","agentId":"foreign"}'))).toThrow();
});
test("HTTP JSON reads/mutations are per-agent, revisioned and cannot start execution", async () => {
  const previous = process.env.ATELIER_DATA_DIR; process.env.ATELIER_DATA_DIR = directory;
  try {
    await mkdir(join(directory, "workspaces/w/metadata"), { recursive: true });
    await mkdir(join(directory, "workspaces/other/metadata"), { recursive: true });
    registerPlanAgentResolver("fixture", async (workspace, id) => workspace === "w" && ["a", "b", "readonly"].includes(id) ? { id, title: id, readOnly: id === "readonly" } : undefined);
    async function call(id: string, body?: JsonObject, workspace = "w") {
      const request = new Request(`http://fixture/workspaces/${workspace}/agent-plans/${id}`, { method: body ? "POST" : "GET", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return (await handlePlanRequest(request, new URL(request.url), { openWorkView: async () => new Response(), renderModalPage: async () => new Response() }))!;
    }
    expect((await (await call("a")).json()).plan.revision).toBe(0);
    const saved = await call("a", { action: "write", markdown: "- [-] Work", expectedRevision: 0 });
    expect(saved.status).toBe(200); expect(saved.headers.get("x-kintsugi-plan-revision")).toBe("1");
    expect((await (await call("b")).json()).plan.revision).toBe(0);
    expect((await call("a", { action: "reset", expectedRevision: 0 })).status).toBe(409);
    expect((await call("a", { action: "write", markdown: "bad", agentId: "b" })).status).toBe(400);
    expect((await call("a", { action: "submit" })).status).toBe(400);
    expect((await call("a", undefined, "other")).status).toBe(404);
    expect((await call("readonly", { action: "reset" })).status).toBe(403);
    expect((await call("missing")).status).toBe(404);
    expect((await call("a", undefined, "missing")).status).toBe(404);
    expect(agentPlanStore().read("w", "a").markdown).toBe("- [-] Work");
    // The authenticated CLI tool's closure supplies its Agent identity, never model arguments.
    await createAgentPlanTool("w", "b").execute("call", { action: "write", markdown: "- [x] CLI plan" });
    expect(agentPlanStore().read("w", "a").markdown).toBe("- [-] Work");
    expect(agentPlanStore().read("w", "b").markdown).toBe("- [x] CLI plan");
    await expect(planChannel.subscribe({ channel: "module", name: "agent-plan", workspaceId: "other", params: { agentId: "a" } }, () => {}, createKintsugiEventBus())).rejects.toThrow("not found");
  } finally { if (previous === undefined) delete process.env.ATELIER_DATA_DIR; else process.env.ATELIER_DATA_DIR = previous; }
});

test("plan tools acknowledge mutations without echoing the checklist; read returns Markdown", async () => {
  const { planToolOutput } = await import("../../src/server/plan.ts");
  const directory = await mkdtemp(join(tmpdir(), "plan-tool-text-"));
  try {
    const store = createAgentPlanStore(directory);
    const input = { action: "write" as const, markdown: "- [-] Active step\n- [ ] Private future step" };
    const plan = store.change("w", "a", input);
    const result = planToolOutput(input, plan);
    expect(result).toBe("Plan updated (revision 1; 0/2 complete). Current: Active step");
    expect(result).not.toContain("Private future step");
    expect(result).not.toContain('"markdown"');
    expect(planToolOutput({ action: "read" }, plan)).toBe(`Plan (revision 1)\n\n${input.markdown}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
