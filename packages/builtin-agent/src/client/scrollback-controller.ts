import type { WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { transcriptExpandEvent, transcriptReadingEvent } from "@kintsugi/agent/client/transcript-navigation";

/** Loads server-rendered history only when the reader reaches its boundary. */
export function createAgentScrollbackController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static targets = ["button", "status"];
    static values = { url: String };
    declare readonly element: HTMLElement;
    declare readonly buttonTarget: HTMLButtonElement;
    declare readonly statusTarget: HTMLElement;
    declare readonly urlValue: string;
    private scroller!: HTMLElement;
    private observer?: IntersectionObserver;
    private request?: AbortController;
    private failed = false;
    private armed = false;
    private connected = false;
    private recheckTimer?: ReturnType<typeof setTimeout>;
    private recheckFrame = 0;

    connect(): void {
      this.connected = true;
      this.scroller = this.element.closest<HTMLElement>(".agent-transcript, .agent-background-page-body")!;
      this.scroller.addEventListener("scroll", this.reachedTop, { passive: true });
      this.scroller.addEventListener(transcriptReadingEvent, this.reading);
      this.observer = new IntersectionObserver(this.reachedTop, { root: this.scroller });
      this.observer.observe(this.element);
    }
    disconnect(): void {
      this.connected = false;
      clearTimeout(this.recheckTimer);
      cancelAnimationFrame(this.recheckFrame);
      this.scroller.removeEventListener("scroll", this.reachedTop);
      this.scroller.removeEventListener(transcriptReadingEvent, this.reading);
      this.observer?.disconnect();
      this.request?.abort();
    }
    urlValueChanged(value: string, previous: string): void {
      if (this.connected && value !== previous) this.scheduleRecheck();
    }
    private scheduleRecheck(): void {
      clearTimeout(this.recheckTimer);
      cancelAnimationFrame(this.recheckFrame);
      // A bookkeeping-only page may leave this boundary in view without another
      // scroll/intersection event. Let Turbo finish and navigation restore its
      // anchor before deciding whether the reader still needs another page.
      this.recheckTimer = setTimeout(() => {
        this.recheckTimer = undefined;
        this.recheckFrame = requestAnimationFrame(() => { this.recheckFrame = 0; this.reachedTop(); });
      }, 0);
    }
    private readonly reading = (): void => { this.armed = true; this.reachedTop(); };
    private readonly reachedTop = (): void => {
      if (!this.connected || !this.armed || this.failed || this.request || this.scroller.dataset.following !== "false" || !this.element.checkVisibility()) return;
      const top = this.scroller.getBoundingClientRect().top;
      if (this.element.getBoundingClientRect().bottom >= top && this.element.getBoundingClientRect().top <= top + 120) void this.load();
    };
    async load(): Promise<void> {
      if (this.request) return;
      const request = new AbortController(), url = this.urlValue;
      this.request = request;
      this.failed = false;
      this.buttonTarget.disabled = true;
      this.statusTarget.textContent = "Loading earlier messages…";
      // Clicking Load earlier is reading, never an instruction to follow the latest reply.
      this.element.dispatchEvent(new CustomEvent(transcriptExpandEvent, { bubbles: true }));
      try {
        const response = await fetch(url, { signal: request.signal, headers: { Accept: "text/vnd.turbo-stream.html" } });
        if (!response.ok) throw new Error(`Could not load earlier messages: HTTP ${response.status}`);
        const html = await response.text();
        // A live update may have advanced the page or selected another branch
        // while this request was in flight. Never restore its obsolete snapshot.
        if (!request.signal.aborted && url === this.urlValue) window.Turbo!.renderStreamMessage(html);
      } catch (error) {
        if (request.signal.aborted || url !== this.urlValue) return;
        this.failed = true;
        this.statusTarget.textContent = "Couldn't load earlier messages. Try again.";
        console.error(error);
      } finally {
        this.request = undefined;
        if (this.connected && this.element.isConnected) {
          this.buttonTarget.disabled = false;
          if (!this.failed) {
            this.statusTarget.textContent = "";
            // Cable may have advanced the boundary while this HTTP request was
            // pending, when the value-change callback was still request-gated.
            if (url !== this.urlValue) this.scheduleRecheck();
          }
        }
      }
    }
  };
}
