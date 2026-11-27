import { durableWorkspaceOwner, isOneShotAgent, WorkspaceAgents } from "@kintsugi/builtin-agent/server";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, defineDoc, type Harness, type EntryId, type Tx } from "@earendil-works/pi-durable";
import { nativeStatus } from "./native-runtime.ts";
import { Delegation } from "./native-state.ts";

// Presentation only. Store the cleared journal position so new activity brings the agent back.
export const SubagentClearance = defineDoc<{ at: Record<string, EntryId | 0> }>({
  kind: "kintsugi.subagent-clearance", version: 1, scope: "session", initial: () => ({ at: {} }), checkpointWhen: () => false,
});

export function isActiveSubagent(agent: { status: string }) {
  return agent.status === "running" || agent.status === "pending";
}

/** Only include the records needed to reach the selected nodes, even through cleared ancestors. */
export function withAncestors<T extends { id: string; parentId: string }>(agents: readonly T[], selected: readonly T[]) {
  const parents = new Map(agents.map(agent => [agent.id, agent.parentId]));
  const ids = new Set<string>();
  for (const { id } of selected) {
    let current: string | undefined = id;
    while (current !== undefined && parents.has(current) && !ids.has(current)) {
      ids.add(current);
      current = parents.get(current);
    }
  }
  return ids;
}

export async function nativeSubagentViews(tx: Tx, rootId?: string) {
  const records = (await tx.doc(WorkspaceAgents)).agents;
  const { at } = await tx.doc(SubagentClearance);
  const agents = [];
  // One-shot agents are Code Mode's, not delegation's.
  for (const record of records.filter(item => item.parentId && !isOneShotAgent(item) && (rootId === undefined || item.rootId === rootId))) {
    const model = (await tx.doc(AgentDoc, record.durableId)).model;
    const status = await nativeStatus(tx, record);
    const mark = at[record.agentId];
    const cleared = mark !== undefined && !isActiveSubagent({ status }) && mark === (await tx.latestEntryId(record.durableId) ?? 0);
    agents.push({
      id: record.agentId, parentId: record.parentId!, rootId: record.rootId!, taskName: record.taskName!, status, cleared, task: record.title,
      model: model ? { provider: model.provider, modelId: model.modelId } : null,
    });
  }
  return agents;
}
export async function nativeSnapshot(workspaceId: string) {
  const owner = await durableWorkspaceOwner(workspaceId);
  const agents = await owner.harness.commit(tx => nativeSubagentViews(tx), context);
  return { agents, messages: Object.values((await owner.harness.snapshot(Delegation, context))?.receipts ?? {}) };
}
export type NativeSubagentView = Awaited<ReturnType<typeof nativeSubagentViews>>[number];

export function clearFinishedSubagents(harness: Harness, rootId: string) {
  return harness.commit(async tx => {
    const { agents: records } = await tx.doc(WorkspaceAgents);
    if (!records.some(record => record.agentId === rootId && !record.parentId)) return null;
    const agents = await nativeSubagentViews(tx, rootId);
    const active = withAncestors(agents, agents.filter(isActiveSubagent));
    const { at } = await tx.doc(SubagentClearance);
    let cleared = 0;
    for (const agent of agents) {
      if (agent.cleared || active.has(agent.id)) continue;
      const record = records.find(item => item.agentId === agent.id)!;
      at[agent.id] = await tx.latestEntryId(record.durableId) ?? 0;
      cleared++;
    }
    return cleared;
  }, context);
}

export function viewPath(agents: readonly NativeSubagentView[], id: string): string {
  const agent = agents.find(item => item.id === id);
  return agent ? `${viewPath(agents, agent.parentId)}/${agent.taskName}` : "/root";
}
