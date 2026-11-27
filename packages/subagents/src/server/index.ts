import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceModule } from "@kintsugi/shared";
import { registerAgentToolPresentations } from "@kintsugi/agent/server";
import { enabledModelOptionViews } from "@kintsugi/agent/server/model-state";
import { listWorkspaceAgents, configureAgentDelegation, registerBuiltinAgentIntegration } from "@kintsugi/builtin-agent/server";
import { createNativeDelegationExtension } from "./native-runtime.ts";
import { delegationModels, stampDelegationRequestIdentity } from "./native-models.ts";
import { nativeDelegationTranscript } from "./native-transcript.ts";
import { attributedEntry } from "./native-state.ts";
import { nativeToolPresentations } from "./native-tool-presentation.ts";
import { nativeSnapshot } from "./native-view-state.ts";
import { renderSubagentsControl, handleSubagentRequest, subscribeSubagentTree } from "./subagent-view.ts";
import { subagentBackground } from "./background.ts";
import { subagentsOpenApiPaths } from "./openapi.ts";

export const kintsugiServerModule: WorkspaceModule = {
  id: "subagents",
  initialize() {
    configureAgentDelegation({
      create(models, harness) {
        const extension = createNativeDelegationExtension(harness, async (provider, id) => {
          const enabled = await enabledModelOptionViews({ provider, id });
          return enabled.some(item => item.selected && item.available) ? models.getModel(provider, id) : undefined;
        });
        return { extension, models: delegationModels(models, harness) };
      },
      requestMessages: stampDelegationRequestIdentity,
      attributed: attributedEntry,
    });
    registerAgentToolPresentations(nativeToolPresentations);
    registerBuiltinAgentIntegration({ id: "subagents", transcript: nativeDelegationTranscript, background: subagentBackground });
  },
  staticFiles: { "/subagents.css": { url: new URL("../client/subagents.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  openApiPaths: subagentsOpenApiPaths,
  cableChannels: [{
    name: "subagents",
    subscribe(identifier, listener) {
      if (identifier.channel !== "module" || identifier.name !== "subagents") throw new Error("Invalid Subagents channel");
      const params = Value.Parse(Type.Object({ agentId: Type.String({ minLength: 1 }) }, { additionalProperties: false }), identifier.params);
      return subscribeSubagentTree(identifier.workspaceId, params.agentId, listener);
    },
  }],
  routes: [{
    async handle(request, url, context) {
      const reveal = url.pathname.match(/^\/workspaces\/([^/]+)\/subagents\/reveal$/);
      if (reveal && (request.method === "POST" || request.method === "GET")) {
        const workspaceId = decodeURIComponent(reveal[1]!);
        const form = request.method === "GET" ? url.searchParams : await request.formData();
        const snapshot = await nativeSnapshot(workspaceId);
        const target = String(form.get("child"));
        const child = snapshot.agents.find((agent) => agent.id === target);
        const message = snapshot.messages.find((message) => message.id === String(form.get("message")));
        if (!message || (message.from !== target && message.to !== target)) return new Response("Subagent message not found", { status: 404 });
        if (!child) {
          const roots = await listWorkspaceAgents(workspaceId);
          if (!roots.some((root) => root.agentId === target)) return new Response("Agent not found", { status: 404 });
          const query = new URLSearchParams({ agent: target, agentTarget: message.id });
          return new Response(null, { status: 303, headers: { location: `/workspaces/${encodeURIComponent(workspaceId)}?${query}` } });
        }
        const query = new URLSearchParams({ agent: child.rootId, subagent: child.id, message: message.id });
        return new Response(null, { status: 303, headers: { location: `/workspaces/${encodeURIComponent(workspaceId)}?${query}` } });
      }
      return handleSubagentRequest(request, url, { events: context.events });
    },
  }],
};
