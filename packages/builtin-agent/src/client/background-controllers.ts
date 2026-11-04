import { CableTopics, isWorkspacePaneVisible, type CableSubscription, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Keeps the Agent's Background bar current while its pane shows. */
export function createBackgroundController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static values = { workspaceId: String, agentId: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly agentIdValue: string;
    private subscription?: CableSubscription;

    connect(): void { this.sync(); }
    disconnect(): void { this.stop(); }
    sync(): void {
      // The presentation's state, not checkVisibility: that would force a layout as panes connect and show.
      if (document.hidden || !isWorkspacePaneVisible(this.element)) { this.stop(); return; }
      this.subscription ??= window.KintsugiCable!.subscribe(CableTopics.module("agent-background", this.workspaceIdValue, { agentId: this.agentIdValue }), {});
    }
    private stop(): void {
      this.subscription?.unsubscribe();
      this.subscription = undefined;
    }
  };
}

/** A message a link revealed on a child agent's page; reopening the page doesn't reveal it again. */
const revealedMessages = new Set<string>();

/** A child agent's page follows its live transcript while it shows, and reveals what links into that transcript point at. */
export function createChildTranscriptController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static values = { workspaceId: String, agentId: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly agentIdValue: string;
    private subscription?: CableSubscription;

    connect(): void { this.sync(); }
    disconnect(): void { this.stop(); }
    sync(): void {
      if (document.hidden || !this.element.checkVisibility()) { this.stop(); return; }
      this.subscription ??= window.KintsugiCable!.subscribe(CableTopics.agent(this.workspaceIdValue, this.agentIdValue), { onReady: () => this.revealFromUrl() });
    }
    private stop(): void {
      this.subscription?.unsubscribe();
      this.subscription = undefined;
    }
    /** A link to this page naming a message, such as one finding a message's recipient. */
    private revealFromUrl(): void {
      const params = new URL(location.href).searchParams;
      const message = params.get("background") === this.agentIdValue ? params.get("message") : null;
      if (!message || revealedMessages.has(`${this.agentIdValue}:${message}`)) return;
      revealedMessages.add(`${this.agentIdValue}:${message}`);
      void this.reveal(message);
    }
    /** A link into this child's own transcript, such as "Started by" on a message from work it started. */
    follow(event: Event): void {
      const link = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action~="agent-pane#reveal"]') : null;
      if (link?.dataset.agentPaneAgentParam !== this.agentIdValue) return;
      event.preventDefault();
      void this.reveal(link.dataset.agentPaneItemParam!);
    }

    private async reveal(target: string): Promise<void> {
      const response = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agents/${encodeURIComponent(this.agentIdValue)}/reveal/${encodeURIComponent(target)}`);
      if (!response.ok) throw new Error(`Could not resolve transcript target: ${response.status}`);
      const { turnId } = Value.Parse(Type.Object({ turnId: Type.Union([Type.String(), Type.Null()]) }), await response.json());
      // A finished turn loads its items when opened, then shows the target.
      const turn = turnId === null ? null : this.element.querySelector<HTMLDetailsElement>(`[data-agent-turn-turn-id-value="${CSS.escape(turnId)}"]`);
      if (turn) { turn.dataset.agentTurnRevealValue = target; turn.open = true; return; }
      const value = CSS.escape(target);
      this.element.querySelector(`[data-transcript-anchor="${value}"], [data-transcript-key="${value}"], [data-tool-call-id="${value}"]`)?.scrollIntoView({ block: "center" });
    }
  };
}
