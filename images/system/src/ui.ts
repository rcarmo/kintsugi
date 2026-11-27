import { Icons } from "../../../packages/design-system/src/icons/icons-html.ts";
import { actionLinkHtml } from "../../../packages/design-system/src/action-link/action-link-html.ts";
import { buttonHtml } from "../../../packages/design-system/src/button/button-html.ts";
import { disclosureHtml } from "../../../packages/design-system/src/disclosure/disclosure-html.ts";
import { escapeHtml } from "../../../packages/shared/src/html.ts";
import type { KintsugiTheme } from "../../../packages/shared/src/theme.ts";

export const button = (caption: string) =>
  buttonHtml({
    type: "submit",
    variant: "primary",
    content: { kind: "caption", caption },
  });
export function page(title: string, content: string, assetOrigin = "", theme: KintsugiTheme = "nord"): string {
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${escapeHtml(assetOrigin)}/design-system.css"><style>
body { margin:0; min-height:100dvh; box-sizing:border-box; display:flex; flex-direction:column; padding:24px 16px; font:var(--text-body)/var(--leading-standard) var(--font-sans); background:var(--bg); color:var(--text); }
main { width:100%; max-width:38rem; margin:auto; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:20rem; overflow:auto; }
form { margin:0; }
p { margin:0 0 16px; }
h1 { margin:0; color:var(--text-bright); font:var(--weight-semibold) var(--text-title)/var(--leading-standard) var(--font-sans); }
.system-checklist { margin:24px 0; }
.system-detail { display:block; margin-top:4px; color:var(--text-muted); font-size:var(--text-code); overflow-wrap:anywhere; }
.system-actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:16px; }
.system-foldout { margin-top:8px; }
.system-error { color:var(--danger); }
.system-log { font:var(--text-code)/var(--leading-standard) var(--font-mono); }
input { width:min(100%,32rem); }
a { color:inherit; }
</style><script type="module" src="${escapeHtml(assetOrigin)}/client.js"></script></head><body><main>${content}</main></body></html>`;
}

export interface SupervisorView {
  operation: "startup" | "update";
  phase: number;
  healthy: boolean;
  recoveringHealth: boolean;
  degradedHealth: boolean;
  stopping: boolean;
  failure?: string;
  candidate: string;
  connectionMode: string;
  connectionState: string;
  connectionProblem?: string;
  connectionAction?: { description: string; url?: string };
  authUrl?: string;
  logs: string[];
}

function foldout(id: string, label: string, body: string): string {
  return `<div class="system-foldout">${disclosureHtml({ element: { id }, summary: { kind: "compact", label: { kind: "text", text: label } }, bodyHtml: body })}</div>`;
}

export function supervisorFragment(view: SupervisorView): string {
  const title = view.stopping ? "Stopping Kintsugi" : view.failure ? "Kintsugi needs attention" : view.degradedHealth ? "Checking Kintsugi" : view.connectionAction ? "Setting up Tailscale" : view.healthy ? "Kintsugi is ready" : view.operation === "update" ? "Updating Kintsugi" : "Starting Kintsugi";
  const labels = ["Prepare Kintsugi images", "Stop the previous version", "Start Kintsugi", "Check health", "Open Kintsugi"];
  const checklist = labels.map((label, index) => {
    const done = (view.healthy || index < view.phase) && !(index === 4 && view.connectionAction);
    const failed = !done && index === view.phase && !!view.failure;
    const running = !done && !failed && index === view.phase;
    return `<li class="status-list__item"${done ? ' role="checkbox" aria-checked="true"' : failed ? ' data-status="failed"' : running ? ' aria-busy="true"' : ''}><span class="status-list__marker"${failed ? ' role="img" aria-label="Failed"' : ''}>${done ? Icons.Check : failed ? Icons.Close : ""}</span><div>${label}${failed ? `<span class="system-detail system-error">${escapeHtml(view.failure!)}</span>` : ""}</div></li>`;
  }).join("");

  const failureActions = view.failure && !view.stopping ? `
    ${view.recoveringHealth ? `<p class="system-detail">System is checking automatically. Rechecking does not restart Kintsugi.</p>` : ""}
    <div class="system-actions">
      ${view.recoveringHealth ? `<form method="post" action="/recheck">${button("Recheck health")}</form>` : ""}
      <form method="post" action="/retry">${button(view.recoveringHealth ? "Restart Kintsugi" : "Retry startup")}</form>
    </div>` : "";

  const remote = view.connectionMode === "tailscale";
  const accessSummary = remote
    ? `Devices on your Tailscale network — including the installation computer.<br>Tailscale: ${escapeHtml(view.connectionState)}`
    : "Installation computer only — Tailscale is off.";
  const accessActions = `
    ${!remote || (!view.authUrl && view.connectionState !== "Running") ? `<form method="post" action="/connect">${button(remote ? "Retry Tailscale connection" : "Use devices on your Tailscale network")}</form>` : ""}
    ${remote ? `<form method="post" action="/local">${button("Use installation computer only")}</form>` : ""}`;

  return `<section aria-label="Kintsugi System"><h1>${title}</h1>
    <section class="system-checklist" aria-label="Kintsugi preparation">${view.stopping ? "" : `<ol class="status-list">${checklist}</ol>`}${failureActions}</section>
    ${view.authUrl ? `<p>Sign in to use Kintsugi from devices on your tailnet.</p>${actionLinkHtml({ href: view.authUrl, variant: "primary", content: { kind: "caption", caption: "Sign in to Tailscale" } })}` : ""}
    ${view.connectionAction ? `<p>${escapeHtml(view.connectionAction.description)}</p>${view.connectionAction.url ? actionLinkHtml({ href: view.connectionAction.url, variant: "primary", content: { kind: "caption", caption: "Open Tailscale DNS settings" }, attributesHtml: 'target="_blank" rel="noreferrer"' }) : ""}` : ""}
    ${view.connectionProblem ? `<p class="system-error">${escapeHtml(view.connectionProblem)}</p>` : ""}
    ${foldout("system-logs", "Docker logs", `<pre class="system-log" data-progress-log>${escapeHtml(view.logs.join("\n") || "Waiting for output…")}</pre>`)}
    ${foldout("system-access", "Connection & system details", `<p>${accessSummary}</p><p class="system-detail">Image: ${escapeHtml(view.candidate)}</p><div class="system-actions">${accessActions}</div>`)}
  </section>`;
}
