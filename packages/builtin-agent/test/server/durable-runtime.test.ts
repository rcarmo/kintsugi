import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type AgentChange } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { KintsugiCoreError, createKintsugiEventBus } from "@kintsugi/core";
import type { WorkspaceAgentToolOptions } from "@kintsugi/agent/server/tools";
import { subscribeWorkspaceAgentBusy } from "@kintsugi/agent/server";
import { currentNotificationTurn } from "../../src/server/turn-notifications.ts";
import { openDurableAgentRuntime, type DurableAgentRuntime } from "../../src/server/durable-runtime.ts";
import { durableEntryContent } from "../../src/server/durable-images.ts";
import { projectDurableTranscript } from "../../src/server/durable-transcript.ts";

const context = BACKGROUND_CONTEXT;
const paths: string[] = [];
const runtimes: DurableAgentRuntime[] = [];
const record = { agentId: "tab", label: "Agent 1", title: "Native runtime" };
const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.suspend()));
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(options: WorkspaceAgentToolOptions = {}) {
  const path = await mkdtemp(join(tmpdir(), "kintsugi-durable-runtime-"));
  paths.push(path);
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000, models: [
    { id: "small", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 4, maxHeight: 4 } } } },
    { id: "large", input: ["text", "image"] },
  ] });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const load = {
    harness: async () => ({ models, registry }),
    prepare: async (): Promise<AgentChange> => ({ model: { provider: "faux", modelId: "small" }, instructions: "Committed instructions", thinkingLevel: "off" }),
    expand: async (_workspace: string, text: string) => text,
    validateModel: async (_ref: { provider: string; modelId: string } | undefined) => {},
    ready: async (_workspace: string) => {},
  };
  const open = async () => {
    const runtime = await openDurableAgentRuntime(path, "native-workspace", options, load);
    runtimes.push(runtime);
    return runtime;
  };
  return { path, models, faux, registry, load, open, runtime: await open() };
}

test("native runtime owns stable handles and reacquires admission before retry preparation", async () => {
  const { runtime, faux, load, open } = await setup();
  faux.setResponses([fauxAssistantMessage("The original answer")]);
  const [one, same] = await Promise.all([runtime.agent(record), runtime.agent(record)]);
  expect(one).toBe(same);
  const first = await one.submit({ requestId: "browser-request", text: "Original input" });
  expect((await first.wait(context)).status).toBe("done");
  await runtime.suspend();
  load.prepare = async () => { throw new Error("Must not reprepare existing conversations"); };
  load.expand = async () => { throw new Error("Must not reprepare admitted requests"); };
  const reopened = await open();
  const restored = await reopened.agent(record);
  expect(restored.id).toBe(one.id);
  const duplicate = await restored.submit({ requestId: "browser-request", text: "Changed retry" });
  expect(duplicate.id).toBe(first.id);
  expect((await duplicate.wait(context)).status).toBe("done");
  expect(faux.state.callCount).toBe(1);
  const entries = (await restored.history({}, 100, undefined, context)).items;
  expect(JSON.stringify(entries)).toContain("Original input");
  expect(JSON.stringify(entries)).not.toContain("Changed retry");
  await expect(restored.submit({ requestId: "new-request", text: "Fails preparation" })).rejects.toThrow("Must not reprepare admitted requests");
  load.expand = async (_workspace, text) => text;
  faux.setResponses([fauxAssistantMessage("A later command still works")]);
  const corrected = await restored.submit({ requestId: "new-request", text: "Corrected" });
  expect((await corrected.wait(context)).status).toBe("done");
});

test("model setup fills a model-less conversation and permits submission without recreating it", async () => {
  const { runtime, faux, load, open } = await setup();
  load.prepare = async () => ({ instructions: "Created before model setup" });
  const agent = await runtime.agent(record);
  expect((await agent.settings()).model).toBeUndefined();
  load.validateModel = async (ref) => {
    if (!ref) throw new Error("No connected model");
  };
  await expect(agent.submit({ requestId: "before-setup", text: "Hello" })).rejects.toThrow("No connected model");
  await agent.configureDefaultModel({ provider: "faux", modelId: "small" });
  expect((await agent.settings()).model).toEqual({ provider: "faux", modelId: "small" });
  expect((await agent.settings()).instructions).toBe("Created before model setup");
  faux.setResponses([fauxAssistantMessage("Ready after setup")]);
  const submission = await agent.submit({ requestId: "after-setup", text: "Hello" });
  expect((await submission.wait(context)).status).toBe("done");
  await runtime.suspend();
  const restored = await (await open()).agent(record);
  expect(restored.id).toBe(agent.id);
  expect((await restored.settings()).model).toEqual({ provider: "faux", modelId: "small" });
});

test("model setup preserves explicit selections, including a queued selection", async () => {
  const { runtime, load } = await setup();
  load.prepare = async () => ({});
  const agent = await runtime.agent(record);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  load.validateModel = async () => { entered.resolve(); await release.promise; };
  const explicit = agent.configure({ model: { provider: "faux", modelId: "large" } });
  await entered.promise;
  const defaultSelection = agent.configureDefaultModel({ provider: "faux", modelId: "small" });
  release.resolve();
  await Promise.all([explicit, defaultSelection]);
  expect((await agent.settings()).model?.modelId).toBe("large");
  load.validateModel = async () => { throw new Error("Existing selection is unavailable"); };
  await agent.configureDefaultModel({ provider: "faux", modelId: "small" });
  expect((await agent.settings()).model?.modelId).toBe("large");
});

test("settings serialize with image preparation without blocking another conversation", async () => {
  const { runtime, faux, load } = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  load.expand = async (_workspace, text) => {
    if (text === "Hold preparation") { entered.resolve(); await release.promise; }
    return text;
  };
  faux.setResponses([fauxAssistantMessage("Independent"), fauxAssistantMessage("Prepared")]);
  const one = await runtime.agent(record);
  const two = await runtime.agent({ ...record, agentId: "other" });
  const admitted = one.submit({ requestId: "slow", text: "Hold preparation", images: [{ type: "image", data: png, mimeType: "image/png" }] });
  await entered.promise;
  const configure = one.configure({ model: { provider: "faux", modelId: "large" } });
  const independent = await two.submit({ requestId: "slow", text: "Independent root" });
  expect((await independent.wait(context)).status).toBe("done");
  expect((await one.settings()).model?.modelId).toBe("small");
  release.resolve();
  const submission = await admitted;
  await configure;
  expect((await submission.wait(context)).status).toBe("done");
  const user = (await one.history({}, 100, undefined, context)).items.find((entry) => entry.model?.some((message) => message.role === "user"))!;
  expect(JSON.stringify(durableEntryContent(user))).toContain("4x4");
  expect((await one.settings()).model?.modelId).toBe("large");
  expect((await two.settings()).model?.modelId).toBe("small");
  await expect(one.configure({ model: { provider: "faux", modelId: "missing" } })).rejects.toThrow("Model not found");
  expect((await one.settings()).model?.modelId).toBe("large");
});

test.each(["suspend", "stop"] as const)("native %s preserves or withdraws committed steering, and passive reopen does not run it", async (operation) => {
  const { runtime, faux, registry, open } = await setup();
  const started = Promise.withResolvers<void>();
  registry.install(defineExtension({ name: "blocking", tools: [defineTool({
    name: "block", description: "Wait until interrupted", parameters: Type.Object({}),
    async execute(_args, _api, invocation) {
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true });
      });
    },
  })] }));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("block", {})], { stopReason: "toolUse" }),
    (request) => {
      expect(JSON.stringify(request)).toContain("Queued instruction");
      expect(JSON.stringify(request)).not.toContain("Kintsugi restarted");
      return fauxAssistantMessage("Recovered");
    },
  ]);
  const agent = await runtime.agent(record);
  const initial = await agent.submit({ requestId: "initial", text: "Begin" });
  await started.promise;
  const steer = await agent.submit({ requestId: "steer", text: "Queued instruction" });
  expect((await steer.status(context)).status).toBe("queued");
  await expect(agent.reset()).rejects.toThrow("Stop the agent");
  if (operation === "stop") await agent.stop();
  await runtime.suspend();
  await expect(agent.submit({ requestId: "after-suspend", text: "No admission" })).rejects.toThrow("suspended");
  const reopened = await open();
  const restored = await reopened.agent(record);
  const watch = await restored.watch(context);
  expect(Boolean(watch.value.docs["pi.live"]?.run)).toBe(operation === "suspend");
  const duplicate = await restored.submit({ requestId: "steer", text: "Retry" });
  expect(duplicate.id).toBe(steer.id);
  expect((await duplicate.status(context)).status).toBe(operation === "suspend" ? "queued" : "unanswered");
  expect(faux.state.callCount).toBe(1);
  if (operation === "suspend") {
    await reopened.resume();
    expect((await duplicate.wait(context)).status).toBe("done");
    expect(faux.state.callCount).toBe(2);
  } else {
    const prior = await restored.submit({ requestId: "initial", text: "Retry" });
    expect(prior.id).toBe(initial.id);
    expect((await prior.status(context)).status).toBe("unanswered");
  }
  await watch.stop();
});

test("reset changes active context but retains journal history and settings", async () => {
  const { runtime, faux, open } = await setup();
  faux.setResponses([fauxAssistantMessage("Old answer")]);
  const agent = await runtime.agent(record);
  const submission = await agent.submit({ requestId: "old", text: "Old input" });
  await submission.wait(context);
  await agent.reset();
  const active = await agent.context(context);
  expect(JSON.stringify(active.messages)).not.toContain("Old input");
  expect(JSON.stringify((await agent.history({}, 100, undefined, context)).items)).toContain("Old input");
  expect((await agent.settings()).model?.modelId).toBe("small");
  await runtime.suspend();
  const reopened = await open();
  const restored = await reopened.agent(record);
  expect(JSON.stringify((await restored.context(context)).messages)).not.toContain("Old input");
  expect((await restored.settings()).instructions).toBe("Committed instructions");
});

test("committed watches reconnect with complete state; disconnecting a viewer does not stop work", async () => {
  const { runtime, faux, registry } = await setup();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  registry.install(defineExtension({ name: "progress", tools: [defineTool({
    name: "progress", description: "Publish progress and wait", parameters: Type.Object({}),
    async execute(_args, api) {
      api.output("Committed output");
      started.resolve();
      await finish.promise;
      return { output: [{ type: "text", text: "Completed output" }] };
    },
  })] }));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("progress", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished"),
  ]);
  const agent = await runtime.agent(record);
  const viewer = await agent.watch(context);
  const sawRun = Promise.withResolvers<void>();
  viewer.start(async (value) => { if (value.docs["pi.live"]?.run) sawRun.resolve(); });
  const admitted = await agent.submit({ requestId: "watched", text: "Watch committed state" });
  await sawRun.promise;
  await started.promise;
  await viewer.stop();
  expect((await admitted.status(context)).status).toBe("placed");
  const reconnect = await agent.watch(context);
  expect(reconnect.value.docs["pi.live"]?.run).toBeDefined();
  expect(JSON.stringify(reconnect.value.docs["pi.live"])).toContain("progress");
  finish.resolve();
  await admitted.wait(context);
  await reconnect.stop();
  const settled = await agent.watch(context);
  expect(settled.value.docs["pi.live"]?.run).toBeUndefined();
  expect(JSON.stringify(settled.value.entries)).toContain("Completed output");
  expect(JSON.stringify(settled.value.entries)).toContain("Finished");
  await settled.stop();
});

test("suspending during preparation fences pending admission without adding a recovery prompt", async () => {
  const { runtime, faux, load, open } = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  load.expand = async (_workspace, text) => { entered.resolve(); await release.promise; return text; };
  const agent = await runtime.agent(record);
  const pending = agent.submit({ requestId: "preparing", text: "Not yet admitted" });
  await entered.promise;
  await runtime.suspend();
  release.resolve();
  await expect(pending).rejects.toThrow("suspended");
  const reopened = await open();
  const restored = await reopened.agent(record);
  expect((await restored.history({}, 100, undefined, context)).items).toHaveLength(0);
  expect(faux.state.callCount).toBe(0);
});

test.each(["close", "delete"] as const)("permanent %s fences preparation and survives reopen with readable history", async (operation) => {
  const { runtime, faux, load, open } = await setup();
  faux.setResponses([fauxAssistantMessage("Saved answer"), fauxAssistantMessage("Other root")]);
  const agent = await runtime.agent(record);
  await (await agent.submit({ requestId: "saved", text: "Saved input" })).wait(context);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  load.expand = async (_workspace, text) => { entered.resolve(); await release.promise; return text; };
  const pending = agent.submit({ requestId: "blocked", text: "Not admitted" });
  await entered.promise;
  const closing = operation === "close" ? agent.close() : runtime.delete();
  release.resolve();
  await expect(pending).rejects.toThrow(operation === "close" ? "closed" : "deleted");
  await closing;
  await expect(agent.configure({ thinkingLevel: "off" })).rejects.toThrow(operation === "close" ? "closed" : "deleted");
  await runtime.suspend();
  const reopened = await open();
  const restored = await reopened.agent(record);
  expect(JSON.stringify((await restored.history({}, 100, undefined, context)).items)).toContain("Saved input");
  await expect(restored.submit({ requestId: "saved", text: "Even retries cannot start work" })).rejects.toThrow(operation === "close" ? "closed" : "deleted");
  if (operation === "delete") {
    await expect(reopened.agent({ ...record, agentId: "new" })).rejects.toThrow("deleted");
  } else {
    load.expand = async (_workspace, text) => text;
    const other = await reopened.agent({ ...record, agentId: "new" });
    await (await other.submit({ requestId: "other", text: "Independent" })).wait(context);
  }
  expect(faux.state.callCount).toBe(operation === "close" ? 2 : 1);
});

test.each(["close", "delete"] as const)("recovery after %s gate commit marks work before any scheduler resume", async (operation) => {
  const { runtime, path, faux, load, registry, open } = await setup();
  const { openDurableWorkspace } = await import("../../src/server/durable-workspace.ts");
  const { WorkspaceAdmission } = await import("../../src/server/durable-lifecycle.ts");
  const started = Promise.withResolvers<void>();
  let executions = 0;
  registry.install(defineExtension({ name: "replay-probe", tools: [defineTool({
    name: "probe", description: "Safe execution must not recover after close", parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, _api, invocation) {
      executions++;
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true });
      });
    },
  })] }));
  faux.setResponses([fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" })]);
  const agent = await runtime.agent(record);
  await agent.submit({ requestId: "run", text: "Start tool" });
  await started.promise;
  await agent.submit({ requestId: "queued", text: "Must not execute" });
  await runtime.suspend();
  // Simulate the durable boundary: host died after committing the gate and
  // before withdrawing inputs or cancelling tasks. No destructive UI fixture.
  const workspace = await openDurableWorkspace(path, "native-workspace", await load.harness());
  await workspace.harness.commit(async (tx) => {
    const admission = await tx.doc(WorkspaceAdmission);
    if (operation === "delete") admission.deleted = true;
    else admission.closed.push(agent.id);
  }, context);
  await workspace.close();
  const reopened = await open();
  const restored = await reopened.agent(record);
  const watch = await restored.watch(context);
  const idle = Promise.withResolvers<void>();
  watch.start(async (value) => { if (!value.docs["pi.live"]?.run) idle.resolve(); });
  expect(executions).toBe(1);
  expect(faux.state.callCount).toBe(1);
  await reopened.resume();
  await idle.promise;
  await watch.stop();
  expect(executions).toBe(1);
  expect(faux.state.callCount).toBe(1);
  expect(JSON.stringify((await restored.history({}, 100, undefined, context)).items)).not.toContain("Must not execute");
});

test.each(["close", "delete"] as const)("live %s cancels work and withdraws queued input before resolving", async (operation) => {
  const { runtime, faux, registry } = await setup();
  const started = Promise.withResolvers<void>();
  let interrupted = false;
  registry.install(defineExtension({ name: "live-close", tools: [defineTool({
    name: "hold", description: "Wait for cancellation", parameters: Type.Object({}),
    async execute(_args, _api, invocation) {
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        invocation.abortSignal!.addEventListener("abort", () => {
          interrupted = true;
          reject(invocation.abortSignal!.reason);
        }, { once: true });
      });
    },
  })] }));
  faux.setResponses([fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" })]);
  const agent = await runtime.agent(record);
  const first = await agent.submit({ requestId: "first", text: "Begin" });
  await started.promise;
  const queued = await agent.submit({ requestId: "queued", text: "Never run" });
  if (operation === "close") await agent.close();
  else await runtime.delete();
  expect(interrupted).toBe(true);
  expect((await first.status(context)).status).toBe("unanswered");
  expect((await queued.status(context)).status).toBe("unanswered");
  const watch = await agent.watch(context);
  expect(watch.value.docs["pi.live"]?.run).toBeUndefined();
  await watch.stop();
  expect(faux.state.callCount).toBe(1);
});

test("committed titles survive stale attachment metadata and remain discoverable after close and deletion", async () => {
  const { runtime, faux, load, open } = await setup();
  expect(await runtime.catalog()).toEqual([]);
  const one = await runtime.agent(record);
  const otherRecord = { ...record, agentId: "other", title: "Independent title" };
  const two = await runtime.agent(otherRecord);
  const renamed = await one.setTitle("searchable-durable-title");
  expect(renamed).toEqual({ ...record, durableId: one.id, title: "searchable-durable-title" });
  expect(await runtime.catalog()).toEqual([renamed, { ...otherRecord, durableId: two.id }]);
  await runtime.suspend();
  load.prepare = async () => { throw new Error("Catalog reads must not prepare prompts"); };
  const reopened = await open();
  expect((await reopened.catalog())[0]).toEqual(renamed);
  const restored = await reopened.agent(record);
  expect((await reopened.catalog())[0]?.title).toBe("searchable-durable-title");
  await restored.close();
  await expect(restored.setTitle("Closed rename")).rejects.toThrow("closed");
  expect((await reopened.catalog())[0]).toEqual(renamed);
  await reopened.delete();
  const retained = await reopened.catalog();
  expect(retained).toHaveLength(2);
  expect(retained[0]).toEqual(renamed);
  expect(faux.state.callCount).toBe(0);
  await reopened.suspend();
  expect(await (await open()).catalog()).toEqual(retained);
});

test("title changes serialize with commands and cannot cross a close fence", async () => {
  const { runtime, load } = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  load.expand = async (_workspace, text) => { entered.resolve(); await release.promise; return text; };
  const agent = await runtime.agent(record);
  const pending = agent.submit({ requestId: "blocked", text: "Waiting" });
  await entered.promise;
  const title = agent.setTitle("Must not commit");
  const close = agent.close();
  release.resolve();
  await expect(pending).rejects.toThrow("closed");
  await expect(title).rejects.toThrow("closed");
  await close;
  expect((await runtime.catalog())[0]?.title).toBe(record.title);
});

test("reopened reads and known requests stay passive; new execution waits for workspace readiness", async () => {
  const { runtime, faux, load, open } = await setup();
  faux.setResponses([fauxAssistantMessage("Saved"), fauxAssistantMessage("New")]);
  const agent = await runtime.agent(record);
  const saved = await agent.submit({ requestId: "saved", text: "Original" });
  await saved.wait(context);
  await runtime.suspend();
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  let probes = 0;
  load.ready = async () => { probes++; entered.resolve(); await ready.promise; };
  const reopened = await open();
  const restored = await reopened.agent(record);
  await reopened.catalog();
  await restored.history({}, 100, undefined, context);
  const watch = await restored.watch(context);
  await watch.stop();
  expect((await restored.submit({ requestId: "saved", text: "Retry" })).id).toBe(saved.id);
  expect(probes).toBe(0);
  const pending = restored.submit({ requestId: "new", text: "New input" });
  await entered.promise;
  expect(faux.state.callCount).toBe(1);
  expect(JSON.stringify((await restored.history({}, 100, undefined, context)).items)).not.toContain("New input");
  ready.resolve();
  await (await pending).wait(context);
  expect(probes).toBe(1);
  expect(faux.state.callCount).toBe(2);
});

test("readiness failure rejects before prompt preparation and admission, and a later command can retry", async () => {
  const { runtime, faux, load } = await setup();
  load.ready = async () => { throw new Error("Workspace offline"); };
  await expect(runtime.agent(record)).rejects.toThrow("Workspace offline");
  expect(await runtime.catalog()).toEqual([]);
  load.ready = async () => {};
  const agent = await runtime.agent(record);
  load.ready = async () => { throw new Error("Workspace offline again"); };
  await expect(agent.submit({ requestId: "retryable", text: "Not admitted" })).rejects.toThrow("Workspace offline again");
  await expect(agent.compact()).rejects.toThrow("Workspace offline again");
  await expect(runtime.resume()).rejects.toThrow("Workspace offline again");
  expect((await agent.history({}, 100, undefined, context)).items).toHaveLength(0);
  expect(faux.state.callCount).toBe(0);
  load.ready = async () => {};
  faux.setResponses([fauxAssistantMessage("Recovered")]);
  await (await agent.submit({ requestId: "retryable", text: "Now admitted" })).wait(context);
  expect(faux.state.callCount).toBe(1);
});

test.each(["suspend", "close", "delete"] as const)("%s during readiness prevents late admission", async (operation) => {
  const { runtime, faux, load } = await setup();
  const agent = await runtime.agent(record);
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  load.ready = async () => { entered.resolve(); await ready.promise; };
  const pending = agent.submit({ requestId: "late", text: "Must not run" });
  await entered.promise;
  const ending = operation === "close" ? agent.close() : operation === "delete" ? runtime.delete() : runtime.suspend();
  ready.resolve();
  await expect(pending).rejects.toThrow(operation === "suspend" ? "suspended" : operation === "close" ? "closed" : "deleted");
  await ending;
  expect(faux.state.callCount).toBe(0);
});

test("recovery cannot replay a tool until the execution workspace is ready", async () => {
  const { runtime, faux, load, registry, open } = await setup();
  const started = Promise.withResolvers<void>();
  let executions = 0;
  registry.install(defineExtension({ name: "ready-probe", tools: [defineTool({
    name: "probe", description: "Replay only after readiness", parameters: Type.Object({}), replay: "safe",
    async execute(_args, _api, invocation) {
      executions++;
      if (executions > 1) return { output: [{ type: "text", text: "Recovered tool" }] };
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true });
      });
    },
  })] }));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Recovered answer"),
  ]);
  const agent = await runtime.agent(record);
  await agent.submit({ requestId: "recover", text: "Begin" });
  await started.promise;
  await runtime.suspend();
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  load.ready = async () => { entered.resolve(); await ready.promise; };
  const reopened = await open();
  const restored = await reopened.agent(record);
  const recovery = reopened.resume();
  await entered.promise;
  expect(executions).toBe(1);
  expect(faux.state.callCount).toBe(1);
  ready.resolve();
  await recovery;
  await (await restored.submit({ requestId: "recover", text: "Retry" })).wait(context);
  expect(executions).toBe(2);
  expect(faux.state.callCount).toBe(2);
});

test.each(["close", "delete"] as const)("%s persists its fence even if cleanup readiness fails, and cleanup can be retried", async (operation) => {
  const { runtime, faux, load, registry, open } = await setup();
  const started = Promise.withResolvers<void>();
  let executions = 0;
  registry.install(defineExtension({ name: "offline-close", tools: [defineTool({
    name: "hold", description: "Must never replay", parameters: Type.Object({}), replay: "safe",
    async execute(_args, _api, invocation) {
      executions++;
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true });
      });
    },
  })] }));
  faux.setResponses([fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" })]);
  const agent = await runtime.agent(record);
  await agent.submit({ requestId: "offline", text: "Begin" });
  await started.promise;
  await runtime.suspend();
  load.ready = async () => { throw new Error("Cleanup workspace offline"); };
  const reopened = await open();
  const restored = await reopened.agent(record);
  await expect(operation === "close" ? restored.close() : reopened.delete()).rejects.toThrow("Cleanup workspace offline");
  await expect(restored.submit({ requestId: "offline", text: "Retry" })).rejects.toThrow(operation === "close" ? "closed" : "deleted");
  load.ready = async () => {};
  await (operation === "close" ? restored.close() : reopened.delete());
  expect(executions).toBe(1);
  expect(faux.state.callCount).toBe(1);
  await reopened.suspend();
  const retained = await (await open()).agent(record);
  await expect(retained.setTitle("Cannot reopen")).rejects.toThrow(operation === "close" ? "closed" : "deleted");
});

test("resetting an idle root cannot recover another root before readiness", async () => {
  const { runtime, faux, load, registry, open } = await setup();
  const started = Promise.withResolvers<void>();
  let executions = 0;
  registry.install(defineExtension({ name: "reset-ready", tools: [defineTool({
    name: "probe", description: "Replay after readiness", parameters: Type.Object({}), replay: "safe",
    async execute(_args, _api, invocation) {
      executions++;
      if (executions > 1) return { output: [{ type: "text", text: "Recovered" }] };
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true });
      });
    },
  })] }));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished"),
  ]);
  const busy = await runtime.agent(record);
  const idleRecord = { ...record, agentId: "idle" };
  await runtime.agent(idleRecord);
  await busy.submit({ requestId: "recover", text: "Begin" });
  await started.promise;
  await runtime.suspend();
  const reopened = await open();
  const idle = await reopened.agent(idleRecord);
  load.ready = async () => { throw new Error("Workspace offline"); };
  await expect(idle.reset()).rejects.toThrow("Workspace offline");
  expect(executions).toBe(1);
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  load.ready = async () => { entered.resolve(); await ready.promise; };
  const resetting = idle.reset();
  await entered.promise;
  expect(executions).toBe(1);
  expect(faux.state.callCount).toBe(1);
  ready.resolve();
  await resetting;
  const restored = await reopened.agent(record);
  await (await restored.submit({ requestId: "recover", text: "Retry" })).wait(context);
  expect(executions).toBe(2);
});

test("native navigation atomically selects immutable forks, preserves settings/history and deduplicates across branches", async () => {
  const { runtime, faux, load, open } = await setup();
  faux.setResponses([fauxAssistantMessage("First answer"), fauxAssistantMessage("Abandoned answer"), fauxAssistantMessage("Fork answer")]);
  const agent = await runtime.agent(record);
  await (await agent.submit({ requestId: "first", text: "First input", images: [{ type: "image", data: png, mimeType: "image/png" }] })).wait(context);
  const firstBranch = agent.id;
  const target = (await agent.history({}, 1, undefined, context)).items[0]!;
  await agent.configure({ model: { provider: "faux", modelId: "large" } });
  await (await agent.submit({ requestId: "abandoned", text: "Abandoned input" })).wait(context);
  await agent.label(String(target.id), "Decision", "add");
  const before = (await agent.history({}, 100, undefined, context)).items;
  load.ready = async () => { throw new Error("Navigation must be passive"); };
  await agent.navigate(String(target.id));
  expect(agent.id).not.toBe(firstBranch);
  expect((await agent.settings()).model?.modelId).toBe("small");
  expect(JSON.stringify((await agent.context(context)).messages)).not.toContain("Abandoned");
  expect((await agent.tree()).labels[String(target.id)]).toEqual(["Decision"]);
  expect((await agent.tree()).nodes).toHaveLength(before.length);
  expect((await runtime.catalog())[0]?.branches).toEqual([firstBranch, agent.id]);
  expect(await agent.knownRequest("abandoned")).toBe(true);
  const duplicate = await agent.submit({ requestId: "abandoned", text: "Do not replay in fork" });
  expect((await duplicate.wait(context)).status).toBe("done");
  expect(faux.state.callCount).toBe(2);
  const firstImage = before.find(entry => durableEntryContent(entry).some(part => part.type === "image"))!;
  expect((await agent.image(String(firstImage.id), durableEntryContent(firstImage).findIndex(part => part.type === "image"))).status).toBe(200);
  expect(JSON.stringify(await agent.historyView(String(firstBranch)))).toContain("Abandoned answer");
  load.ready = async () => {};
  await (await agent.submit({ requestId: "fork", text: "Fork input" })).wait(context);
  const selectedId = agent.id;
  await runtime.suspend();
  const reopened = await open();
  const restored = await reopened.agent(record);
  expect(restored.id).toBe(selectedId);
  expect(JSON.stringify((await restored.context(context)).messages)).toContain("Fork answer");
  expect(JSON.stringify((await restored.context(context)).messages)).not.toContain("Abandoned answer");
  const abandoned = (await restored.tree()).nodes.find(node => JSON.stringify(node.entry).includes("Abandoned answer"))!;
  await restored.navigate(String(abandoned.entry.id));
  expect(JSON.stringify((await restored.context(context)).messages)).toContain("Abandoned answer");
  expect(JSON.stringify((await restored.context(context)).messages)).not.toContain("Fork answer");
  await restored.close();
  expect((await reopened.admission())?.closed).toEqual(expect.arrayContaining((await reopened.catalog())[0]!.branches!));
  await expect(restored.navigate(String(target.id))).rejects.toThrow("closed");
});

test("native rewind rejects foreign IDs and live work, then forks before the selected entry", async () => {
  const { runtime, faux } = await setup();
  faux.setResponses([fauxAssistantMessage("First response"), fauxAssistantMessage("Second response")]);
  const agent = await runtime.agent(record);
  const other = await runtime.agent({ ...record, agentId: "foreign" });
  await (await agent.submit({ requestId: "first", text: "First" })).wait(context);
  await (await agent.submit({ requestId: "second", text: "Second" })).wait(context);
  const second = (await agent.tree()).nodes.find(node => node.entry.model?.some(message => message.role === "user" && JSON.stringify(message).includes("Second")))!;
  await expect(other.navigate(String(second.entry.id))).rejects.toThrow("no longer exists");
  await expect(other.label(String(second.entry.id), "foreign", "add")).rejects.toThrow("no longer exists");
  await expect(other.historyView(String(agent.id))).rejects.toThrow("no longer exists");
  expect((await other.image(String(second.entry.id), 0)).status).toBe(404);
  await agent.navigate(String(second.entry.id), true);
  expect(JSON.stringify((await agent.context(context)).messages)).toContain("First response");
  expect(JSON.stringify((await agent.context(context)).messages)).not.toContain("Second");
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("Done"); }]);
  const running = await agent.submit({ requestId: "running", text: "Busy" });
  await entered.promise;
  const blocked = agent.navigate(String(second.entry.id));
  await expect(blocked).rejects.toThrow("Stop the agent");
  release.resolve();
  await running.wait(context);
});

test.each(["offline", "commit-crash"] as const)("Stop %s boundary withdraws steering and never replays scoped safe work", async boundary => {
  const { runtime, path, faux, registry, load, open } = await setup();
  const { openDurableWorkspace } = await import("../../src/server/durable-workspace.ts");
  const { commitDurableStop } = await import("../../src/server/durable-lifecycle.ts");
  const started = Promise.withResolvers<void>();
  let executions = 0;
  registry.install(defineExtension({ name: "stop-probe", tools: [defineTool({
    name: "probe", description: "Safe replay probe", parameters: Type.Object({}), replay: "safe",
    async execute(_args, _api, invocation) {
      executions++;
      started.resolve();
      return new Promise<never>((_resolve, reject) => invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true }));
    },
  })] }));
  faux.setResponses([fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" })]);
  const agent = await runtime.agent(record);
  const independent = await runtime.agent({ ...record, agentId: "independent" });
  await agent.submit({ requestId: "original", text: "Original input" });
  await started.promise;
  await agent.submit({ requestId: "queued", text: "Withdraw this steering" });
  await runtime.suspend();
  if (boundary === "commit-crash") {
    const workspace = await openDurableWorkspace(path, "native-workspace", await load.harness());
    // Fault immediately after the Stop transaction, before any abort mark or
    // cleanup readiness. This is the exact exported production commit seam.
    await workspace.harness.commit(tx => commitDurableStop(tx, agent.id), context);
    expect((await workspace.harness.inspect(context)).tasks.every(task => !task.record.abortRequested)).toBe(true);
    await workspace.close();
  } else {
    load.ready = async () => { throw new Error("Workspace unavailable"); };
    load.prepare = async () => { throw new Error("No providers configured"); };
    const offline = await open();
    const restored = await offline.agent(record);
    await expect(restored.stop()).rejects.toThrow("Stop saved");
    await offline.suspend();
  }
  const reopened = await open();
  const restored = await reopened.agent(record);
  const queued = await restored.submit({ requestId: "queued", text: "Retry must stay withdrawn" });
  expect((await queued.status(context)).status).toBe("unanswered");
  expect(executions).toBe(1);
  expect(faux.state.callCount).toBe(1);
  expect((await reopened.admission())?.closed).toEqual([]);
  expect((await reopened.admission())?.deleted).toBe(false);
  load.ready = async () => {};
  // No successful cleanup retry is required before the next genuine message.
  faux.setResponses([fauxAssistantMessage("Later genuine answer"), fauxAssistantMessage("Independent answer")]);
  expect((await (await restored.submit({ requestId: "later", text: "New genuine input" })).wait(context)).status).toBe("done");
  expect(executions).toBe(1);
  const original = await restored.submit({ requestId: "original", text: "Retry" });
  expect((await original.status(context)).status).toBe("unanswered");
  const other = await reopened.agent({ ...record, agentId: "independent" });
  expect(other.id).toBe(independent.id);
  expect((await (await other.submit({ requestId: "other", text: "Independent root" })).wait(context)).status).toBe("done");
  expect(executions).toBe(1);
  expect(JSON.stringify((await restored.history({}, 100, undefined, context)).items)).not.toContain("Withdraw this steering");
});

test("self-deleting workspace capability releases its invocation so durable deletion cannot join itself", async () => {
  const { runtime, faux, registry, open } = await setup();
  const { durableWorkspaceTool } = await import("../../src/server/durable-tools.ts");
  const deleted = Promise.withResolvers<void>();
  let executions = 0;
  registry.install(defineExtension({ name: "self-delete", tools: [durableWorkspaceTool({
    name: "delete_current_workspace", label: "Delete", description: "Delete this workspace", parameters: Type.Object({}),
    async execute() {
      executions++;
      await runtime.delete();
      deleted.resolve();
      return { content: [{ type: "text", text: "Must not commit a success after abort" }], details: undefined };
    },
  })] }));
  faux.setResponses([fauxAssistantMessage([fauxToolCall("delete_current_workspace", {})], { stopReason: "toolUse" })]);
  const agent = await runtime.agent(record);
  await agent.submit({ requestId: "self-delete", text: "Delete this workspace" });
  await deleted.promise;
  expect((await runtime.admission())?.deleted).toBe(true);
  expect(JSON.stringify((await agent.history({}, 100, undefined, context)).items)).not.toContain("Must not commit a success");
  await runtime.suspend();
  const reopened = await open();
  await reopened.resume();
  expect(executions).toBe(1);
  expect(faux.state.callCount).toBe(1);
  await expect((await reopened.agent(record)).submit({ requestId: "no", text: "No" })).rejects.toThrow("deleted");
});


test("Stop does not signal another root's active tool", async () => {
  const { runtime, faux, registry } = await setup();
  const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const signals: AbortSignal[] = [];
  const release = Promise.withResolvers<void>();
  registry.install(defineExtension({ name: "independent-stop", tools: [defineTool({
    name: "hold", description: "Hold work", parameters: Type.Object({}),
    async execute(_args, _api, invocation) {
      const index = signals.length;
      signals.push(invocation.abortSignal!);
      starts[index]!.resolve();
      await Promise.race([release.promise, new Promise<never>((_resolve, reject) => invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true }))]);
      return { output: [{ type: "text", text: "Independent completion" }] };
    },
  })] }));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Independent answer"),
  ]);
  const one = await runtime.agent(record);
  const two = await runtime.agent({ ...record, agentId: "other-live" });
  const first = await one.submit({ requestId: "one", text: "First" });
  await starts[0]!.promise;
  const second = await two.submit({ requestId: "two", text: "Second" });
  await starts[1]!.promise;
  await one.stop();
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);
  expect((await first.status(context)).status).toBe("unanswered");
  release.resolve();
  expect((await second.wait(context)).status).toBe("done");
});


/** A `hold` tool that runs until it is cancelled, whose start `held` reports. */
function installHold(registry: ReturnType<typeof createRegistry>) {
  const held = Promise.withResolvers<void>();
  registry.install(defineExtension({ name: "hold-test-tool", tools: [defineTool({
    name: "hold", description: "Hold until cancelled", parameters: Type.Object({}),
    async execute(_args, _api, invocation) {
      held.resolve();
      return await new Promise<never>((_resolve, reject) => invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true }));
    },
  })] }));
  return held;
}

test("a message after Stop starts its own turn instead of steering the stopped one", async () => {
  const { runtime, faux, registry } = await setup();
  const held = installHold(registry);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Second answer"),
  ]);
  const agent = await runtime.agent(record);
  await agent.submit({ requestId: "first", text: "First" });
  await held.promise;
  await agent.stop();
  expect((await (await agent.submit({ requestId: "second", text: "Second" })).wait(context)).status).toBe("done");
  const watch = await agent.watch(context);
  const items = projectDurableTranscript(watch.value);
  await watch.stop();
  const turns = items.filter(item => item.type === "working");
  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({ stoppedAt: expect.any(Number), durationUnavailable: false, timing: { elapsedMs: expect.any(Number) } });
  expect(items.filter(item => item.type === "user").map(item => item.text)).toEqual(["First", "Second"]);
});

test("execution owner publishes busy and finished turns without a presentation mount", async () => {
  const events = createKintsugiEventBus();
  const finished: Array<{ workspaceId: string; agentId: string }> = [];
  const completed = Promise.withResolvers<void>();
  events.on("workspace_agent_turn_finished", async event => { finished.push(event); completed.resolve(); });
  const busy: boolean[] = [];
  const unsubscribe = subscribeWorkspaceAgentBusy(event => {
    if (event.workspaceId === "native-workspace" && event.agentKey === "agent:tab") busy.push(event.busy);
  });
  const release = Promise.withResolvers<void>();
  try {
    const { runtime, faux } = await setup({ events });
    const entered = Promise.withResolvers<void>();
    faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("Finished without a viewer"); }]);
    const agent = await runtime.agent(record);
    const turn = await agent.submit({ requestId: "headless", text: "Run without a viewer" });
    await entered.promise;
    // No presentation or viewer watch was created.
    expect(busy).toEqual([true]);
    expect(currentNotificationTurn({ workspaceId: "native-workspace", agentId: record.agentId })).toBeDefined();
    expect(finished).toEqual([]);
    release.resolve();
    await turn.wait(context);
    await completed.promise;
    expect(busy).toEqual([true, false]);
    expect(finished).toEqual([{ workspaceId: "native-workspace", agentId: record.agentId }]);
    expect(currentNotificationTurn({ workspaceId: "native-workspace", agentId: record.agentId })).toBeUndefined();
    await runtime.suspend();
    expect(finished).toHaveLength(1);
  } finally {
    release.resolve();
    unsubscribe();
  }
});

test("selection listeners observe committed branch switches and can detach", async () => {
  const { runtime, faux } = await setup();
  faux.setResponses([fauxAssistantMessage("First answer"), fauxAssistantMessage("Later answer")]);
  const agent = await runtime.agent(record);
  await (await agent.submit({ requestId: "first", text: "First input" })).wait(context);
  const target = (await agent.history({}, 1, undefined, context)).items[0]!;
  await (await agent.submit({ requestId: "later", text: "Later input" })).wait(context);
  const previous = agent.id;
  const selections: Array<{ id: typeof agent.id; catalogId: typeof agent.id; messages: string }> = [];
  const unsubscribe = agent.subscribeSelection(async () => {
    selections.push({ id: agent.id, catalogId: (await runtime.catalog())[0]!.durableId, messages: JSON.stringify((await agent.context(context)).messages) });
  });
  await expect(agent.navigate("-1")).rejects.toThrow("no longer exists");
  expect(selections).toEqual([]);
  await agent.navigate(String(target.id));
  expect(selections).toHaveLength(1);
  expect(selections[0]!.id).not.toBe(previous);
  expect(selections[0]!.id).toBe(agent.id);
  expect(selections[0]!.catalogId).toBe(agent.id);
  expect(selections[0]!.messages).toContain("First answer");
  expect(selections[0]!.messages).not.toContain("Later answer");
  unsubscribe();
  await agent.navigate(String(target.id));
  expect(selections).toHaveLength(1);
});

test("model availability is validated by commands after request deduplication", async () => {
  const { runtime, faux, load } = await setup();
  faux.setResponses([fauxAssistantMessage("Admitted while available")]);
  const agent = await runtime.agent(record);
  const original = await agent.submit({ requestId: "available", text: "Original input" });
  await original.wait(context);
  const validated: Array<{ provider: string; modelId: string } | undefined> = [];
  load.validateModel = async ref => { validated.push(ref); throw new Error("Model disconnected"); };
  expect((await agent.submit({ requestId: "available", text: "Retry while disconnected" })).id).toBe(original.id);
  expect(validated).toEqual([]);
  await expect(agent.submit({ requestId: "new", text: "Not admitted" })).rejects.toThrow("Model disconnected");
  await expect(agent.compact()).rejects.toThrow("Model disconnected");
  await expect(agent.configure({ model: { provider: "faux", modelId: "large" } })).rejects.toThrow("Model disconnected");
  expect(validated).toEqual([
    { provider: "faux", modelId: "small" },
    { provider: "faux", modelId: "small" },
    { provider: "faux", modelId: "large" },
  ]);
  expect((await agent.settings()).model?.modelId).toBe("small");
  expect(await agent.knownRequest("new")).toBe(false);
  expect(faux.state.callCount).toBe(1);
});

test("owner resumes retained work and emits completion without callers acquiring a controller", async () => {
  const events = createKintsugiEventBus();
  const finished = Promise.withResolvers<{ workspaceId: string; agentId: string }>();
  events.on("workspace_agent_turn_finished", event => { finished.resolve(event); });
  const { runtime, faux, registry, open } = await setup({ events });
  const started = Promise.withResolvers<void>();
  let executions = 0;
  registry.install(defineExtension({ name: "unmounted-recovery", tools: [defineTool({
    name: "recover", description: "Resume retained execution", parameters: Type.Object({}), replay: "safe",
    async execute(_args, _api, invocation) {
      if (++executions > 1) return { output: [{ type: "text", text: "Recovered" }] };
      started.resolve();
      return new Promise<never>((_resolve, reject) => invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true }));
    },
  })] }));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("recover", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Recovered without a viewer"),
  ]);
  const agent = await runtime.agent(record);
  await agent.submit({ requestId: "recover-unmounted", text: "Begin" });
  await started.promise;
  await runtime.suspend();
  const reopened = await open();
  expect(executions).toBe(1);
  // No caller acquires a controller, watch, or presentation in the new owner.
  await reopened.resume();
  expect(await finished.promise).toEqual({ workspaceId: "native-workspace", agentId: record.agentId });
  expect(executions).toBe(2);
  expect(faux.state.callCount).toBe(2);
});


test("completion-handler failure is reported without disabling execution observation", async () => {
  const events = createKintsugiEventBus();
  const failure = new Error("Completion consumer failed");
  const reported = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let completions = 0;
  events.on("workspace_agent_turn_finished", async () => {
    if (++completions === 1) throw failure;
    completed.resolve();
  });
  const log = spyOn(console, "error").mockImplementation((message, error) => {
    if (message === "Could not publish Agent turn completion" && error === failure) reported.resolve();
  });
  const busy: boolean[] = [];
  const unsubscribe = subscribeWorkspaceAgentBusy(event => {
    if (event.workspaceId === "native-workspace" && event.agentKey === "agent:tab") busy.push(event.busy);
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const { runtime, faux } = await setup({ events });
    faux.setResponses([fauxAssistantMessage("First answer"), async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("Second answer");
    }]);
    const agent = await runtime.agent(record);
    await (await agent.submit({ requestId: "first", text: "First task" })).wait(context);
    await reported.promise;
    const second = await agent.submit({ requestId: "second", text: "Second task" });
    await entered.promise;
    expect(busy).toEqual([true, false, true]);
    expect(currentNotificationTurn({ workspaceId: "native-workspace", agentId: record.agentId })).toBeDefined();
    release.resolve();
    await second.wait(context);
    await completed.promise;
    expect(busy).toEqual([true, false, true, false]);
    expect(completions).toBe(2);
    expect(log).toHaveBeenCalledWith("Could not publish Agent turn completion", failure);
    expect(currentNotificationTurn({ workspaceId: "native-workspace", agentId: record.agentId })).toBeUndefined();
    await runtime.suspend();
  } finally { release.resolve(); unsubscribe(); log.mockRestore(); }
});

test("user messages exclude retained history before a reset and follow branch selection", async () => {
  const { runtime, faux } = await setup();
  faux.setResponses([fauxAssistantMessage("Old answer"), fauxAssistantMessage("Current answer")]);
  const agent = await runtime.agent(record);
  await (await agent.submit({ requestId: "old", text: "Old unrelated task" })).wait(context);
  const target = (await agent.history({}, 1, undefined, context)).items[0]!;
  await agent.reset();
  expect(await agent.userMessages()).toEqual([]);
  await (await agent.submit({ requestId: "current", text: "Current task" })).wait(context);
  expect(await agent.userMessages()).toEqual(["Current task"]);
  expect(JSON.stringify((await agent.history({}, 100, undefined, context)).items)).toContain("Old unrelated task");
  await agent.navigate(String(target.id));
  expect(await agent.userMessages()).toEqual(["Old unrelated task"]);
});

test("unknown model selection rejects with invalid_arguments and leaves settings unchanged", async () => {
  const { runtime } = await setup();
  const agent = await runtime.agent(record);
  const before = (await agent.settings()).model;
  const result = agent.configure({ model: { provider: "faux", modelId: "missing" } });
  await expect(result).rejects.toBeInstanceOf(KintsugiCoreError);
  await expect(result).rejects.toMatchObject({ code: "invalid_arguments" });
  expect((await agent.settings()).model).toEqual(before);
  await agent.configure({ model: { provider: "faux", modelId: "large" } });
  expect((await agent.settings()).model?.modelId).toBe("large");
});

test.each([undefined, "   ", "  Try a narrower search instead.  "])("aborting one tool preserves the turn and other tool calls (note: %p)", async note => {
  const { runtime, faux, registry } = await setup();
  const started = Promise.withResolvers<void>();
  const survivor = Promise.withResolvers<void>();
  let running = 0;
  let cancelled = false;
  registry.install(defineExtension({ name: "tool-cancellation", tools: [defineTool({
    name: "block", description: "Wait", parameters: Type.Object({ stop: Type.Boolean() }),
    async execute(args, _api, invocation) {
      if (++running === 2) started.resolve();
      if (!args.stop) {
        await survivor.promise;
        return { output: [{ type: "text", text: "Other tool completed" }] };
      }
      return new Promise<never>((_resolve, reject) => {
        invocation.abortSignal!.addEventListener("abort", () => {
          cancelled = true;
          reject(invocation.abortSignal!.reason);
        }, { once: true });
      });
    },
  })] }));
  const stopping = fauxToolCall("block", { stop: true });
  const continuing = fauxToolCall("block", { stop: false });
  faux.setResponses([
    fauxAssistantMessage([stopping, continuing], { stopReason: "toolUse" }),
    request => {
      const results = request.messages.filter(message => message.role === "toolResult");
      const stopped = results.find(message => message.toolCallId === stopping.id)!;
      if (note?.trim()) {
        expect(stopped.content).toEqual([{ type: "text", text: "<harness>\n[error] The user manually cancelled this tool with the following note:\nTry a narrower search instead.\n[error] Tool block was aborted\n</harness>" }]);
      } else {
        expect(stopped.content).toEqual([{ type: "text", text: "<harness>\n[error] Tool block was aborted\n</harness>" }]);
      }
      expect(stopped.isError).toBe(true);
      expect(results.find(message => message.toolCallId === continuing.id)?.content).toEqual([{ type: "text", text: "Other tool completed" }]);
      return fauxAssistantMessage("Continued after stopping just one tool");
    },
  ]);
  const agent = await runtime.agent(record);
  const submission = await agent.submit({ requestId: "abort-one", text: "Begin" });
  await started.promise;
  expect(await agent.abortTool("unknown-call")).toBe(false);
  expect(await agent.abortTool(stopping.id, note)).toBe(true);
  expect(cancelled).toBe(true);
  survivor.resolve();
  expect((await submission.wait(context)).status).toBe("done");
  expect(faux.state.callCount).toBe(2);
  expect(await agent.abortTool(stopping.id)).toBe(false);
});

test("a follow-up promoted to steering joins the running turn after its current step", async () => {
  const { runtime, faux, registry } = await setup();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  registry.install(defineExtension({ name: "blocking-step", tools: [defineTool({
    name: "block", description: "Wait", parameters: Type.Object({}),
    async execute() {
      started.resolve();
      await release.promise;
      return { output: [{ type: "text", text: "Step done" }] };
    },
  })] }));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("block", {})], { stopReason: "toolUse" }),
    request => {
      const users = request.messages.filter(message => message.role === "user");
      expect(JSON.stringify(users.at(-1))).toContain("Promote me");
      return fauxAssistantMessage("Steered answer");
    },
  ]);
  const agent = await runtime.agent(record);
  const original = await agent.submit({ requestId: "original", text: "Start" });
  await started.promise;
  const promoted = await agent.submit({ requestId: "promoted", text: "Promote me", whenBusy: "followUp" });
  const removed = await agent.submit({ requestId: "removed", text: "Remove me", whenBusy: "followUp" });
  expect(await agent.steerQueuedInput(String(promoted.id))).toBe(true);
  expect(await agent.steerQueuedInput(String(promoted.id))).toBe(false);
  expect(await agent.cancelQueuedInput(String(removed.id))).toBe(true);
  release.resolve();
  expect((await original.wait(context)).status).toBe("done");
  expect((await promoted.wait(context)).status).toBe("done");
  expect(faux.state.callCount).toBe(2);
  expect(JSON.stringify((await agent.context(context)).messages)).not.toContain("Remove me");
  // Steering ends the block it interrupted and gets its own.
  const watch = await agent.watch(context);
  const items = projectDurableTranscript(watch.value);
  await watch.stop();
  expect(items.map(item => item.type === "user" ? `user:${item.text}` : item.type)).toEqual(["user:Start", "working", "user:Promote me", "working", "text"]);
  const [interrupted, steered] = items.filter(item => item.type === "working");
  expect(interrupted).toMatchObject({ completedAt: expect.any(Number), items: [{ type: "tool" }] });
  expect(interrupted!.hasFinalAnswer).toBeUndefined();
  expect(steered).toMatchObject({ completedAt: expect.any(Number), hasFinalAnswer: true, items: [] });
});

test("cancelling one queued input leaves the active turn and other steering intact", async () => {
  const { runtime, faux } = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  faux.setResponses([async () => {
    entered.resolve();
    await release.promise;
    return fauxAssistantMessage("Original answer");
  }, fauxAssistantMessage("Kept steering answer")]);
  const agent = await runtime.agent(record);
  const original = await agent.submit({ requestId: "original", text: "Keep running" });
  await entered.promise;
  const cancelled = await agent.submit({ requestId: "cancelled", text: "Remove me" });
  const kept = await agent.submit({ requestId: "kept", text: "Keep me" });
  const other = await runtime.agent({ ...record, agentId: "other" });
  expect(await other.cancelQueuedInput(String(cancelled.id))).toBe(false);
  expect(await agent.cancelQueuedInput(String(cancelled.id))).toBe(true);
  expect(await agent.cancelQueuedInput(String(cancelled.id))).toBe(false);
  expect((await cancelled.status(context)).status).toBe("unanswered");
  expect((await kept.status(context)).status).toBe("queued");
  const duplicate = await agent.submit({ requestId: "cancelled", text: "Must not requeue" });
  expect(duplicate.id).toBe(cancelled.id);
  expect((await duplicate.status(context)).status).toBe("unanswered");
  release.resolve();
  expect((await original.wait(context)).status).toBe("done");
  expect((await kept.wait(context)).status).toBe("done");
  expect(await agent.cancelQueuedInput(String(kept.id))).toBe(false);
  expect(JSON.stringify((await agent.context(context)).messages)).not.toContain("Remove me");
});

test("a follow-up left behind by a turn that failed is shown as not sent, and Steer sends it", async () => {
  const { runtime, faux, registry } = await setup();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  registry.install(defineExtension({ name: "blocking-step-fail", tools: [defineTool({
    name: "block", description: "Wait", parameters: Type.Object({}),
    async execute() {
      started.resolve();
      await release.promise;
      return { output: [{ type: "text", text: "Step done" }] };
    },
  })] }));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("block", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Bad request: invalid" }),
    fauxAssistantMessage("Would answer the follow-up"),
  ]);
  const agent = await runtime.agent(record);
  const original = await agent.submit({ requestId: "original", text: "Start" });
  await started.promise;
  const followUp = await agent.submit({ requestId: "later", text: "Later please", whenBusy: "followUp" });
  release.resolve();
  expect((await original.wait(context)).status).toBe("unanswered");
  const watch = await agent.watch(context);
  const items = projectDurableTranscript(watch.value);
  await watch.stop();
  expect(items.filter(item => item.type === "user" && item.queued).map(item => item.type === "user" && item.queued)).toEqual([{ submissionId: String(followUp.id), mode: "followUp", stranded: true }]);
  expect(await agent.steerQueuedInput(String(followUp.id))).toBe(true);
  expect((await followUp.wait(context)).status).toBe("done");
  expect(faux.state.callCount).toBe(3);
  const after = await agent.watch(context);
  // The bookkeeping write that resumed the queue shows nothing.
  expect(projectDurableTranscript(after.value).map(item => item.type)).toEqual(["user", "working", "error", "user", "working", "text"]);
  await after.stop();
  expect(JSON.stringify((await agent.context(context)).messages)).toContain("Later please");
});

test("sending the newest of three follow-ups a failed turn left behind keeps them in the order they were written", async () => {
  const { runtime, faux, registry } = await setup();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  registry.install(defineExtension({ name: "blocking-step-order-three", tools: [defineTool({
    name: "block", description: "Wait", parameters: Type.Object({}),
    async execute() {
      started.resolve();
      await release.promise;
      return { output: [{ type: "text", text: "Step done" }] };
    },
  })] }));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("block", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Bad request: invalid" }),
    fauxAssistantMessage("Answer"),
    fauxAssistantMessage("Answer"),
    fauxAssistantMessage("Answer"),
  ]);
  const agent = await runtime.agent(record);
  const original = await agent.submit({ requestId: "original", text: "Start" });
  await started.promise;
  const first = await agent.submit({ requestId: "first", text: "First follow-up", whenBusy: "followUp" });
  const second = await agent.submit({ requestId: "second", text: "Second follow-up", whenBusy: "followUp" });
  const third = await agent.submit({ requestId: "third", text: "Third follow-up", whenBusy: "followUp" });
  release.resolve();
  expect((await original.wait(context)).status).toBe("unanswered");
  // Cmd+Enter in an empty composer sends the newest one shown.
  expect(await agent.steerQueuedInput(String(third.id))).toBe(true);
  for (const submission of [first, second, third]) expect((await submission.wait(context)).status).toBe("done");
  const users = (await agent.context(context)).messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content));
  const at = ["First follow-up", "Second follow-up", "Third follow-up"].map(text => users.findIndex(user => user.includes(text)));
  expect(at.every(index => index >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
});

test("work parked after repeated crashes shows as parked until it is retried", async () => {
  const { utimes } = await import("node:fs/promises");
  const path = await mkdtemp(join(tmpdir(), "kintsugi-durable-parked-"));
  paths.push(path);
  const journal = join(path, "journal");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/durable-runtime-crash.ts"), journal], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("crash now")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(await new Response(child.stderr).text());
    output += new TextDecoder().decode(chunk.value);
  }
  child.kill("SIGKILL");
  await child.exited;
  const expired = new Date(Date.now() - 60_000);
  await utimes(`${journal}.lock`, expired, expired);

  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Recovered")]);
  const registry = createRegistry();
  let executions = 0;
  registry.install(defineExtension({ name: "crash-probe", tools: [defineTool({
    name: "probe", description: "Recovers", parameters: Type.Object({}), replay: "safe",
    async execute() { executions++; return { output: [{ type: "text", text: "Recovered tool" }] }; },
  })] }));
  const runtime = await openDurableAgentRuntime(journal, "native-workspace", {}, {
    // One crash is enough to park here; the app keeps pi's default.
    harness: async () => ({ models, registry, settings: { restartLimit: 1 } }),
    prepare: async (): Promise<AgentChange> => { throw new Error("Must not reprepare"); },
    expand: async (_workspace: string, text: string) => text,
    validateModel: async () => {},
    ready: async () => {},
  });
  runtimes.push(runtime);
  const agent = await runtime.agent(record);
  await runtime.resume();
  expect(agent.hasParkedWork).toBe(true);
  expect(agent.hasStoppableWork).toBe(true);
  expect(executions).toBe(0);

  const unparked = new Promise<void>(resolve => { const stop = agent.subscribeWork(() => { if (!agent.hasParkedWork) { stop(); resolve(); } }); });
  expect(await agent.retryParkedWork()).toBe(true);
  await unparked;
  const submission = await agent.submit({ requestId: "crash", text: "Run the probe" });
  expect((await submission.wait(context)).status).toBe("done");
  expect(executions).toBe(1);
  expect(await agent.retryParkedWork()).toBe(false);
}, 30_000);
