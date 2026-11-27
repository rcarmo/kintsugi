import { CableTopics, type CableSubscription, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";

export function createSubagentsController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static targets = ["branch", "panel", "status", "cleared"];
    static values = { workspaceId: String, agentId: String };
    declare readonly element: HTMLElement;
    declare readonly branchTargets: HTMLDetailsElement[];
    declare readonly workspaceIdValue: string;
    declare readonly agentIdValue: string;
    declare readonly panelTarget: HTMLDetailsElement;
    declare readonly clearedTargets: HTMLDetailsElement[];
    private clearedOpen = false;
    private tree?: CableSubscription;
    private children = new Map<string, { branch: HTMLDetailsElement; subscription: CableSubscription }>();
    private expanded = new Set<string>();
    private reveal?: string;
    private message?: string;

    connect(): void {
      const params = new URL(location.href).searchParams;
      this.reveal = params.get("agent") === this.agentIdValue ? params.get("subagent") ?? undefined : undefined;
      this.message = params.get("message") ?? undefined;
      this.sync();
    }
    disconnect(): void { this.stop(); }
    private stop(): void {
      this.tree?.unsubscribe();
      this.tree = undefined;
      this.stopChildren();
    }
    private stopChildren(): void {
      for (const child of this.children.values()) child.subscription.unsubscribe();
      this.children.clear();
    }
    sync(): void {
      // The control is hidden when empty, but its pane must still listen for new subagents.
      if (document.hidden || !this.element.parentElement!.checkVisibility()) { this.stop(); return; }
      if (!this.tree) {
        this.tree = window.KintsugiCable!.subscribe(CableTopics.module("subagents", this.workspaceIdValue, { agentId: this.agentIdValue }), {
          onReady: () => this.restore(),
          onDisconnected: () => this.stopChildren(),
        });
      }
    }
    statusTargetConnected(status: HTMLElement): void {
      const empty = Number(status.dataset.subagentCount) === 0;
      this.panelTarget.hidden = empty;
      if (empty) this.panelTarget.open = false;
      else if (this.tree) this.restore();
    }
    private restore(): void {
      if (this.reveal && !this.panelTarget.hidden) {
        this.panelTarget.open = true;
        let branch = this.branchTargets.find((branch) => branch.dataset.subagentId === this.reveal);
        const cleared = branch?.closest<HTMLDetailsElement>("details[data-subagents-cleared]");
        if (cleared) this.clearedOpen = true;
        while (branch) {
          this.expanded.add(branch.dataset.subagentId!);
          branch = branch.parentElement!.closest<HTMLDetailsElement>("details[data-subagent-id]") ?? undefined;
        }
      }
      for (const section of this.clearedTargets) section.open = this.clearedOpen;
      for (const branch of this.branchTargets) branch.open = this.expanded.has(branch.dataset.subagentId!);
      this.syncChildren();
    }
    clearedTargetConnected(): void { if (this.tree) this.restore(); }
    branchTargetConnected(): void { if (this.tree) this.restore(); }
    branchTargetDisconnected(branch: HTMLDetailsElement): void {
      const id = branch.dataset.subagentId!;
      const child = this.children.get(id);
      if (child?.branch === branch) { child.subscription.unsubscribe(); this.children.delete(id); }
    }
    private syncChildren(): void {
      for (const branch of this.branchTargets) {
        const id = branch.dataset.subagentId!;
        const visible = this.tree && this.panelTarget.open && branch.open && !branch.parentElement!.closest("details:is([data-subagent-id], [data-subagents-cleared]):not([open])");
        const child = this.children.get(id);
        if (!visible) { child?.subscription.unsubscribe(); this.children.delete(id); continue; }
        if (child?.branch === branch) continue;
        child?.subscription.unsubscribe();
        const subscription = window.KintsugiCable!.subscribe(CableTopics.agent(this.workspaceIdValue, id), {
          onReady: () => {
            if (this.reveal === id && this.message) void this.revealMessage(branch, id, this.message);
            else this.loaded();
          },
        });
        this.children.set(id, { branch, subscription });
      }
    }
    private async revealMessage(branch: HTMLDetailsElement, id: string, message: string): Promise<void> {
      const response = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agents/${encodeURIComponent(id)}/reveal/${encodeURIComponent(message)}`);
      if (!response.ok) throw new Error(`Could not resolve transcript target: ${response.status}`);
      const { turnId } = Value.Parse(Type.Object({ turnId: Type.Union([Type.String(), Type.Null()]) }), await response.json());
      if (!branch.isConnected || this.reveal !== id) return;
      if (turnId !== null) {
        const turn = branch.querySelector<HTMLDetailsElement>(`[data-agent-turn-turn-id-value="${CSS.escape(turnId)}"]`);
        if (turn) { turn.dataset.agentTurnRevealValue = message; turn.open = true; }
      }
      this.loaded();
    }
    toggle(event: Event): void {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      if (details === this.panelTarget) { this.syncChildren(); return; }
      if (details.hasAttribute("data-subagents-cleared")) { this.clearedOpen = details.open; this.syncChildren(); return; }
      if (!details.dataset.subagentId) return;
      if (details.open) this.expanded.add(details.dataset.subagentId);
      else this.expanded.delete(details.dataset.subagentId);
      this.syncChildren();
    }
    loaded(): void {
      if (!this.reveal || this.panelTarget.hidden) return;
      const branch = this.branchTargets.find((branch) => branch.dataset.subagentId === this.reveal);
      if (!branch) return;
      const target = this.message ? branch.querySelector<HTMLElement>(`[data-transcript-anchor="${CSS.escape(this.message)}"], [data-transcript-key="${CSS.escape(this.message)}"]`) : branch;
      if (target) {
        if (target instanceof HTMLDetailsElement) target.open = true;
        target.scrollIntoView({ block: "center" });
        this.reveal = undefined;
      }
    }
  };
}
