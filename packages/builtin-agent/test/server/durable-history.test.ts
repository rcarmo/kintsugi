import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { retainedDurableHistories } from "../../src/server/durable-history.ts";
import { retainedDurableWorkspaceOwner, suspendAllDurableWorkspaceOwners } from "../../src/server/runtime.ts";
import { durableJournalDirectory } from "../../src/server/durable-storage.ts";
import { ensureDefaultWorkspaceAgent, listWorkspaceAgents } from "../../src/server/agent-store.ts";

const original = process.env.KINTSUGI_DATA_DIR;
let directory: string;
afterEach(async () => {
  await suspendAllDurableWorkspaceOwners();
  if (original === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = original;
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function setup() {
  directory = await mkdtemp(join(tmpdir(), "kintsugi-history-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  const load = {
    harness: async () => ({ models, registry: createRegistry() }),
    prepare: async () => ({ model: { provider: "faux", modelId: "faux-1" } }),
    validateModel: async (_ref: { provider: string; modelId: string } | undefined) => {},
    ready: async () => {}, expand: async (_workspace: string, text: string) => text,
  };
  async function workspaceTemplate(id: string, share: string) {
    const path = join(directory, "workspaces", id, "metadata");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "init.json"), JSON.stringify({ type: "project.git", projectId: "p", name: "p", gitUrl: "https://example.com/p.git", branch: null, sessionShareKey: share }));
  }
  return { faux, load, workspaceTemplate };
}

test("retained discovery is share-scoped and reads closed/deleted native history without workspace metadata or readiness", async () => {
  const { faux, load, workspaceTemplate } = await setup();
  await workspaceTemplate("viewer", "team");
  await workspaceTemplate("deleted", "team");
  faux.setResponses([fauxAssistantMessage("Retained answer")]);
  const path = durableJournalDirectory("team", "deleted");
  const owner = await retainedDurableWorkspaceOwner(path, "deleted", {}, load);
  const controller = await owner.agent({ agentId: "tab", title: "Retained title", label: "Agent 1" });
  await (await controller.submit({ requestId: "once", text: "Retained input" })).wait(BACKGROUND_CONTEXT);
  await controller.close();
  await owner.delete();
  await rm(join(directory, "workspaces", "deleted"), { recursive: true });
  const foreign = await retainedDurableWorkspaceOwner(durableJournalDirectory("other-team", "foreign"), "foreign", {}, load);
  await foreign.agent({ agentId: "foreign-tab", title: "Private", label: "Agent 1" });
  load.ready = async () => { throw new Error("Read-only discovery must not probe execution"); };
  load.prepare = async () => { throw new Error("Read-only discovery must not prepare prompts"); };
  const before = await readFile(join(path, "main.jsonl"), "utf8");
  const histories = await retainedDurableHistories("viewer");
  expect(histories.map(item => item.workspaceId)).toEqual(["deleted"]);
  const found = histories[0]!;
  expect(found.owner).toBe(owner);
  expect((await found.owner.catalog())[0]?.title).toBe("Retained title");
  expect((await found.owner.admission())?.deleted).toBe(true);
  const view = await controller.historyView();
  expect(JSON.stringify(view)).toContain("Retained answer");
  expect(await readFile(join(path, "main.jsonl"), "utf8")).toBe(before);
  expect(faux.state.callCount).toBe(1);
});

test("retained discovery requires an existing viewer and cannot fall through to projectless history", async () => {
  const { load } = await setup();
  const owner = await retainedDurableWorkspaceOwner(durableJournalDirectory("projectless", "deleted"), "deleted", {}, load);
  await owner.agent({ agentId: "private", title: "Projectless history", label: "Agent 1" });
  for (const viewer of ["missing", "deleted", "../workspaces", "/absolute", "..", "viewer/child"]) {
    await expect(retainedDurableHistories(viewer)).rejects.toThrow();
  }
  // A real projectless viewer need not have an init.json or running container.
  await mkdir(join(directory, "workspaces", "viewer", "metadata"), { recursive: true });
  expect((await retainedDurableHistories("viewer")).map(item => item.workspaceId)).toEqual(["deleted"]);
  await rm(join(directory, "workspaces", "viewer"), { recursive: true });
  await expect(retainedDurableHistories("viewer")).rejects.toThrow("workspace not found");
});

test("committed catalog title reconciles stale tab metadata without reopening a closed tab", async () => {
  const { load } = await setup();
  const agent = await ensureDefaultWorkspaceAgent("workspace");
  const owner = await retainedDurableWorkspaceOwner(agent.path, agent.workspaceId, {}, load);
  const controller = await owner.agent(agent);
  await controller.setTitle("Committed rename");
  const metadata = join(directory, "workspaces", "workspace", "metadata", "agents.json");
  expect(await readFile(metadata, "utf8")).toContain("Untitled");
  expect((await listWorkspaceAgents("workspace"))[0]?.title).toBe("Committed rename");
  await controller.close();
  await writeFile(metadata, JSON.stringify({ version: 2, agents: [] }));
  expect(await listWorkspaceAgents("workspace")).toEqual([]);
  expect((await retainedDurableHistories("workspace"))[0]?.owner).toBe(owner);
  expect((await owner.catalog())[0]?.title).toBe("Committed rename");
});
