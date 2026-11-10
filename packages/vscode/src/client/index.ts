/// <reference lib="dom" />

import type { WorkspaceClientModule } from "@kintsugi/shared";

function cssVariable(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function addKintsugiThemeParams(url: URL): void {
  url.searchParams.set("kintsugiBg", cssVariable("--bg"));
  url.searchParams.set("kintsugiPanel", cssVariable("--panel"));
  url.searchParams.set("kintsugiElev", cssVariable("--elev"));
  url.searchParams.set("kintsugiText", cssVariable("--text"));
  url.searchParams.set("kintsugiLine", cssVariable("--line"));
  url.searchParams.set("kintsugiAccent", cssVariable("--accent"));
  url.searchParams.set("kintsugiAccentContrast", cssVariable("--accent-contrast"));
  for (const role of ["comment", "string", "keyword", "number", "function", "variable", "type", "punctuation", "literal", "attribute", "tag", "constant", "link"]) {
    url.searchParams.set(`kintsugiSyntax-${role}`, cssVariable(`--syntax-${role}`));
  }
  for (const color of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
    for (const prefix of ["", "bright-"]) {
      url.searchParams.set(`kintsugiTerminal-${prefix}${color}`, cssVariable(`--terminal-${prefix}${color}`));
    }
  }
}

export const vscodeClientModule: WorkspaceClientModule = {
  id: "vscode",
  install({ application, Controller, hooks }) {
    class VSCodeStartingController extends Controller {
      static targets = ["frame", "help"];
      declare readonly element: HTMLElement;
      declare readonly frameTarget: HTMLIFrameElement;
      declare readonly helpTarget: HTMLElement;
      private helpTimer?: ReturnType<typeof setTimeout>;

      connect(): void {
        this.frameTarget.addEventListener("load", this.loaded);
        if (this.element.classList.contains("vscode-loading")) this.scheduleHelp();
      }

      disconnect(): void {
        clearTimeout(this.helpTimer);
        this.frameTarget.removeEventListener("load", this.loaded);
      }

      retry(): void {
        this.element.classList.add("vscode-loading");
        this.helpTarget.hidden = true;
        this.scheduleHelp();
        this.frameTarget.src = this.frameTarget.src;
      }

      private scheduleHelp(): void {
        clearTimeout(this.helpTimer);
        this.helpTimer = setTimeout(() => { this.helpTarget.hidden = false; }, 8000);
      }

      private loaded = (): void => {
        if (!this.frameTarget.hasAttribute("src")) return;
        clearTimeout(this.helpTimer);
        this.helpTarget.hidden = true;
        this.element.classList.remove("vscode-loading");
      };
    }

    class VSCodeNavigateController extends Controller {
      static values = { viewId: String, path: String, delivered: Boolean };
      declare readonly viewIdValue: string;
      declare readonly pathValue: string;
      declare readonly deliveredValue: boolean;
      private observer?: MutationObserver;

      connect(): void {
        // The presentation stream activates the view; its body may still be loading.
        this.observer = new MutationObserver(() => this.navigate());
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.navigate();
      }

      disconnect(): void {
        this.observer?.disconnect();
      }

      private navigate(): void {
        const frame = document.getElementById(this.viewIdValue)?.querySelector("iframe");
        if (!frame) return;
        this.observer!.disconnect();
        // The server already handed the file to the live VS Code windows. A
        // loaded frame keeps its workbench: reloading it costs a full download.
        // A frame still loading (perhaps only just activated) takes the file along.
        if (this.deliveredValue && !frame.closest(".vscode-frame-shell")!.classList.contains("vscode-loading")) return;
        // Navigate the existing frame, rather than removing it, so VS Code can
        // run its normal shutdown/backup handling for unsaved editors.
        frame.setAttribute("data-workspace-app-frame-initial-path-value", this.pathValue);
      }
    }

    application.register("vscode-navigate", VSCodeNavigateController);
    application.register("vscode-starting", VSCodeStartingController);
    hooks.onWorkspaceAppFrameUrl(({ appKey, url }) => {
      if (appKey !== "vscode") return;
      addKintsugiThemeParams(url);
    });
    hooks.onWorkspaceAppFrameRefresh(({ appKey, frame, load }) => {
      if (appKey === "vscode" && frame.src) load();
    });
  },
};

export { vscodeClientModule as kintsugiClientModule };
