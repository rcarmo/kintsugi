import { CableTopics, type CableSubscription, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";

export function createSubagentsController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static targets = ["tree", "branch", "cleared"];
    static values = { workspaceId: String };
    declare readonly element: HTMLElement;
    declare readonly branchTargets: HTMLDetailsElement[];
    declare readonly workspaceIdValue: string;
    declare readonly clearedTargets: HTMLDetailsElement[];
    declare readonly hasTreeTarget: boolean;
    private connected = false;
    private clearedOpen = new Set<string>();
    private tree?: CableSubscription;
    private children = new Map<string, { branch: HTMLDetailsElement; subscription: CableSubscription }>();
    private expanded = new Set<string>();
    private reveal?: string;
    private message?: string;

    connect(): void {
      this.connected = true;
      const params = new URL(location.href).searchParams;
      this.reveal = params.get("subagent") ?? undefined;
      this.message = this.reveal ? params.get("message") ?? undefined : undefined;
      this.sync();
    }
    disconnect(): void { this.connected = false; this.stop(); }
    treeTargetConnected(): void { if (this.connected) this.sync(); }
    treeTargetDisconnected(): void { if (this.connected) this.sync(); }
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
      if (!this.hasTreeTarget || document.hidden || !this.element.checkVisibility()) { this.stop(); return; }
      if (!this.tree) {
        this.tree = window.KintsugiCable!.subscribe(CableTopics.module("subagents", this.workspaceIdValue, {}), {
          onReady: () => this.restore(),
          onDisconnected: () => this.stopChildren(),
        });
      }
    }
    private restore(): void {
      if (this.reveal) {
        let branch = this.branchTargets.find((branch) => branch.dataset.subagentId === this.reveal);
        const cleared = branch?.closest<HTMLDetailsElement>("details[data-subagents-cleared]");
        if (cleared) this.clearedOpen.add(cleared.id);
        while (branch) {
          this.expanded.add(branch.dataset.subagentId!);
          branch = branch.parentElement!.closest<HTMLDetailsElement>("details[data-subagent-id]") ?? undefined;
        }
      }
      for (const section of this.clearedTargets) section.open = this.clearedOpen.has(section.id);
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
      if (details.hasAttribute("data-subagents-cleared")) {
        if (details.open) this.clearedOpen.add(details.id);
        else this.clearedOpen.delete(details.id);
        this.syncChildren();
        return;
      }
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
