import type { WorkspaceClientModule } from "@kintsugi/shared";
import { Value } from "typebox/value";
import { desktopViewerMessage } from "../messages.ts";

const clipboardFeedbackLabels = {
  pending: "Not sent yet",
  sending: "Sending to remote clipboard",
  sent: "Sent to remote clipboard",
};
type ClipboardState = "remote" | keyof typeof clipboardFeedbackLabels;

export const kintsugiClientModule: WorkspaceClientModule = {
  id: "desktop",
  install({ application, Controller, hooks }) {
    class DesktopPaneController extends Controller {
      static targets = ["frame", "fullscreen", "status", "detail", "clipboardInput", "clipboardCopy", "clipboardFeedback", "clipboardFeedbackLabel"];
      declare readonly frameTarget: HTMLIFrameElement;
      declare readonly fullscreenTarget: HTMLButtonElement;
      declare readonly statusTargets: HTMLElement[];
      declare readonly detailTarget: HTMLElement;
      declare readonly clipboardInputTarget: HTMLTextAreaElement;
      declare readonly clipboardCopyTarget: HTMLButtonElement;
      declare readonly clipboardFeedbackTarget: HTMLElement;
      declare readonly clipboardFeedbackLabelTarget: HTMLElement;
      private clipboardTimer?: ReturnType<typeof setTimeout>;
      private viewerOrigin?: string;
      private clipboardState: ClipboardState = "remote";

      connect(): void {
        this.fullscreenTarget.hidden = !document.fullscreenEnabled;
        this.fullscreenChanged();
        this.loaded();
      }

      disconnect(): void {
        this.cancelClipboardSend();
      }

      reset(): void {
        this.cancelClipboardSend();
        this.viewerOrigin = undefined;
        this.clipboardInputTarget.value = "";
        this.setClipboardState("remote");
        this.show("connecting", "");
      }

      loaded(): void {
        this.reset();
        // The viewer uses a management subpath (or a retained legacy origin).
        // This non-sensitive request discovers it; replies must prove possession
        // of the per-frame token before we pin and check that origin.
        this.frameTarget.contentWindow?.postMessage({ type: "kintsugi:desktop:status-request" }, "*");
      }

      receive(event: MessageEvent): void {
        const data = event.data;
        if (event.source !== this.frameTarget.contentWindow || event.origin === "null") return;
        if (!Value.Check(desktopViewerMessage, data) || !this.frameTarget.dataset.statusToken || data.token !== this.frameTarget.dataset.statusToken) return;
        if (this.viewerOrigin && event.origin !== this.viewerOrigin) return;
        this.viewerOrigin = event.origin;
        if (data.type === "kintsugi:desktop:status") {
          this.show(data.phase, data.detail);
        } else if (data.type === "kintsugi:desktop:clipboard") {
          // VNC can echo text we just sent; that doesn't make it a remote copy.
          if (data.text !== this.clipboardInputTarget.value) {
            this.cancelClipboardSend();
            this.clipboardInputTarget.value = data.text;
            this.setClipboardState("remote");
          }
        } else if (this.clipboardState === "sending" && data.text === this.clipboardInputTarget.value) {
          this.setClipboardState("sent");
        }
      }

      queueClipboard(event: InputEvent | CompositionEvent): void {
        this.cancelClipboardSend();
        this.setClipboardState("pending");
        if (event instanceof InputEvent && event.isComposing) return;
        this.clipboardTimer = setTimeout(() => this.publishClipboard(), 300);
      }

      clipboardKeydown(event: KeyboardEvent): void {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        this.publishClipboard();
      }

      private publishClipboard(): void {
        this.cancelClipboardSend();
        this.setClipboardState("sending");
        this.frameTarget.contentWindow!.postMessage({
          type: "kintsugi:desktop:clipboard-set",
          token: this.frameTarget.dataset.statusToken,
          text: this.clipboardInputTarget.value,
        }, this.viewerOrigin!);
      }

      private cancelClipboardSend(): void {
        clearTimeout(this.clipboardTimer);
        this.clipboardTimer = undefined;
      }

      private setClipboardState(state: ClipboardState): void {
        this.clipboardState = state;
        this.clipboardCopyTarget.dataset.copyText = this.clipboardInputTarget.value;
        this.clipboardCopyTarget.hidden = state !== "remote" || this.clipboardInputTarget.value.length === 0;
        this.clipboardFeedbackTarget.hidden = state === "remote";
        if (state !== "remote") {
          this.clipboardFeedbackTarget.dataset.state = state;
          this.clipboardFeedbackTarget.title = clipboardFeedbackLabels[state];
          this.clipboardFeedbackLabelTarget.textContent = clipboardFeedbackLabels[state];
        }
      }

      async toggleFullscreen(): Promise<void> {
        if (document.fullscreenElement === this.element) await document.exitFullscreen();
        else await this.element.requestFullscreen();
      }

      fullscreenChanged(): void {
        this.fullscreenTarget.setAttribute("aria-pressed", String(document.fullscreenElement === this.element));
      }

      private show(phase: string, detail: string): void {
        this.clipboardInputTarget.disabled = phase !== "connected";
        if (phase !== "connected") {
          this.cancelClipboardSend();
          if (this.clipboardState !== "remote") this.setClipboardState("pending");
        }
        for (const status of this.statusTargets) status.hidden = status.dataset.phase !== phase;
        this.detailTarget.textContent = detail;
      }
    }
    application.register("desktop-pane", DesktopPaneController);
    hooks.onWorkspaceAppFrameUrl(({ appKey, url, frame }) => {
      if (appKey !== "desktop") return;
      url.searchParams.set("theme", document.documentElement.dataset.theme ?? "");
      url.searchParams.set("parentOrigin", window.location.origin);
      url.searchParams.set("statusToken", frame.dataset.statusToken ??= crypto.randomUUID());
      if (frame.src !== url.toString()) frame.dispatchEvent(new CustomEvent("desktop:navigating"));
    });
    hooks.onWorkspaceAppFrameRefresh(({ appKey, frame, load }) => {
      if (appKey === "desktop" && frame.src) load();
    });
  },
};
