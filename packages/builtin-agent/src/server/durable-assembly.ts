import { mcpConnections } from "./mcp-connections.ts";
import { createWorkspaceMcpRuntime } from "./mcp-runtime.ts";
import { nativeOptimizerOptions, type createNativeTokenOptimizer } from "./token-optimizer.ts";
import { createNativePlanExtension } from "./durable-plan.ts";
import { durablePromptCache } from "./durable-prompt-cache.ts";
import { createNativeAgentIdentityResolver } from "./durable-agent-identity.ts";
import { createHistorySearchTool } from "./history-search.ts";
import { agentDelegation } from "./delegation.ts";
import { builtinAgentIntegrations } from "./integrations.ts";
import { durableTiming, type WriteDurableTiming } from "./durable-timing.ts";
import { durableSubscriptionActivity } from "./durable-accounting.ts";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, type AgentChange, type Harness, type HarnessOptions, type ConversationId } from "@earendil-works/pi-durable";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { createPiModelRuntime } from "@kintsugi/llm/server";
import { workspaceRoot } from "@kintsugi/workspace";
import { createDurableWorkspaceTools } from "./durable-tools.ts";
import { createDurableBashExtension } from "./durable-bash.ts";
import { createCodemodeTemplates } from "./durable-codemode-templates.ts";
import { listPromptTemplates } from "@kintsugi/agent/server/prompt-templates";
import { durableJournalInstructions } from "./durable-storage.ts";
import { formatProjectInstructions, loadWorkspaceAgentsFiles } from "@kintsugi/agent/server/workspace-agents-files";
import { loadWorkspaceSkills } from "@kintsugi/agent/server/skills";
import { builtinKintsugiSystemPrompt, prepareAppendedKintsugiInstructions } from "@kintsugi/agent/server/system-prompt";
import { launchComposerThinkingSettings, resolveNewWorkspaceAgentModel } from "@kintsugi/agent/server/model-state";
import type { WorkspaceAgentToolOptions } from "@kintsugi/agent/server/tools";

/** Workspace-scoped tools and bash recovery; integrations install their own task definitions. */
export function createDurableWorkspaceRegistry(workspaceId: string, options: WorkspaceAgentToolOptions = {}, resolveAgentId?: (conversationId: ConversationId) => Promise<string>) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "kintsugi.workspace-tools", tools: createDurableWorkspaceTools(workspaceId, options, resolveAgentId) }));
  registry.install(createDurableBashExtension(workspaceId));
  return registry;
}

/** No AgentSession, delegation coordinator, or host-local filesystem environment. */
/** Our Harness always gets one `Models`, never a function returning the current one. */
export type DurableHarnessOptions = HarnessOptions & { models: Models; tokenOptimizer?:ReturnType<typeof createNativeTokenOptimizer>; mcp?:ReturnType<typeof createWorkspaceMcpRuntime> };

export async function createDurableHarnessOptions(workspaceId: string, options: WorkspaceAgentToolOptions, writeTiming: WriteDurableTiming, harness: () => Harness): Promise<DurableHarnessOptions> {
  const models = await createPiModelRuntime();
  const registry = createDurableWorkspaceRegistry(workspaceId, options, createNativeAgentIdentityResolver(workspaceId, harness));
  registry.install(defineExtension({ name: "kintsugi.history-search", tools: [createHistorySearchTool(workspaceId, harness)] }));
  registry.install(durablePromptCache);
  registry.install(createNativePlanExtension(workspaceId, harness));
  const delegation = agentDelegation?.create(models, harness);
  if (delegation) registry.install(delegation.extension);
  // Such as code mode, whose task definitions must be installed to recover its scripts.
  for (const integration of builtinAgentIntegrations()) if (integration.extension) registry.install(integration.extension(workspaceId, models));
  registry.install(durableSubscriptionActivity(models));
  registry.install(durableTiming(writeTiming));
  const templates = createCodemodeTemplates(() => listPromptTemplates(workspaceId), harness);
  registry.install(templates.extension);
  const tokenOptimizer = await nativeOptimizerOptions(workspaceId,harness,models,registry);
  registry.install(tokenOptimizer.optimizer.extension);
  return {
    tokenOptimizer,
    mcp:createWorkspaceMcpRuntime(workspaceId,registry,harness,await mcpConnections()),
    models: templates.models(delegation?.models ?? models),
    registry,
    settings: { documentRetentionMs: 60_000, stream: { cacheRetention: "short" }, compaction: { enabled: true, keepRecentTokens: 6000 } },
    // Faulted, interrupted and unmigratable tasks, and failing extension code, are otherwise invisible.
    onReport: ({ error, ...info }) => console.error(`Agent work report (${info.kind})`, error, info),
  };
}

/** Only builtin Agents run code mode templates. */
const codemodeTemplatesInstructions = "Prompt templates with codemode: true run their JavaScript body as an explicit slash-command call in code mode. Script arguments are available as args and argumentsText; attachments are not accepted. Saving a template never starts work.";

const resourceLoaders = {
  agents: loadWorkspaceAgentsFiles,
  skills: loadWorkspaceSkills,
  model: resolveNewWorkspaceAgentModel,
  thinking: launchComposerThinkingSettings,
};

/**
 * Prepare outside the journal commit; pass the result to workspace.agent().
 * The resulting prompt/model are committed with creation, not rebuilt on recovery
 * from potentially changed workspace files or the host's current model default.
 * Existing conversations keep their settings; explicit refresh uses configure().
 */
export async function prepareDurableAgent(
  workspaceId: string,
  agentId: string,
  options: WorkspaceAgentToolOptions = {},
  initial: Pick<AgentChange, "model" | "thinkingLevel"> = {},
  load: typeof resourceLoaders = resourceLoaders,
): Promise<AgentChange> {
  const [agents, skills, model, appended] = await Promise.all([
    load.agents(workspaceId),
    load.skills(workspaceId),
    initial.model !== undefined ? Promise.resolve(undefined) : load.model(),
    prepareAppendedKintsugiInstructions(options.events, workspaceId, agentId),
  ]);
  const selectedModel = initial.model !== undefined ? initial.model : model ? { provider: model.provider, modelId: model.id } : undefined;
  const thinking = initial.thinkingLevel !== undefined ? initial.thinkingLevel
    : (await load.thinking(selectedModel ? { provider: selectedModel.provider, id: selectedModel.modelId } : undefined)).selected;
  const instructions = [
    builtinKintsugiSystemPrompt,
    codemodeTemplatesInstructions,
    ...appended,
    ...agents.map(formatProjectInstructions),
    formatSkillsForPrompt(skills.skills),
    // Keep per-Agent identity after the shared project/skill prefix for provider reuse.
    durableJournalInstructions(workspaceId, agentId),
    `Current working directory: ${workspaceRoot}`,
  ].filter(Boolean).join("\n\n");
  return {
    cwd: workspaceRoot,
    model: selectedModel,
    thinkingLevel: thinking,
    instructions,
  };
}
