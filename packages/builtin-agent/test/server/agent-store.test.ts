import { sessionShareDir, sessionShareKeySlug } from "@kintsugi/agent/server/session-share";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  removeClosedWorkspaceAgent,
  createNextWorkspaceAgent,
  ensureDefaultWorkspaceAgent as ensureNativeAgent,
  listWorkspaceAgents,
  setWorkspaceAgentTitle,
} from "../../src/server/agent-store.ts";

let dir: string | undefined;

async function dataDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "kintsugi-agent-test-"));
  process.env.KINTSUGI_DATA_DIR = dir;
  return dir;
}

const ensureDefaultWorkspaceAgent = ensureNativeAgent;

async function writeWorkspaceTemplateInit(workspaceId: string, workspaceTemplateId: string, sessionShareKey: string): Promise<void> {
  const path = join(process.env.KINTSUGI_DATA_DIR!, "workspaces", workspaceId, "metadata");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "init.json"), JSON.stringify({ type: "project.git", projectId: workspaceTemplateId, name: "repo", gitUrl: "https://example.com/repo.git", branch: null, sessionShareKey }));
}

afterEach(async () => {
  delete process.env.KINTSUGI_DATA_DIR;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("Workspace Agent store", () => {
  test("project and projectless journals resolve through workspace metadata", async () => {
    const root = await dataDir();
    await writeWorkspaceTemplateInit("front", "frontend", "suite");
    const front = await ensureNativeAgent("front");
    expect(front.path).toBe(join(root, "session-shares", "suite", "builtin-durable", "front"));
    const scratch = await ensureNativeAgent("scratch");
    expect(scratch.path).toBe(join(root, "session-shares", "projectless", "builtin-durable", "scratch"));
  });

  test("concurrent Agent creation assigns unique ordered labels", async () => {
    await dataDir();

    const [defaultA, defaultB] = await Promise.all([
      ensureNativeAgent("ws1"),
      ensureNativeAgent("ws1"),
    ]);
    const created = await Promise.all(Array.from({ length: 4 }, () => createNextWorkspaceAgent("ws1")));

    expect(defaultA.agentId).toBe(defaultB.agentId);
    expect(created.map((agent) => agent.label)).toEqual(["Agent 2", "Agent 3", "Agent 4", "Agent 5"]);
    expect(new Set(created.map((agent) => agent.agentId)).size).toBe(4);
    expect((await listWorkspaceAgents("ws1")).map((agent) => agent.label)).toEqual(["Agent 1", "Agent 2", "Agent 3", "Agent 4", "Agent 5"]);
  });

  test("concurrent list readers observe a newly published agent with its title", async () => {
    await dataDir();

    const creation = ensureNativeAgent("ws1");
    const readers = Array.from({ length: 8 }, () => listWorkspaceAgents("ws1"));
    const [created, ...snapshots] = await Promise.all([creation, ...readers]);

    for (const snapshot of snapshots) expect(snapshot).toEqual([created]);
  });

  test("Agents have immutable identities and mutable titles", async () => {
    await dataDir();
    const created = await ensureDefaultWorkspaceAgent("ws1");
    expect(created.title).toBe("Untitled");

    const renamed = await setWorkspaceAgentTitle(created, "Investigate persistence");

    expect(renamed).toMatchObject({ agentId: created.agentId, title: "Investigate persistence" });
    expect(await listWorkspaceAgents("ws1")).toEqual([renamed]);
  });

  test("removing closed Agent metadata does not resurrect the Agent and permits label reuse", async () => {
    await dataDir();
    const first = await ensureNativeAgent("ws1");
    const second = await createNextWorkspaceAgent("ws1");
    await removeClosedWorkspaceAgent(second);
    expect(await listWorkspaceAgents("ws1")).toEqual([first]);
    expect((await createNextWorkspaceAgent("ws1")).label).toBe("Agent 2");
  });

  test("slugs are filesystem friendly", () => {
    expect(sessionShareKeySlug("Product Suite")).toBe("product-suite");
    expect(sessionShareDir("Product Suite", "/tmp/data")).toBe("/tmp/data/session-shares/product-suite");
  });
});

test("new agents explicitly select durable storage without a legacy transcript", async () => {
  const root = await dataDir();
  const agent = await ensureNativeAgent("native");
  expect(agent.storage).toBe("durable");
  expect(agent.path).toBe(join(root, "session-shares", "projectless", "builtin-durable", "native"));
  expect(await Bun.file(join(root, "workspaces", "native", "agent-sessions", `${agent.agentId}.jsonl`)).exists()).toBe(false);
  const renamed = await setWorkspaceAgentTitle(agent, "Before first turn");
  expect(renamed.storage).toBe("durable");
  await removeClosedWorkspaceAgent(renamed);
  expect(await listWorkspaceAgents("native")).toEqual([]);
});

test("previous Agent metadata preserves IDs and titles and writes only the new vocabulary", async () => {
  const root = await dataDir();
  const metadata = join(root, "workspaces", "previous", "metadata");
  await mkdir(metadata, { recursive: true });
  const record = { conversationId: "retained-agent", label: "Agent 1", title: "Retained title", storage: "durable" };
  await writeFile(join(metadata, "agent-conversations.json"), JSON.stringify({ version: 1, conversations: [record] }));
  const [agent] = await listWorkspaceAgents("previous");
  expect(agent).toMatchObject({ agentId: record.conversationId, title: record.title });
  expect(await Bun.file(join(metadata, "agents.json")).json()).toEqual({
    version: 2, agents: [{ agentId: record.conversationId, label: record.label, title: record.title, storage: "durable" }],
  });
  await removeClosedWorkspaceAgent(agent!);
  expect(await listWorkspaceAgents("previous")).toEqual([]);
});
