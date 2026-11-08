import { flushPreviewFrames } from "@kintsugi/proxy-ingress/preview-client";
import { restoreAppSettingsDestination } from "./app-settings-controller.ts";
import { restoreTemplateSettingsDestination } from "./template-settings-controller.ts";
import { markActiveWorkspaceRow } from "./workspace-presentation.ts";
import { phoneLayoutMediaQuery } from "@kintsugi/shared";
import { Controller } from "@hotwired/stimulus";
import { liveSurfaceReady, prepareLiveSurface, releaseLiveSurface } from "./live-surface.ts";
import { controllerForElement, registerWorkspaceControllers, workspaceNavigationController } from "./workspace-controller-registry.ts";

export type WorkspaceSelectionEvent = CustomEvent<{ resume(): Promise<void> }>;

interface MountPresentation {
  prepareIntendedSurfaces(): Promise<void>;
  intendedSurfacesReady(): boolean;
  focusSelectedAgent(): void;
}

class WorkspaceSelectionController extends Controller<HTMLElement> {
  static targets = ["mount", "empty", "loading"];
  static values = { maxPreloaded: Number };
  declare readonly mountTargets: HTMLElement[];
  declare readonly emptyTargets: HTMLElement[];
  declare readonly loadingTargets: HTMLElement[];
  declare readonly maxPreloadedValue: number;
  private intended?: string;
  private selectedFromList = false;
  private selection = 0;
  private readonly preparing = new Set<HTMLElement>();
  private retained = new Set<HTMLElement>();
  private readonly preparedSubmissions = new WeakSet<HTMLFormElement>();
  private readonly beforeWorkspaceStop = (event: SubmitEvent): void => {
    if (!(event.target instanceof HTMLFormElement) || event.defaultPrevented) return;
    const form = event.target, url = new URL(form.action);
    if (url.origin !== location.origin || !/^\/workspaces\/[^/]+\/(?:park|delete)$/.test(url.pathname)) return;
    if (this.preparedSubmissions.delete(form)) return;
    const workspaceId = decodeURIComponent(url.pathname.split("/")[2]!);
    const mount = this.mountTargets.find(mount => mount.dataset.workspaceId === workspaceId);
    if (!mount) return;
    event.preventDefault();
    void flushPreviewFrames(mount).then(() => {
      this.preparedSubmissions.add(form); form.requestSubmit(event.submitter);
    }).catch(error => { console.error("Workspace stop paused", error); window.alert("Preview settings could not be saved. The workspace was kept open."); });
  };

  connect(): void {
    document.addEventListener("submit", this.beforeWorkspaceStop);
    document.addEventListener("kintsugi:workspace-pane-changed", this.changed);
    this.element.addEventListener("live:ready", this.changed);
    document.addEventListener("live:connection", this.changed);
    document.addEventListener("kintsugi:workspace-pane-visible", this.reportVisibility);
    document.addEventListener("kintsugi:workspace-pane-hidden", this.reportVisibility);
    document.addEventListener("visibilitychange", this.reportVisibility);
    document.addEventListener("kintsugi:mobile-workspace-pane-changed", this.reportVisibility);
    window.addEventListener("popstate", this.historyChanged);
    this.historyChanged();
  }
  disconnect(): void {
    document.removeEventListener("submit", this.beforeWorkspaceStop);
    this.selection++;
    document.removeEventListener("kintsugi:workspace-pane-changed", this.changed);
    this.element.removeEventListener("live:ready", this.changed);
    document.removeEventListener("live:connection", this.changed);
    document.removeEventListener("kintsugi:workspace-pane-visible", this.reportVisibility);
    document.removeEventListener("kintsugi:workspace-pane-hidden", this.reportVisibility);
    document.removeEventListener("visibilitychange", this.reportVisibility);
    document.removeEventListener("kintsugi:mobile-workspace-pane-changed", this.reportVisibility);
    window.removeEventListener("popstate", this.historyChanged);
    window.KintsugiCable?.reportVisibility({ surfaceKeys: [] });
  }
  mountTargetConnected(mount: HTMLElement): void {
    if (mount.dataset.workspaceId === this.intended && !mount.classList.contains("visible")) void this.selectWorkspace(this.intended!, location.href, "none");
  }
  mountTargetDisconnected(mount: HTMLElement): void {
    if (mount.dataset.workspaceId === this.intended) this.unselectWorkspace(this.intended!);
    this.reportVisibility();
  }
  async selectWorkspace(workspaceId: string, href: string, historyMode: "push" | "none" = "push"): Promise<void> {
    if (historyMode === "push" && !this.element.dispatchEvent(new CustomEvent("workspace-selection:before-select", { bubbles: true, cancelable: true, detail: { resume: () => this.selectWorkspace(workspaceId, href, historyMode) } }))) return;
    const selection = ++this.selection;
    this.selectedFromList = historyMode === "push" || (this.intended === workspaceId && this.selectedFromList);
    this.intended = workspaceId;
    if (historyMode === "push" && new URL(href, location.href).href !== location.href) history.pushState({}, "", href);
    workspaceNavigationController()?.setActiveWorkspace(workspaceId);
    const mount = this.mountTargets.find(item => item.dataset.workspaceId === workspaceId);
    // A command acknowledgement can precede the shell snapshot containing its mount.
    if (!mount) return;
    this.hideMounts();
    this.emptyTargets.forEach(element => { element.hidden = true; });
    this.loadingTargets.forEach(element => { element.hidden = true; });
    mount.classList.add("visible");
    mount.dataset.lastActivatedAt = String(Date.now());
    await prepareLiveSurface(mount);
    if (selection !== this.selection) return;
    mount.querySelector("[data-controller~='workspace-presentation']")?.dispatchEvent(new CustomEvent("kintsugi:workspace-mount-visible", { detail: { selectedFromList: this.selectedFromList } }));
    this.selectedFromList = false;
    const presentation = this.presentation(mount);
    await presentation?.prepareIntendedSurfaces();
    if (selection !== this.selection) return;
    presentation?.focusSelectedAgent();
    this.changed();
    this.reportVisibility();

  }
  unselectWorkspace(workspaceId: string): void {
    if (this.intended !== workspaceId) return;
    this.selection++;
    this.intended = undefined;
    workspaceNavigationController()?.setActiveWorkspace();
    history.replaceState({}, "", "/");
    this.hideMounts();
    this.emptyTargets.forEach(element => { element.hidden = false; });
    workspaceNavigationController()?.showWorkspacePane();
    this.changed();
    this.reportVisibility();
  }
  visibleWorkspaceId(): string | undefined { return this.mountTargets.find(item => item.classList.contains("visible"))?.dataset.workspaceId; }
  oldestAttentionWorkspaceId(): string | undefined {
    const workspaces = [...document.querySelectorAll<HTMLElement>("[data-workspace-entry-id][data-workspace-attention-at]")]
      .sort((a, b) => Number(a.dataset.workspaceAttentionAt) - Number(b.dataset.workspaceAttentionAt));
    return (workspaces.find(row => {
      const mount = this.mountTargets.find(item => item.dataset.workspaceId === row.dataset.workspaceEntryId);
      return mount && this.prepared(mount);
    }) ?? workspaces[0])?.dataset.workspaceEntryId;
  }
  private hideMounts(): void {
    for (const mount of this.mountTargets) {
      if (mount.classList.contains("visible")) mount.querySelector("[data-controller~='workspace-presentation']")?.dispatchEvent(new Event("kintsugi:workspace-mount-hidden"));
      mount.classList.remove("visible");
    }
  }
  private presentation(mount: HTMLElement): MountPresentation | undefined {
    const element = mount.querySelector<HTMLElement>("[data-controller~='workspace-presentation']");
    return element ? controllerForElement<MountPresentation>(element, "workspace-presentation") ?? undefined : undefined;
  }
  private prepared(mount: HTMLElement): boolean {
    return liveSurfaceReady(mount) && (this.presentation(mount)?.intendedSurfacesReady() ?? false);
  }
  private maintainPreloads(): void {
    const attention = new Map([...document.querySelectorAll<HTMLElement>("[data-workspace-entry-id][data-workspace-attention-at]")]
      .map(row => [row.dataset.workspaceEntryId!, Number(row.dataset.workspaceAttentionAt)]));
    const candidates = this.mountTargets.filter(mount => mount.classList.contains("visible") || mount.childElementCount || attention.has(mount.dataset.workspaceId!));
    candidates.sort((a, b) => Number(b.classList.contains("visible")) - Number(a.classList.contains("visible"))
      || (attention.get(a.dataset.workspaceId!) ?? Infinity) - (attention.get(b.dataset.workspaceId!) ?? Infinity)
      || Number(b.dataset.lastActivatedAt ?? 0) - Number(a.dataset.lastActivatedAt ?? 0));
    this.retained = new Set(candidates.slice(0, this.maxPreloadedValue));
    // The visible workspace goes live first; preloads would compete with it.
    const visible = this.mountTargets.find(mount => mount.classList.contains("visible"));
    const visibleLoading = visible !== undefined && !(liveSurfaceReady(visible) && (this.presentation(visible)?.intendedSurfacesReady() ?? true));
    for (const mount of candidates) {
      if (!this.retained.has(mount)) { releaseLiveSurface(mount); continue; }
      if (this.prepared(mount) || this.preparing.has(mount) || (visibleLoading && mount !== visible)) continue;
      this.preparing.add(mount);
      void (async () => {
        await prepareLiveSurface(mount);
        if (!mount.isConnected || !this.retained.has(mount)) return;
        await this.presentation(mount)?.prepareIntendedSurfaces();
      })().finally(() => { this.preparing.delete(mount); this.updateRows(); });
    }
  }
  private readonly changed = (): void => {
    const selected = this.mountTargets.find(mount => mount.dataset.workspaceId === this.intended);
    // Approval ends selection; container teardown can continue in the background.
    if (this.intended && selected?.querySelector('[data-deletion-status="deleting"]')) {
      this.unselectWorkspace(this.intended);
      return;
    }
    this.maintainPreloads();
    this.updateRows();
  };
  private updateRows(): void {
    const active = this.visibleWorkspaceId();
    markActiveWorkspaceRow(document, active);
    document.querySelectorAll<HTMLElement>("[data-workspace-entry-id]").forEach(row => {
      const mount = this.mountTargets.find(item => item.dataset.workspaceId === row.dataset.workspaceEntryId);
      row.dataset.workspacePreloadState = mount && this.prepared(mount) ? "preloaded" : "not-preloaded";
    });
    const next = document.querySelector<HTMLButtonElement>("#fixed_shell_kintsugi_next_attention");
    if (next) {
      next.disabled = this.oldestAttentionWorkspaceId() === undefined;
      next.toggleAttribute("data-preloaded-attention", document.querySelector('[data-workspace-entry-id][data-workspace-attention-at][data-workspace-preload-state="preloaded"]') !== null);
    }
    const close = document.querySelector<HTMLButtonElement>("[data-close-workspace-pane]");
    if (close) close.disabled = active === undefined;
  }
  private readonly reportVisibility = (): void => {
    const workspaceId = this.visibleWorkspaceId();
    const hidden = document.hidden || this.element.inert || (window.matchMedia(phoneLayoutMediaQuery).matches && this.element.closest(".is-mobile-workspace-pane-open") !== null);
    const mount = this.mountTargets.find(item => item.dataset.workspaceId === workspaceId);
    const surfaceKeys = !hidden && mount ? [...mount.querySelectorAll<HTMLElement>('[data-workspace-surface-visible="true"]')].map(pane => `${pane.dataset.workspacePaneRole === "agent" ? "agent:" : ""}${pane.dataset.workspacePaneId}`) : [];
    window.KintsugiCable?.reportVisibility({ workspaceId: hidden ? undefined : workspaceId, surfaceKeys });
  };
  private readonly historyChanged = (): void => {
    if (restoreTemplateSettingsDestination() || restoreAppSettingsDestination()) return;
    const id = location.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1];
    if (id) void this.selectWorkspace(decodeURIComponent(id), location.href, "none");
    else if (this.intended) this.unselectWorkspace(this.intended);
  };
}
export function registerWorkspaceSelectionController(): void { registerWorkspaceControllers({ "workspace-selection": WorkspaceSelectionController }); }
