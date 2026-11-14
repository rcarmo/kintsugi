import { recentWorkspaceTemplateStorageKey } from "@kintsugi/shared";
import { slidePageChange } from "@kintsugi/design-system/page-slide/client";
import { Controller } from "@hotwired/stimulus";
import { registerWorkspaceControllers, workspaceSelectionController } from "./workspace-controller-registry.ts";
import { markActiveWorkspaceRow } from "./workspace-presentation.ts";

/** Points from the artwork to the first-workspace action. */
class FirstWorkspaceGuideController extends Controller<HTMLElement> {
  static targets = ["origin", "svg", "path"];
  declare readonly originTarget: HTMLElement;
  declare readonly svgTarget: SVGSVGElement;
  declare readonly pathTarget: SVGPathElement;
  private resizeObserver?: ResizeObserver;
  private observer?: MutationObserver;
  private frame?: number;
  private dismissed = false;

  connect(): void {
    this.resizeObserver = new ResizeObserver(this.scheduleDraw);
    this.resizeObserver.observe(this.originTarget);
    // Live shell morphs can clear the client-drawn path or replace the button.
    this.observer = new MutationObserver(this.scheduleDraw);
    this.observer.observe(this.element.closest(".fixed-shell-app")!, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["hidden", "class", "inert", "d"],
    });
    window.addEventListener("resize", this.scheduleDraw);
    window.addEventListener("workspace-pane:slide-changed", this.scheduleDraw);
    window.addEventListener("workspace-pane:first-template-chosen", this.dismiss);
    this.scheduleDraw();
  }

  disconnect(): void {
    this.resizeObserver?.disconnect();
    this.observer?.disconnect();
    window.removeEventListener("resize", this.scheduleDraw);
    window.removeEventListener("workspace-pane:slide-changed", this.scheduleDraw);
    window.removeEventListener("workspace-pane:first-template-chosen", this.dismiss);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
  }

  private dismiss = (): void => {
    this.dismissed = true;
    this.scheduleDraw();
  };

  private scheduleDraw = (): void => {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.draw);
  };

  private draw = (): void => {
    this.frame = undefined;
    const origin = this.originTarget.getBoundingClientRect();
    const destinations = [...document.querySelectorAll<HTMLElement>("[data-first-workspace-destination]")];
    const destinationElement = destinations.find(element => !element.closest("[inert]"));
    for (const element of destinations) {
      const highlighted = !this.dismissed && element === destinationElement;
      if (element.classList.contains("is-first-workspace-destination") !== highlighted) element.classList.toggle("is-first-workspace-destination", highlighted);
    }
    this.svgTarget.style.opacity = this.dismissed ? "0" : "1";
    if (this.dismissed) return;
    if (!destinationElement) {
      this.svgTarget.style.visibility = "hidden";
      return;
    }
    const destination = destinationElement.getBoundingClientRect();
    const hidden = origin.width === 0 || destination.width === 0;
    this.svgTarget.style.visibility = hidden ? "hidden" : "";
    if (hidden) return;
    // Anchor just left of the A robot's face in the 2400 × 1260 artwork.
    const start = { x: origin.left + origin.width * 490 / 2400, y: origin.top + origin.height * 150 / 1260 };
    const end = { x: destination.right + 5, y: destination.top + destination.height / 2 };
    const bend = Math.min(180, Math.max(40, Math.abs(start.x - end.x) * 0.7));
    this.svgTarget.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
    const path = `M ${start.x} ${start.y} C ${start.x - bend} ${start.y}, ${end.x + bend} ${end.y}, ${end.x} ${end.y}`;
    if (this.pathTarget.getAttribute("d") !== path) this.pathTarget.setAttribute("d", path);
  };
}

/** Slides the workspace pane between the workspace list and the "New workspace" template picker. */
class WorkspacePaneController extends Controller<HTMLElement> {
  static targets = ["workspacesHeader", "pickerHeader", "body", "workspaces", "picker", "newWorkspace", "option", "value", "addFirst"];
  declare readonly workspacesHeaderTarget: HTMLElement;
  declare readonly bodyTarget: HTMLElement;
  declare readonly pickerHeaderTarget: HTMLElement;
  declare readonly workspacesTarget: HTMLElement;
  declare readonly pickerTarget: HTMLElement;
  declare readonly newWorkspaceTarget: HTMLElement;
  declare readonly optionTargets: HTMLElement[];
  declare readonly valueTarget: HTMLInputElement;
  declare readonly addFirstTarget: HTMLElement;
  declare readonly hasAddFirstTarget: boolean;
  /** Undefined until a choice exists: with no templates yet, nothing is preselected. */
  private selected: string | undefined;
  private knownWorkspaceTemplateIds = new Set<string>();
  private optionsObserver?: MutationObserver;

  connect(): void {
    this.knownWorkspaceTemplateIds = new Set(this.optionTargets.map((option) => option.dataset.workspaceTemplateId!));
    // Live updates may morph existing options in place, so watch the options rather than target connections.
    this.optionsObserver = new MutationObserver(this.optionsChanged);
    this.optionsObserver.observe(this.pickerTarget, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-workspace-template-id", "aria-checked"] });
    document.addEventListener("kintsugi:mobile-workspace-pane-changed", this.mobileWorkspacePaneChanged);
  }

  disconnect(): void {
    document.removeEventListener("kintsugi:mobile-workspace-pane-changed", this.mobileWorkspacePaneChanged);
    this.optionsObserver?.disconnect();
  }

  /** "New workspace" starts from the current workspace's template. */
  openPicker(): void {
    const active = this.element.querySelector<HTMLElement>("[data-workspace-entry-id][aria-current='page']");
    this.showPicker(this.hasAddFirstTarget ? undefined : active?.dataset.workspaceTemplateId ?? "");
  }

  addFirstTemplate(): void {
    window.dispatchEvent(new CustomEvent("workspace-pane:first-template-chosen"));
  }

  /** A row's template icon starts from that row's template. */
  openPickerFor({ params }: { params: { workspaceTemplate: string } }): void {
    this.showPicker(params.workspaceTemplate);
  }

  back(): void {
    this.setPicking(false, () => this.newWorkspaceTarget.focus({ preventScroll: true }));
  }

  choose(event: Event): void {
    // SAFETY: This action is attached only to server-rendered template options.
    this.select((event.currentTarget as HTMLElement).dataset.workspaceTemplateId!);
  }

  optionKeydown(event: KeyboardEvent): void {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const options = this.optionTargets;
    // SAFETY: This action is attached only to server-rendered template options.
    const next = options[(options.indexOf(event.currentTarget as HTMLElement) + step + options.length) % options.length]!;
    this.select(next.dataset.workspaceTemplateId!);
    next.focus();
  }

  submitted(): void {
    this.showWorkspaces();
  }

  private showPicker(workspaceTemplateId: string | undefined): void {
    this.select(workspaceTemplateId);
    this.setPicking(true, () => {
      const checked = this.optionTargets.find((option) => option.getAttribute("aria-checked") === "true");
      (checked ?? this.addFirstTarget).focus({ preventScroll: true });
    });
  }

  private showWorkspaces(): void {
    this.setPicking(false);
  }

  private setPicking(picking: boolean, focus?: () => void): void {
    const render = (): HTMLElement => {
      this.element.classList.toggle("is-picking-template", picking);
      this.workspacesTarget.inert = picking;
      this.pickerTarget.inert = !picking;
      this.workspacesHeaderTarget.hidden = picking;
      this.pickerHeaderTarget.hidden = !picking;
      focus?.();
      window.dispatchEvent(new CustomEvent("workspace-pane:slide-changed"));
      return this.bodyTarget;
    };
    if (this.element.classList.contains("is-picking-template") === picking) { focus?.(); return; }
    void slidePageChange(() => this.bodyTarget, render, picking ? "forward" : "back")
      .then(() => window.dispatchEvent(new CustomEvent("workspace-pane:slide-changed")));
  }

  private select(workspaceTemplateId: string | undefined): void {
    const available = this.optionTargets.some((option) => option.dataset.workspaceTemplateId === workspaceTemplateId);
    this.selected = workspaceTemplateId === undefined ? undefined : available ? workspaceTemplateId : "";
    this.valueTarget.value = this.selected ?? "";
    for (const option of this.optionTargets) {
      const checked = option.dataset.workspaceTemplateId === this.selected;
      // Only write real changes: the options observer watches this attribute.
      if (option.getAttribute("aria-checked") !== String(checked)) option.setAttribute("aria-checked", String(checked));
      option.tabIndex = checked || (this.selected === undefined && option === this.optionTargets[0]) ? 0 : -1;
    }
  }

  /** Server updates refresh the options; a template that was just added becomes the choice, otherwise keep it. */
  private readonly optionsChanged = (): void => {
    const workspaceTemplateIds = this.optionTargets.map((option) => option.dataset.workspaceTemplateId!);
    const added = workspaceTemplateIds.find((workspaceTemplateId) => !this.knownWorkspaceTemplateIds.has(workspaceTemplateId));
    this.knownWorkspaceTemplateIds = new Set(workspaceTemplateIds);
    this.select(added ?? this.selected);
  };

  private readonly mobileWorkspacePaneChanged = (): void => {
    if (!this.element.closest(".fixed-shell-app")!.classList.contains("is-mobile-workspace-pane-open")) this.showWorkspaces();
  };
}

class WorkspaceNavigationController extends Controller<HTMLElement> {
  static targets = ["scroll"];
  declare readonly scrollTarget: HTMLElement;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  private pinnedWorkspace?: { id: string; index: number };

  connect(): void {
    this.scrollTarget.addEventListener("scroll", this.scrolled, { passive: true });
    this.element.addEventListener("kintsugi:workspace-mobile-destination-selected", this.workspaceMobileDestinationSelected);
    document.addEventListener("kintsugi:workspace-pane-changed", this.workspacePaneChanged);
    const scroll = Number(localStorage.getItem("kintsugi:workspace-pane-scroll"));
    if (Number.isFinite(scroll)) this.scrollTarget.scrollTop = scroll;
    this.setWorkspacePaneOpen(!this.element.querySelector(".workspace-detail-mount.visible"));
    this.setWorkspacePaneCollapsed(sessionStorage.getItem("kintsugi:workspace-pane-collapsed") === "true" && Boolean(this.visibleWorkspacePaneToggle()));
  }

  disconnect(): void {
    this.scrollTarget.removeEventListener("scroll", this.scrolled);
    this.element.removeEventListener("kintsugi:workspace-mobile-destination-selected", this.workspaceMobileDestinationSelected);
    document.removeEventListener("kintsugi:workspace-pane-changed", this.workspacePaneChanged);
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
  }

  closeWorkspacePane(): void {
    this.setWorkspacePaneOpen(false);
    this.element.querySelector<HTMLElement>(".workspace-detail-mount.visible [data-show-workspace-list]")!.focus();
  }

  showWorkspacePane(): void {
    this.setWorkspacePaneOpen(true);
  }

  toggleWorkspacePaneCollapsed(): void {
    const collapsed = !this.element.classList.contains("is-workspace-pane-collapsed");
    const toggle = collapsed
      ? this.visibleWorkspacePaneToggle()
      : this.element.querySelector<HTMLButtonElement>("[data-collapse-workspace-pane]");
    if (!toggle) return;
    this.setWorkspacePaneCollapsed(collapsed);
    requestAnimationFrame(() => toggle.focus());
  }

  private setWorkspacePaneCollapsed(collapsed: boolean): void {
    this.element.classList.toggle("is-workspace-pane-collapsed", collapsed);
    sessionStorage.setItem("kintsugi:workspace-pane-collapsed", String(collapsed));
    document.dispatchEvent(new CustomEvent("kintsugi:workspace-pane-visibility-changed"));
  }

  private visibleWorkspacePaneToggle(): HTMLButtonElement | null {
    return this.element.querySelector<HTMLButtonElement>(".workspace-detail-mount.visible [data-show-workspace-pane]");
  }

  private setWorkspacePaneOpen(open: boolean): void {
    this.element.classList.toggle("is-mobile-workspace-pane-open", open);
    document.dispatchEvent(new CustomEvent("kintsugi:mobile-workspace-pane-changed"));
  }

  private readonly workspaceMobileDestinationSelected = (): void => this.setWorkspacePaneOpen(false);
  private readonly workspacePaneChanged = (): void => {
    this.setActiveWorkspace(workspaceSelectionController()?.visibleWorkspaceId());
  };

  async selectWorkspace(event: Event): Promise<void> {
    // SAFETY: This action is attached only to server-rendered Workspace entry elements.
    const workspaceId = (event.currentTarget as HTMLElement).dataset.workspaceEntryId;
    if (workspaceId) await this.selectWorkspaceById(workspaceId);
  }

  async selectWorkspaceById(workspaceId: string): Promise<void> {
    this.setWorkspacePaneOpen(false);
    await workspaceSelectionController()?.selectWorkspace(workspaceId, `/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async parkWorkspace(event: Event): Promise<void> {
    event.preventDefault();
    // SAFETY: This action is attached only to the server-rendered Agent-pane park form.
    const form = event.currentTarget as HTMLFormElement;
    await this.submitParkedState(form);
  }

  async unparkWorkspace(event: Event): Promise<void> {
    event.preventDefault();
    // SAFETY: This action is attached only to server-rendered unpark forms.
    const form = event.currentTarget as HTMLFormElement;
    const workspaceId = form.querySelector<HTMLElement>("[data-workspace-entry-id]")!.dataset.workspaceEntryId!;
    await this.submitParkedState(form);
    await this.selectWorkspaceById(workspaceId);
  }

  private async submitParkedState(form: HTMLFormElement): Promise<void> {
    const button = form.querySelector<HTMLButtonElement>("button[type='submit']")!;
    button.disabled = true;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { Accept: "text/vnd.turbo-stream.html" },
      });
      if (!response.ok) throw new Error(`Could not update parked workspace: HTTP ${response.status}`);
      const html = await response.text();
      if (html) window.Turbo?.renderStreamMessage(html);
    } finally {
      button.disabled = false;
    }
  }

  setActiveWorkspace(workspaceId?: string): void {
    document.dispatchEvent(new CustomEvent("kintsugi:active-workspace-changed", { detail: { workspaceId } }));
    if (this.pinnedWorkspace?.id !== workspaceId) {
      this.pinnedWorkspace = undefined;
      const rows = this.arrangeWorkspaceRows();
      const index = rows.findIndex(row => row.querySelector<HTMLElement>("[data-workspace-entry-id]")!.dataset.workspaceEntryId === workspaceId);
      if (workspaceId && index >= 0) this.pinnedWorkspace = { id: workspaceId, index };
    } else this.arrangeWorkspaceRows();
    markActiveWorkspaceRow(this.element, workspaceId);
    const row = workspaceId ? this.element.querySelector<HTMLElement>(`[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`) : null;
    if (!row) return;
    if (row.dataset.workspaceTemplateId) localStorage.setItem(recentWorkspaceTemplateStorageKey, row.dataset.workspaceTemplateId);
    else localStorage.removeItem(recentWorkspaceTemplateStorageKey);
  }

  private activeWorkspaceRows(): HTMLElement[] {
    return [...this.scrollTarget.querySelectorAll<HTMLElement>(":scope > [data-workspace-order]")];
  }

  /** Server ranks remain authoritative; only the selected row's slot is browser-owned. */
  private arrangeWorkspaceRows(): HTMLElement[] {
    const rows = this.activeWorkspaceRows().sort((a, b) => Number(a.dataset.workspaceOrder) - Number(b.dataset.workspaceOrder));
    const pinned = this.pinnedWorkspace;
    if (pinned) {
      const selectedIndex = rows.findIndex(row => row.querySelector<HTMLElement>("[data-workspace-entry-id]")!.dataset.workspaceEntryId === pinned.id);
      if (selectedIndex < 0) this.pinnedWorkspace = undefined;
      else {
        const [selected] = rows.splice(selectedIndex, 1);
        rows.splice(pinned.index, 0, selected);
      }
    }
    // Move only out-of-order rows; leave the Parked disclosure after active rows.
    rows.forEach((row, index) => {
      const current = this.scrollTarget.children[index];
      if (current !== row) this.scrollTarget.insertBefore(row, current);
    });
    return rows;
  }

  private scrolled = (): void => {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => localStorage.setItem("kintsugi:workspace-pane-scroll", String(this.scrollTarget.scrollTop)), 80);
  };
}

export function registerWorkspaceNavigationControllers(): void {
  registerWorkspaceControllers({
    "first-workspace-guide": FirstWorkspaceGuideController,
    "workspace-navigation": WorkspaceNavigationController,
    "workspace-pane": WorkspacePaneController,
  });
}
