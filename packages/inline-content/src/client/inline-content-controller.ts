import { Value } from "typebox/value";
import { inlineContentFrameMessage } from "../shared/inline-content-protocol.ts";
import { frameScrollEvent, frameSelectionEvent, type FrameScrollDetail, type FrameSelectionDetail, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";

export function createInlineContentController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static targets = ["frame", "status"];
    static values = { url: String };
    declare readonly element: HTMLElement;
    declare readonly frameTarget: HTMLIFrameElement;
    declare readonly statusTarget: HTMLElement;
    declare readonly urlValue: string;
    private abort = new AbortController();
    private port?: MessagePort;
    private theme = new MutationObserver(() => this.sendTheme());
    private loadedOnce = false;
    private handshakeTimer?: ReturnType<typeof setTimeout>;

    connect(): void {
      this.element.addEventListener("turbo:before-morph-element", this.preserve);
      this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
      void this.load();
    }
    disconnect(): void {
      this.abort.abort(); this.port?.close(); this.theme.disconnect(); clearTimeout(this.handshakeTimer);
      this.element.removeEventListener("turbo:before-morph-element", this.preserve);
    }
    private preserve = (event: Event): void => { if (event.target === this.element) event.preventDefault(); };
    private async load(): Promise<void> {
      try {
        const response = await fetch(this.urlValue, { signal: this.abort.signal });
        const html = await response.text();
        if (!response.ok) { this.fail(html); return; }
        this.frameTarget.srcdoc = html;
      } catch (error) {
        if (!this.abort.signal.aborted) { this.fail("Could not load this visual explanation. Reload to try again."); console.error(error); }
      }
    }
    loaded(): void {
      if (!this.frameTarget.hasAttribute("srcdoc")) return;
      if (this.loadedOnce) { this.fail("This visual tried to navigate away. Ask the agent to fix it."); return; }
      this.loadedOnce = true;
      const channel = new MessageChannel(); this.port = channel.port1;
      this.port.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (!Value.Check(inlineContentFrameMessage, data)) return;
        if (data.type === "ready") { clearTimeout(this.handshakeTimer); this.sendTheme(); this.frameTarget.hidden = false; this.statusTarget.hidden = true; }
        if (data.type === "size") {
          this.frameTarget.style.height = `${Math.max(1, Math.min(30000, data.height))}px`;
          if (data.overflow) { this.statusTarget.textContent = "This visual is wider than the conversation. Ask the agent to make it responsive."; this.statusTarget.hidden = false; }
        }
        // Replay input from inside the visual as if it happened over the frame.
        if (data.type === "scroll") this.frameTarget.dispatchEvent(new CustomEvent<FrameScrollDetail>(frameScrollEvent, { detail: { deltaY: data.deltaY }, bubbles: true }));
        if (data.type === "selection" || data.type === "selection-cleared") {
          const detail = data.type === "selection" ? { text: data.text, code: data.code, rect: data.rect } : null;
          this.frameTarget.dispatchEvent(new CustomEvent<FrameSelectionDetail>(frameSelectionEvent, { detail, bubbles: true }));
        }
        if (data.type === "error") this.fail(`An interaction failed: ${data.message}`, false);
        if (data.type === "link") {
          // A sandbox cannot navigate Kintsugi. External navigation always requires host confirmation.
          if (confirm(`Open this external link?\n${data.href}`)) window.open(data.href, "_blank", "noopener,noreferrer");
        }
      };
      this.frameTarget.contentWindow!.postMessage({ type: "inline-content-connect" }, "*", [channel.port2]);
      this.handshakeTimer = setTimeout(() => this.fail("This visual did not finish loading. Ask the agent to fix it."), 10000);
    }
    private sendTheme(): void {
      this.port?.postMessage({ type: "theme", theme: document.documentElement.dataset.theme ?? "", fontSize: getComputedStyle(document.documentElement).getPropertyValue("--text-body").trim() });
    }
    private fail(message: string, hide = true): void { this.statusTarget.textContent = message; this.statusTarget.hidden = false; if (hide) this.frameTarget.hidden = true; }
  };
}
