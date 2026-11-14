import { Controller } from "@hotwired/stimulus";
import { CableTopics, isCompactLayout, layoutPreferenceEvent, type CableSubscription } from "@kintsugi/shared";
import { workspaceSelectionController } from "./workspace-controller-registry.ts";

/** Selection and visibility only; all values and markup arrive as native Turbo Streams. */
export class ResourceMetersController extends Controller<HTMLElement> {
  private subscription?: CableSubscription;
  private workspaceId?: string;
  private key?: string;
  private observer?: ResizeObserver;
  connect(): void {
    this.workspaceId = workspaceSelectionController()?.visibleWorkspaceId();
    document.addEventListener("kintsugi:active-workspace-changed", this.selected);
    document.addEventListener("visibilitychange", this.update);
    document.addEventListener("kintsugi:mobile-workspace-pane-changed", this.update);
    document.addEventListener("kintsugi:workspace-pane-visibility-changed", this.update);
    document.addEventListener(layoutPreferenceEvent, this.update);
    this.element.closest(".fixed-shell-workspace-pane")?.addEventListener("transitionend", this.update);
    this.observer = new ResizeObserver(this.update);
    this.observer.observe(this.element);
    this.update();
  }
  disconnect(): void {
    document.removeEventListener("kintsugi:active-workspace-changed", this.selected);
    document.removeEventListener("visibilitychange", this.update);
    document.removeEventListener("kintsugi:mobile-workspace-pane-changed", this.update);
    document.removeEventListener("kintsugi:workspace-pane-visibility-changed", this.update);
    document.removeEventListener(layoutPreferenceEvent, this.update);
    this.element.closest(".fixed-shell-workspace-pane")?.removeEventListener("transitionend", this.update);
    this.observer?.disconnect();
    this.subscription?.unsubscribe();
  }
  private readonly selected = (event: Event): void => {
    // SAFETY: WorkspaceNavigationController owns this event and its selection payload.
    this.workspaceId = (event as CustomEvent<{ workspaceId?: string }>).detail.workspaceId;
    this.update();
  };
  private readonly update = (): void => {
    const app = this.element.closest(".fixed-shell-app")!;
    const hidden = isCompactLayout()
      ? app.querySelector(".workspace-detail-mount.visible") !== null && !app.classList.contains("is-mobile-workspace-pane-open")
      : app.classList.contains("is-workspace-pane-collapsed");
    const visible = !document.hidden && !hidden && getComputedStyle(this.element).visibility === "visible" && this.element.getBoundingClientRect().width > 0 && this.element.getBoundingClientRect().height > 0;
    const key = visible ? this.workspaceId ?? "" : undefined;
    if (key === this.key) return;
    this.subscription?.unsubscribe(); this.subscription = undefined; this.key = key;
    if (key === undefined) return;
    this.element.dataset.resourceMetersConnection = "connecting";
    this.subscription = window.KintsugiCable!.subscribe(CableTopics.resources(this.workspaceId), {
      onReady: () => { this.element.dataset.resourceMetersConnection = "connected"; },
      onDisconnected: () => { this.element.dataset.resourceMetersConnection = "offline"; },
      onRejected: () => { this.element.dataset.resourceMetersConnection = "unavailable"; },
    });
  };
}
