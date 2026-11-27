import { markdown } from "@kintsugi/agent/server/render-markup";
import type { AgentRenderContext } from "@kintsugi/agent/server/render-context";
import { escapeHtml } from "@kintsugi/shared";

/** Communication details share the standard tool card, with labelled data rows. */
export function communicationCardHtml(rows: Array<{ label: string; html: string }>): string {
  return `<div class="agent-tool-detail"><table class="agent-communication-table"><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${row.html}</td></tr>`).join("")}</tbody></table></div>`;
}

export function communicationBodyHtml(ctx: AgentRenderContext, text: string): string {
  return `<div class="markdown">${markdown(ctx, text)}</div>`;
}

export function communicationTraceHtml(ctx: AgentRenderContext, agentId: string, messageId: string, label: string): string {
  const query = new URLSearchParams({ child: agentId, message: messageId });
  return `<a href="/workspaces/${encodeURIComponent(ctx.workspaceId)}/subagents/reveal?${escapeHtml(query.toString())}" data-turbo="false" class="agent-trace-link">${escapeHtml(label)}</a>`;
}
