import { disclosureHtml, type DisclosureSummary } from "@kintsugi/design-system/disclosure";
import { buttonHtml } from "@kintsugi/design-system/button";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { Icons } from "@kintsugi/design-system/icons";
import { renderStreamingMarkdownSnapshot } from "@kintsugi/markdown";
import type { ModelRef } from "@kintsugi/llm/server";
import { domId, escapeHtml } from "@kintsugi/shared";
import { agentPath, commentaryContext, ids, sessionImageUrl, transcriptItemPath, type AgentRenderContext } from "./render-context.ts";
import { codeBlockHtml, detailFullscreen, fullscreenAttributes, markdown, renderMarkdownRow, transcriptRowContent, transcriptRow } from "./render-markup.ts";
import { renderToolCard, renderToolDetail } from "./render-tool.ts";
import { formatDuration, formatTokens, unfencedJson, type QueuedInput, type TranscriptItem, type WorkingTranscriptItem } from "./transcript.ts";

interface AgentToolDefinitionView {
  name: string;
  description: string;
  parameters: unknown;
}

export interface AgentModelContextView {
  systemPrompt: string;
  tools: AgentToolDefinitionView[];
}

export function renderTranscript(ctx: AgentRenderContext, items: TranscriptItem[], modelContext: AgentModelContextView, busy = false): string {
  return `${renderModelContextEntries(ctx, modelContext)}${items.map((item) => renderTranscriptItem(ctx, item)).join("")}${renderIdleSeparator(items, busy)}<div class="agent-notices" id="${ids.notices(ctx)}"></div>`;
}

/** Presentation only: never append a synthetic message or persist an idle boundary. */
export function renderIdleSeparator(items: readonly TranscriptItem[], busy: boolean): string {
  if (busy) return "";
  const latest = (items: readonly TranscriptItem[]): number => {
    let last = 0;
    for (const item of items) {
      if (item.type === "inherited-context" || item.type === "extension" || (item.type === "user" && item.queued)) continue;
      // Some native harnesses expose only turn-level dates, not per-message dates.
      const timestamp = item.type === "working" ? latest(item.items) || item.completedAt || item.stoppedAt : item.timestamp;
      if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp > last && timestamp <= 8.64e15) last = timestamp;
    }
    return last;
  };
  const timestamp = latest(items);
  if (!timestamp) return "";
  const iso = new Date(timestamp).toISOString();
  return `<div class="agent-idle-separator" role="separator" aria-label="Last message: ${iso}"><time datetime="${iso}" title="${iso}" data-controller="agent-message-time" data-agent-message-time-timestamp-value="${timestamp}">${iso}</time></div>`;
}

export function renderModelContextEntries(ctx: AgentRenderContext, modelContext: AgentModelContextView): string {
  const prompt = modelContext.systemPrompt.trim()
    ? renderLazyTranscriptEntry(ctx, "system-prompt", "System prompt") : "";
  const tools = modelContext.tools.length
    ? renderLazyTranscriptEntry(ctx, "tool-definitions", "Tool definitions") : "";
  return `${prompt}${tools}`;
}

export function renderLazyTranscriptEntry(ctx: AgentRenderContext, key: string, label: string): string {
  const frame = `<turbo-frame id="${ids.detailFrame(ctx, key)}" data-turbo-permanent data-agent-lazy-detail-target="frame" data-src="${escapeHtml(transcriptItemPath(ctx, key))}"></turbo-frame>`;
  return transcriptRow(disclosureHtml({ element: { attributesHtml: 'data-controller="agent-lazy-detail" data-action="toggle->agent-lazy-detail#load"' }, summary: transcriptRowContent({ kind: "text", text: label }), bodyHtml: frame }));
}

export function renderModelContextDetailFrame(ctx: AgentRenderContext, modelContext: AgentModelContextView, key: "system-prompt" | "tool-definitions"): string {
  const content = key === "system-prompt"
    ? renderMarkdownRow(ctx, modelContext.systemPrompt, "markdown agent-itext-md")
    : `<div class="agent-tool-detail">${detailFullscreen("Tool definitions", codeBlockHtml(JSON.stringify(modelContext.tools, null, 2), "tools.json"))}</div>`;
  return `<turbo-frame id="${ids.detailFrame(ctx, key)}">${content}</turbo-frame>`;
}

function renderUserMessage(ctx: AgentRenderContext, user: Extract<TranscriptItem, { type: "user" }>): string {
  const images = user.images.length ? `<div class="agent-user-attachments">${user.images.map((image) => `<img${fullscreenAttributes("attachment", "media")} src="${escapeHtml(sessionImageUrl(ctx, image))}" alt="attachment" loading="lazy">`).join("")}</div>` : "";
  const label = user.queued?.stranded ? "Not sent · the turn ended early"
    : user.queued?.mode === "followUp" ? "Follow-up · after this turn"
    : user.queued ? "Steering · after this step" : "";
  const actions = user.queued && !ctx.readOnly ? renderQueuedInputActions(ctx, user.key, user.queued) : "";
  return transcriptRow(`<div class="agent-user" data-agent-user-text="${escapeHtml(user.text)}"><div class="agent-user-bubble markdown">${label ? `<div class="agent-user-label"><span>${label}</span>${actions}</div>` : ""}${markdown(ctx, user.text)}${images}</div></div>`);
}

/**
 * A follow-up can be promoted to steering, and input a failed turn left behind can be sent now;
 * ⌘/Ctrl+Enter in an empty composer does that to the newest one.
 */
function renderQueuedInputActions(ctx: AgentRenderContext, key: string, queued: QueuedInput): string {
  const path = (action: string) => escapeHtml(agentPath(ctx, `/queued-inputs/${encodeURIComponent(queued.submissionId)}/${action}`));
  const steer = queued.mode === "followUp" || queued.stranded
    ? buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: queued.stranded ? "Send now" : "Steer" }, attributesHtml: `formaction="${path("steer")}" data-agent-queued-steer="${escapeHtml(queued.submissionId)}" data-agent-pane-target="queuedSteer" aria-keyshortcuts="Meta+Enter Control+Enter"` }) : "";
  const cancel = destructiveConfirmationHtml({
    id: domId(ids.item(ctx, key), "cancel"),
    trigger: { type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Remove queued message" } },
    confirmCaption: "Remove message",
    cancelCaption: "Keep",
  });
  return `<form class="agent-user-queued-actions" method="post" action="${path("cancel")}">${steer}${cancel}</form>`;
}

function renderStreamingTextBody(ctx: AgentRenderContext, key: string, text: string, className: string): string {
  const snapshot = ctx.streamingText?.(key, text) ?? renderStreamingMarkdownSnapshot(ctx.workspaceId, text);
  // Live streaming text is owned by its own regions; morphing the row must not blank it.
  const island = ctx.streamingText ? " data-turbo-permanent" : "";
  return `<div class="${className} agent-stream-markdown" data-controller="agent-streaming-text" id="${ids.itemText(ctx, key)}"><div id="${ids.itemTextStable(ctx, key)}"${island}>${snapshot.stableHtml}</div><div id="${ids.itemTextTail(ctx, key)}"${island}>${snapshot.tailHtml}</div></div>`;
}

export function renderTranscriptItem(ctx: AgentRenderContext, item: TranscriptItem, options: { live?: boolean; open?: boolean } = {}): string {
  if (item.type === "working") return renderWorkingSection(ctx, item);
  const id = ids.item(ctx, item.key);
  let body = "";
  if (item.type === "inherited-context") {
    const label = `Inherited context from ${item.source} · ${item.messageCount} ${item.messageCount === 1 ? "message" : "messages"} · filtered`;
    body = renderLazyTranscriptEntry(ctx, item.key, label);
  } else if (item.type === "user") body = renderUserMessage(ctx, item);
  else if (item.type === "thinking") body = renderThinkingItem(ctx, item);
  else if (item.type === "text" && item.final && ctx.jsonFinalAnswers) body = renderJsonFinalAnswer(ctx, item.text, Boolean(item.live));
  else if (item.type === "text") {
    const className = item.final ? "markdown agent-final" : "markdown agent-itext-md";
    body = item.live
      ? transcriptRow(renderStreamingTextBody(ctx, item.key, item.text, className))
      : renderMarkdownRow(ctx, item.text, className);
  } else if (item.type === "tool") body = transcriptRow(renderToolCard(ctx, item.key, item.tool, { ...options, open: options.open || Boolean(ctx.revealTarget && (item.anchor === ctx.revealTarget || item.key === ctx.revealTarget)) }));
  else if (item.type === "extension") body = item.render(ctx);
  else if (item.type === "note") {
    body = item.tone === "summary"
      ? transcriptRow(disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Compaction summary" } }, bodyHtml: `<div class="markdown">${markdown(ctx, item.text)}</div>` }))
      : renderMarkdownRow(ctx, item.text, `markdown agent-note ${escapeHtml(item.tone)}`);
  }
  else body = transcriptRow(`<div class="agent-error">${escapeHtml(item.text)}</div>`);
  return `<div class="agent-item" id="${id}" data-transcript-key="${escapeHtml(item.key)}" data-quote-source="${escapeHtml(quoteSource(item))}"${item.anchor ? ` data-transcript-anchor="${escapeHtml(item.anchor)}"` : ""}${item.type === "tool" ? ` data-tool-call-id="${escapeHtml(item.tool.callId)}"` : ""}>${body}</div>`;
}

/** The Comment button for selected transcript text; the pane's `transcript-quote` controller places it. */
export function renderTranscriptQuoteAction(): string {
  return `<div class="transcript-quote-action" data-transcript-quote-target="action" hidden>${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Comment, label: "Comment on selection" }, attributesHtml: 'data-popular-button="touch" data-action="mousedown->transcript-quote#keepSelection pointerdown->transcript-quote#press pointerup@window->transcript-quote#release pointercancel->transcript-quote#release click->transcript-quote#quote"' })}</div>`;
}

/** Where a quoted selection came from, as the user tells the Agent. */
function quoteSource(item: Exclude<TranscriptItem, { type: "working" }>): string {
  switch (item.type) {
    case "user": return "From my prompt";
    case "text": return "From your reply";
    case "thinking": return "From your thinking";
    case "tool": return `From the \`${item.tool.name}\` tool call`;
    default: return "From the transcript";
  }
}

/** A JSON final answer, formatted once it parses. A streaming answer shows as written; one that isn't JSON, as markdown. */
function renderJsonFinalAnswer(ctx: AgentRenderContext, text: string, live: boolean): string {
  let code = unfencedJson(text);
  if (!live) {
    try { code = JSON.stringify(JSON.parse(code), null, 2); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return renderMarkdownRow(ctx, text, "markdown agent-final");
    }
  }
  return transcriptRow(`<div class="agent-final">${codeBlockHtml(code, "answer.json", "agent-tool-code agent-final-json")}</div>`);
}

function renderWorkingContent(ctx: AgentRenderContext, section: WorkingTranscriptItem, options: { live?: boolean; open?: boolean } = {}): string {
  const content = section.items.map((item) => renderTranscriptItem(ctx, item, options)).join("");
  const finished = section.completedAt !== undefined || section.stoppedAt !== undefined;
  return !content && finished ? '<p class="agent-working-empty">No intermediate activity for this turn.</p>' : content;
}

function renderWorkingItems(ctx: AgentRenderContext, section: WorkingTranscriptItem, options: { live?: boolean; open?: boolean } = {}): string {
  const items = renderWorkingContent(ctx, section, options);
  return `<div id="${ids.workingItems(ctx, section.key)}">${items}</div>`;
}

export function workingCommentaryItems(section: WorkingTranscriptItem): TranscriptItem[] {
  if (section.completedAt !== undefined && section.hasFinalAnswer) return [];
  return section.items.filter((item) => item.type === "text");
}

/** Live renderers pass the commentary collection's islands so morphing the turn keeps its rows mounted. */
export function renderWorkingSection(ctx: AgentRenderContext, section: WorkingTranscriptItem, commentaryHtml?: string): string {
  if (section.completedAt !== undefined && section.items.length === 0 && !section.timing) return "";
  const summary = workingSummary(ctx, section);
  const commentary = commentaryContext(ctx);
  commentaryHtml ??= workingCommentaryItems(section).map((item) => renderTranscriptItem(commentary, item)).join("");
  const revealing = Boolean(ctx.revealTarget && section.items.some((item) => item.anchor === ctx.revealTarget || item.key === ctx.revealTarget));
  const finished = section.completedAt !== undefined || section.stoppedAt !== undefined;
  const lazy = !ctx.readOnly && Boolean(ctx.lazyCompletedWorkingItems && finished);
  const attributes = ctx.readOnly ? "" : lazy
    ? 'data-controller="agent-lazy-detail" data-action="toggle->agent-lazy-detail#load"'
    : ctx.inlineWorkingItems ? `data-agent-turn-turn-id-value="${escapeHtml(section.key)}"` : `data-controller="agent-turn" data-agent-turn-workspace-id-value="${escapeHtml(ctx.workspaceId)}" data-agent-turn-agent-id-value="${escapeHtml(ctx.agentId)}" data-agent-turn-turn-id-value="${escapeHtml(section.key)}" data-agent-turn-branch-id-value="${escapeHtml(ctx.branchId ?? "")}"${revealing ? ` data-agent-turn-reveal-value="${escapeHtml(ctx.revealTarget!)}"` : ""} data-action="toggle->agent-turn#toggle"`;
  const items = lazy
    ? `<turbo-frame id="${ids.detailFrame(ctx, section.key)}" data-turbo-permanent data-agent-lazy-detail-target="frame" data-src="${escapeHtml(transcriptItemPath(ctx, section.key))}"></turbo-frame>`
    : ctx.readOnly || ctx.inlineWorkingItems ? renderWorkingContent(ctx, section) : "";
  const builtinLazy = !ctx.readOnly && !ctx.inlineWorkingItems && !lazy;
  return `<div class="agent-working-block" id="${ids.item(ctx, section.key)}">${disclosureHtml({
    element: { attributesHtml: attributes }, summary, open: revealing,
    bodyAttributesHtml: lazy ? undefined : `id="${ids.workingItems(ctx, section.key)}"${builtinLazy ? ' data-agent-turn-target="items" data-turbo-permanent' : ""}`,
    bodyHtml: items,
  })}<div class="disclosure-content agent-working-commentary" id="${ids.workingItems(commentary, section.key)}">${commentaryHtml}</div></div>`;
}

function workingSummary(ctx: AgentRenderContext, section: WorkingTranscriptItem): DisclosureSummary {
  const endedAt = section.completedAt ?? section.stoppedAt;
  const active = endedAt === undefined;
  const duration = formatDuration(active ? Date.now() - section.startedAt : section.timing?.elapsedMs ?? (endedAt! - section.startedAt));
  const completed = section.completedAt !== undefined;
  const activityLabel = section.durationUnavailable ? (active ? "Working" : completed ? "Completed" : "Stopped")
    : active ? `Working · ${duration}` : completed ? `Worked for ${duration}` : `Stopped · ${duration}`;
  const status = active ? `<i class="status-dot running${ctx.readOnly ? " static" : ""} content-row__status" aria-label="In progress"></i>` : "";
  return { ...transcriptRowContent({ kind: "text", text: activityLabel,
    attributesHtml: active && !ctx.readOnly && !section.durationUnavailable ? `data-controller="agent-elapsed" data-agent-elapsed-since-value="${section.startedAt}" data-agent-elapsed-prefix-value="Working · " data-agent-elapsed-format-value="duration"` : undefined,
    textAttributesHtml: active && !ctx.readOnly && !section.durationUnavailable ? 'data-agent-elapsed-target="time"' : undefined,
  }, {
    leadingHtml: status, trailingHtml: active ? "" : renderWorkingTiming(section),
  }), attributesHtml: `id="${ids.itemSummaryContent(ctx, section.key)}"` };
}

function renderWorkingTiming(section: Omit<WorkingTranscriptItem, "items">): string {
  if (!section.timing) return "";
  const timing = section.timing;
  const rate = timing.usageComplete && timing.inferenceMs > 0
    ? `${(timing.outputTokens / (timing.inferenceMs / 1000)).toFixed(0)} tps`
    : "tps unavailable";
  const toolDuration = formatDuration(timing.toolMs);
  const toolsLabel = toolDuration === "0s" ? "" : `${toolDuration} tools, `;
  return ` <span class="agent-working-timing" title="Wall-clock tool wait (parallel calls counted once). Output-token count and tokens per inference second, including reported thinking tokens.">(${escapeHtml(toolsLabel)}${timing.usageComplete ? `${formatTokens(timing.outputTokens)} tok` : "tokens unavailable"} @ ${escapeHtml(rate)})</span>`;
}

/** These models write short, final-quality thoughts, so they render in full rather than clamped until expanded. */
function showsFullThinking(model?: ModelRef): boolean {
  return model?.provider === "openai-codex" && /^gpt-5\.(?:5|6)(?:$|[-.])/.test(model.id);
}

function renderThinkingItem(ctx: AgentRenderContext, item: Extract<TranscriptItem, { type: "thinking" }>): string {
  const contentId = escapeHtml(ids.itemText(ctx, item.key));
  const content = item.live
    // Thinking rows are morphed as a whole, unlike the independently streamed prose regions.
    ? renderStreamingTextBody({ ...ctx, streamingText: undefined }, item.key, item.text, "markdown")
    : `<div class="markdown" id="${contentId}">${markdown(ctx, item.text.trimEnd())}</div>`;
  return transcriptRow(showsFullThinking(ctx.model)
    ? `<div class="agent-thinking-text expanded">${content}</div>`
    : `<div class="agent-thinking-text" data-controller="agent-thinking" data-action="click->agent-thinking#expand keydown->agent-thinking#keydown"><div data-agent-thinking-target="content">${content}</div><div class="markdown" data-agent-thinking-target="preview" hidden></div><button class="agent-thinking-more" type="button" data-agent-thinking-target="more" tabindex="-1" hidden>...(show more)</button></div>`);
}

export function renderTranscriptItemDetailFrame(ctx: AgentRenderContext, item: TranscriptItem, options: { count?: number } = {}): string {
  const frameId = ids.detailFrame(ctx, item.key);
  let html = "";
  if (item.type === "working") html = renderWorkingItems(ctx, item);
  else if (item.type === "inherited-context") html = `<div class="agent-inherited-content"><p class="agent-inherited-explanation">Copied from ${escapeHtml(item.source)} at spawn time. Only selected user messages, final assistant text, and context summaries are retained; tool activity, reasoning, and intermediate messages are omitted.</p>${item.items.map((child) => renderTranscriptItem(ctx, child)).join("")}</div>`;
  else if (item.type === "tool") html = renderToolDetail(ctx, item.key, item.tool, options.count ?? 100);
  return `<turbo-frame id="${frameId}">${html}</turbo-frame>`;
}
