import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceModule } from "@kintsugi/shared";
import { invalidArguments } from "@kintsugi/core";
import { Icons } from "@kintsugi/design-system/icons";
import { registerAgentToolPresentations } from "@kintsugi/agent/server";
import { enabledModelOptionViews } from "@kintsugi/agent/server/model-state";
import { listWorkspaceAgents, configureAgentDelegation, registerBuiltinAgentIntegration } from "@kintsugi/builtin-agent/server";
import { createNativeDelegationExtension } from "./native-runtime.ts";
import { delegationModels, stampDelegationRequestIdentity } from "./native-models.ts";
import { nativeDelegationTranscript } from "./native-transcript.ts";
import { attributedEntry } from "./native-state.ts";
import { nativeToolPresentations } from "./native-tool-presentation.ts";
import { nativeSnapshot } from "./native-view-state.ts";
import { handleSubagentRequest, renderSubagentsWorkView, subagentsWorkKey, subscribeSubagentTree } from "./subagent-view.ts";
import { subagentBackground } from "./background.ts";
import { subagentsOpenApiPaths } from "./openapi.ts";

const referenceSchema = Type.Object({ type: Type.Literal("subagents") }, { additionalProperties: false });
const reference = { type: "subagents" } as const;

export const kintsugiServerModule: WorkspaceModule = {
  id: "subagents",
  initialize() {
    configureAgentDelegation({
      create(models, harness) {
        const extension = createNativeDelegationExtension(harness, async (provider, id) => {
          const enabled = await enabledModelOptionViews({ provider, id });
          return enabled.some(item => item.selected && item.available) ? models.getModel(provider, id) : undefined;
        }, (provider, id) => models.getModel(provider, id));
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
  workViews: [{
    type: "subagents",
    parseReference(value) {
      if (!Value.Check(referenceSchema, value)) throw invalidArguments("Invalid Subagents view");
      return value;
    },
    identity: () => "workspace",
    render: async ({ workspaceId }, listAgents, agentSettings) => renderSubagentsWorkView(workspaceId, await listAgents(), agentSettings),
  }],
  commands: [{ id: "subagents.open", execute: () => ({ createdWorkView: reference }) }],
  attachToWorkspace: () => ({
    workViews: [{ reference, sourceKey: subagentsWorkKey, label: "Subagents", kind: "contextual", iconHtml: Icons.Subagents, availability: { phase: "live" }, initiallyOpen: false }],
    commands: [{ id: "subagents.open", label: "Open Subagents", description: "Inspect the workspace’s Agents and delegated work.", scope: "workspace", surfaces: { ui: { placement: "work-launcher", label: "Subagents", iconHtml: Icons.Subagents } } }],
  }),
  cableChannels: [{
    name: "subagents",
    subscribe(identifier, listener) {
      if (identifier.channel !== "module" || identifier.name !== "subagents") throw new Error("Invalid Subagents channel");
      Value.Assert(Type.Object({}, { additionalProperties: false }), identifier.params);
      return subscribeSubagentTree(identifier.workspaceId, listener);
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
        await context.openWorkView(workspaceId, reference, { select: false });
        const query = new URLSearchParams({ agent: child.rootId, workView: subagentsWorkKey, subagent: child.id, message: message.id });
        return new Response(null, { status: 303, headers: { location: `/workspaces/${encodeURIComponent(workspaceId)}?${query}` } });
      }
      return handleSubagentRequest(request, url, { events: context.events });
    },
  }],
};
