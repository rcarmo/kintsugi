import { Application, Controller } from "@hotwired/stimulus";
import RFB from "@novnc/novnc";
import { Value } from "typebox/value";
import { desktopClipboardSetMessage, type DesktopPhase, type DesktopViewerPayload } from "../messages.ts";

class DesktopController extends Controller {
  static targets = ["screen", "runtime"];
  declare readonly screenTarget: HTMLElement;
  declare readonly runtimeTarget: HTMLElement;
  private phase: DesktopPhase = "connecting";
  private detail = "";
  private readonly params = new URL(window.location.href).searchParams;
  private rfb?: RFB;
  private retry?: ReturnType<typeof setTimeout>;
  private active = false;
  private request?: AbortController;

  connect(): void {
    this.active = true;
    this.reportRuntime();
    if (this.runtimeTarget.firstElementChild!.getAttribute("data-phase") === "running") this.open();
    else this.scheduleRetry();
  }

  disconnect(): void {
    this.active = false;
    clearTimeout(this.retry);
    this.request?.abort();
    this.rfb?.disconnect();
    this.rfb = undefined;
  }

  receive(event: MessageEvent): void {
    if (event.source !== window.parent || event.origin !== this.params.get("parentOrigin")) return;
    if (event.data?.type === "kintsugi:desktop:status-request") {
      this.report(this.phase, this.detail);
    } else if (Value.Check(desktopClipboardSetMessage, event.data) && event.data.token === this.params.get("statusToken") && this.phase === "connected") {
      this.rfb!.clipboardPasteFrom(event.data.text);
      this.postToParent({ type: "kintsugi:desktop:clipboard-sent", text: event.data.text });
    }
  }

  private report(phase: DesktopPhase, detail = ""): void {
    this.phase = phase;
    this.detail = detail;
    this.postToParent({ type: "kintsugi:desktop:status", phase, detail });
  }

  private postToParent(message: DesktopViewerPayload): void {
    const parentOrigin = this.params.get("parentOrigin");
    if (window.parent !== window && parentOrigin) window.parent.postMessage({ ...message, token: this.params.get("statusToken") }, parentOrigin);
  }

  private reportRuntime(): void {
    // SAFETY: the server renders this attribute from its validated desktop runtime status.
    const phase = this.runtimeTarget.firstElementChild!.getAttribute("data-phase") as DesktopPhase | "running";
    this.report(phase === "running" ? "connecting" : phase, this.runtimeTarget.querySelector(".desktop-status-detail")?.textContent ?? "");
  }

  private open(): void {
    const url = new URL("websockify", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const rfb = new RFB(this.screenTarget, url.toString());
    this.rfb = rfb;
    rfb.background = getComputedStyle(document.body).backgroundColor;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = true;
    rfb.qualityLevel = 6;
    rfb.compressionLevel = 2;
    rfb.addEventListener("clipboard", (event) => {
      // SAFETY: noVNC's clipboard event is a CustomEvent with detail.text containing the remote text.
      const text = (event as CustomEvent<{ text: string }>).detail.text;
      this.postToParent({ type: "kintsugi:desktop:clipboard", text });
    });
    rfb.addEventListener("connect", () => {
      this.report("connected");
    });
    rfb.addEventListener("disconnect", () => {
      this.rfb = undefined;
      if (!this.active) return;
      this.report("disconnected");
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    this.retry = setTimeout(() => void this.refresh(), 3000);
  }

  private async refresh(): Promise<void> {
    this.request = new AbortController();
    try {
      const response = await fetch(new URL("status", window.location.href), { signal: this.request.signal });
      if (!response.ok) throw new Error(`Desktop status: HTTP ${response.status}`);
      const html = await response.text();
      if (!this.active) return;
      this.runtimeTarget.innerHTML = html;
      this.reportRuntime();
      if (this.runtimeTarget.firstElementChild!.getAttribute("data-phase") === "running") this.open();
      else this.scheduleRetry();
    } catch (error) {
      if (!this.active) return;
      console.error("Desktop connection failed", error);
      this.report("disconnected");
      this.scheduleRetry();
    }
  }
}

Application.start().register("desktop", DesktopController);
