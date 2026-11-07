import { type ContentRowContent, type ContentRowLabel } from "@kintsugi/design-system/content-row";
import { renderMarkdown } from "@kintsugi/markdown";
import { highlightCodeHtmlForPath } from "@kintsugi/syntax";
import { escapeHtml } from "@kintsugi/shared";
import type { AgentRenderContext } from "./render-context.ts";

export function markdown(ctx: AgentRenderContext, text: string): string {
  return renderMarkdown(ctx.workspaceId, text);
}

/** Native hover text, localised in the browser without changing message contents. */
export function transcriptTimestampAttributes(timestamp?: number): string {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8.64e15) return "";
  const iso = new Date(timestamp).toISOString();
  return ` title="${iso}" data-controller="agent-message-time" data-agent-message-time-timestamp-value="${timestamp}" data-agent-message-time-tooltip-only-value="true"`;
}

export function transcriptRow(html: string): string {
  return `<div class="agent-row">${html}</div>`;
}

export function transcriptRowContent(label: ContentRowLabel, options: { leadingHtml?: string; trailingHtml?: string; labelId?: string } = {}): ContentRowContent {
  return {
    kind: "compact",
    leadingHtml: options.leadingHtml,
    trailingHtml: options.trailingHtml,
    label: { ...label, textAttributesHtml: [label.textAttributesHtml, options.labelId ? `id="${escapeHtml(options.labelId)}"` : ""].filter(Boolean).join(" ") },
  };
}

export function renderMarkdownRow(ctx: AgentRenderContext, text: string, className: string): string {
  const body = markdown(ctx, text);
  return body ? transcriptRow(`<div class="${className}">${body}</div>`) : "";
}

export function fullscreenAttributes(title: string, mode: "template" | "media" = "template"): string {
  return ` data-controller="kintsugi-fullscreen" data-kintsugi-fullscreen-mode-value="${mode}" data-kintsugi-fullscreen-title-value="${escapeHtml(title)}"`;
}

export function detailFullscreen(title: string, html: string): string {
  return `<div class="agent-detail-fullscreen"${fullscreenAttributes(title)}>${html}<template data-kintsugi-fullscreen-target="content">${html}</template></div>`;
}

export function codeBlockHtml(code: string, filePath: string | undefined, className = "agent-tool-code"): string {
  const highlighted = highlightCodeHtmlForPath(code, filePath);
  const languageClass = highlighted.language ? ` language-${escapeHtml(highlighted.language)}` : "";
  return `<pre class="${className}${languageClass}"><code>${highlighted.html}</code></pre>`;
}

export function transcriptTargetLink(ctx: AgentRenderContext, target: string, label: string): string {
  const query = new URLSearchParams({ agent: ctx.agentId, agentTarget: target });
  return `<a href="/workspaces/${encodeURIComponent(ctx.workspaceId)}?${escapeHtml(query.toString())}" class="agent-trace-link" data-action="agent-pane#reveal" data-agent-pane-item-param="${escapeHtml(target)}" data-agent-pane-agent-param="${escapeHtml(ctx.agentId)}">${escapeHtml(label)}</a>`;
}
