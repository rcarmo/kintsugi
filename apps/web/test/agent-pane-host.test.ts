import { expect, test } from "bun:test";
import type { WorkspaceAgentType, WorkspaceAgentTabSummary } from "@kintsugi/shared";
import { createAgentPaneHost } from "../src/server/agent-pane-host.ts";

function occupant(id: string, initial: WorkspaceAgentTabSummary[], settings: Record<string, { model?: string; thinkingLevel?: string }> = {}) {
  let agents = initial;
  const closed: string[] = [];
  const projected: string[][] = [];
  let listCalls = 0;
  const agentType: WorkspaceAgentType = {
    id, label: id, iconHtml: id,
    tabs: {
      list: async () => { listCalls++; return agents; },
      settings: async ({ agentIds }) => {
        projected.push([...agentIds]);
        return new Map(agentIds.flatMap(agentId => agents.some(agent => agent.id === agentId) && settings[agentId] ? [[agentId, settings[agentId]!]] as const : []));
      },
      render: async ({ agentId }) => ({ html: `${id}/${agentId}` }),
      close: async ({ agentId }) => {
        closed.push(agentId);
        agents = agents.filter((agent) => agent.id !== agentId);
      },
    },
    async create() { throw new Error("Listing must not create an agent"); },
    launch: {
      async renderFooter() { return ""; }, async prepare() { return undefined; },
      async submit() { throw new Error("not used"); }, async prepareWorkspace() { throw new Error("Listing must not prepare a workspace"); },
    },
  };
  return { agentType, closed, projected, listCalls: () => listCalls, remove: (id: string) => { agents = agents.filter(agent => agent.id !== id); } };
}

test("empty panes stay empty without preparing a default", async () => {
  const host = createAgentPaneHost([occupant("builtin", []).agentType, occupant("codex", []).agentType]);
  expect(await host.list({ workspaceId: "workspace" })).toEqual([]);
  expect(await host.list({ workspaceId: "workspace" })).toEqual([]);
});

test("mixed Agent types expose ownership and route rendering and closure", async () => {
  const builtin = occupant("builtin", [{ id: "first", title: "First" }]);
  const codex = occupant("codex", [{ id: "second", title: "Second" }, { id: "third", title: "Third" }]);
  const host = createAgentPaneHost([builtin.agentType, codex.agentType]);
  expect((await host.list({ workspaceId: "workspace" })).map(({ id, agentTypeId }) => ({ id, agentTypeId }))).toEqual([
    { id: "first", agentTypeId: "builtin" }, { id: "second", agentTypeId: "codex" }, { id: "third", agentTypeId: "codex" },
  ]);
  expect(await host.render({ workspaceId: "workspace", agentId: "second" })).toEqual({ html: "codex/second" });
  await host.close({ workspaceId: "workspace", agentId: "second" });
  expect(codex.closed).toEqual(["second"]);
  expect(builtin.closed).toEqual([]);
});

test("settings projection is routed on demand without changing the cheap tab catalogue", async () => {
  const builtin = occupant("builtin", [{ id: "first", title: "First" }], { first: { model: "faux/first", thinkingLevel: "high" } });
  const host = createAgentPaneHost([builtin.agentType]);
  expect(await host.list({ workspaceId: "workspace" })).toEqual([{ id: "first", title: "First", agentTypeId: "builtin", iconHtml: "builtin" }]);
  expect(builtin.projected).toEqual([]);
  const tabs = await host.list({ workspaceId: "workspace" });
  expect(await host.settings({ workspaceId: "workspace", agents: tabs })).toEqual(new Map([["first", { model: "faux/first", thinkingLevel: "high" }]]));
  expect(builtin.projected).toEqual([["first"]]);
});

test("captured roster projects settings in one Agent enumeration and omits a vanished row", async () => {
  const tabs = Array.from({ length: 25 }, (_, index) => ({ id: `agent-${index}`, title: `Agent ${index}` }));
  const settings = Object.fromEntries(tabs.map(tab => [tab.id, { model: `faux/${tab.id}`, thinkingLevel: "high" }]));
  const builtin = occupant("builtin", tabs, settings);
  const host = createAgentPaneHost([builtin.agentType]);
  const captured = await host.list({ workspaceId: "workspace" });
  builtin.remove("agent-12");
  const projected = await host.settings({ workspaceId: "workspace", agents: captured });
  expect(builtin.listCalls()).toBe(1);
  expect(builtin.projected).toEqual([captured.map(agent => agent.id)]);
  expect(projected.size).toBe(24);
  expect(projected.has("agent-12")).toBe(false);
});

test("concurrent closures may close the last tab and retain the empty state", async () => {
  const { agentType, closed } = occupant("builtin", [{ id: "first", title: "First" }, { id: "second", title: "Second" }]);
  const host = createAgentPaneHost([agentType]);
  await Promise.all([host.close({ workspaceId: "workspace", agentId: "first" }), host.close({ workspaceId: "workspace", agentId: "second" })]);
  expect(closed).toEqual(["first", "second"]);
  expect(await host.list({ workspaceId: "workspace" })).toEqual([]);
});

test("unknown identities do not reach an Agent type", async () => {
  const { agentType, closed } = occupant("builtin", [{ id: "existing", title: "Existing" }]);
  const host = createAgentPaneHost([agentType]);
  await expect(host.close({ workspaceId: "workspace", agentId: "missing" })).rejects.toMatchObject({ code: "agent_not_found" });
  expect(closed).toEqual([]);
});

test("ambiguous Agent type and Agent identities fail explicitly", async () => {
  const a = occupant("a", [{ id: "same", title: "A" }]).agentType;
  const b = occupant("b", [{ id: "same", title: "B" }]).agentType;
  expect(() => createAgentPaneHost([a, a])).toThrow("Duplicate agent type identity");
  await expect(createAgentPaneHost([a, b]).list({ workspaceId: "workspace" })).rejects.toThrow("Duplicate agent identity");
});
