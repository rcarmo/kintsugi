import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@kintsugi/shared";

export function createAgentTailFrameController(Controller: StimulusControllerConstructor) {
  return class AgentTailFrameController extends Controller {
    declare readonly element: HTMLElement;
    private awaitingCompletedDetail = false;
    private previous?: {
      scrollerIndex: number;
      height: number;
      top: number;
      tail: boolean;
      transcript?: { element: HTMLElement; top: number };
    };
    private scrollers(): HTMLElement[] {
      return [...this.element.querySelectorAll<HTMLElement>(".agent-tail-output")];
    }
    prepare(event: Event): void {
      if (!(event.currentTarget instanceof HTMLAnchorElement)) throw new Error("Agent tail pagination action requires a link");
      const scrollers = this.scrollers();
      const scroller = event.currentTarget.closest<HTMLElement>(".agent-tail-output");
      if (!scroller) throw new Error("Agent tail pagination link requires an output container");
      const transcript = this.element.closest<HTMLElement>(".agent-transcript");
      this.previous = {
        scrollerIndex: scrollers.indexOf(scroller),
        height: scroller.scrollHeight,
        top: scroller.scrollTop,
        tail: scroller.dataset.agentTailDirection === "last",
        transcript: transcript ? { element: transcript, top: transcript.scrollTop } : undefined,
      };
    }
    private completedDetailSource(next?: Node): string | undefined {
      if (!(next instanceof HTMLElement) || next.hasChildNodes() || !this.element.hasChildNodes() || !this.element.closest("details")?.open) return;
      return next.dataset.src;
    }
    preserveLiveIsland(event: Event): void {
      if (!(event.target instanceof Element) || event.target.closest("turbo-frame") !== this.element) return;
      // Preserve the live terminal when Cable would remove it before morphing.
      // SAFETY: The Cable renderer emits live:before-island-remove with the incoming elements by ID.
      const { incoming } = (event as CustomEvent<{ incoming: ReadonlyMap<string, Element> }>).detail;
      if (this.completedDetailSource(incoming.get(this.element.id))) event.preventDefault();
    }
    keepUntilLoaded(event: Event): void {
      if (event.target !== this.element) return;
      // SAFETY: Turbo emits before-morph-element with its replacement node; removals have none.
      const next = (event as CustomEvent<{ newElement?: Node }>).detail.newElement;
      const source = this.completedDetailSource(next);
      if (!(next instanceof HTMLElement) || !source) return;
      // Switch the frame to lazy detail without clearing the visible output.
      event.preventDefault();
      for (const name of this.element.getAttributeNames()) if (!next.hasAttribute(name)) this.element.removeAttribute(name);
      for (const { name, value } of next.attributes) this.element.setAttribute(name, value);
      this.awaitingCompletedDetail = true;
      this.element.setAttribute("src", source);
    }
    loadFailed(event: Event): void {
      if (event.target !== this.element || !this.awaitingCompletedDetail) return;
      // Keep the last visible output. Closing and reopening can retry the load.
      event.preventDefault();
      this.element.removeAttribute("src");
    }
    loaded(): void {
      this.awaitingCompletedDetail = false;
      const previous = this.previous;
      this.previous = undefined;
      if (!previous) {
        for (const scroller of this.element.querySelectorAll<HTMLElement>('.agent-tail-output[data-agent-tail-direction="last"]')) scroller.scrollTop = scroller.scrollHeight;
        return;
      }
      const scroller = this.scrollers()[previous.scrollerIndex];
      if (!scroller) return;
      scroller.scrollTop = previous.tail ? previous.top + scroller.scrollHeight - previous.height : previous.top;
      if (previous.transcript) {
        // Keep pagination from activating native anchoring or stick-to-bottom.
        previous.transcript.element.scrollTop = previous.transcript.top;
        previous.transcript.element.dispatchEvent(new Event("scroll"));
      }
    }
  };
}

export function createAgentLazyDetailController(Controller: StimulusControllerConstructor) {
  return class AgentLazyDetailController extends Controller {
    static targets = ["frame"];
    declare readonly element: HTMLDetailsElement;
    declare readonly frameTarget: HTMLElement & { src: string };

    connect(): void { if (this.element.open) this.load(); }
    load(): void {
      if (!this.element.open || this.frameTarget.getAttribute("src")) return;
      this.frameTarget.setAttribute("src", this.frameTarget.dataset.src!);
    }
  };
}

