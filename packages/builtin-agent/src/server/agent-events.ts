import { configureDurableOwnerEvents } from "./runtime.ts";
import type { KintsugiEventBus } from "@kintsugi/core";
import type { AgentWorkspaceParameters } from "@kintsugi/shared";
import { agentAttachmentDraftId, moveAttachmentDraft, validDraftId } from "@kintsugi/prompt/server";
import { stageInitialPrompt } from "./initial-prompt-draft.ts";
import { parseModelRef, getAgentModelThinkingLevel } from "@kintsugi/llm/server";
import { expandSlashCommand } from "@kintsugi/agent/server/slash-command-input";
import { getWorkspaceAgentController, removeWorkspaceAgentRuntimes, suspendWorkspaceAgentRuntimes, stopWorkspaceAgentRuntimes } from "./runtime.ts";
import { resumeInterruptedAgentSessions } from "./restart-recovery.ts";
import { ensureDefaultWorkspaceAgent } from "./agent-store.ts";

export function registerAgentEvents(events: KintsugiEventBus): void {
  configureDurableOwnerEvents(events);
  events.on("kintsugi_host_stopping", stopWorkspaceAgentRuntimes);
  events.on("workspace_suspending", ({ workspaceId }) => suspendWorkspaceAgentRuntimes(workspaceId));
  // Runs after host start too, once the helper has been refreshed and the workspace prepared.
  events.on("workspace_runtime_ready", ({ workspaceId }) => resumeInterruptedAgentSessions(workspaceId, events));
  events.on("workspace_deleting", ({ workspaceId }) => removeWorkspaceAgentRuntimes(workspaceId));
  events.on("workspace_created", async ({ workspaceId, context }) => {
    const agentContext = context?.agent;
    if (!agentContext || (agentContext.agentTypeId && agentContext.agentTypeId !== "builtin")) return;
    const hasPrompt = !agentContext.initialPromptMode && Boolean(agentContext.initialPrompt?.trim());
    if (hasPrompt) await events.emit("workspace_provision_progress", { workspaceId, detail: "Start initial agent task" });
    await initializeWorkspaceAgent(workspaceId, agentContext, events);
  });
}

async function initializeWorkspaceAgent(workspaceId: string, context: AgentWorkspaceParameters, events: KintsugiEventBus): Promise<void> {
  const agent = await ensureDefaultWorkspaceAgent(workspaceId);
  const runtime = await getWorkspaceAgentController(agent, { events });
  const modelRef = context.model ? parseModelRef(context.model) : undefined;
  if (modelRef) await runtime.configure({ model: { provider: modelRef.provider, modelId: modelRef.id } });
  const thinkingLevel = context.thinkingLevel || (modelRef ? await getAgentModelThinkingLevel("builtin", modelRef) : undefined);
  if (thinkingLevel) await runtime.configure({ thinkingLevel });

  const input = context.input!;
  if (context.initialPromptMode === "composer") {
    const prompt = input.text;
    if (prompt) await stageInitialPrompt(workspaceId, agent.agentId, prompt);
    const attachmentDraft = context.attachmentDraft ?? "";
    if (validDraftId(attachmentDraft)) await moveAttachmentDraft(attachmentDraft, agentAttachmentDraftId(workspaceId, agent.agentId));
    return;
  }

  const prompt = await expandSlashCommand(workspaceId, input.text);
  const { images, attachmentNotes, files } = input;
  if (!prompt.trim() && images.length === 0 && attachmentNotes.length === 0) return;

  await events.emit("workspace_user_activity", { workspaceId });
  await runtime.submit({ text: prompt, requestId: crypto.randomUUID(), images: images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType })), attachmentNotes, files });
}
