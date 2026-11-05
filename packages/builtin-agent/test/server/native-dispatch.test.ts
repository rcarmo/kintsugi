import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { AgentPresentation } from "../../src/server/agent-presentation.ts";
import { openDurableAgentRuntime } from "../../src/server/durable-runtime.ts";
import { durableWorkspaceOwner, retainedDurableWorkspaceOwner, suspendAllDurableWorkspaceOwners } from "../../src/server/runtime.ts";
import { getWorkspaceAgentController, getWorkspaceAgentPresentation, unloadWorkspaceAgentPresentation, closeWorkspaceAgent, removeWorkspaceAgentRuntimes, suspendWorkspaceAgentRuntimes, allowWorkspaceAgentResume } from "../../src/server/runtime.ts";
import { removeClosedWorkspaceAgent, ensureDefaultWorkspaceAgent, listWorkspaceAgents, setWorkspaceAgentTitle } from "../../src/server/agent-store.ts";

const originalDataDir = process.env.KINTSUGI_DATA_DIR;
let directory: string;
afterEach(async () => {
  await suspendAllDurableWorkspaceOwners();
  if (originalDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = originalDataDir;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("production dispatch reattaches native journal, deduplicates passively, retains titles and fences close/delete", async () => {
  directory = await mkdtemp(join(tmpdir(), "native-dispatch-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  const workspaceId = `native-${crypto.randomUUID()}`;
  const agent = await ensureDefaultWorkspaceAgent(workspaceId);
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "test" }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Persisted answer")]);
  const initial = await openDurableAgentRuntime(agent.path, workspaceId, {}, {
    harness: async () => ({ models, registry: createRegistry() }),
    prepare: async () => ({ model: { provider: "faux", modelId: "test" }, thinkingLevel: "off" }),
    expand: async (_workspace, text) => text, ready: async () => {}, validateModel: async () => {},
  });
  const controller = await initial.agent(agent);
  await (await controller.submit({ text: "Persisted request", requestId: "admitted" })).wait(BACKGROUND_CONTEXT);
  await initial.suspend();

  const [runtime, same] = await Promise.all([getWorkspaceAgentPresentation(agent), getWorkspaceAgentPresentation(agent)]);
  expect(runtime).toBeInstanceOf(AgentPresentation);
  expect(runtime).toBe(same);
  const commands = await getWorkspaceAgentController(agent);
  expect(await commands.userMessages()).toEqual(["Persisted request"]);
  expect(await commands.knownRequest("admitted")).toBe(true);
  // No container or available Faux auth exists. A duplicate still succeeds.
  await commands.submit({ text: "Different retry", requestId: "admitted" });
  expect(runtime.currentModel()).toEqual({ provider: "faux", id: "test" });
  const named = await setWorkspaceAgentTitle(agent, "Retained native title");
  expect((await (await durableWorkspaceOwner(workspaceId)).catalog())[0]!.title).toBe(named.title);
  const disposing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalDispose = runtime.dispose.bind(runtime);
  const dispose = spyOn(runtime, "dispose").mockImplementation(async () => { disposing.resolve(); await release.promise; await originalDispose(); });
  const unloading = unloadWorkspaceAgentPresentation(workspaceId, agent.agentId);
  await disposing.promise;
  let mounted = false;
  const mounting = getWorkspaceAgentPresentation(named).then(value => { mounted = true; return value; });
  await Bun.sleep(5);
  expect(mounted).toBe(false);
  release.resolve();
  await unloading;
  dispose.mockRestore();
  const reopened = await mounting;
  expect(reopened).not.toBe(runtime);
  expect(await (await getWorkspaceAgentController(named)).userMessages()).toEqual(["Persisted request"]);
  // Park and close overlap: closure must reopen passively after disposal and
  // persist its fence rather than operating on a just-suspended owner.
  const parking = suspendWorkspaceAgentRuntimes(workspaceId);
  const closing = closeWorkspaceAgent(workspaceId, agent.agentId);
  await parking;
  await closing;
  allowWorkspaceAgentResume(workspaceId);
  expect((await (await durableWorkspaceOwner(workspaceId)).admission())?.closed).toContain(controller.id);
  await removeClosedWorkspaceAgent(named);
  expect(await listWorkspaceAgents(workspaceId)).toEqual([]);
  // Deletion must fence the retained owner even when no mounted tabs remain.
  await removeWorkspaceAgentRuntimes(workspaceId);
  const retained = await durableWorkspaceOwner(workspaceId);
  const history = await retained.agent(named);
  expect((await history.history({}, 100, undefined, BACKGROUND_CONTEXT)).items.length).toBeGreaterThan(0);
  await expect(history.knownRequest("admitted")).rejects.toThrow("deleted");
  expect(faux.state.callCount).toBe(1);
});


test("unloading the last presentation leaves the owner and its execution running", async () => {
  directory = await mkdtemp(join(tmpdir(), "native-unload-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  const workspaceId = `native-${crypto.randomUUID()}`;
  const agent = await ensureDefaultWorkspaceAgent(workspaceId);
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "test" }] });
  models.setProvider(faux.provider);
  const owner = await retainedDurableWorkspaceOwner(agent.path, workspaceId, {}, {
    harness: async () => ({ models, registry: createRegistry() }),
    prepare: async () => ({ model: { provider: "faux", modelId: "test" } }),
    expand: async (_workspace, text) => text, ready: async () => {}, validateModel: async () => {},
  });
  const controller = await owner.agent(agent);
  const mounted = await getWorkspaceAgentPresentation(agent);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("Completed after view disposal"); }]);
  try {
    const submission = await controller.submit({ requestId: "unload", text: "Keep working" });
    await entered.promise;
    await unloadWorkspaceAgentPresentation(workspaceId, agent.agentId);
    expect(await durableWorkspaceOwner(workspaceId)).toBe(owner);
    expect((await submission.status(BACKGROUND_CONTEXT)).status).toBe("placed");
    release.resolve();
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(faux.state.callCount).toBe(1);
    const remounted = await getWorkspaceAgentPresentation(agent);
    expect(remounted).not.toBe(mounted);
    await unloadWorkspaceAgentPresentation(workspaceId, agent.agentId);
  } finally {
    release.resolve();
  }
});

test.each(["close", "suspend", "delete"] as const)("%s drains first controller acquisition before applying its lifecycle fence", async operation => {
  directory = await mkdtemp(join(tmpdir(), `native-acquire-${operation}-`));
  process.env.KINTSUGI_DATA_DIR = directory;
  const workspaceId = `native-${crypto.randomUUID()}`;
  const agent = await ensureDefaultWorkspaceAgent(workspaceId);
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "test" }] });
  models.setProvider(faux.provider);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owner = await retainedDurableWorkspaceOwner(agent.path, workspaceId, {}, {
    harness: async () => ({ models, registry: createRegistry() }),
    prepare: async () => { entered.resolve(); await release.promise; return { model: { provider: "faux", modelId: "test" } }; },
    expand: async (_workspace, text) => text, ready: async () => {}, validateModel: async () => {},
  });
  // No presentation promise exists for the lifecycle operation to await.
  const acquiring = getWorkspaceAgentController(agent);
  await entered.promise;
  expect(await owner.catalog()).toEqual([]);
  let fenced = false;
  const ending = (operation === "close" ? closeWorkspaceAgent(workspaceId, agent.agentId)
    : operation === "suspend" ? suspendWorkspaceAgentRuntimes(workspaceId) : removeWorkspaceAgentRuntimes(workspaceId))
    .then(() => { fenced = true; });
  try {
    await Bun.sleep(5);
    expect(fenced).toBe(false);
  } finally {
    release.resolve();
  }
  const controller = await acquiring;
  await ending;
  await expect(controller.submit({ requestId: "after-fence", text: "Must not run" })).rejects.toThrow(operation === "close" ? "closed" : "suspended");
  expect(() => getWorkspaceAgentController(agent)).toThrow(operation === "close" ? "Agent not found" : operation === "suspend" ? "suspended" : "workspace not found");
  expect(faux.state.callCount).toBe(0);
  if (operation === "close") expect((await owner.admission())?.closed).toContain(controller.id);
  if (operation === "delete") expect((await (await durableWorkspaceOwner(workspaceId)).admission())?.deleted).toBe(true);
});
