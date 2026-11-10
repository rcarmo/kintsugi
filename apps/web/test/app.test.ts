import { KintsugiCoreError, createKintsugiEventBus, type KintsugiEventBus } from "@kintsugi/core";
import { type WorkspaceAgentTabProvider, type WorkspaceModule } from "@kintsugi/shared";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createWebApp, type WebApp } from "../src/server/app.ts";
import { workspaceModules } from "../src/server/workspace-modules.generated.ts";
import { createWorkspaceRegistry, type WorkspaceRegistry } from "../src/server/workspace-registry.ts";
import { workspaceWarnings } from "../src/server/workspace-warnings.ts";

interface TestConversation {
  id: string;
  title: string;
}

interface TestAgentModule {
  module: WorkspaceModule;
  conversations: TestConversation[];
  listedWorkspaceIds: string[];
  rendered: Array<{ workspaceId: string; agentId: string }>;
  closed: Array<{ workspaceId: string; agentId: string }>;
}

interface TestAppContext {
  app: WebApp;
  events: KintsugiEventBus;
  registry: WorkspaceRegistry;
  agent: TestAgentModule;
  workspaceId: string;
}


function createTestAgentModule(initial: TestConversation[], created: TestConversation | TestConversation[] = { id: "conversation-new", title: "New Agent" }): TestAgentModule {
  const conversations = initial.map((conversation) => ({ ...conversation }));
  const creations = (Array.isArray(created) ? created : [created]).map((conversation) => ({ ...conversation }));
  const listedWorkspaceIds: string[] = [];
  const rendered: Array<{ workspaceId: string; agentId: string }> = [];
  const closed: Array<{ workspaceId: string; agentId: string }> = [];
  const tabs: WorkspaceAgentTabProvider = {
    async list({ workspaceId }) {
      listedWorkspaceIds.push(workspaceId);
      return conversations.map(({ id, title }) => ({ id, title }));
    },
    async render(context) {
      const conversation = conversations.find((candidate) => candidate.id === context.agentId);
      if (!conversation) throw new KintsugiCoreError("agent_not_found", `Agent not found: ${context.agentId}`);
      rendered.push(context);
      return { html: `<article data-rendered-conversation="${conversation.id}">${conversation.title} body</article>` };
    },
    async close(context) {
      const index = conversations.findIndex((candidate) => candidate.id === context.agentId);
      if (index < 0) throw new KintsugiCoreError("agent_not_found", `Agent not found: ${context.agentId}`);
      conversations.splice(index, 1);
      closed.push(context);
    },
  };
  const module: WorkspaceModule = {
    id: "test-agent",
    agentType: {
      id: "builtin", label: "Builtin", iconHtml: "", tabs,
      async create() {
        const conversation = creations.shift()!;
        conversations.push(conversation);
        return conversation.id;
      },
      launch: {
        async renderFooter() { return ""; }, async prepare() { return undefined; },
        async submit() { throw new Error("not used"); }, async prepareWorkspace() {},
      },
    },
  };
  return { module, conversations, listedWorkspaceIds, rendered, closed };
}

async function withTestApp(
  initial: TestConversation[],
  run: (context: TestAppContext) => Promise<void>,
  created?: TestConversation | TestConversation[],
  additionalModules: WorkspaceModule[] = [],
): Promise<void> {
  const previousDataDir = process.env.KINTSUGI_DATA_DIR;
  const dataDir = await mkdtemp(join(tmpdir(), "kintsugi-app-agent-routes-"));
  const originalModules = workspaceModules.splice(0, workspaceModules.length);
  const agent = createTestAgentModule(initial, created);
  process.env.KINTSUGI_DATA_DIR = dataDir;
  workspaceModules.push(agent.module, ...additionalModules);
  try {
    const registry = createWorkspaceRegistry();
    const events = createKintsugiEventBus();
    const app = createWebApp({
      registry,
      events,
      provisionWorkspace: async () => {},
      deletionReview: { inspect: async () => ({ status: "clear" }), renderEvidence: () => "" },
      destroyWorkspace: async () => {},
      persistWorkspaceParked: async () => {},
      logError: () => {},
    });
    const workspaceId = "workspace-agent-routes";
    await registry.seed([{ id: workspaceId, title: "Agent routes" }]);
    await Bun.sleep(0);
    await run({ app, events, registry, agent, workspaceId });
  } finally {
    workspaceModules.splice(0, workspaceModules.length, ...originalModules);
    if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe("Agent type app integration", () => {
  test("automation retains command schemas and lists host agent commands once", async () => {
    const inputSchema = Type.Object({ value: Type.String() });
    await withTestApp([], async ({ app, workspaceId }) => {
      const response = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}`, { headers: { accept: "application/json" } }));
      const { workspace } = await response.json();
      expect(workspace.commands.find((command: { id: string }) => command.id === "test.command").inputSchema).toEqual(JSON.parse(JSON.stringify(inputSchema)));
      expect(workspace.commands.map((command: { id: string }) => command.id)).toEqual(["test.command", "agent.create", "agent.create.builtin"]);
    }, undefined, [{
      id: "test-command",
      commands: [{ id: "test.command", execute() { return {}; } }],
      attachToWorkspace() { return { commands: [{ id: "test.command", label: "Test command", scope: "workspace", inputSchema }] }; },
    }]);
  });

  test("warning dismissal does not attach modules or list Agents", async () => {
    await withTestApp([{ id: "conversation-a", title: "Alpha" }], async ({ app, agent, registry, workspaceId }) => {
      registry.setWarning(workspaceId, "preparation", "Gateway unavailable");
      const warning = workspaceWarnings(registry.get(workspaceId)!, undefined)[0]!;
      const response = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}/warnings/preparation/dismiss`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ state: warning.state }),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ dismissed: true });
      expect(agent.listedWorkspaceIds).toEqual([]);
    }, undefined, [{ id: "must-not-attach", attachToWorkspace() { throw new Error("Warning dismissal attached a module"); } }]);
  });

});

for (const operation of ["createWorkView", "presentWorkViewFromAgent"] as const) {
  test(`${operation} initializes Work views without a prior workspace read`, async () => {
    const types = ["default-view", "requested-view", "unopened-view"];
    const module: WorkspaceModule = {
      id: "test-work-views",
      workViews: types.map(type => ({
        type,
        parseReference: () => ({ type }),
        identity: () => "workspace",
        render: async () => "",
      })),
      attachToWorkspace: () => ({
        workViews: types.map(type => ({
          reference: { type }, sourceKey: `${type}:workspace`, label: type, kind: "resource" as const,
          availability: { phase: "live" as const }, initiallyOpen: type === "default-view",
        })),
      }),
    };
    await withTestApp([], async ({ app, workspaceId, agent }) => {
      await app[operation](workspaceId, { type: "requested-view" });
      await app[operation](workspaceId, { type: "requested-view" });
      const state = JSON.parse(await readFile(join(process.env.KINTSUGI_DATA_DIR!, "workspaces", workspaceId, "metadata", "presentation.json"), "utf8"));
      expect(state.workViews).toEqual([
        { reference: { type: "default-view" } },
        { reference: { type: "requested-view" } },
      ]);
      expect(agent.listedWorkspaceIds).toEqual([]);
      expect(agent.rendered).toEqual([]);
    }, undefined, [module]);
  });
}

test("a workspace command refreshes each contributed live resource once", async () => {
  let loads = 0;
  await withTestApp([], async ({ app, workspaceId }) => {
    await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}`, { headers: { accept: "application/json" } }));
    const subscription = await app.subscribeSurface({ channel: "module", name: "surface", workspaceId, params: { kind: "test-resource" } }, () => {});
    expect(loads).toBe(1);
    const response = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}/commands/test.update`, {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(200);
    await Bun.sleep(0);
    expect(loads).toBe(2);
    subscription.unsubscribe();
  }, undefined, [{
    id: "test-updates",
    commands: [{ id: "test.update", execute: () => ({}) }],
    liveSurfaces: [{ name: "test-resource", async load() { loads++; return []; } }],
  }]);
});

test("the theme is a server setting pushed to every open page", async () => {
  await withTestApp([], async ({ app }) => {
    const pushed: string[] = [];
    const subscription = await app.subscribeShell((html) => pushed.push(html));
    const response = await app.fetch(new Request("http://test.local/settings/theme", {
      method: "POST", headers: { accept: "text/vnd.turbo-stream.html" }, body: new URLSearchParams({ theme: "tokyo-night" }),
    }));
    expect(response.status).toBe(200);
    await Bun.sleep(10);
    expect(pushed.join("")).toContain('data-kintsugi-theme-name-value="tokyo-night"');
    expect(JSON.parse(await readFile(join(process.env.KINTSUGI_DATA_DIR!, "theme.json"), "utf8"))).toEqual({ theme: "tokyo-night" });
    const rejected = await app.fetch(new Request("http://test.local/settings/theme", { method: "POST", body: new URLSearchParams({ theme: "neon" }) }));
    expect(rejected.status).toBe(400);
    subscription.unsubscribe();
  });
});

test("a failed work-view loader does not reject the workspace channel or its agent", async()=>{
  let attempts=0;let fail=true;
  const module:WorkspaceModule={id:"faulting-preview",workViews:[{type:"faulting-preview",parseReference:()=>({type:"faulting-preview"}),identity:()=>"one",render:async()=>{attempts++;if(fail)throw new Error("Workspace ingress origin capacity exhausted in range 41000-41009");return "Recovered preview";}}],attachToWorkspace:()=>({workViews:[{key:"faulting-preview:one",sourceKey:"faulting-preview:one",kind:"resource",label:"Preview",reference:{type:"faulting-preview"},availability:{phase:"live"}}]})};
  await withTestApp([{id:"agent-one",title:"Agent one"}],async({app,workspaceId,agent})=>{
    await app.createWorkView(workspaceId,{type:"faulting-preview"});
    let messages=0;const subscription=await app.subscribeSurface({channel:"module",name:"surface",workspaceId,params:{kind:"workspace",agent:"agent-one",work:"faulting-preview:one"}},()=>{messages++;});
    expect(attempts).toBe(0);
    const agentSubscription = await app.subscribeSurface({channel:"module",name:"surface",workspaceId,params:{kind:"agent-pane",key:"agent-one"}},()=>{});
    expect(agent.rendered).toContainEqual({workspaceId,agentId:"agent-one"});
    await expect(app.subscribeSurface({channel:"module",name:"surface",workspaceId,params:{kind:"work-view-body",key:"faulting-preview:one"}},()=>{})).rejects.toThrow("Workspace ingress origin capacity exhausted");
    expect(attempts).toBe(1);
    expect(messages).toBeGreaterThan(0);subscription.unsubscribe();agentSubscription.unsubscribe();
    fail=false;
    expect((await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}?retryPane=1`,{headers:{Accept:"application/json"}}))).status).toBe(200);
    const recovered=await app.subscribeSurface({channel:"module",name:"surface",workspaceId,params:{kind:"work-view-body",key:"faulting-preview:one"}},()=>{});expect(attempts).toBe(2);recovered.unsubscribe();
    const workspace=await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}`,{headers:{Accept:"application/json"}}));expect(workspace.status).toBe(200);
  },undefined,[module]);
});

test("force parking a failed workspace does not need live pane adapters", async () => {
  const module: WorkspaceModule = { id: "unavailable-terminal", attachToWorkspace: () => ({ workViews: [{key: "terminal:one", sourceKey: "terminal:one", kind: "resource", label: "Shell", reference: {type: "terminal"}, availability: {phase: "live"}}] }), workViews: [{ type: "terminal", parseReference: () => ({ type: "terminal" }), identity: () => "one", async render() { throw Error("Container stopped"); }, async close() { throw Error("Cannot attach to stopped container"); } }] };
  await withTestApp([], async ({ app, registry, workspaceId }) => {
    await app.createWorkView(workspaceId, { type: "terminal" });
    registry.startProvisioning(workspaceId); registry.setProvisioningState(workspaceId, "failed", "Workspace stopped after OOM");
    const response = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}/park?force=1`, { method: "POST", headers: { Origin: "http://test.local", Accept: "application/json" } }));
    expect(response.status).toBe(200); expect(registry.get(workspaceId)!.parked).toBe(true);
    expect(registry.get(workspaceId)!.phase.kind).toBe("runningPhase");
  }, undefined, [module]);
});

test.each(["stopped", "hung"])("home and settings stay available without touching a %s workspace container", async mode => {
  let calls = 0;
  const module: WorkspaceModule = { id: "unresponsive-workspace", attachToWorkspace: async () => {
    calls++;
    if (mode === "stopped") throw Error("Error response from daemon: container fixture-container is not running");
    return new Promise(() => {});
  } };
  await withTestApp([], async ({ app, workspaceId }) => {
    for (const path of ["/", "/settings", `/workspaces/${workspaceId}`]) {
      const response = await app.fetch(new Request(`http://test.local${path}`, { headers: { Accept: "text/html" } }));
      expect(response.status).toBe(200);
    }
    expect((await app.fetch(new Request("http://test.local/", { method: "HEAD" }))).status).toBe(200);
    expect(calls).toBe(0);
    if (mode === "stopped") {
      let received = 0;
      const subscription = await app.subscribeSurface({channel: "module", name: "surface", workspaceId, params: {kind: "workspace"}}, () => { received++; });
      expect(calls).toBe(1); expect(received).toBeGreaterThan(0);
      expect((await app.fetch(new Request("http://test.local/"))).status).toBe(200);
      subscription.unsubscribe();
    }
  }, undefined, [module]);
});
