/// <reference lib="dom" />

import { focusLikelyOpensSoftwareKeyboard, phoneLayoutMediaQuery, workspaceAgentSelectionEvent, type WorkspaceClientApplication, type WorkspaceClientControllerConstructor, type WorkspaceClientSurfaceVisibilityContext } from "@kintsugi/shared";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { liveSurfaceReady, prepareLiveSurface, stopLiveSurface } from "./live-surface.ts";
import { flushPreviewFrames } from "@kintsugi/proxy-ingress/preview-client";
import { workspaceSelectionController } from "./workspace-controller-registry.ts";

type PresentationPane = HTMLElement & { dataset: DOMStringMap & { workspacePaneRole?: string; workspacePaneId?: string; workspaceLogicallyVisible?: string } };
const phoneDestinationSchema = Type.Union([
  Type.Literal("agents"),
  Type.TemplateLiteral("work:${string}"),
]);
type PhoneDestination = Static<typeof phoneDestinationSchema>;

const storedPersonalNavigationSchema = Type.Object({
  activeAgentId: Type.Optional(Type.String()),
  activeWorkViewKey: Type.Optional(Type.String()),
  workPaneVisible: Type.Optional(Type.Boolean()),
  phoneDestination: Type.Optional(phoneDestinationSchema),
  drawers: Type.Optional(Type.Array(Type.String())),
});
type StoredPersonalNavigation = Static<typeof storedPersonalNavigationSchema>;

interface PersonalNavigationState {
  activeAgentId?: string;
  activeWorkViewKey?: string;
  workPaneVisible: boolean;
  phoneDestination: PhoneDestination;
  drawers: string[];
}

interface PresentationLifecycle {
  becomeVisible(context: WorkspaceClientSurfaceVisibilityContext): void;
  noLongerVisible(context: WorkspaceClientSurfaceVisibilityContext): void;
}

type PresentationApplication = WorkspaceClientApplication;

interface StreamElement extends HTMLElement {
  readonly targetElements: HTMLElement[];
  readonly templateContent: DocumentFragment;
}

interface TurboLike {
  StreamActions: Record<string, (this: StreamElement) => void | Promise<void>>;
}

const navigationIntents = new Map<string, { agent?: string; work?: string; createdAgent?: string }>();

const visiblePresentationPanes = new WeakSet<HTMLElement>();
/** A pane's content element, which is its own live surface. */
const paneSurfaceSelector = "[data-controller~='live-surface']";
const agentPaneWidthStorageKey = "kintsugi:agent-pane-width";

function storedNavigation(storage: Storage, key: string): StoredPersonalNavigation | undefined {
  const value = storage.getItem(key);
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!Value.Check(storedPersonalNavigationSchema, parsed)) throw new Error(`invalid personal navigation state at ${key}`);
  return parsed;
}

function workspaceNavigationStorageKey(workspaceId: string): string {
  return `kintsugi:workspace-navigation:${workspaceId}`;
}

function persistIntendedAgent(workspaceId: string, agentId: string): void {
  navigationIntents.set(workspaceId, { ...navigationIntents.get(workspaceId), agent: agentId, createdAgent: agentId });
  const storageKey = workspaceNavigationStorageKey(workspaceId);
  const state = storedNavigation(sessionStorage, storageKey) ?? {};
  sessionStorage.setItem(storageKey, JSON.stringify({ ...state, activeAgentId: agentId, phoneDestination: "agents" } satisfies StoredPersonalNavigation));
}

export function markActiveWorkspaceRow(root: ParentNode, workspaceId?: string): void {
  root.querySelectorAll<HTMLElement>("[data-workspace-entry-id][aria-current=\"page\"]").forEach((row) => {
    row.removeAttribute("aria-current");
  });
  if (workspaceId) root.querySelector<HTMLElement>(`[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`)?.setAttribute("aria-current", "page");
}

export function createWorkspacePresentationController(
  Controller: WorkspaceClientControllerConstructor,
  application: PresentationApplication,
  lifecycle: PresentationLifecycle,
) {
  return class WorkspacePresentationController extends Controller {
    static values = { workspaceId: String, workIntent: Object };
    declare readonly workIntentValue: { key?: string; revision?: string };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    private state!: PersonalNavigationState;
    private media?: MediaQueryList;
    private sizeObserver?: ResizeObserver;
    private preferredAgentWidth?: number;
    private resize?: { startX: number; startAgentWidth: number };
    private moreOpen = false;
    private mobileNavigationLayoutFrame?: number;
    private draggedWorkKey?: string;

    connect(): void {
      const initialUrl = new URL(location.href);
      this.state = this.restoreState();
      this.media = window.matchMedia(phoneLayoutMediaQuery);
      this.media.addEventListener("change", this.viewportChanged);
      this.element.addEventListener("kintsugi:workspace-mount-visible", this.mountVisible);
      this.element.addEventListener("live:structure", this.structureChanged);
      this.element.addEventListener("kintsugi:workspace-mount-hidden", this.mountHidden);
      this.element.addEventListener("kintsugi:agent-connection-rejected", this.agentConnectionRejected);
      this.element.addEventListener("turbo:before-morph-attribute", this.preserveAgentWidth);
      document.addEventListener("visibilitychange", this.documentVisibilityChanged);
      this.restorePreferences();
      this.sizeObserver = new ResizeObserver(() => {
        this.restorePreferences();
        this.scheduleMobileNavigationLayout();
      });
      this.sizeObserver.observe(this.element);
      this.acceptWorkIntent();
      this.normalizeState();
      this.applyDeepLink(initialUrl);
      this.applyState({ emit: true });
    }

    disconnect(): void {
      this.media?.removeEventListener("change", this.viewportChanged);
      this.element.removeEventListener("kintsugi:workspace-mount-visible", this.mountVisible);
      this.element.removeEventListener("live:structure", this.structureChanged);
      this.element.removeEventListener("kintsugi:workspace-mount-hidden", this.mountHidden);
      this.element.removeEventListener("kintsugi:agent-connection-rejected", this.agentConnectionRejected);
      this.element.removeEventListener("turbo:before-morph-attribute", this.preserveAgentWidth);
      document.removeEventListener("visibilitychange", this.documentVisibilityChanged);
      this.sizeObserver?.disconnect();
      if (this.mobileNavigationLayoutFrame !== undefined) cancelAnimationFrame(this.mobileNavigationLayoutFrame);
      this.visiblePanes().forEach((pane) => this.emitHidden(pane));
    }

    selectAgent(event: Event): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const id = (event.currentTarget as HTMLElement).dataset.agentId;
      if (!id) return;
      this.state.activeAgentId = id;
      this.state.phoneDestination = "agents";
      this.persistAndApply();
    }

    selectAgentById(agentId: string): void {
      this.state.activeAgentId = agentId;
      this.state.phoneDestination = "agents";
      this.persistAndApply();
    }

    private readonly agentConnectionRejected = (event: Event): void => {
      // SAFETY: Agent panes emit this event with their server-rendered workspace and agent identities.
      const detail = (event as CustomEvent<{ workspaceId: string; agentId: string }>).detail;
      if (detail.workspaceId !== this.workspaceIdValue || detail.agentId !== this.state.activeAgentId) return;
      const alternatives = [...this.element.querySelectorAll<HTMLElement>("[data-agent-id]")]
        .map(element => element.dataset.agentId)
        .filter((agentId): agentId is string => Boolean(agentId && agentId !== detail.agentId));
      this.state.activeAgentId = alternatives[0];
      this.state.phoneDestination = "agents";
      this.persistAndApply();
    };

    presentWorkView(key: string): void {
      navigationIntents.set(this.workspaceIdValue, { ...navigationIntents.get(this.workspaceIdValue), work: key });
      if (!this.element.closest(".workspace-detail-mount.visible")) return;
      this.selectWorkViewState(key, this.workViewPane(key)?.dataset.workViewKind === "contextual");
      this.persistAndApply({ focus: true });
    }

    workIntentValueChanged(): void {
      if (!this.state) return; // Stimulus initializes values before connect.
      this.acceptWorkIntent();
      this.presentationChanged();
    }

    private acceptWorkIntent(): void {
      const { key, revision } = this.workIntentValue;
      const storageKey = `kintsugi:work-presentation:${this.workspaceIdValue}`;
      if (!key || !revision || sessionStorage.getItem(storageKey) === revision) return;
      sessionStorage.setItem(storageKey, revision);
      navigationIntents.set(this.workspaceIdValue, { ...navigationIntents.get(this.workspaceIdValue), work: key });
    }

    intendedSurfacesReady(): boolean {
      if (!this.selectedPaneSurfaces().every(liveSurfaceReady)) return false;
      const pane = this.agentPaneSlot(this.state.activeAgentId ?? "");
      // Hidden panes already have server-rendered content; only visible agents
      // need an active transcript subscription to finish preparation.
      return !pane || !visiblePresentationPanes.has(pane) || document.hidden
        || !pane.querySelector('[data-agent-presentation-ready="false"]');
    }

    presentationChanged(): void {
      this.normalizeState();
      this.applyState({ emit: true });
    }

    async prepareIntendedSurfaces(): Promise<void> {
      this.normalizeState();
      this.applyState({ emit: false });
      await prepareLiveSurface(this.element.closest<HTMLElement>(".workspace-detail-mount")!);
      await Promise.all(this.selectedPaneSurfaces().map(prepareLiveSurface));
      await this.initializeEmbeddedWorkSurface();
    }

    selectedAgentId(): string | undefined {
      return this.state.activeAgentId;
    }

    focusSelectedAgent(): void {
      if (!document.hasFocus() || focusLikelyOpensSoftwareKeyboard()) return;
      const pane = this.visiblePanes().find(item => item.dataset.workspacePaneRole === "agent");
      if (!pane) return;
      const composer = pane.querySelector<HTMLTextAreaElement>(".agent-composer-open .composer-input");
      if (composer) composer.focus({ preventScroll: true });
      else pane.querySelector<HTMLElement>("[data-controller~='cli-terminal']")?.dispatchEvent(new Event("kintsugi:workspace-agent-focus"));
    }

    selectWorkView(event: Event): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const button = event.currentTarget as HTMLElement;
      const key = button.dataset.workViewKey;
      if (!key) return;
      this.activateWorkView(key, button.dataset.workViewKind === "contextual");
    }

    selectMoreWorkView(event: Event): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const item = event.currentTarget as HTMLElement;
      const key = item.dataset.moreWorkKey;
      if (!key) return;
      this.moreOpen = false;
      this.activateWorkView(key, item.dataset.moreWorkKind === "contextual");
    }

    syncMore(event: ToggleEvent): void {
      this.moreOpen = event.newState === "open";
      if (this.moreOpen) this.selectWorkspaceMobileDestination();
      this.applyState({ emit: false, focus: this.moreOpen });
    }

    closeMore(): void {
      this.moreOpen = false;
      this.applyState({ emit: false });
    }

    selectMobileDestination(event: Event): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const destination = (event.currentTarget as HTMLElement).dataset.mobileDestination as PhoneDestination | undefined;
      if (!destination) return;
      this.selectWorkspaceMobileDestination();
      this.state.phoneDestination = destination;
      if (destination.startsWith("work:")) {
        this.state.activeWorkViewKey = destination.slice(5);
        this.state.workPaneVisible = true;
      }
      this.moreOpen = false;
      this.persistAndApply({ focus: destination.startsWith("work:") });
    }

    private readonly preparedCloses = new WeakSet<HTMLFormElement>();
    confirmClose(event: SubmitEvent): void {
      if (!(event.currentTarget instanceof HTMLFormElement)) throw new Error("Close action requires its form");
      const form = event.currentTarget;
      if (this.preparedCloses.delete(form)) return;
      event.preventDefault();
      const label = form.dataset.closeLabel ?? "this destination";
      if (!window.confirm(`Close ${label}? Its live state will be destroyed.`)) return;
      void flushPreviewFrames(this.element).then(() => {
        this.preparedCloses.add(form);
        form.requestSubmit(event.submitter);
      }).catch(error => { console.error("Work view close paused", error); window.alert("Preview settings could not be saved. The view was kept open."); });
    }

    toggleWorkPane(): void {
      this.state.workPaneVisible = !this.state.workPaneVisible;
      this.persistAndApply({ focus: this.state.workPaneVisible });
    }

    toggleDrawer(event: Event): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const id = (event.currentTarget as HTMLElement).dataset.workspaceDrawerId;
      if (!id) return;
      this.state.drawers = this.state.drawers.includes(id) ? this.state.drawers.filter((candidate) => candidate !== id) : [...this.state.drawers, id];
      this.persistAndApply();
    }

    beginWorkResize(event: PointerEvent): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const handle = event.currentTarget as HTMLElement;
      this.resize = { startX: event.clientX, startAgentWidth: this.agentPane.getBoundingClientRect().width };
      handle.setPointerCapture(event.pointerId);
      window.addEventListener("pointermove", this.resizeWork);
      window.addEventListener("pointerup", this.finishWorkResize, { once: true });
    }

    beginWorkReorder(event: DragEvent): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      this.draggedWorkKey = (event.currentTarget as HTMLElement).dataset.workViewReorderKey;
      if (this.draggedWorkKey) event.dataTransfer?.setData("text/plain", this.draggedWorkKey);
    }

    allowWorkReorder(event: DragEvent): void {
      if (this.draggedWorkKey) event.preventDefault();
    }

    async finishWorkReorder(event: DragEvent): Promise<void> {
      if (!this.draggedWorkKey) return;
      event.preventDefault();
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const target = event.currentTarget as HTMLElement;
      const views = [...target.parentElement!.querySelectorAll<HTMLElement>("[data-work-view-reorder-key]")];
      const index = views.indexOf(target);
      const headers = new Headers({ "Content-Type": "application/json", "Accept": "text/vnd.turbo-stream.html" });
      const response = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/work-views/reorder`, {
        method: "POST",
        headers,
        body: JSON.stringify({ key: this.draggedWorkKey, index }),
      });
      this.draggedWorkKey = undefined;
      const html = await response.text();
      if (!response.ok) throw new Error(html || `HTTP ${response.status}`);
      window.Turbo?.renderStreamMessage(html);
    }

    resizeWorkWithKeyboard(event: KeyboardEvent): void {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      this.setAgentWidth(this.agentPane.getBoundingClientRect().width + direction * (event.shiftKey ? 80 : 24), true);
    }

    private activateWorkView(key: string, contextual: boolean): void {
      this.selectWorkspaceMobileDestination();
      this.selectWorkViewState(key, contextual);
      this.persistAndApply({ focus: true });
    }

    private selectWorkspaceMobileDestination(): void {
      this.element.dispatchEvent(new CustomEvent("kintsugi:workspace-mobile-destination-selected", { bubbles: true }));
    }

    private selectWorkViewState(key: string, contextual: boolean): void {
      this.state.activeWorkViewKey = key;
      this.state.workPaneVisible = true;
      this.state.phoneDestination = `work:${key}`;
      if (contextual) this.element.dataset.activeContextualWork = key;
    }

    private get isPhone(): boolean { return this.media?.matches ?? window.matchMedia(phoneLayoutMediaQuery).matches; }
    private get agentPane(): HTMLElement { return this.element.querySelector<HTMLElement>("[data-workspace-presentation-target='agentPane']")!; }
    private get storageKey(): string { return workspaceNavigationStorageKey(this.workspaceIdValue); }

    private restoreState(): PersonalNavigationState {
      const stored = storedNavigation(sessionStorage, this.storageKey);
      return {
        activeAgentId: stored?.activeAgentId,
        activeWorkViewKey: stored?.activeWorkViewKey,
        workPaneVisible: stored?.workPaneVisible ?? !this.isPhone,
        phoneDestination: stored?.phoneDestination ?? "agents",
        drawers: stored?.drawers ?? [],
      };
    }

    private normalizeState(): void {
      // Panes are in the presentation from the start; their selectors arrive separately.
      const paneIds = (role: string) => [...this.element.querySelectorAll<HTMLElement>(`[data-workspace-pane-role="${role}"]`)].map((pane) => pane.dataset.workspacePaneId!);
      const agents = paneIds("agent");
      const workViews = paneIds("work");
      const intent = navigationIntents.get(this.workspaceIdValue);
      if (intent?.agent) {
        this.state.activeAgentId = intent.agent;
        this.state.phoneDestination = "agents";
        if (agents.includes(intent.agent)) delete intent.agent;
      } else if (!this.state.activeAgentId || !agents.includes(this.state.activeAgentId)) this.state.activeAgentId = agents[0];
      if (intent?.work) {
        this.selectWorkViewState(intent.work, this.workViewPane(intent.work)?.dataset.workViewKind === "contextual");
        if (workViews.includes(intent.work)) delete intent.work;
      } else if (!this.state.activeWorkViewKey || !workViews.includes(this.state.activeWorkViewKey)) this.state.activeWorkViewKey = workViews[0];
      if (!intent?.work && this.state.phoneDestination.startsWith("work:") && !workViews.includes(this.state.phoneDestination.slice(5))) this.state.phoneDestination = "agents";
      this.persist();
    }

    private agentPaneSlot(agentId: string): HTMLElement | null {
      return this.element.querySelector<HTMLElement>(`[data-workspace-pane-role="agent"][data-workspace-pane-id="${CSS.escape(agentId)}"]`);
    }

    private workViewPane(key: string): HTMLElement | null {
      return this.element.querySelector<HTMLElement>(`[data-workspace-pane-role="work"][data-workspace-pane-id="${CSS.escape(key)}"]`);
    }

    /** The content surfaces of the selected Agent pane and, while the Work pane is open, the selected Work view. */
    private selectedPaneSurfaces(): HTMLElement[] {
      const agent = this.state.activeAgentId ? this.agentPaneSlot(this.state.activeAgentId) : null;
      const work = this.state.workPaneVisible && this.state.activeWorkViewKey ? this.workViewPane(this.state.activeWorkViewKey) : null;
      return [agent, work].flatMap(pane => pane?.querySelector<HTMLElement>(`:scope > ${paneSurfaceSelector}`) ?? []);
    }

    /** Selected panes publish their content; the others keep what they last showed. */
    private followSelectedPanes(): void {
      const selected = this.selectedPaneSurfaces();
      this.element.querySelectorAll<HTMLElement>(`[data-workspace-pane-role] > ${paneSurfaceSelector}`).forEach(surface => {
        if (!selected.includes(surface)) stopLiveSurface(surface);
      });
      for (const surface of selected) void prepareLiveSurface(surface);
    }

    private selectDestinationOnWorkspaceEntry(): void {
      const oldestAttention = (selector: string) => [...this.element.querySelectorAll<HTMLElement>(selector)]
        .sort((a, b) => Number(a.dataset.attentionSequence) - Number(b.dataset.attentionSequence))[0];
      const agentAttention = oldestAttention("[data-agent-attention-id][data-attention-sequence]");
      if (agentAttention) {
        this.state.activeAgentId = agentAttention.dataset.agentAttentionId!;
        this.state.phoneDestination = "agents";
      }
      if (!this.isPhone || agentAttention) return;
      const workAttention = oldestAttention("[data-work-view-key][data-attention-sequence]");
      if (workAttention) this.selectWorkViewState(workAttention.dataset.workViewKey!, workAttention.dataset.workViewKind === "contextual");
      else this.state.phoneDestination = "agents";
    }

    private applyDeepLink(url = new URL(location.href)): void {
      if (!url.pathname.endsWith(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}`)) return;
      const agentId = url.searchParams.get("agent");
      const workViewKey = url.searchParams.get("workView");
      if (agentId) {
        if (!this.agentPaneSlot(agentId)) return;
        this.state.activeAgentId = agentId;
        this.state.phoneDestination = "agents";
      }
      if (workViewKey) {
        const workView = this.workViewPane(workViewKey);
        if (!workView) return;
        const intent = navigationIntents.get(this.workspaceIdValue);
        if (intent) delete intent.work;
        this.selectWorkViewState(workViewKey, workView.dataset.workViewKind === "contextual");
      }
      if (agentId || workViewKey) this.persist();
    }

    private persist(): void {
      sessionStorage.setItem(this.storageKey, JSON.stringify(this.state));
      if (this.element.closest(".workspace-detail-mount.visible")) {
        const url = new URL(location.href);
        if (url.pathname === `/workspaces/${encodeURIComponent(this.workspaceIdValue)}`) {
          if (url.searchParams.get("agent") !== this.state.activeAgentId) url.searchParams.delete("agentTarget");
          if (this.state.activeAgentId) url.searchParams.set("agent", this.state.activeAgentId);
          else url.searchParams.delete("agent");
          if (this.state.workPaneVisible && this.state.activeWorkViewKey && (!this.isPhone || this.state.phoneDestination !== "agents")) url.searchParams.set("workView", this.state.activeWorkViewKey);
          else url.searchParams.delete("workView");
          history.replaceState({}, "", url);
        }
      }
    }
    private persistAndApply(options: { focus?: boolean } = {}): void { this.persist(); this.applyState({ emit: true, focus: options.focus }); }

    private applyState(options: { emit: boolean; focus?: boolean }): void {
      const before = [...this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role]")].filter((pane) => visiblePresentationPanes.has(pane));
      this.element.classList.toggle("is-work-pane-open", this.state.workPaneVisible);
      this.element.dataset.phoneDestination = this.state.phoneDestination;
      this.element.dataset.navigationReady = "true";
      this.followSelectedPanes();
      const selectedAgentChanged = this.element.dataset.workspaceSelectedAgent !== this.state.activeAgentId;
      this.element.dataset.workspaceSelectedAgent = this.state.activeAgentId ?? "";

      this.element.querySelectorAll<HTMLElement>("[data-agent-id]").forEach((selector) => {
        const active = selector.dataset.agentId === this.state.activeAgentId;
        selector.setAttribute("aria-selected", String(active));
      });
      this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role='agent']").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.workspacePaneId === this.state.activeAgentId));
      if (selectedAgentChanged) this.element.dispatchEvent(new CustomEvent(workspaceAgentSelectionEvent, { bubbles: true, detail: { workspaceId: this.workspaceIdValue, agentId: this.state.activeAgentId } }));

      this.element.querySelectorAll<HTMLElement>("[data-work-view-key]").forEach((selector) => {
        const active = selector.dataset.workViewKey === this.state.activeWorkViewKey;
        selector.setAttribute("aria-selected", String(active));
      });
      this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role='work']").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.workspacePaneId === this.state.activeWorkViewKey));
      this.element.querySelectorAll<HTMLElement>("[data-mobile-destination]").forEach((destination) => {
        const selected = destination.dataset.mobileDestination === this.state.phoneDestination;
        destination.setAttribute("aria-current", selected ? "page" : "false");
      });
      this.element.querySelectorAll<HTMLElement>("[data-more-work-key]").forEach((item) => {
        item.setAttribute("aria-checked", String(`work:${item.dataset.moreWorkKey}` === this.state.phoneDestination));
      });
      const moreButton = this.element.querySelector<HTMLElement>("[data-mobile-more]");
      moreButton?.setAttribute("aria-expanded", String(this.moreOpen));
      const moreMenu = this.element.querySelector<HTMLElement>("[data-workspace-presentation-target='moreMenu']");
      if (moreMenu?.matches(":popover-open") && !this.moreOpen) moreMenu.hidePopover();
      else if (moreMenu && !moreMenu.matches(":popover-open") && this.moreOpen) moreMenu.showPopover();
      this.scheduleMobileNavigationLayout();
      this.element.querySelectorAll<HTMLElement>("[data-more-close-destination]").forEach((closer) => {
        closer.hidden = closer.dataset.moreCloseDestination !== this.state.phoneDestination;
      });
      this.element.querySelectorAll<HTMLElement>("[data-workspace-drawer]").forEach((drawer) => drawer.classList.toggle("is-open", this.state.drawers.includes(drawer.dataset.workspaceDrawer!)));

      const after = this.visiblePanes();
      const afterSet = new Set(after);
      this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role]").forEach((pane) => {
        pane.dataset.workspaceLogicallyVisible = String(afterSet.has(pane));
        pane.dataset.workspaceSurfaceVisible = String(visiblePresentationPanes.has(pane));
      });
      // Mark the newly created pane when it arrives, before its visibility event.
      const intent = navigationIntents.get(this.workspaceIdValue);
      const createdPane = after.find(pane => pane.dataset.workspacePaneRole === "agent" && pane.dataset.workspacePaneId === intent?.createdAgent);
      if (intent && createdPane) {
        createdPane.dataset.workspaceAgentCreated = "true";
        delete intent.createdAgent;
        // Lazy SSE insertion connects child controllers at the next mutation checkpoint.
        // Deliver creation separately so an already-visible surface can still open its composer.
        queueMicrotask(() => {
          if (createdPane.isConnected && this.visiblePanes().includes(createdPane))
            createdPane.dispatchEvent(new CustomEvent("kintsugi:workspace-agent-created", { bubbles: true }));
        });
      }
      if (options.emit) this.emitVisibilityChanges(before, after);
      if (options.focus && document.hasFocus()) this.focusActiveSurface();
    }

    private scheduleMobileNavigationLayout(): void {
      if (this.mobileNavigationLayoutFrame !== undefined) cancelAnimationFrame(this.mobileNavigationLayoutFrame);
      this.mobileNavigationLayoutFrame = requestAnimationFrame(() => {
        this.mobileNavigationLayoutFrame = undefined;
        this.layoutMobileNavigation();
      });
    }

    private layoutMobileNavigation(): void {
      if (!this.isPhone) return;
      const container = this.element.querySelector<HTMLElement>("[data-mobile-overflow-container]");
      if (!container) return;
      const destinations = [...container.querySelectorAll<HTMLElement>("[data-mobile-work-key]")];
      const overflowItems = new Map([...this.element.querySelectorAll<HTMLElement>("[data-more-work-key]")].map((item) => [item.dataset.moreWorkKey!, item]));
      destinations.forEach((destination) => { destination.hidden = false; });
      overflowItems.forEach((item) => { item.hidden = true; });

      // Try roomy spacing first, then compact before moving views into More.
      container.classList.remove("is-compact");
      container.classList.toggle("is-compact", container.scrollWidth > container.clientWidth);

      const overflowed: HTMLElement[] = [];
      for (let index = destinations.length - 1; container.scrollWidth > container.clientWidth && index >= 0; index -= 1) {
        const destination = destinations[index]!;
        destination.hidden = true;
        overflowed.push(destination);
        overflowItems.get(destination.dataset.mobileWorkKey!)!.hidden = false;
      }

      const separator = this.element.querySelector<HTMLElement>("[data-mobile-overflow-separator]");
      if (separator) separator.hidden = overflowed.length === 0;
      const attention = this.element.querySelector<HTMLElement>("[data-mobile-overflow-attention]");
      if (attention) attention.hidden = !overflowed.some((destination) => destination.querySelector(".status-dot.attention"));
      const selectedDestination = destinations.find((destination) => destination.dataset.mobileDestination === this.state.phoneDestination);
      const secondarySelected = selectedDestination?.hidden === true;
      this.element.querySelector<HTMLElement>("[data-mobile-more]")?.setAttribute("aria-current", secondarySelected ? "page" : "false");
    }

    private visiblePanes(): PresentationPane[] {
      if (!this.element.closest(".workspace-detail-mount.visible")) return [];
      const selector = this.isPhone
        ? this.state.phoneDestination === "agents" ? `[data-workspace-pane-role='agent'].is-active` : `[data-workspace-pane-role='work'].is-active`
        : `[data-workspace-pane-role='agent'].is-active${this.state.workPaneVisible ? ", [data-workspace-pane-role='work'].is-active" : ""}`;
      return [...this.element.querySelectorAll<PresentationPane>(selector)];
    }

    private emitVisibilityChanges(before: PresentationPane[], after: PresentationPane[]): void {
      const afterSet = new Set(after);
      before.filter((pane) => !afterSet.has(pane)).forEach((pane) => this.emitHidden(pane));
      after.forEach((pane) => this.emitVisible(pane));
    }

    private lifecycleContext(pane: PresentationPane): WorkspaceClientSurfaceVisibilityContext {
      return { workspaceId: this.workspaceIdValue, surfaceKey: pane.dataset.workspacePaneId!, region: pane.closest("[data-workspace-role-region]")!, pane, application };
    }

    private emitVisible(pane: PresentationPane): void {
      pane.dataset.workspaceSurfaceVisible = "true";
      if (visiblePresentationPanes.has(pane)) return;
      visiblePresentationPanes.add(pane);
      pane.querySelectorAll<HTMLIFrameElement>('[data-controller~="workspace-app-frame"]').forEach((frame) => {
        // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
        const controller = application.getControllerForElementAndIdentifier(frame, "workspace-app-frame") as { becomeVisible?(): void } | null;
        controller?.becomeVisible?.();
      });
      lifecycle.becomeVisible(this.lifecycleContext(pane));
      pane.dispatchEvent(new CustomEvent("kintsugi:workspace-pane-visible", { bubbles: true, detail: { role: pane.dataset.workspacePaneRole, id: pane.dataset.workspacePaneId } }));
    }

    private emitHidden(pane: PresentationPane): void {
      pane.dataset.workspaceLogicallyVisible = "false";
      pane.dataset.workspaceSurfaceVisible = "false";
      if (!visiblePresentationPanes.has(pane)) return;
      visiblePresentationPanes.delete(pane);
      lifecycle.noLongerVisible(this.lifecycleContext(pane));
      pane.dispatchEvent(new CustomEvent("kintsugi:workspace-pane-hidden", { bubbles: true, detail: { role: pane.dataset.workspacePaneRole, id: pane.dataset.workspacePaneId } }));
    }

    private focusActiveSurface(): void {
      if (this.isPhone && this.moreOpen) {
        this.element.querySelector<HTMLElement>("[data-workspace-presentation-target~=\"moreMenu\"] [role='menuitem']:not([hidden]), [data-workspace-presentation-target~=\"moreMenu\"] [role='menuitemradio']:not([hidden])")?.focus();
        return;
      }
      this.visiblePanes().at(-1)?.focus({ preventScroll: true });
    }

    private async initializeEmbeddedWorkSurface(): Promise<void> {
      if (!this.state.activeWorkViewKey) return;
      const pane = this.workViewPane(this.state.activeWorkViewKey);
      const frames = pane?.querySelectorAll<HTMLIFrameElement>('[data-controller~="workspace-app-frame"]') ?? [];
      await Promise.all([...frames].map(async (frame) => {
        // SAFETY: The registered workspace-app-frame controller exposes the preparation method below.
        let controller = application.getControllerForElementAndIdentifier(frame, "workspace-app-frame") as { loadAndWait(): Promise<void> } | null;
        if (!controller) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          // SAFETY: The registered workspace-app-frame controller exposes the preparation method below.
          controller = application.getControllerForElementAndIdentifier(frame, "workspace-app-frame") as { loadAndWait(): Promise<void> } | null;
        }
        if (!controller) throw new Error("Embedded Work surface did not connect");
        await controller.loadAndWait();
      }));
    }

    private restorePreferences(): void {
      if (this.preferredAgentWidth === undefined) {
        const stored = Number(localStorage.getItem(agentPaneWidthStorageKey));
        const defaultWidth = Number.parseFloat(getComputedStyle(this.element).getPropertyValue("--fixed-agent-width"));
        this.preferredAgentWidth = Number.isFinite(stored) && stored > 0 ? stored : defaultWidth;
      }
      this.setAgentWidth(this.preferredAgentWidth);
    }

    private setAgentWidth(width: number, persist = false): void {
      const gap = Number.parseFloat(getComputedStyle(this.element).getPropertyValue("--fixed-shell-gap"));
      const maximum = this.element.clientWidth - 360 - gap;
      const bounded = Math.max(380, Math.min(width, maximum));
      this.element.style.setProperty("--fixed-agent-width", `${bounded}px`);
      if (persist) {
        this.preferredAgentWidth = bounded;
        localStorage.setItem(agentPaneWidthStorageKey, String(bounded));
      }
    }

    private resizeWork = (event: PointerEvent): void => {
      if (!this.resize) return;
      this.setAgentWidth(this.resize.startAgentWidth + event.clientX - this.resize.startX);
    };

    private finishWorkResize = (): void => {
      if (!this.resize) return;
      window.removeEventListener("pointermove", this.resizeWork);
      this.preferredAgentWidth = this.agentPane.getBoundingClientRect().width;
      localStorage.setItem(agentPaneWidthStorageKey, String(this.preferredAgentWidth));
      this.resize = undefined;
    };

    // The agent width lives in this element's inline style, which the server never
    // renders. Keep live morphs from stripping it.
    private preserveAgentWidth = (event: Event): void => {
      // SAFETY: Turbo emits this event with its attribute mutation descriptor.
      const detail = (event as CustomEvent<{ attributeName: string }>).detail;
      if (event.target === this.element && detail.attributeName === "style") event.preventDefault();
    };
    private structureChanged = (): void => { this.presentationChanged(); };
    private viewportChanged = (): void => { this.applyState({ emit: true }); };
    private mountVisible = (event: Event): void => {
      // Restore the visible pane's width before transcript navigation measures it.
      this.restorePreferences();
      if (event instanceof CustomEvent && event.detail.selectedFromList) this.selectDestinationOnWorkspaceEntry();
      else this.applyDeepLink();
      this.persist();
      this.applyState({ emit: true });
    };
    private mountHidden = (): void => {
      const panes = [...this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role]")];
      panes.forEach((pane) => { pane.dataset.workspaceLogicallyVisible = "false"; });
      this.emitVisibilityChanges(panes.filter((pane) => visiblePresentationPanes.has(pane)), []);
    };
    private documentVisibilityChanged = (): void => {
      if (document.visibilityState !== "visible") return;
    };
  };
}

export function installWorkspacePresentationTurboStream(Turbo: TurboLike, application: PresentationApplication): void {
  interface PresentationActions {
    selectAgentById(agentId: string): void;
    presentWorkView(key: string): void;
    presentationChanged(): void;
  }
  const controllerFor = (target: HTMLElement, workspaceId: string): PresentationActions | null => {
    const presentation = target.matches("[data-controller~='workspace-presentation']")
      ? target
      : target.querySelector<HTMLElement>(`.fixed-workspace-presentation[data-workspace-id="${CSS.escape(workspaceId)}"]`);
    // SAFETY: The server-rendered presentation element is connected to the registered controller exposing these actions.
    return presentation ? application.getControllerForElementAndIdentifier(presentation, "workspace-presentation") as PresentationActions | null : null;
  };
  const behaviorWorkspaceId = (stream: StreamElement): string => {
    const workspaceId = stream.dataset.workspaceId;
    if (!workspaceId) throw new Error(`${stream.getAttribute("action")} requires a Workspace ID`);
    return workspaceId;
  };
  Turbo.StreamActions["unselect-workspace"] = function unselectWorkspace(this: StreamElement): void {
    workspaceSelectionController()?.unselectWorkspace(behaviorWorkspaceId(this));
  };

  Turbo.StreamActions["workspace-pane-changed"] = function workspacePaneChanged(this: StreamElement): void {
    for (const target of this.targetElements) {
      const visibleWorkspaceId = document.querySelector<HTMLElement>(".workspace-detail-mount.visible[data-workspace-id]")?.dataset.workspaceId;
      const pathWorkspaceId = location.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1];
      const workspaceId = visibleWorkspaceId ?? (pathWorkspaceId ? decodeURIComponent(pathWorkspaceId) : undefined);
      if (workspaceId) markActiveWorkspaceRow(target, workspaceId);
    }
    document.dispatchEvent(new CustomEvent("kintsugi:workspace-pane-changed"));
  };
  Turbo.StreamActions["present-work-view"] = function presentWorkView(this: StreamElement): void {
    const key = this.dataset.workViewKey;
    if (!key) throw new Error("present-work-view requires a Work view key");
    const workspaceId = behaviorWorkspaceId(this);
    navigationIntents.set(workspaceId, { ...navigationIntents.get(workspaceId), work: key });
    for (const target of this.targetElements) controllerFor(target, workspaceId)?.presentWorkView(key);
  };

  Turbo.StreamActions["select-agent"] = function selectAgent(this: StreamElement): void {
    const agentId = this.dataset.agentId;
    if (!agentId) throw new Error("select-agent requires an Agent ID");
    const workspaceId = behaviorWorkspaceId(this);
    persistIntendedAgent(workspaceId, agentId);
    for (const target of this.targetElements) controllerFor(target, workspaceId)?.selectAgentById(agentId);
  };

}
