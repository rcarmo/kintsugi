import { activityButtonHtml } from "@kintsugi/design-system/activity-button";
import { buttonHtml } from "@kintsugi/design-system/button";
import { createPiModelRuntime, hasConnectedModelProvider, modelRefValue, parseModelRef, renderLaunchModelSettings, renderSharedComposerSelections, type ComposerModelOption } from "@kintsugi/llm/server";
import { agentAttachmentDraftId, listStagedAttachments, renderComposerBody, renderFloatingStack, renderFollowLatestButton, renderOpenComposerButton, agentComposerActions, composerAttachmentAttributes, type StagedAttachment } from "@kintsugi/prompt/server";
import { dictationComposerController } from "@kintsugi/dictation/server";
import { domId, escapeHtml, type LiveRegion, type WorkspaceAgentPane } from "@kintsugi/shared";
import { readInitialPromptDraft } from "./initial-prompt-draft.ts";
import { enabledModelOptionViews, launchComposerThinkingSettings, selectAvailableEnabledModel } from "@kintsugi/agent/server/model-state";
import { agentKey, agentPath, ids, type AgentRenderContext } from "@kintsugi/agent/server/render-context";
import { renderTranscriptQuoteAction } from "@kintsugi/agent/server/render-transcript";
import { renderAgentNotifications } from "./render-notification.ts";
import { renderBackgroundControl } from "./background.ts";
import type { WorkspaceAgentInfo } from "./agent-store.ts";
import { formatCost, formatTokens } from "@kintsugi/agent/server/transcript";

export interface AgentStatsView {
  contextPercent: number | null;
  nativeBranchUsage?: boolean;
  compactAvailable: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  descendantCost?: number;
  modelName: string | undefined;
  thinkingLevel: string;
  thinkingLevels: string[];
  models: ComposerModelOption[];
  connectedProvider?: boolean;
}

interface AgentPaneState {
  readOnly?: boolean;
  /** What the pane's live presentation publishes. The shell has mounts for its transcript
   * and, unless read-only, the composer's actions, footer and slash-command catalog. */
  regions(): readonly LiveRegion[];
}

/** The pane's shell; its controller's channel owns the content placed into the mounts. */
export async function renderAgentPane(ctx: AgentRenderContext, agent: Pick<WorkspaceAgentInfo, "agentId">, state: AgentPaneState, presentation: { moduleChannel?: string; notifications?: boolean; background?: boolean; initialPromptDraft?: boolean } = {}): Promise<WorkspaceAgentPane> {
  const key = agentKey(agent.agentId);
  const draftId = agentAttachmentDraftId(ctx.workspaceId, ctx.agentId);
  const attachments = state.readOnly ? [] : await listStagedAttachments(draftId);
  const initialPromptDraft = state.readOnly || presentation.initialPromptDraft === false ? undefined : await readInitialPromptDraft(ctx.workspaceId, ctx.agentId);
  const initialText = initialPromptDraft?.prompt;
  const attachRowId = ids.attachRow(ctx);
  const html = `<section id="${domId("agent_pane", ctx.workspaceId, agent.agentId)}" data-turbo-permanent class="agent-pane builtin-agent-shell" data-agent-source="${escapeHtml(key)}">
    <div class="agent-pane agent-composer-pane" id="${ids.pane(ctx)}"
      ${state.readOnly ? "" : `data-controller="agent-pane agent-attachments agent-composer composer-focus agent-background transcript-quote"
      data-agent-composer-open-on-create-value="true"
      data-agent-pane-workspace-id-value="${escapeHtml(ctx.workspaceId)}"
      data-agent-pane-agent-id-value="${escapeHtml(ctx.agentId)}"
      data-agent-background-path-value="${escapeHtml(agentPath(ctx, "/background/"))}"
      ${presentation.moduleChannel ? `data-agent-pane-module-channel-value="${escapeHtml(presentation.moduleChannel)}"` : ""}
      ${composerAttachmentAttributes(draftId, attachRowId, agentComposerActions)}`}>
      ${state.readOnly || presentation.notifications === false ? "" : `<div class="agent-body-controls">${renderAgentNotifications(ctx)}</div>`}
      <div class="agent-background" id="${ids.background(ctx)}"></div>
      <div class="agent-transcript-region">
        ${presentation.background === false ? "" : renderBackgroundControl(ctx)}
        <div class="agent-transcript" tabindex="0" role="region" aria-label="Agent transcript" data-agent-pane-target="transcript">
          <div class="agent-transcript-surface"><div class="agent-transcript-content" id="${ids.transcript(ctx)}" data-agent-pane-target="transcriptContent"></div></div>
        </div>
        ${state.readOnly ? "" : `${renderFloatingStack({ openComposer: renderOpenComposerButton(), followLatest: renderFollowLatestButton('data-agent-pane-target="transcriptEnd" data-action="agent-pane#scrollToTranscriptEnd"') })}${renderTranscriptQuoteAction()}`}
      </div>
      ${state.readOnly ? '<p class="agent-noticeline">This Agent is read-only. Start a new Agent to continue.</p>' : renderAgentPaneComposer({
        ctx,
        action: agentPath(ctx, "/messages"),
        draftId,
        attachments,
        initialText,
      })}
      ${state.readOnly ? "" : `<section class="agent-background-page" data-agent-background-target="page" data-action="click->agent-background#pageClicked" hidden><turbo-frame id="${ids.backgroundPage(ctx)}" refresh="morph" data-agent-background-target="frame"></turbo-frame></section>`}
    </div>
  </section>`;
  return { html, live: { regions: state.regions, subscriberId: ids.pane(ctx) } };
}

function renderAgentPanePromptInput(ctx: AgentRenderContext, initialText = ""): string {
  const placeholder = "Write your prompt here";
  return `<textarea id="${ids.input(ctx)}" class="composer-input" name="text" rows="2" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}" data-controller="composer-send-hint" data-agent-pane-target="input" data-agent-completions-target="input" data-action="paste->agent-attachments#paste input->agent-completions#input input->agent-pane#promptChanged">${escapeHtml(initialText)}</textarea>`;
}

interface AgentComposerRenderOptions {
  ctx: AgentRenderContext;
  action: string;
  draftId: string;
  attachments: readonly StagedAttachment[];
  initialText?: string;
}

function renderAgentPaneComposer(options: AgentComposerRenderOptions): string {
  const { ctx, draftId } = options;
  const formId = `agent_pane_composer_${draftId}`;
  const actions = `<span class="composer-primary-action" id="${ids.actions(ctx)}"></span>`;
  return `<div class="composer agent-pane-composer" data-controller="agent-model-setup agent-completions ${dictationComposerController}" data-action="agent-composer:send-prompt->agent-pane#sendPrompt" data-agent-completions-url-value="${escapeHtml(agentPath(ctx, "/completions"))}" data-dictation-composer-workspace-id-value="${escapeHtml(ctx.workspaceId)}">
    <div class="composer-surface">
      <form id="${escapeHtml(formId)}" method="post" action="${escapeHtml(options.action)}" data-agent-pane-target="form" data-action="submit->agent-model-setup#guard keydown->agent-completions#keydown keydown->agent-pane#inputKeydown submit->dictation-composer#submit turbo:submit-start->agent-pane#submitStarted turbo:submit-end->agent-pane#submitted">
        ${renderComposerBody({
          draft: { id: draftId, rowId: ids.attachRow(ctx), attachments: options.attachments },
          collapsible: true,
          promptTemplateButtons: true,
          inputHtml: renderAgentPanePromptInput(ctx, options.initialText ?? ""),
          sendHtml: renderComposerActions(actions),
        })}
      </form>
      <div class="agent-completion-menu-host" data-agent-completions-target="menu" hidden></div>
      <div id="${ids.completionCatalog(ctx)}" data-agent-completions-target="catalog" hidden></div>
      <form id="${ids.abortForm(ctx)}" method="post" action="${escapeHtml(agentPath(ctx, "/abort"))}" hidden></form>
      <div class="composer-footer" data-controller="agent-footer" id="${ids.stats(ctx)}"></div>
    </div>
  </div>`;
}

export async function renderLaunchComposerSettings(options: { frameId: string; formId: string; url: string; selectedModel?: string; selectedThinkingLevel?: string }): Promise<string> {
  const models = await enabledModelOptionViews();
  const selected = selectAvailableEnabledModel(models, options.selectedModel ? parseModelRef(options.selectedModel) : undefined);
  const selectedValue = selected ? modelRefValue(selected) : "";
  const { selected: selectedThinkingLevel, levels: thinkingLevels } = await launchComposerThinkingSettings(selected);
  return renderLaunchModelSettings({
    ...options, agentTypeId: "builtin", selectedValue,
    models: models.map((model) => ({ ...model, selected: modelRefValue(model) === selectedValue })),
    thinkingLevels,
    selectedThinkingLevel: options.selectedThinkingLevel && thinkingLevels.includes(options.selectedThinkingLevel) ? options.selectedThinkingLevel : selectedThinkingLevel ?? "",
    connectedProvider: hasConnectedModelProvider(await createPiModelRuntime()),
  });
}

/** `busyMode` is what sending does while the agent works: queue a follow-up, or steer the running turn. */
export function renderPromptActions(ctx: AgentRenderContext | undefined, busy: boolean, hasStoppableWork = busy, busyMode: "steer" | "followUp" = "steer"): string {
  const initialLabel = busy ? (busyMode === "followUp" ? "Queue follow-up" : "Steer agent") : "Send prompt";
  const activeLabel = busy ? "Agent is working — click to stop" : "Subagents are working — click to stop";
  const state = hasStoppableWork ? "active" : "initial";
  const paneAttrs = ctx
    ? ` data-agent-pane-target="sendStop" data-agent-busy="${busy}" data-agent-busy-mode="${busyMode}" data-agent-stoppable="${hasStoppableWork}"${hasStoppableWork ? ` data-agent-abort-form-id="${ids.abortForm(ctx)}"` : ""}`
    : "";
  const actionAttrs = hasStoppableWork && ctx ? `form="${ids.abortForm(ctx)}"` : "";
  return activityButtonHtml({
    variant: "primary",
    iconOnly: true,
    initialLabel,
    activeLabel,
    type: "submit",
    state,
    initialContent: { kind: "html", html: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4"/></svg>' },
    activeContent: { kind: "html", html: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/></svg>' },
    attributesHtml: `data-popular-button ${actionAttrs}${paneAttrs}`,
  });
}

function renderComposerActions(sendHtml: string): string {
  return `<span class="composer-send-action">${sendHtml}</span>
    <span class="composer-connect-action">${buttonHtml({ type: "button", variant: "primary", content: { kind: "caption", caption: "Connect to send" }, attributesHtml: 'data-action="agent-model-setup#open"' })}</span>`;
}

export function renderAgentPaneComposerFooter(ctx: AgentRenderContext, stats: AgentStatsView): string {
  const percent = stats.contextPercent;
  const contextTitle = stats.nativeBranchUsage ? "Estimated context window used" : "Context window used";
  const meter = percent === null
    ? ""
    : `<span class="agent-stat" data-footer-drop="4" title="${contextTitle}"><span class="agent-ctx-meter"><i style="width:${Math.min(100, Math.max(0, percent)).toFixed(0)}%"></i></span></span>
<span class="agent-stat" data-footer-drop="3" title="${contextTitle}"><b>${percent.toFixed(0)}%</b></span>`;
  const models = stats.models.length > 0 ? stats.models : [{ provider: "", id: "", name: stats.modelName ?? "no model", selected: true, available: false }];
  const formPrefix = `${ids.stats(ctx)}_selection`;
  const modelFormId = `${formPrefix}_model`;
  const thinkingLevelFormId = `${formPrefix}_thinking_level`;
  const selectionForms = `<form id="${modelFormId}" method="post" action="${escapeHtml(agentPath(ctx, "/model"))}" hidden></form>
${stats.thinkingLevels.length > 0 ? `<form id="${thinkingLevelFormId}" method="post" action="${escapeHtml(agentPath(ctx, "/thinking-level"))}" hidden></form>` : ""}`;
  return `<span data-agent-compact-available="${stats.compactAvailable}" hidden></span>
${meter}
${stats.inputTokens === null ? "" : `<span class="agent-stat" data-footer-drop="1" title="Tokens up (input)${stats.nativeBranchUsage ? " on this branch" : ""}">↑ <b>${formatTokens(stats.inputTokens)}</b></span>`}
${stats.outputTokens === null ? "" : `<span class="agent-stat" data-footer-drop="1" title="Tokens down (output)${stats.nativeBranchUsage ? " on this branch" : ""}">↓ <b>${formatTokens(stats.outputTokens)}</b></span>`}
${stats.cost === null ? "" : `<span class="agent-stat" data-footer-drop="2" title="${stats.nativeBranchUsage ? `This branch cost, including compaction and recorded attempts.${stats.descendantCost === undefined ? "" : " Plus what its subagents and its scripts' one-shot agents cost, excluding inherited usage."} Updated when usage commits.` : "Agent cost. Updated at agent turn end."}"><b>${formatCost(stats.cost)}${stats.descendantCost === undefined ? "" : ` + ${formatCost(stats.descendantCost)}`}</b></span>`}
${selectionForms}
${renderSharedComposerSelections({
    modelFormId,
    thinkingLevelFormId,
    models,
    thinkingLevels: stats.thinkingLevels,
    selectedThinkingLevel: stats.thinkingLevel,
    autosubmitThinking: true,
    connectedProvider: stats.connectedProvider,
  })}`;
}
