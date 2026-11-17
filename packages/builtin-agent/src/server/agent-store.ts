import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createKeyedOperationQueue, getKintsugiRuntimeContext, isJsonObject, readTextIfExists, writeJsonAtomic } from "@kintsugi/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { sessionShareDir, workspaceSessionShareKey } from "@kintsugi/agent/server/session-share";

export interface WorkspaceAgentInfo {
  workspaceId: string;
  agentId: string;
  label: string;
  title: string;
  path: string;
  storage?: "durable";
  readOnly?: boolean;
  /** A script's one-shot agent, whose final answer is JSON. */
  oneShot?: boolean;
}

export const untitledAgentTitle = "Untitled";
const serializeAgentOperation = createKeyedOperationQueue();

interface AgentRecord { agentId: string; label: string; title: string; storage: "durable" }
const agentsSchema = Type.Object({ version: Type.Literal(2), agents: Type.Array(Type.Object({ agentId: Type.String(), label: Type.String(), title: Type.String(), storage: Type.Literal("durable") })) });
const previousAgentsSchema = Type.Object({ version: Type.Literal(1), conversations: Type.Array(Type.Object({ conversationId: Type.String(), label: Type.String(), title: Type.String(), storage: Type.Literal("durable") })) });
function agentMetadataPath(workspaceId: string): string {
  return join(getKintsugiRuntimeContext().kintsugiDataDir, "workspaces", workspaceId, "metadata", "agents.json");
}
async function agentRecords(workspaceId: string): Promise<AgentRecord[]> {
  const content = await readTextIfExists(agentMetadataPath(workspaceId));
  if (content !== undefined) {
    const value: unknown = JSON.parse(content);
    Value.Assert(agentsSchema, value);
    return value.agents;
  }
  // Read the actual previous format once; all subsequent writes use Agent names.
  const previousContent = await readTextIfExists(join(getKintsugiRuntimeContext().kintsugiDataDir, "workspaces", workspaceId, "metadata", "agent-conversations.json"));
  const previous: unknown = previousContent === undefined ? undefined : JSON.parse(previousContent);
  if (isJsonObject(previous) && previous.version !== undefined) {
    Value.Assert(previousAgentsSchema, previous);
    const records = previous.conversations.map(({ conversationId, ...record }) => ({ ...record, agentId: conversationId }));
    await saveAgentRecords(workspaceId, records);
    return records;
  }
  const { convertLegacyAgents } = await import("@kintsugi/legacy-converter");
  const records = await convertLegacyAgents({
    workspaceId,
    workspaceDirectory: join(getKintsugiRuntimeContext().kintsugiDataDir, "workspaces", workspaceId),
    shareDirectory: sessionShareDir(await workspaceSessionShareKey(workspaceId)),
    metadata: previousContent,
    destination: async () => {
      const { durableWorkspaceOwner } = await import("./runtime.ts");
      return durableWorkspaceOwner(workspaceId);
    },
  });
  if (previousContent !== undefined || records.length) await saveAgentRecords(workspaceId, records);
  return records;
}
async function saveAgentRecords(workspaceId: string, records: AgentRecord[]): Promise<void> {
  await writeJsonAtomic(agentMetadataPath(workspaceId), { version: 2, agents: records });
}
async function persistAgent(agent: WorkspaceAgentInfo): Promise<void> {
  const records = (await agentRecords(agent.workspaceId)).filter((item) => item.agentId !== agent.agentId);
  records.push({ agentId: agent.agentId, label: agent.label, title: agent.title, storage: "durable" });
  await saveAgentRecords(agent.workspaceId, records);
}

async function createWorkspaceAgent(workspaceId: string, label: string): Promise<WorkspaceAgentInfo> {
  const agentId = randomUUID();
  const { workspaceDurableJournalDirectory } = await import("./durable-storage.ts");
  const path = await workspaceDurableJournalDirectory(workspaceId);
  const agent: WorkspaceAgentInfo = { workspaceId, agentId, label, title: untitledAgentTitle, path, storage: "durable" };
  await persistAgent(agent);
  return agent;
}

export async function ensureDefaultWorkspaceAgent(workspaceId: string): Promise<WorkspaceAgentInfo> {
  return await serializeAgentOperation(workspaceId, async () => {
    const current = (await listWorkspaceAgentsUnlocked(workspaceId)).find((agent) => agent.label === "Agent 1");
    return current ?? await createWorkspaceAgent(workspaceId, "Agent 1");
  });
}

async function listWorkspaceAgentsUnlocked(workspaceId: string): Promise<WorkspaceAgentInfo[]> {
  const { workspaceDurableJournalDirectory, durableJournalExists } = await import("./durable-storage.ts");
  const journal = await workspaceDurableJournalDirectory(workspaceId);
  const local: WorkspaceAgentInfo[] = (await agentRecords(workspaceId)).map(info => ({ ...info, workspaceId, path: journal }));
  // The journal catalog wins after a crash between a metadata commit and tab metadata.
  if (local.length && durableJournalExists(journal)) {
    const { durableWorkspaceOwner } = await import("./runtime.ts");
    const catalog = await (await durableWorkspaceOwner(workspaceId)).catalog();
    for (const agent of local) {
      const committed = catalog.find(record => record.agentId === agent.agentId);
      if (committed) { agent.title = committed.title; agent.readOnly = committed.readOnly; }
    }
  }
  return local.sort((a, b) => Number(a.label.slice(6)) - Number(b.label.slice(6)));
}

export async function listWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgentInfo[]> {
  return await serializeAgentOperation(workspaceId, async () => await listWorkspaceAgentsUnlocked(workspaceId));
}

export async function createNextWorkspaceAgent(workspaceId: string): Promise<WorkspaceAgentInfo> {
  return await serializeAgentOperation(workspaceId, async () => {
    const used = new Set((await listWorkspaceAgentsUnlocked(workspaceId)).map((agent) => Number(agent.label.slice("Agent ".length))));
    let next = 1;
    while (used.has(next)) next += 1;
    return await createWorkspaceAgent(workspaceId, `Agent ${next}`);
  });
}

export async function setWorkspaceAgentTitle(agent: WorkspaceAgentInfo, title: string): Promise<WorkspaceAgentInfo> {
  if (!title.trim()) throw new Error("Agent title must not be empty");
  return await serializeAgentOperation(agent.workspaceId, async () => {
    const current = (await listWorkspaceAgentsUnlocked(agent.workspaceId)).find((item) => item.agentId === agent.agentId)!;
    const updated = { ...current, title };
    const { existingDurableController } = await import("./runtime.ts");
    await (await existingDurableController(current))?.setTitle(title);
    await persistAgent(updated);
    return updated;
  });
}

/** Remove a closed Agent from the active list without deleting its transcript. */
export async function removeClosedWorkspaceAgent(agent: WorkspaceAgentInfo): Promise<void> {
  await serializeAgentOperation(agent.workspaceId, async () => {
    const current = (await listWorkspaceAgentsUnlocked(agent.workspaceId)).find((item) => item.agentId === agent.agentId)!;
    await saveAgentRecords(current.workspaceId, (await agentRecords(current.workspaceId)).filter((item) => item.agentId !== current.agentId));
  });
}
