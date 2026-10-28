import { Value } from "typebox/value";
import { inlineContentConnectMessage, inlineContentThemeMessage } from "../shared/inline-content-protocol.ts";
import { Application, Controller } from "@hotwired/stimulus";
import { quotableSelection } from "@kintsugi/shared/text-selection";

export { Controller };
const application = new Application();
let pendingError: string | undefined;
function reportInteractionError(message: string): void {
  pendingError = message.slice(0, 1000);
  document.dispatchEvent(new Event("inline-content:interaction-error"));
}
application.handleError = (error, message) => {
  console.error(message, error);
  reportInteractionError(error instanceof Error ? error.message : message);
};
export function registerController(name: string, controller: typeof Controller): void { application.register(name, controller); }
export function colors(): Record<string, string> {
  const probe = document.createElement("span");
  probe.hidden = true; document.body.append(probe);
  const result = Object.fromEntries(["text", "text-muted", "surface", "border", "accent", "on-accent", "danger", ...Array.from({ length: 6 }, (_, i) => `series-${i + 1}`)].map(name => {
    probe.style.color = `var(--ic-${name})`;
    return [name, getComputedStyle(probe).color];
  }));
  probe.remove();
  return result;
}

class RuntimeController extends Controller {
  private port?: MessagePort;
  private resize = new ResizeObserver(() => this.report());
  private mutations = new MutationObserver(() => this.observe());
  private scheduled = 0;
  private touchY?: number;
  private selectionFrame = 0;
  private selected = false;
  connect(): void {
    document.addEventListener("selectionchange", this.selectionChanged);
    window.addEventListener("message", this.handshake);
    document.addEventListener("click", this.link);
    window.addEventListener("wheel", this.wheel, { passive: true });
    window.addEventListener("touchstart", this.touchStart, { passive: true });
    window.addEventListener("touchmove", this.touchMove, { passive: true });
    window.addEventListener("error", this.error);
    window.addEventListener("unhandledrejection", this.rejection);
    document.addEventListener("inline-content:interaction-error", this.sendError);
    document.addEventListener("securitypolicyviolation", this.policyViolation);
    this.observe();
    this.mutations.observe(document.getElementById("ic-content")!, { childList: true, subtree: true });
  }
  disconnect(): void {
    document.removeEventListener("selectionchange", this.selectionChanged);
    cancelAnimationFrame(this.selectionFrame);
    window.removeEventListener("message", this.handshake);
    document.removeEventListener("click", this.link);
    window.removeEventListener("wheel", this.wheel);
    window.removeEventListener("touchstart", this.touchStart);
    window.removeEventListener("touchmove", this.touchMove);
    window.removeEventListener("error", this.error);
    window.removeEventListener("unhandledrejection", this.rejection);
    document.removeEventListener("inline-content:interaction-error", this.sendError);
    document.removeEventListener("securitypolicyviolation", this.policyViolation);
    this.resize.disconnect(); this.mutations.disconnect(); this.port?.close(); cancelAnimationFrame(this.scheduled);
  }
  private observe(): void {
    const root = document.getElementById("ic-content")!;
    this.resize.observe(root);
    for (const child of root.children) this.resize.observe(child);
    this.report();
  }
  private report(): void {
    cancelAnimationFrame(this.scheduled);
    this.scheduled = requestAnimationFrame(() => {
      const root = document.getElementById("ic-content")!;
      this.port?.postMessage({ type: "size", height: Math.ceil(root.getBoundingClientRect().height), overflow: root.scrollWidth > root.clientWidth + 2 });
    });
  }
  private handshake = (event: MessageEvent): void => {
    if (event.source !== parent || !Value.Check(inlineContentConnectMessage, event.data) || !event.ports[0] || this.port) return;
    this.port = event.ports[0];
    this.port.onmessage = (message: MessageEvent) => {
      if (!Value.Check(inlineContentThemeMessage, message.data)) return;
      document.documentElement.dataset.theme = message.data.theme;
      document.documentElement.style.setProperty("--text-body", message.data.fontSize);
      document.dispatchEvent(new CustomEvent("inline-content:theme"));
      this.report();
    };
    this.port.postMessage({ type: "ready" });
    this.sendError();
    this.report();
  };
  private link = (event: MouseEvent): void => {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    event.preventDefault();
    if (event.isTrusted && /^https?:\/\//i.test(href)) this.port?.postMessage({ type: "link", href });
  };
  // Scrolling over the frame never reaches the host; upward scrolling must stop transcript following.
  private wheel = (event: WheelEvent): void => {
    // Ctrl+wheel is pinch zoom.
    if (event.deltaY !== 0 && !event.ctrlKey) this.port?.postMessage({ type: "scroll", deltaY: event.deltaY });
  };
  // Screen coordinates: the frame moves under the finger while the host scrolls.
  private touchStart = (event: TouchEvent): void => { this.touchY = event.touches.length === 1 ? event.touches[0]!.screenY : undefined; };
  private touchMove = (event: TouchEvent): void => {
    if (this.touchY === undefined || event.touches.length !== 1) { this.touchY = undefined; return; }
    const y = event.touches[0]!.screenY;
    if (Math.abs(y - this.touchY) < 4) return;
    this.port?.postMessage({ type: "scroll", deltaY: this.touchY - y });
    this.touchY = y;
  };
  // The host draws the Comment button for selected text; it cannot see into this document.
  private selectionChanged = (): void => {
    cancelAnimationFrame(this.selectionFrame);
    this.selectionFrame = requestAnimationFrame(() => {
      const selection = quotableSelection(document);
      if (selection) {
        const { left, top, right, bottom } = selection.range.getBoundingClientRect();
        this.port?.postMessage({ type: "selection", text: selection.text, code: selection.code, rect: { left, top, right, bottom } });
      } else if (this.selected) this.port?.postMessage({ type: "selection-cleared" });
      this.selected = Boolean(selection);
    });
  };
  private sendError = (): void => {
    if (pendingError) this.port?.postMessage({ type: "error", message: pendingError });
  };
  private error = (event: ErrorEvent): void => {
    // ResizeObserver defers undelivered observations to another frame. This is a
    // browser layout diagnostic, not a thrown exception or failed interaction.
    // Leave the diagnostic visible in the console; don't mislabel the visual as broken.
    if (event.message === "ResizeObserver loop completed with undelivered notifications." || event.message === "ResizeObserver loop limit exceeded") {
      console.warn(event.message);
      return;
    }
    reportInteractionError(event.message);
  };
  private rejection = (event: PromiseRejectionEvent): void => {
    reportInteractionError(event.reason instanceof Error ? event.reason.message : "An asynchronous interaction failed.");
  };
  private policyViolation = (event: SecurityPolicyViolationEvent): void => {
    reportInteractionError(`The sandbox blocked ${event.violatedDirective}: ${event.blockedURI}. Keep scripts, styles, and data self-contained.`);
  };
}

class TabsController extends Controller<HTMLElement> {
  connect(): void {
    this.element.addEventListener("click", this.click);
    this.element.addEventListener("keydown", this.key);
    const selected = this.tabs.find(tab => tab.getAttribute("aria-selected") === "true") ?? this.tabs[0];
    if (selected) this.select(selected);
  }
  disconnect(): void { this.element.removeEventListener("click", this.click); this.element.removeEventListener("keydown", this.key); }
  private get tabs(): HTMLButtonElement[] { return [...this.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')]; }
  private select(tab: HTMLButtonElement): void {
    for (const candidate of this.tabs) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected)); candidate.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(candidate.getAttribute("aria-controls")!);
      if (panel) panel.hidden = !selected;
    }
  }
  private click = (event: MouseEvent): void => {
    const tab = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[role="tab"]') : null;
    if (tab && !tab.disabled) this.select(tab);
  };
  private key = (event: KeyboardEvent): void => {
    const tabs = this.tabs.filter(tab => !tab.disabled);
    const index = tabs.findIndex(tab => tab === document.activeElement);
    if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
    this.select(tabs[next]!); tabs[next]!.focus();
  };
}

class TooltipController extends Controller<HTMLElement> {
  private tooltip?: HTMLSpanElement;
  connect(): void {
    this.element.addEventListener("pointerenter", this.show); this.element.addEventListener("focus", this.show);
    this.element.addEventListener("pointerleave", this.hide); this.element.addEventListener("blur", this.hide);
    this.element.addEventListener("click", this.toggle);
  }
  disconnect(): void {
    this.hide();
    this.element.removeEventListener("pointerenter", this.show); this.element.removeEventListener("focus", this.show);
    this.element.removeEventListener("pointerleave", this.hide); this.element.removeEventListener("blur", this.hide);
    this.element.removeEventListener("click", this.toggle);
  }
  private toggle = (): void => { if (this.tooltip) this.hide(); else this.show(); };
  private show = (): void => {
    this.hide();
    const tooltip = document.createElement("span"); tooltip.className = "ic-tooltip-content"; tooltip.role = "tooltip";
    tooltip.id = `ic-tooltip-${crypto.randomUUID()}`; tooltip.textContent = this.element.dataset.icTooltip!;
    document.body.append(tooltip); this.tooltip = tooltip;
    this.element.setAttribute("aria-describedby", `${this.element.getAttribute("aria-describedby") ?? ""} ${tooltip.id}`.trim());
    const rect = this.element.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(0, rect.top - tooltip.offsetHeight - 4)}px`;
  };
  private hide = (): void => {
    if (!this.tooltip) return;
    this.element.setAttribute("aria-describedby", (this.element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id !== this.tooltip!.id).join(" "));
    this.tooltip.remove(); this.tooltip = undefined;
  };
}
application.register("ic-runtime", RuntimeController);
application.register("ic-tabs", TabsController);
application.register("ic-tooltip", TooltipController);

// Imported author controllers start only after the host controller is listening.
await application.start();
