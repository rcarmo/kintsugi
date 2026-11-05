import { Type } from "typebox";
import { retainedDurableWorkspaceOwner, suspendAllDurableWorkspaceOwners } from "../../src/server/runtime.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKintsugiEventBus } from "@kintsugi/core";
import { agentAttachmentDraftId, findStagedAttachment, stageAttachment } from "@kintsugi/prompt/server";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { type DurableAgentRuntime } from "../../src/server/durable-runtime.ts";
import { ensureDefaultWorkspaceAgent } from "../../src/server/agent-store.ts";
import { handleAgentRequest } from "../../src/server/routes.ts";

let directory: string;
let owner: DurableAgentRuntime | undefined;
const originalDataDir = process.env.KINTSUGI_DATA_DIR;
afterEach(async () => {
  await suspendAllDurableWorkspaceOwners();
  owner = undefined;
  if (originalDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = originalDataDir;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("lost HTTP response retries admitted input after attachment staging is consumed, without preparation or another generation", async () => {
  directory = await mkdtemp(join(tmpdir(), "durable-http-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  const agent = await ensureDefaultWorkspaceAgent("http-workspace");
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "test", input: ["text", "image"] }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Received the image")]);
  owner = await retainedDurableWorkspaceOwner(agent.path, agent.workspaceId, {}, {
    harness: async () => ({ models, registry: createRegistry() }),
    prepare: async () => ({ model: { provider: "faux", modelId: "test" } }),
    expand: async (_workspace, text) => text,
    validateModel: async (_ref: { provider: string; modelId: string } | undefined) => {},
    ready: async () => {},
  });
  const controller = await owner.agent(agent);
  const draft = agentAttachmentDraftId(agent.workspaceId, agent.agentId);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=", "base64");
  const attachment = await stageAttachment(draft, new File([image], "image.png", { type: "image/png" }));
  let admissions = 0;
  let accepted: Awaited<ReturnType<typeof controller.submit>>;
  const events = createKintsugiEventBus();
  // The route boundary uses an actual native execution controller. No HTML or UI assertions.
  const countedController = {
    ...controller,
    async submit(input: Parameters<typeof controller.submit>[0]) {
      admissions++;
      accepted = await controller.submit(input);
      return accepted;
    },
  };
  const request = () => new Request(`http://kintsugi.test/workspaces/${agent.workspaceId}/agents/${agent.agentId}/messages`, {
    method: "POST", body: new URLSearchParams({ text: "Look at the image", requestId: "lost-response", attachmentDraft: draft, attachment: attachment.id }),
  });
  const first = request();
  const response = await handleAgentRequest(first, new URL(first.url), {
    events, knownRequest: (_agent, id) => controller.knownRequest(id),
    getController: async () => countedController,
    suggestTitleFromPrompt: () => {},
  });
  expect(response?.headers.get("x-kintsugi-attachment-draft-consumed")).toBe("true");
  expect(await findStagedAttachment(draft, attachment.id)).toBeUndefined();
  expect((await accepted!.wait(BACKGROUND_CONTEXT)).status).toBe("done");
  await suspendAllDurableWorkspaceOwners();
  // Reopen the same journal; retry must remain passive, even when execution is unavailable.
  owner = await retainedDurableWorkspaceOwner(agent.path, agent.workspaceId, {}, {
    harness: async () => ({ models, registry: createRegistry() }),
    prepare: async () => { throw new Error("Must not prepare prompts on retry"); },
    expand: async () => { throw new Error("Must not expand on retry"); },
    validateModel: async (_ref: { provider: string; modelId: string } | undefined) => {},
    ready: async () => { throw new Error("Workspace is offline"); },
  });
  const reopened = await owner.agent(agent);
  const retry = request();
  const retried = await handleAgentRequest(retry, new URL(retry.url), {
    events, knownRequest: (_agent, id) => reopened.knownRequest(id),
    getController: async () => { throw new Error("Must not acquire execution on retry"); },
  });
  expect(retried?.status).toBe(200);
  expect(retried?.headers.get("x-kintsugi-attachment-draft-consumed")).toBe("true");
  expect(admissions).toBe(1);
  expect(faux.state.callCount).toBe(1);
});


test("offline HTTP Stop bypasses model/UI preparation and commits intent before cleanup failure", async () => {
  directory = await mkdtemp(join(tmpdir(), "durable-http-stop-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  const agent = await ensureDefaultWorkspaceAgent(`stop-${crypto.randomUUID()}`);
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  const started = Promise.withResolvers<void>();
  const registry = createRegistry();
  registry.install(defineExtension({ name: "hold", tools: [defineTool({
    name: "hold", description: "Wait", parameters: Type.Object({}), replay: "safe",
    async execute(_args, _api, context) {
      started.resolve();
      return new Promise<never>((_resolve, reject) => context.abortSignal!.addEventListener("abort", () => reject(context.abortSignal!.reason), { once: true }));
    },
  })] }));
  faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "hold", name: "hold", arguments: {} }], { stopReason: "toolUse" })]);
  owner = await retainedDurableWorkspaceOwner(agent.path, agent.workspaceId, {}, {
    harness: async () => ({ models, registry }), prepare: async () => ({ model: { provider: "faux", modelId: "faux-1" } }),
    expand: async (_workspace, text) => text, validateModel: async (_ref: { provider: string; modelId: string } | undefined) => {},
    ready: async () => {},
  });
  const controller = await owner.agent(agent);
  await controller.submit({ requestId: "initial", text: "Start" });
  await started.promise;
  await controller.submit({ requestId: "queued", text: "Steering" });
  await suspendAllDurableWorkspaceOwners();
  owner = await retainedDurableWorkspaceOwner(agent.path, agent.workspaceId, {}, {
    harness: async () => ({ models: createModels(), registry }),
    prepare: async () => { throw new Error("No model providers"); },
    expand: async () => { throw new Error("No workspace"); }, validateModel: async (_ref: { provider: string; modelId: string } | undefined) => {},
    ready: async () => { throw new Error("Offline"); },
  });
  const request = new Request(`http://kintsugi.test/workspaces/${agent.workspaceId}/agents/${agent.agentId}/abort`, { method: "POST" });
  await expect(handleAgentRequest(request, new URL(request.url), {
    getPresentation: async () => { throw new Error("Must not mount UI for Stop"); },
  })).rejects.toThrow("Stop saved");
  const restored = await owner.agent(agent);
  const queued = await restored.submit({ requestId: "queued", text: "Retry" });
  expect((await queued.status(BACKGROUND_CONTEXT)).status).toBe("unanswered");
  const { WorkspaceStops } = await import("../../src/server/durable-lifecycle.ts");
  await suspendAllDurableWorkspaceOwners();
  const { openDurableWorkspace } = await import("../../src/server/durable-workspace.ts");
  const workspace = await openDurableWorkspace(agent.path, agent.workspaceId, { models, registry });
  try {
    expect(Object.values((await workspace.harness.snapshot(WorkspaceStops, BACKGROUND_CONTEXT))!.tasks).flat().length).toBeGreaterThan(0);
    expect((await workspace.harness.inspect(BACKGROUND_CONTEXT)).tasks.every(task => task.record.abortRequested)).toBe(true);
  } finally { await workspace.close(); }
  expect(faux.state.callCount).toBe(1);
});

test("thinking level HTTP configuration uses canonical fields and validates native model support", async () => {
  directory = await mkdtemp(join(tmpdir(), "durable-thinking-level-http-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  const agent = await ensureDefaultWorkspaceAgent("thinking-level-workspace");
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "test" }] });
  models.setProvider(faux.provider);
  const model = { provider: "faux", modelId: "test" };
  owner = await retainedDurableWorkspaceOwner(agent.path, agent.workspaceId, {}, {
    harness: async () => ({ models, registry: createRegistry() }),
    prepare: async () => ({ model }),
    expand: async (_workspace, text) => text,
    validateModel: async () => {},
    ready: async () => {},
  });
  const controller = await owner.agent(agent, { model });
  const configure = (thinkingLevel?: string) => {
    const request = new Request(`http://kintsugi.test/workspaces/${agent.workspaceId}/agents/${agent.agentId}/thinking-level`, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ thinkingLevel }),
    });
    return handleAgentRequest(request, new URL(request.url), { getController: async () => controller });
  };
  const response = await configure("off");
  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({ agent: { agentId: agent.agentId, thinkingLevel: "off" } });
  expect((await controller.settings()).thinkingLevel).toBe("off");
  await expect(configure()).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(configure("unsupported")).rejects.toMatchObject({ code: "invalid_arguments" });
  expect((await controller.settings()).thinkingLevel).toBe("off");
});
