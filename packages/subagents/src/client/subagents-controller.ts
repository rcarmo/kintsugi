import { CableTopics, selectedWorkspaceAgent, type CableSubscription, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";

export function createSubagentsController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static targets = ["branch", "cleared", "content"];
    static values = { workspaceId: String };
    declare readonly element: HTMLElement;
    declare readonly branchTargets: HTMLDetailsElement[];
    declare readonly workspaceIdValue: string;
    declare readonly contentTarget: HTMLElement;
    private agentId = "";
    declare readonly clearedTargets: HTMLDetailsElement[];
    private clearedOpen = false;
    private tree?: CableSubscription;
    private children = new Map<string, { branch: HTMLDetailsElement; subscription: CableSubscription }>();
    private expanded = new Set<string>();
    private reveal?: string;
    private message?: string;

    connect(): void { this.sync(); }
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
    private empty(text: string): void {
      const message = document.createElement("p");
      message.className = "subagents-empty";
      message.textContent = text;
      this.contentTarget.replaceChildren(message);
    }
    sync(): void {
      const selected = selectedWorkspaceAgent(this.element) ?? "";
      if (selected !== this.agentId) {
        this.stop();
        this.agentId = selected;
        this.expanded.clear();
        this.clearedOpen = false;
        const params = new URL(location.href).searchParams;
        this.reveal = params.get("agent") === selected ? params.get("subagent") ?? undefined : undefined;
        this.message = this.reveal ? params.get("message") ?? undefined : undefined;
        this.contentTarget.id = selected ? `subagents-content-${this.workspaceIdValue}-${selected}` : "";
        this.empty(selected ? "Loading subagents…" : "Select a Builtin Agent to view its subagents.");
      }
      if (!selected || document.hidden || !this.element.checkVisibility()) { this.stop(); return; }
      if (!this.tree) {
        this.tree = window.KintsugiCable!.subscribe(CableTopics.module("subagents", this.workspaceIdValue, { agentId: selected }), {
          onReady: () => { if (this.agentId === selected) this.restore(); },
          onDisconnected: () => { if (this.agentId === selected) this.stopChildren(); },
          onRejected: () => { if (this.agentId === selected) this.empty("Subagents aren’t available for this Agent."); },
        });
      }
    }
    private restore(): void {
      if (this.reveal) {
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
        const visible = this.tree && branch.open && !branch.parentElement!.closest("details:is([data-subagent-id], [data-subagents-cleared]):not([open])");
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
      if (details.hasAttribute("data-subagents-cleared")) { this.clearedOpen = details.open; this.syncChildren(); return; }
      if (!details.dataset.subagentId) return;
      if (details.open) this.expanded.add(details.dataset.subagentId);
      else this.expanded.delete(details.dataset.subagentId);
      this.syncChildren();
    }
    loaded(): void {
      if (!this.reveal) return;
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
