import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { createNativeAgentIdentityResolver } from "../../src/server/durable-agent-identity.ts";
import { createDurableFileTools, createDurableWorkspaceTools, durableWorkspaceTool } from "../../src/server/durable-tools.ts";
import { openDurableWorkspace, type DurableWorkspace } from "../../src/server/durable-workspace.ts";
import { defineWorkspaceTool, type WorkspaceTool } from "@kintsugi/agent/server/workspace-tool";
import { registerWorkspacePresenter } from "@kintsugi/agent/server/tools";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const workspaces: DurableWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "kintsugi-durable-tools-"));
  directories.push(path);
  return path;
}

async function runTool(tool: ToolRegistration<any> | WorkspaceTool<any, any>, args: Record<string, JsonValue>, verifyIdentity = false) {
  const path = await directory();
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(tool.name, args)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  const registry = createRegistry();
  // SAFETY: Identity probes are workspace tools; native tools use the other branch.
  registry.install(defineExtension({ name: "workspace-tools", tools: [verifyIdentity ? durableWorkspaceTool(tool as any, "unsafe", id => createNativeAgentIdentityResolver("test-workspace", () => workspace.harness)(id)) : tool as ToolRegistration<any>] }));
  const workspace = await openDurableWorkspace(path, "test-workspace", { models, registry });
  workspaces.push(workspace);
  const conversation = await workspace.agent({ agentId: "tab", label: "Agent 1", title: "Tools" }, {
    model: { provider: "faux", modelId: "faux-1" },
  });
  const submission = await conversation.submit({ type: "input", content: "Use the tool", requestId: "request" }, context);
  expect((await submission.wait(context)).status).toBe("done");
  const entries = (await conversation.entries({}, 100, undefined, context)).items;
  const messages = entries.flatMap((entry) => entry.model ?? []);
  const result = messages.find((message) => message.role === "toolResult");
  expect(result?.role).toBe("toolResult");
  await workspace.close();
  const reopened = await openDurableWorkspace(path, "test-workspace", { models, registry });
  workspaces.push(reopened);
  const restored = await reopened.agent({ agentId: "tab", label: "Agent 1", title: "Tools" });
  expect((await restored.entries({}, 100, undefined, context)).items).toEqual(entries);
  await reopened.close();
  return { result: result!, journal: await readFile(join(path, "main.jsonl"), "utf8") };
}

test("assembly opts only the observational read into replay and excludes legacy bash", () => {
  const unregister = registerWorkspacePresenter("test-browser", () => ({
    kind: "test-browser", description: "Browser", parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "Presented" }], details: {} }),
  }));
  try {
    const tools = createDurableWorkspaceTools("workspace");
    expect(tools.map((tool) => [tool.name, tool.replay])).toEqual([
      ["read", "safe"], ["write", "unsafe"], ["edit", "unsafe"], ["present", "unsafe"],
    ]);
    expect(tools.find((tool) => tool.name === "present")!.description).toContain("artifact-preview:");
  } finally {
    unregister();
  }
  // A registered tool named read does not inherit the built-in's replay policy.
  expect(durableWorkspaceTool(defineWorkspaceTool({
    name: "read", label: "Read", description: "Not necessarily observational", parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  })).replay).toBe("unsafe");
});

test("images survive the native Harness tool result and fsynced journal", async () => {
  const cwd = await directory();
  const path = join(cwd, "pixel.png");
  // A 16×16 red PNG, within every limit, so it is sent as it is.
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
  await writeFile(path, Buffer.from(base64, "base64"));
  const [read] = createDurableFileTools(new NodeExecutionEnv({ cwd }));
  const { result, journal } = await runTool(read!, { path });
  expect(result.isError).toBe(false);
  expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: base64 });
  expect(journal).toContain(base64);
});

test("invalid tool input and execution failures become durable errors, not effects or lost tasks", async () => {
  let executed = false;
  const tool = defineWorkspaceTool({
    name: "effect", label: "Effect", description: "Test", parameters: Type.Object({ value: Type.String() }),
    async execute() { executed = true; throw new Error("workspace unavailable"); },
  });
  const invalid = await runTool(durableWorkspaceTool(tool), {});
  expect(invalid.result.isError).toBe(true);
  expect(executed).toBe(false);
  const failed = await runTool(durableWorkspaceTool(tool), { value: "valid" });
  expect(executed).toBe(true);
  expect(failed.result.isError).toBe(true);
  expect(failed.journal).toContain("workspace unavailable");
});

test("SDK snapshot updates and final details are committed without repeating output", async () => {
  const { result, journal } = await runTool(durableWorkspaceTool(defineWorkspaceTool({
    name: "progress", label: "Progress", description: "Test", parameters: Type.Object({}),
    async execute(callId, _args, signal, update) {
      expect(callId.length).toBeGreaterThan(0);
      expect(signal?.aborted).toBe(false);
      update?.({ content: [{ type: "text", text: "working" }], details: { step: 1 } });
      update?.({ content: [{ type: "text", text: "working more" }], details: { step: 2 } });
      return { content: [{ type: "text", text: "finished" }], details: { step: 3 } };
    },
  })), {});
  expect(result.content).toEqual([{ type: "text", text: "finished" }]);
  expect(journal).toContain('"step":3');
});

test("scoped workspace tools receive committed native identity, never model-supplied identity", async () => {
  const tool = defineWorkspaceTool({ name: "identity_probe", label: "Probe", description: "Verified identity", requiresAgentIdentity: true,
    parameters: Type.Object({ agentId: Type.Optional(Type.String()) }),
    async execute(_id, input, _signal, _update, identity) { return { content: [{ type: "text" as const, text: JSON.stringify({ verified: identity?.agentId, supplied: input.agentId }) }], details: {} }; },
  });
  const verified = await runTool(tool, { agentId: "foreign-agent" }, true);
  expect(verified.result).toMatchObject({ isError: false, content: [{ type: "text", text: JSON.stringify({ verified: "tab", supplied: "foreign-agent" }) }] });
  const unavailable = await runTool(durableWorkspaceTool(tool), { agentId: "foreign-agent" });
  expect(unavailable.result.isError).toBe(true);
  expect(JSON.stringify(unavailable.result)).toContain("Verified Agent identity is unavailable");
});
