import { tokenOptimizerSettingsContribution, tokenOptimizerOpenApiPaths } from "./token-optimizer-settings.ts";
import { tokenOptimizerIntegration } from "./token-optimizer.ts";
import { registerBuiltinAgentIntegration, builtinAgentIntegrations } from "./integrations.ts";
import { registerAgentRequestReceiptChecker } from "@kintsugi/agent/server/request-receipts";
import { registerPlanAgentResolver } from "@kintsugi/agent/server/plan";
import { KintsugiCoreError as PlanCoreError } from "@kintsugi/core";
import { registerWorkspaceAgentTool } from "@kintsugi/agent/server/tools";
import { createCredentialCatalogueTool } from "./credential-catalogue.ts";
import { KintsugiCoreError, createKeyedOperationQueue, type KintsugiEventBus } from "@kintsugi/core";
import { builtinAgentIconHtml } from "@kintsugi/design-system/icons";
import { launchComposerCommand, type WorkspaceAgentPane, type WorkspaceAgentTabProvider, type WorkspaceCommandContribution, type WorkspaceModule } from "@kintsugi/shared";
import { registerAgentEvents } from "./agent-events.ts";
import { resolveAgent } from "./delegation.ts";
import { removeWorkspaceInitialPromptDrafts } from "./initial-prompt-draft.ts";
import { nativeAgentLaunch } from "./launch.ts";
import { resolveNewWorkspaceAgentModel } from "@kintsugi/agent/server/model-state";
import { renderAgentPane } from "./render-composer.ts";
import { agentKey } from "@kintsugi/agent/server/render-context";
import { handleAgentRequest } from "./routes.ts";
import { backgroundChannelName, subscribeBackground } from "./background.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { refreshWorkspaceCompletionCatalogs, closeWorkspaceAgent, getWorkspaceAgentController, getWorkspaceAgentPresentation, restoreWorkspaceAgentRuntime, knownWorkspaceAgentRequest } from "./runtime.ts";
import { removeClosedWorkspaceAgent, createNextWorkspaceAgent, listWorkspaceAgents, untitledAgentTitle, type WorkspaceAgentInfo } from "./agent-store.ts";

const toolAbortRequestSchema = { type: "object", properties: { note: { type: "string", description: "Optional user note returned in the tool result" } } };

let agentEvents: KintsugiEventBus | undefined;

export function createWorkspaceAgentTabProvider(dependencies: {
  list(workspaceId: string): Promise<readonly WorkspaceAgentInfo[]>;
  render(conversation: WorkspaceAgentInfo): Promise<WorkspaceAgentPane>;
  dispose(workspaceId: string, agentId: string): Promise<void>;
  restore(workspaceId: string, agentId: string): void;
  removeClosedAgent(conversation: WorkspaceAgentInfo): Promise<void>;
}): WorkspaceAgentTabProvider {
  const serializedClose = createKeyedOperationQueue();

  return {
    async list({ workspaceId }) {
      return (await dependencies.list(workspaceId)).map(({ agentId, title }) => ({ id: agentId, title, untitled: title === untitledAgentTitle }));
    },

    async render({ workspaceId, agentId }) {
      const conversation = (await dependencies.list(workspaceId)).find((candidate) => candidate.agentId === agentId);
      if (!conversation) throw new KintsugiCoreError("agent_not_found", `Agent not found: ${agentId}`);
      return await dependencies.render(conversation);
    },

    async close({ workspaceId, agentId }) {
      await serializedClose(workspaceId, async () => {
        const conversations = await dependencies.list(workspaceId);
        const conversation = conversations.find((candidate) => candidate.agentId === agentId);
        if (!conversation) throw new KintsugiCoreError("agent_not_found", `Agent not found: ${agentId}`);
        try {
          await dependencies.dispose(workspaceId, agentId);
          await dependencies.removeClosedAgent(conversation);
        } catch (error) {
          dependencies.restore(workspaceId, agentId);
          throw error;
        }
      });
    },
  };
}

export const workspaceAgentTabProvider = createWorkspaceAgentTabProvider({
  list: listWorkspaceAgents,
  async render(conversation) {
    const runtime = await getWorkspaceAgentPresentation(conversation, { events: agentEvents });
    await runtime.loadCompletionCatalog();
    return await renderAgentPane({ workspaceId: conversation.workspaceId, agentId: conversation.agentId }, conversation, runtime.paneState());
  },
  dispose: closeWorkspaceAgent,
  restore: restoreWorkspaceAgentRuntime,
  removeClosedAgent: removeClosedWorkspaceAgent,
});

const launchComposerCommandContribution: WorkspaceCommandContribution = {
  id: launchComposerCommand.id,
  label: launchComposerCommand.label,
  description: launchComposerCommand.description,
  scope: "global",
  surfaces: { shortcut: { defaultBinding: launchComposerCommand.binding } },
};

async function applyNewAgentSettings(agent: WorkspaceAgentInfo, source: WorkspaceAgentInfo | undefined, events?: KintsugiEventBus): Promise<void> {
  const runtimeOptions = { events };
  const sourceController = source ? await getWorkspaceAgentController(source, runtimeOptions) : undefined;
  const sourceSettings = await sourceController?.settings();
  const model = sourceSettings?.model ?? await resolveNewWorkspaceAgentModel().then(model => model && { provider: model.provider, modelId: model.id });
  const target = await getWorkspaceAgentController(agent, runtimeOptions);
  if (model) await target.configure({ model });
  if (sourceSettings?.thinkingLevel) await target.configure({ thinkingLevel: sourceSettings.thinkingLevel });
  await events?.emit("workspace_agent_view_invalidated", { workspaceId: agent.workspaceId, agentId: agent.agentId });
}

export const builtinAgentWorkspaceModule: WorkspaceModule = {
  id: "builtin-agent",
  staticFiles: { "/token-optimizer.css": { url: new URL("../client/token-optimizer.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  settingsContributions:[tokenOptimizerSettingsContribution],
  cableChannels: [{
    name: "agent",
    async subscribe(identifier, listener, events, shown) {
      if (identifier.channel !== "agent") throw new Error("Invalid Agent channel identifier");
      const agent = await resolveAgent(identifier.workspaceId, identifier.agentId);
      const runtime = await getWorkspaceAgentPresentation(agent, { events });
      return runtime.subscribeLivePresentation(listener, shown);
    },
  }, {
    name: "agent-turn",
    async subscribe(identifier, listener, events) {
      if (identifier.channel !== "agent-turn") throw new Error("Invalid Agent turn channel identifier");
      const agent = await resolveAgent(identifier.workspaceId, identifier.agentId);
      const runtime = await getWorkspaceAgentPresentation(agent, { events });
      return runtime.subscribeTurnPresentation(identifier.turnId, identifier.branchId, listener);
    },
  }, {
    name: backgroundChannelName,
    subscribe(identifier, listener) {
      if (identifier.channel !== "module" || identifier.name !== backgroundChannelName) throw new Error("Invalid Background channel identifier");
      const params = Value.Parse(Type.Object({ agentId: Type.String({ minLength: 1 }) }, { additionalProperties: false }), identifier.params);
      return subscribeBackground(identifier.workspaceId, params.agentId, listener);
    },
  }],
  openApiPaths: {
    ...tokenOptimizerOpenApiPaths,
    "/agent-notifications/public-key": { get: {
      summary: "Get this Kintsugi installation's VAPID public key for browser PushManager subscription",
      responses: { "200": { description: "Public application-server key", content: { "application/json": { schema: { type: "object", properties: { publicKey: { type: "string" } } } } } } },
    } },
    "/workspaces/{id}/agents/{agentId}/notification": {
      parameters: ["id", "agentId"].map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      get: {
        summary: "Get the current turn's one-shot notification state",
        responses: { "200": { description: "Current turnId (null when idle), busy and armed; HTML clients receive the header control", content: { "application/json": { schema: { type: "object", properties: { turnId: { type: ["string", "null"] }, busy: { type: "boolean" }, armed: { type: "boolean" } } } } } } },
      },
      post: {
        summary: "Arm or cancel a native Web Push notification for this exact running turn",
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["turnId", "enabled"], properties: {
            turnId: { type: "string" }, enabled: { type: "boolean" },
            subscription: { type: "object", description: "Required when enabled; PushSubscription.toJSON() from the receiving device", required: ["endpoint", "keys"], properties: { endpoint: { type: "string" }, keys: { type: "object", required: ["p256dh", "auth"], properties: { p256dh: { type: "string" }, auth: { type: "string" } } } } },
          },
        } } } },
        responses: { "200": { description: "Notification state updated; JSON or Turbo Stream according to Accept" }, "409": { description: "The requested turn is no longer running" }, "422": { description: "Invalid notification intent or unsupported push service" } },
      },
    },
    "/workspaces/{id}/agents/{agentId}/queued-inputs/{submissionId}/cancel": { post: {
      summary: "Cancel one queued steering or follow-up message without stopping the agent turn",
      parameters: ["id", "agentId", "submissionId"].map(name => ({ name, in: "path", required: true, schema: { type: "string" } })),
      responses: { "200": { description: "Input withdrawn; cancelled is false if it is no longer queued. HTML clients receive a Turbo Stream.", content: { "application/json": { schema: { type: "object", properties: { input: { type: "object", required: ["submissionId", "cancelled"], properties: { submissionId: { type: "string" }, cancelled: { type: "boolean" } } } } } } } } },
    } },
    "/workspaces/{id}/agents/{agentId}/queued-inputs/{submissionId}/steer": { post: {
      summary: "Turn one queued follow-up into steering, so the agent reads it after its current step instead of when it finishes. On an idle agent, whose turn ended in an error with input still queued, this instead resumes that queue in the order it was written, changing no input",
      parameters: ["id", "agentId", "submissionId"].map(name => ({ name, in: "path", required: true, schema: { type: "string" } })),
      responses: { "200": { description: "steered is false if the input is no longer queued, or is already steering a running turn. HTML clients receive a Turbo Stream.", content: { "application/json": { schema: { type: "object", properties: { input: { type: "object", required: ["submissionId", "steered"], properties: { submissionId: { type: "string" }, steered: { type: "boolean" } } } } } } } } },
    } },
    "/workspaces/{id}/agents/{agentId}/tools/{callId}/abort": { post: {
      summary: "Abort one live tool call and its owned work without stopping the agent turn",
      requestBody: { required: false, content: {
        "application/json": { schema: toolAbortRequestSchema },
        "application/x-www-form-urlencoded": { schema: toolAbortRequestSchema },
      } },
      parameters: ["id", "agentId", "callId"].map(name => ({ name, in: "path", required: true, schema: { type: "string" } })),
      responses: { "200": { description: "Cancellation requested; aborted is false if the call is no longer active. HTML clients receive a Turbo Stream.", content: { "application/json": { schema: { type: "object", properties: { tool: { type: "object", required: ["callId", "aborted"], properties: { callId: { type: "string" }, aborted: { type: "boolean" } } } } } } } } },
    } },
    "/workspaces/{id}/agents/{agentId}/background/{key}": { get: {
      summary: "A background activity's page in its root Agent's Background bar, such as a subagent's or a script's one-shot agent's live transcript",
      parameters: ["id", "agentId", "key"].map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      responses: { "200": { description: "The page, for the pane's background page frame", content: { "text/html": { schema: { type: "string" } } } } },
    } },
    "/workspaces/{id}/agents/{agentId}/background/{key}/stop": { post: {
      summary: "Stop a running background activity",
      parameters: ["id", "agentId", "key"].map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      responses: { "204": { description: "Stopping" } },
    } },
    "/workspaces/{id}/agents/{agentId}/reveal/{target}": { get: {
      summary: "Resolve the enclosing turn for a transcript navigation target",
      parameters: ["id", "agentId", "target"].map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      responses: { "200": { description: "Enclosing turn identity for browser-local navigation", content: { "application/json": { schema: { type: "object", properties: { turnId: { type: ["string", "null"] } } } } } } },
    } },
  },
  routes: [{
    async handle(request, url, context) {
      // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
      return handleAgentRequest(request, url, { events: context.events as KintsugiEventBus | undefined, renderPage: context.renderPage });
    },
  }],
  agentType: {
    id: "builtin", label: "Builtin", iconHtml: builtinAgentIconHtml,
    tabs: workspaceAgentTabProvider,
    create: createBuiltinAgent,
    launch: nativeAgentLaunch,
  },
  initialize(context) {
    registerPlanAgentResolver("builtin", async (workspaceId, agentId) => {
      try { const agent = await resolveAgent(workspaceId, agentId); return { id: agent.agentId, title: agent.title, readOnly: agent.readOnly }; }
      catch (error) { if (error instanceof PlanCoreError && error.code === "agent_not_found") return undefined; throw error; }
    });
    registerAgentRequestReceiptChecker("builtin", async (workspaceId, agentId, requestId) => {
      let agent;
      try { agent = await resolveAgent(workspaceId, agentId); }
      catch (error) { if (error instanceof KintsugiCoreError && error.code === "agent_not_found") return undefined; throw error; }
      return knownWorkspaceAgentRequest(agent, requestId, { events: agentEvents });
    });
    if (!builtinAgentIntegrations().some(integration => integration.id === tokenOptimizerIntegration.id)) registerBuiltinAgentIntegration(tokenOptimizerIntegration);
    registerWorkspaceAgentTool("list_credentials", workspaceId => createCredentialCatalogueTool(workspaceId));
    // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
    const events = context.events as KintsugiEventBus;
    agentEvents = events;
    registerAgentEvents(events);
    events.on("workspace_agent_turn_finished", async ({ workspaceId, agentId }) => {
      const agent = (await listWorkspaceAgents(workspaceId)).find((item) => item.agentId === agentId);
      context.registry.requestSurfaceAttention(workspaceId, agentKey(agentId));
      // Delegated conversations finish independently of the root's turn. Their
      // completion belongs to the Agent surface, not workspace-level attention.
      if (agent) context.registry.requestAttention(workspaceId);
      context.invalidateWorkspace(workspaceId);
      await refreshWorkspaceCompletionCatalogs(workspaceId);
    });
    context.onWorkspaceRemoved(removeWorkspaceInitialPromptDrafts);
  },
  attachToWorkspace() {
    return { commands: [launchComposerCommandContribution] };
  },
};

async function createBuiltinAgent({ workspaceId, events }: { workspaceId: string; events?: KintsugiEventBus }): Promise<string> {
  const sourceConversation = (await listWorkspaceAgents(workspaceId))[0];
  const conversation = await createNextWorkspaceAgent(workspaceId);
  const applySettingsTimer = setTimeout(() => {
    void applyNewAgentSettings(conversation, sourceConversation, events).catch((error) => console.error("Could not apply settings to new Agent", error));
  }, 0);
  applySettingsTimer.unref?.();
  return conversation.agentId;
}
