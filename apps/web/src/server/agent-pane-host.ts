import { KintsugiCoreError, kintsugiDataPath, createKeyedOperationQueue, getKintsugiRuntimeContext, readTextIfExists, writeJsonAtomic } from "@kintsugi/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { placeLiveRegions, type WorkspaceAgentType, type WorkspaceAgentTab } from "@kintsugi/shared";

const tabOrderSchema = Type.Array(Type.String());

export interface HostedAgentTab extends WorkspaceAgentTab {
  iconHtml: string;
}

/** The host routes globally unique Agent identities without interpreting Agent type storage. */
export function createAgentPaneHost(agentTypes: readonly WorkspaceAgentType[]) {
  const byId = new Map(agentTypes.map((agentType) => [agentType.id, agentType]));
  if (byId.size !== agentTypes.length) throw new Error("Duplicate agent type identity");

  const serialize = createKeyedOperationQueue();

  async function list(context: { workspaceId: string }): Promise<HostedAgentTab[]> {
    return serialize(context.workspaceId, async () => {
      const tabs = (await Promise.all(agentTypes.map(async (agentType) =>
        (await agentType.tabs.list(context)).map((tab) => ({ ...tab, agentTypeId: agentType.id, iconHtml: agentType.iconHtml })),
      ))).flat();
      const byAgent = new Map(tabs.map(tab => [tab.id, tab]));
      if (byAgent.size !== tabs.length) throw new Error("Duplicate agent identity");
      const path = kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", context.workspaceId, "metadata", "agent-tab-order.json");
      const content = await readTextIfExists(path);
      const saved: unknown = content === undefined ? [] : JSON.parse(content);
      Value.Assert(tabOrderSchema, saved);
      const order = [
        ...saved.filter(id => byAgent.has(id)),
        ...tabs.filter(tab => !saved.includes(tab.id)).map(tab => tab.id),
      ];
      if (order.length !== saved.length || order.some((id, index) => id !== saved[index])) await writeJsonAtomic(path, order);
      return order.map(id => byAgent.get(id)!);
    });
  }

  async function owner(context: { workspaceId: string; agentId: string }) {
    const tab = (await list(context)).find((tab) => tab.id === context.agentId);
    if (!tab) throw new KintsugiCoreError("agent_not_found", `Agent not found: ${context.agentId}`);
    return byId.get(tab.agentTypeId)!;
  }

  return {
    list,
    async settings(context: { workspaceId: string; agents: readonly WorkspaceAgentTab[] }) {
      const groups = new Map<string, string[]>();
      for (const agent of context.agents) {
        const agentType = byId.get(agent.agentTypeId);
        if (!agentType) continue;
        const ids = groups.get(agent.agentTypeId);
        if (ids) ids.push(agent.id);
        else groups.set(agent.agentTypeId, [agent.id]);
      }
      const projected = await Promise.all([...groups].map(async ([agentTypeId, agentIds]) =>
        await byId.get(agentTypeId)!.tabs.settings?.({ workspaceId: context.workspaceId, agentIds }),
      ));
      const result = new Map<string, import("@kintsugi/shared").WorkspaceAgentSettings>();
      for (const settings of projected) if (settings) for (const [id, value] of settings) result.set(id, value);
      return result;
    },
    async render(context: { workspaceId: string; agentId: string }) {
      const pane = await (await owner(context)).tabs.render(context);
      if (!pane.live) return pane;
      // Mount the committed state with its shell: controls must not stay empty
      // while the Agent's live subscription connects. Digests let that subscription
      // skip unchanged regions without dropping the first paint.
      return { ...pane, html: placeLiveRegions(pane.html, pane.live.regions(), pane.live.subscriberId) };
    },
    async close(context: { workspaceId: string; agentId: string }) {
      return (await owner(context)).tabs.close(context);
    },
  };
}
