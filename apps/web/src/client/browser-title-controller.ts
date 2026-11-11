import { Controller } from "@hotwired/stimulus";
import { workspaceAgentSelectionEvent } from "@kintsugi/shared";
import { workspacePageTitle } from "../page-title.ts";

/** Titles follow published names and personal selection, not transcript text or provider activity. */
export class BrowserTitleController extends Controller<HTMLElement> {
  private queued = false;
  private readonly events = ["kintsugi:workspace-pane-changed", "kintsugi:workspace-pane-visible", "kintsugi:workspace-pane-hidden", "workspace-selection:before-select", workspaceAgentSelectionEvent];

  connect(): void {
    for (const name of this.events) document.addEventListener(name, this.schedule);
    window.addEventListener("popstate", this.schedule);
    this.update();
  }
  disconnect(): void {
    for (const name of this.events) document.removeEventListener(name, this.schedule);
    window.removeEventListener("popstate", this.schedule);
  }
  private readonly schedule = (): void => {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; if (this.element.isConnected) this.update(); });
  };
  private update(): void {
    const match = /^\/workspaces\/([^/]+)$/.exec(location.pathname);
    let title = workspacePageTitle();
    if (match && !document.querySelector('[data-controller~="app-settings"], [data-controller~="template-settings"]')) {
      let id: string;
      try { id = decodeURIComponent(match[1]!); } catch { document.title = title; return; }
      const escaped = CSS.escape(id);
      const row = document.querySelector<HTMLElement>(`[data-workspace-entry-id="${escaped}"]`);
      const presentation = document.querySelector<HTMLElement>(`.workspace-detail-mount[data-workspace-id="${escaped}"] .fixed-workspace-presentation`);
      const selected = presentation?.dataset.workspaceSelectedAgent || new URL(location.href).searchParams.get("agent");
      const agent = selected ? presentation?.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(selected)}"][data-agent-title]`) : undefined;
      title = workspacePageTitle(row?.dataset.workspaceTitle ?? presentation?.dataset.workspaceTitle, agent?.dataset.agentTitle);
    }
    if (document.title !== title) document.title = title;
  }
}
