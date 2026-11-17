import { CableTopics, type CableSubscription, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";

// Disclosure choice belongs to this pane instance, not another tab or browser.
const expandedTurns = new WeakMap<Element, Set<string>>();

export function createAgentTurnController(Controller: WorkspaceClientControllerConstructor) {
  return class AgentTurnController extends Controller {
    static values = { workspaceId: String, agentId: String, turnId: String, branchId: String, reveal: String };
    static targets = ["items"];
    declare readonly element: HTMLDetailsElement;
    declare readonly workspaceIdValue: string;
    declare readonly agentIdValue: string;
    declare readonly turnIdValue: string;
    declare readonly branchIdValue: string;
    declare readonly revealValue: string;
    declare readonly itemsTarget: HTMLElement;
    private pane!: HTMLElement;
    private items!: HTMLElement;
    private agentPane = false;
    private visibilityObserver?: IntersectionObserver;
    private subscription?: CableSubscription;
    private readonly reconcile = (): void => {
      const visible = document.visibilityState === "visible" && (this.agentPane
        ? this.pane.dataset.agentConnectionActive === "true"
        : this.element.checkVisibility());
      if (!this.element.open || !visible) {
        this.stop();
        return;
      }
      if (this.subscription) return;
      this.subscription = window.KintsugiCable!.subscribe(
        CableTopics.agentTurn(this.workspaceIdValue, this.agentIdValue, this.turnIdValue, this.branchIdValue),
        { onReady: () => this.reveal() },
      );
    };

    connect(): void {
      const childTranscript = this.element.closest<HTMLElement>('[data-controller~="builtin-child-transcript"]');
      const agentPane = childTranscript ? null : this.element.closest<HTMLElement>('[data-controller~="agent-pane"]');
      this.agentPane = agentPane !== null;
      this.pane = agentPane ?? childTranscript ?? this.element.closest<HTMLElement>(".agent-transcript")!;
      this.items = this.itemsTarget;
      if (!this.agentPane) {
        // Subagent transcripts have no agent-pane controller. Observe changes to
        // ancestor visibility without treating offscreen content as folded.
        this.visibilityObserver = new IntersectionObserver(this.reconcile);
        this.visibilityObserver.observe(this.element);
        document.addEventListener("toggle", this.reconcile, true);
      }
      if (!expandedTurns.has(this.pane)) expandedTurns.set(this.pane, new Set());
      if (expandedTurns.get(this.pane)!.has(this.key)) this.element.open = true;
      if (this.element.open) expandedTurns.get(this.pane)!.add(this.key);
      this.pane.addEventListener("agent:connection", this.reconcile);
      document.addEventListener("visibilitychange", this.reconcile);
      this.reconcile();
    }

    branchIdValueChanged(): void {
      if (!this.pane) return;
      this.stop();
      this.reconcile();
    }

    toggle(event: Event): void {
      // Nested tool disclosures emit their own toggle events.
      if (event.target !== this.element) return;
      if (this.element.open) expandedTurns.get(this.pane)!.add(this.key);
      else expandedTurns.get(this.pane)!.delete(this.key);
      this.reconcile();
    }

    disconnect(): void {
      this.visibilityObserver?.disconnect();
      document.removeEventListener("toggle", this.reconcile, true);
      this.pane.removeEventListener("agent:connection", this.reconcile);
      document.removeEventListener("visibilitychange", this.reconcile);
      this.stop();
    }

    private get key(): string { return `${this.branchIdValue}:${this.turnIdValue}`; }

    private stop(): void {
      this.subscription?.unsubscribe();
      this.subscription = undefined;
      this.items.replaceChildren();
    }

    private reveal(): void {
      if (!this.revealValue) return;
      const selector = `[data-transcript-anchor="${CSS.escape(this.revealValue)}"], [data-transcript-key="${CSS.escape(this.revealValue)}"]`;
      const target = this.items.querySelector<HTMLElement>(selector);
      if (!target) return;
      for (const detail of target.querySelectorAll("details")) detail.open = true;
      this.element.dispatchEvent(new CustomEvent("agent:turn-reveal", { bubbles: true, detail: { target } }));
    }
  };
}
