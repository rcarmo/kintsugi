import type { KintsugiEventBus, JsonObject } from "@kintsugi/core";
import type { WorkspaceAgentSettings, WorkspaceModule } from "@kintsugi/shared";
import type { createCliModelSettings } from "@kintsugi/cli-agent/server";
import type { NativeAgentRuntime, NativeAgents } from "./agents.ts";
import type { NativeAgentRendering } from "./render.ts";
import { parseModelRef } from "@kintsugi/llm/server";

/** Path parameters of every native Agent route. */
export const nativeAgentParameters = ["id", "agentId"].map(name => ({ name, in: "path", required: true, schema: { type: "string" } }));

/** Registers a native Agent type: its tabs, launch settings, live channel and routes. */
export function createNativeAgentModule<Runtime extends NativeAgentRuntime>(options: {
  id: string; agentTypeId: string; label: string; iconHtml: string;
  createAgents(getEvents: () => KintsugiEventBus): NativeAgents<Runtime>;
  rendering: NativeAgentRendering<Runtime>;
  routes(agents: NativeAgents<Runtime>): (request: Request, url: URL) => Promise<Response | undefined>;
  requireSetup(): Promise<void>;
  settings: ReturnType<typeof createCliModelSettings>;
  openApiPaths: Record<string, JsonObject>;
}): WorkspaceModule {
  const { channelName } = options.rendering;
  let events: KintsugiEventBus;
  const agents = options.createAgents(() => events);
  const { requireSetup, settings } = options;
  return {
    id: options.id,
    initialize(context) {
      events = context.events;
      context.events.on("kintsugi_host_stopping", () => agents.disposeAll());
      context.events.on("workspace_deleting", ({ workspaceId }) => agents.disposeWorkspace(workspaceId));
      context.events.on("workspace_agent_turn_finished", ({ workspaceId, agentId }) => {
        if (agents.list(workspaceId).some(record => record.id === agentId)) context.registry.requestAttention(workspaceId);
      });
      context.onWorkspaceRemoved(workspaceId => agents.disposeWorkspace(workspaceId));
    },
    cableChannels: [{
      name: channelName,
      async subscribe(identifier, listener, _events, shown) {
        if (identifier.channel !== "module" || identifier.name !== channelName || !identifier.params.agentId) throw new Error(`Invalid ${options.label} channel`);
        return (await agents.ready(identifier.workspaceId, identifier.params.agentId)).presentation.subscribe(listener, shown);
      },
    }],
    routes: [{ handle: options.routes(agents) }],
    agentType: {
      id: options.agentTypeId, label: options.label, iconHtml: options.iconHtml,
      async create({ workspaceId }) { await requireSetup(); return agents.create(workspaceId); },
      tabs: {
        async list({ workspaceId }) { return agents.list(workspaceId).map(record => ({ id: record.id, title: record.title })); },
        async settings({ workspaceId, agentIds }) {
          const records = agents.list(workspaceId);
          const projected = new Map<string, WorkspaceAgentSettings>();
          for (const agentId of agentIds) {
            const record = records.find(item => item.id === agentId);
            if (!record) continue;
            const model = record.model ? parseModelRef(record.model) : undefined;
            const settings: WorkspaceAgentSettings = {};
            if (model) settings.model = `${model.provider}/${model.id}`;
            if (record.thinkingLevel) settings.thinkingLevel = record.thinkingLevel;
            projected.set(agentId, settings);
          }
          return projected;
        },
        async render({ workspaceId, agentId }) { return options.rendering.paneHtml(await agents.ready(workspaceId, agentId)); },
        close: ({ workspaceId, agentId }) => agents.close(workspaceId, agentId),
      },
      launch: {
        renderFooter: settings.renderFooter,
        async prepare(parameters) { await requireSetup(); return { agent: await settings.prepare(parameters) }; },
        async submit(form) {
          await requireSetup();
          const selected = await settings.prepare({ model: String(form.get("model") ?? ""), thinkingLevel: String(form.get("thinkingLevel") ?? "") });
          return { async prepare() { return { agent: selected }; } };
        },
        async prepareWorkspace(workspaceId, context) {
          await requireSetup();
          if (!agents.list(workspaceId).length) await agents.create(workspaceId, context?.agent);
        },
      },
    },
    openApiPaths: options.openApiPaths,
  };
}
