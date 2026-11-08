import { flushPreviewFrames } from "@kintsugi/proxy-ingress/preview-client";
import { CableTopics, type CableSubscription } from "@kintsugi/shared";
import { Controller } from "@hotwired/stimulus";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

const mounts = new WeakMap<HTMLElement, LiveSurfaceController>();

class LiveSurfaceController extends Controller<HTMLElement> {
  static values = { workspace: String, kind: String, key: String, eager: Boolean };
  declare readonly workspaceValue: string;
  declare readonly kindValue: string;
  declare readonly keyValue: string;
  declare readonly eagerValue: boolean;
  private subscription?: CableSubscription;
  private pending?: ReturnType<typeof Promise.withResolvers<void>>;
  ready = false;
  private failure?: HTMLElement;
  private failed = false;
  private releaseGeneration = 0;
  private releasing?: Promise<void>;
  get prepared(): boolean { return this.ready || this.failed; }

  connect(): void {
    mounts.set(this.element, this);
    if (this.eagerValue) void this.ensureReady();
  }

  disconnect(): void {
    this.releaseGeneration++;
    mounts.delete(this.element);
    this.stop();
  }

  release(): void {
    if (this.releasing) return;
    const generation = ++this.releaseGeneration;
    this.releasing = flushPreviewFrames(this.element).then(() => {
      if (generation !== this.releaseGeneration) return;
      this.stop();
      this.element.replaceChildren();
    }).catch(error => {
      console.error("Workspace surface release paused", error);
      this.showFailure("Preview settings did not finish saving. The pane was kept open.");
    }).finally(() => { this.releasing = undefined; });
  }

  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.ready = false;
    this.failed = false;
    this.pending?.resolve();
    this.pending = undefined;
  }

  retry(): void {
    this.stop();
    void this.ensureReady();
  }

  private showFailure(reason: string): void {
    this.failure?.remove();
    const notice = document.createElement("div");
    notice.className = "settings-error";
    notice.setAttribute("role", "alert");
    const message = document.createElement("p");
    message.textContent = "This pane could not be loaded: " + reason;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button secondary";
    retry.textContent = "Retry pane";
    retry.dataset.action = "live-surface#retry";
    notice.append(message, retry);
    this.element.prepend(notice);
    this.failure = notice;
  }

  ensureReady(): Promise<void> {
    // A workspace selected again during saving must keep its live document.
    this.releaseGeneration++;
    if (this.ready || this.failed) return Promise.resolve();
    if (this.pending) return this.pending.promise;
    const pending = this.pending = Promise.withResolvers<void>();
    if (this.subscription) return pending.promise;
    const identifier = CableTopics.module("surface", this.workspaceValue, { kind: this.kindValue, key: this.keyValue });
    this.subscription = window.KintsugiCable!.subscribe(identifier, {
      shownIn: this.element,
      onReady: () => {
        this.failure?.remove();
        this.failure = undefined;
        this.ready = true;
        this.pending?.resolve();
        this.pending = undefined;
        this.element.dispatchEvent(new CustomEvent("live:ready", { bubbles: true }));
      },
      onDisconnected: () => { this.ready = false; },
      onRejected: reason => {
        const pending = this.pending;
        const subscription = this.subscription;
        this.pending = undefined;
        this.subscription = undefined;
        this.ready = false;
        this.failed = true;
        this.showFailure(reason);
        // A rejected pane must not reject workspace selection or sibling preparation.
        pending?.resolve();
        subscription?.unsubscribe();
        if (this.kindValue === "workspace" && /^workspace (?:not found|not in registry):/.test(reason)) {
          pending?.resolve();
          this.element.remove();
          return;
        }
      },
    });
    return pending.promise;
  }
}

export async function prepareLiveSurface(element: HTMLElement): Promise<void> {
  // Newly inserted server HTML connects at Stimulus's next mutation checkpoint.
  if (!mounts.has(element)) await new Promise<void>(resolve => setTimeout(resolve, 0));
  const mount = mounts.get(element);
  if (!mount) throw new Error(`Live surface did not connect: ${element.id}`);
  await mount.ensureReady();
}

export function liveSurfaceReady(element: HTMLElement): boolean { return mounts.get(element)?.prepared ?? false; }
export function registerLiveSurfaces(): void { registerWorkspaceControllers({ "live-surface": LiveSurfaceController }); }

export function releaseLiveSurface(element: HTMLElement): void { mounts.get(element)?.release(); }

/** Ends the surface's subscription; the element keeps showing what it last published. */
export function stopLiveSurface(element: HTMLElement): void { mounts.get(element)?.stop(); }
