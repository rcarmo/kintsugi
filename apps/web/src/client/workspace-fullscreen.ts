import { Controller } from "@hotwired/stimulus";
import { workspaceProxyUrl } from "@kintsugi/shared";
import { buttonElement } from "@kintsugi/design-system/button";
import { Icons } from "@kintsugi/design-system/icons";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

type FullscreenMode = "view" | "template" | "media";
type FullscreenMediaElement = HTMLIFrameElement | HTMLImageElement | HTMLVideoElement;
type FullscreenViewer = { element: HTMLElement; disconnect?: () => void };
type FullscreenSession = { owner: KintsugiFullscreenController; close(): void };

let hoveredFullscreenControllers: KintsugiFullscreenController[] = [];
let fullscreenControllerCount = 0;
let activeFullscreenSession: FullscreenSession | undefined;

function editableShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

function consumeFullscreenShortcut(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || event.isComposing) return false;
  if (event.key.toLowerCase() === "f") {
    if (!activeFullscreenSession && !hoveredFullscreenControllers.at(-1)) return false;
    if (editableShortcutTarget(event.target)) return false;
  } else if (event.key !== "Escape" || !activeFullscreenSession) {
    return false;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}

function documentFullscreenKeydown(event: KeyboardEvent): void {
  if (!consumeFullscreenShortcut(event)) return;
  if (activeFullscreenSession) activeFullscreenSession.close();
  else hoveredFullscreenControllers.at(-1)!.open();
}

function pushFullscreenHover(controller: KintsugiFullscreenController): void {
  hoveredFullscreenControllers = hoveredFullscreenControllers.filter((candidate) => candidate !== controller);
  hoveredFullscreenControllers.push(controller);
}

function removeFullscreenHover(controller: KintsugiFullscreenController): void {
  hoveredFullscreenControllers = hoveredFullscreenControllers.filter((candidate) => candidate !== controller);
}

function iframeShortcutDocument(frame: HTMLIFrameElement): Document | null {
  if (frame.hasAttribute("sandbox") && !frame.sandbox.contains("allow-same-origin")) return null;
  try { return frame.contentDocument; }
  catch (error) {
    // Navigations can end at an isolated origin or acquire a CSP sandbox.
    if (error instanceof DOMException && error.name === "SecurityError") return null;
    throw error;
  }
}

class KintsugiFullscreenController extends Controller<HTMLElement> {
  static values = { mode: String, viewKey: String, title: String, paneHeader: Boolean };
  declare readonly modeValue: FullscreenMode;
  declare readonly viewKeyValue: string;
  declare readonly titleValue: string;
  declare readonly paneHeaderValue: boolean;
  private hoverTarget!: HTMLElement;
  private fullscreenTitle?: HTMLElement;
  private iframeLoadTargets: HTMLIFrameElement[] = [];
  private readonly pointerenter = (): void => pushFullscreenHover(this);
  private readonly pointerleave = (): void => removeFullscreenHover(this);
  private readonly iframeLoaded = (event: Event): void => {
    // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
    const frame = event.currentTarget as HTMLIFrameElement;
    const doc = iframeShortcutDocument(frame);
    doc?.removeEventListener("keydown", documentFullscreenKeydown, true);
    doc?.addEventListener("keydown", documentFullscreenKeydown, true);
  };

  connect(): void {
    this.hoverTarget = this.paneHeaderValue ? this.element.closest<HTMLElement>(".panel__header")! : this.element;
    this.hoverTarget.addEventListener("pointerenter", this.pointerenter);
    this.hoverTarget.addEventListener("pointerleave", this.pointerleave);
    if (fullscreenControllerCount++ === 0) document.addEventListener("keydown", documentFullscreenKeydown, true);
  }

  titleValueChanged(): void {
    if (this.fullscreenTitle) this.fullscreenTitle.textContent = this.titleValue;
  }

  disconnect(): void {
    removeFullscreenHover(this);
    this.detachIframeShortcuts();
    this.hoverTarget.removeEventListener("pointerenter", this.pointerenter);
    this.hoverTarget.removeEventListener("pointerleave", this.pointerleave);
    if (--fullscreenControllerCount === 0) document.removeEventListener("keydown", documentFullscreenKeydown, true);
    if (activeFullscreenSession?.owner === this) activeFullscreenSession.close();
  }

  open(): void {
    const wasActive = activeFullscreenSession?.owner === this;
    activeFullscreenSession?.close();
    if (wasActive) return;

    if (this.modeValue === "view") this.openLiveView();
    else this.openViewer();
  }

  private openLiveView(): void {
    this.showView();
    const target = this.liveViewTarget();
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    let session: FullscreenSession;
    let bar: HTMLElement;
    const preserveFullscreen = (event: Event): void => {
      if (event.target !== target) return;
      // SAFETY: Turbo supplies the incoming element for morphs, but not removals.
      const { newElement } = (event as CustomEvent<{ newElement?: Element }>).detail;
      if (!(newElement instanceof HTMLElement)) { close(); return; }
      // Fullscreen belongs to this browser session. Merge only its two attributes
      // into incoming markup; all server-owned panel state still updates normally.
      newElement.classList.add("kintsugi-fullscreen-live");
      newElement.dataset.kintsugiFullscreenActive = "true";
    };
    const close = (): void => {
      target.removeEventListener("turbo:before-morph-element", preserveFullscreen);
      this.detachIframeShortcuts();
      target.classList.remove("kintsugi-fullscreen-live");
      target.removeAttribute("data-kintsugi-fullscreen-active");
      document.body.classList.remove("kintsugi-fullscreen-open");
      bar.remove();
      this.fullscreenTitle = undefined;
      if (activeFullscreenSession === session) activeFullscreenSession = undefined;
      previousFocus?.focus({ preventScroll: true });
    };
    bar = this.createBar(close);
    bar.classList.add("kintsugi-fullscreen-live-bar");
    document.body.append(bar);
    document.body.classList.add("kintsugi-fullscreen-open");
    target.classList.add("kintsugi-fullscreen-live");
    target.dataset.kintsugiFullscreenActive = "true";
    session = { owner: this, close };
    activeFullscreenSession = session;
    target.addEventListener("turbo:before-morph-element", preserveFullscreen);
    this.attachIframeShortcuts(target);
    target.querySelector<HTMLElement>("iframe, .observable-terminal-host, textarea, input, button, [tabindex]")?.focus({ preventScroll: true });
  }

  private openViewer(): void {
    const viewer = this.createViewer();
    const dialog = document.createElement("dialog");
    dialog.className = "kintsugi-fullscreen-dialog";
    dialog.setAttribute("aria-label", this.titleValue || "Media preview");
    const surface = document.createElement("div");
    surface.className = "kintsugi-fullscreen-surface";
    let session: FullscreenSession;
    const close = (): void => dialog.close();
    surface.append(this.createBar(close), viewer.element);
    dialog.append(surface);
    dialog.addEventListener("close", () => {
      this.detachIframeShortcuts();
      viewer.disconnect?.();
      dialog.remove();
      this.fullscreenTitle = undefined;
      if (activeFullscreenSession === session) activeFullscreenSession = undefined;
    }, { once: true });
    document.body.append(dialog);
    session = { owner: this, close };
    activeFullscreenSession = session;
    dialog.showModal();
    this.attachIframeShortcuts(dialog);
  }

  private createBar(closeFullscreen: () => void): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "kintsugi-fullscreen-bar work-view-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Fullscreen controls");

    const title = document.createElement("strong");
    title.className = "kintsugi-fullscreen-title";
    title.textContent = this.titleValue;
    this.fullscreenTitle = title;
    const close = buttonElement({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Exit full screen" } });
    close.addEventListener("click", closeFullscreen);
    bar.append(title, close);
    return bar;
  }

  private liveViewTarget(): HTMLElement {
    return this.element.closest<HTMLElement>(".fixed-workspace-presentation")!.querySelector<HTMLElement>(`[data-kintsugi-fullscreen-view-key="${CSS.escape(this.viewKeyValue)}"]`)!;
  }

  private showView(): void {
    // A single Agent is already selected; its header is not a tab.
    if (!this.paneHeaderValue) this.element.click();
  }

  private createViewer(): FullscreenViewer {
    if (this.modeValue === "template") {
      const template = this.element.querySelector<HTMLTemplateElement>("template[data-kintsugi-fullscreen-target='content']")!;
      const container = document.createElement("div");
      container.className = "kintsugi-fullscreen-html";
      container.append(template.content.cloneNode(true));
      return { element: container };
    }
    const media = this.findMedia()!;
    return this.createMediaViewer(media, this.mediaSrc(media));
  }

  private findMedia(): FullscreenMediaElement | undefined {
    if (this.element instanceof HTMLIFrameElement || this.element instanceof HTMLImageElement || this.element instanceof HTMLVideoElement) return this.element;
    return this.element.querySelector<HTMLIFrameElement | HTMLImageElement | HTMLVideoElement>("iframe, img, video") ?? undefined;
  }

  private createMediaViewer(source: FullscreenMediaElement, src: string): FullscreenViewer {
    if (source instanceof HTMLIFrameElement) {
      const frame = document.createElement("iframe");
      frame.className = "kintsugi-fullscreen-frame";
      frame.src = src;
      for (const attr of ["sandbox", "allow", "referrerpolicy"] as const) {
        const value = source.getAttribute(attr);
        if (value !== null) frame.setAttribute(attr, value);
      }
      return { element: frame };
    }

    if (source instanceof HTMLVideoElement) {
      const video = document.createElement("video");
      video.className = "kintsugi-fullscreen-video";
      video.src = src;
      video.controls = true;
      video.autoplay = !source.paused;
      video.currentTime = source.currentTime;
      video.muted = source.muted;
      video.playbackRate = source.playbackRate;
      return {
        element: video,
        disconnect: () => {
          source.currentTime = video.currentTime;
          if (!video.paused && source.paused) void source.play();
        },
      };
    }

    const image = document.createElement("img");
    image.className = "kintsugi-fullscreen-image";
    image.src = src;
    image.alt = source.alt;
    return { element: image };
  }

  private mediaSrc(media: FullscreenMediaElement): string {
    if (media instanceof HTMLImageElement) return media.currentSrc || media.src || this.proxyUrl(media);
    if (media instanceof HTMLVideoElement) return media.currentSrc || media.src || this.proxyUrl(media);
    return media.src || this.proxyUrl(media);
  }

  private proxyUrl(element: HTMLElement): string {
    const workspaceId = element.dataset.agentProxyWorkspaceIdValue!;
    const appKey = element.dataset.agentProxyAppKeyValue!;
    const path = element.dataset.agentProxyPathValue || "/";
    return workspaceProxyUrl(workspaceId, appKey, path);
  }

  private attachIframeShortcuts(root: ParentNode): void {
    this.detachIframeShortcuts();
    this.iframeLoadTargets = [...root.querySelectorAll<HTMLIFrameElement>("iframe")];
    for (const frame of this.iframeLoadTargets) {
      frame.addEventListener("load", this.iframeLoaded);
      iframeShortcutDocument(frame)?.addEventListener("keydown", documentFullscreenKeydown, true);
    }
  }

  private detachIframeShortcuts(): void {
    for (const frame of this.iframeLoadTargets) {
      frame.removeEventListener("load", this.iframeLoaded);
      iframeShortcutDocument(frame)?.removeEventListener("keydown", documentFullscreenKeydown, true);
    }
    this.iframeLoadTargets = [];
  }
}

export function registerWorkspaceFullscreenController(): void {
  registerWorkspaceControllers({
    "kintsugi-fullscreen": KintsugiFullscreenController,
  });
}
