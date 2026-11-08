import { flushPreviewFrame } from "@kintsugi/proxy-ingress/preview-client";
import { Controller } from "@hotwired/stimulus";
import { isWorkspacePaneVisible } from "@kintsugi/shared";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";
import { clientHooks } from "./workspace-client-hooks.ts";

class WorkspaceAppFrameController extends Controller<HTMLIFrameElement> {
  static values = { workspaceId: String, appKey: String, initialPath: String };
  declare readonly workspaceIdValue: string;
  declare readonly appKeyValue: string;
  declare readonly initialPathValue: string;
  declare readonly hasInitialPathValue: boolean;
  private loadedUrl?: string;
  private pendingLoad?: { url: string; promise: Promise<void> };

  connect(): void {
    document.addEventListener("kintsugi:theme-change", this.themeChanged);
    if (isWorkspacePaneVisible(this.element)) this.load();
  }

  disconnect(): void {
    document.removeEventListener("kintsugi:theme-change", this.themeChanged);
  }

  initialPathValueChanged(): void {
    if (isWorkspacePaneVisible(this.element)) this.load();
  }

  becomeVisible(): void {
    this.load();
  }

  load(): void {
    void this.loadAndWait().catch(error => { console.error("Editor navigation paused", error); window.alert("Preview settings could not be saved. The current editor was kept open."); });
  }

  loadAndWait(): Promise<void> {
    const src = this.frameSrc();
    if (this.loadedUrl === src) return Promise.resolve();
    if (this.pendingLoad) return this.pendingLoad.url === src ? this.pendingLoad.promise : this.pendingLoad.promise.then(() => this.loadAndWait());
    if (this.element.src === src && this.element.contentDocument?.readyState === "complete") {
      this.loadedUrl = src;
      return Promise.resolve();
    }
    const promise = (async () => {
      if (this.element.getAttribute("src") && this.element.src !== src) await flushPreviewFrame(this.element);
      if (!this.element.isConnected || src !== this.frameSrc()) return;
      await new Promise<void>(resolve => {
        this.element.addEventListener("load", () => { this.loadedUrl = src; resolve(); }, { once: true });
        if (this.element.src !== src) this.element.src = src;
      });
    })().finally(() => { this.pendingLoad = undefined; });
    this.pendingLoad = { url: src, promise };
    return promise;
  }

  private frameSrc(): string {
    const path = this.hasInitialPathValue && this.initialPathValue ? this.initialPathValue : "/";
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/apps/${encodeURIComponent(this.appKeyValue)}${normalizedPath}`, window.location.href);
    clientHooks.workspaceAppFrameUrl({ appKey: this.appKeyValue, url, frame: this.element });
    return url.toString();
  }

  private themeChanged = (): void => {
    clientHooks.workspaceAppFrameRefresh({ appKey: this.appKeyValue, frame: this.element, load: () => this.load() });
  };
}

export function registerWorkspaceAppFrameController(): void {
  registerWorkspaceControllers({
    "workspace-app-frame": WorkspaceAppFrameController,
  });
}
