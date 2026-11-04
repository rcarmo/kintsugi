import { buttonHtml } from "@kintsugi/design-system/button";
import { Icons } from "@kintsugi/design-system/icons";
import { escapeHtml } from "@kintsugi/shared";

export function renderNotice(level: "info" | "error", message: string): string {
  return `<div class="agent-noticeline ${escapeHtml(level)}" data-controller="agent-notice" data-agent-notice-auto-dismiss-value="${level !== "error"}"><span role="${level === "error" ? "alert" : "status"}">${escapeHtml(message)}</span>${level === "error" ? buttonHtml({
    type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss notice" },
    attributesHtml: 'data-action="click->agent-notice#dismiss"',
  }) : ""}</div>`;
}
