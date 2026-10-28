import type {
  Turn,
  ThreadItem,
  ThreadTokenUsageUpdatedNotification,
} from "../protocol.ts";
import type { CodexNotification } from "./protocol.ts";

/** A projection of Codex's native state. Final item snapshots replace streamed deltas. */
export class CodexState {
  readonly turns: Turn[] = [];
  readonly completedItems = new Set<string>();
  /** When items started, in milliseconds. Only live notifications say; Codex's history doesn't. */
  readonly itemStarts = new Map<string, number>();
  private reviewTurnId?: string;
  private readonly reviewWorkerTurns = new Set<string>();
  usage?: ThreadTokenUsageUpdatedNotification["tokenUsage"];
  readonly notices: string[] = [];
  get activeTurn() { return this.turns.findLast(turn => turn.status === "inProgress"); }
  hydrate(turns: Turn[]) {
    this.completedItems.clear();
    this.reviewTurnId = undefined;
    this.reviewWorkerTurns.clear();
    this.turns.splice(0, this.turns.length, ...turns);
    for (const turn of turns) if (turn.status !== "inProgress") for (const item of turn.items) this.completedItems.add(item.id);
  }
  hydrateItems(turnId: string, items: ThreadItem[], completed: boolean) {
    const turn = this.turn(turnId);
    if (completed) {
      turn.items = items;
      for (const item of items) this.completedItems.add(item.id);
    } else {
      // Active text already includes deltas. Hydrate only user inputs, which the
      // server does not publish through item lifecycle notifications.
      const live = new Map(turn.items.map(item => [item.id, item]));
      const ordered: ThreadItem[] = [];
      for (const item of items) {
        const known = live.get(item.id);
        if (item.type === "userMessage") ordered.push(item);
        else if (known) ordered.push(known);
        live.delete(item.id);
      }
      turn.items = [...ordered, ...live.values()];
    }
  }
  private upsertTurn(turn: Turn) {
    const index = this.turns.findIndex(value => value.id === turn.id);
    if (index === -1) this.turns.push(turn);
    else this.turns[index] = { ...turn, items: turn.items.length ? turn.items : this.turns[index]!.items };
  }
  private turn(id: string) {
    const turn = this.turns.find(value => value.id === id);
    if (!turn) throw new Error(`Codex item references unknown turn ${id}`);
    return turn;
  }
  private item(turnId: string, itemId: string): ThreadItem {
    const item = this.turn(turnId).items.find(value => value.id === itemId);
    if (!item) throw new Error(`Codex delta references unknown item ${itemId}`);
    return item;
  }
  receive(notification: CodexNotification): void {
    switch (notification.method) {
      case "turn/started": case "turn/completed": {
        const { turn } = notification.params;
        this.upsertTurn(turn);
        // Inline review workers start their own turns in this thread, but Codex
        // closes the owning review turn rather than emitting worker completions.
        if (notification.method === "turn/started" && this.reviewTurnId && turn.id !== this.reviewTurnId) this.reviewWorkerTurns.add(turn.id);
        if (notification.method === "turn/completed" && turn.id === this.reviewTurnId) {
          for (const id of this.reviewWorkerTurns) {
            const worker = this.turn(id);
            if (worker.status !== "inProgress") continue;
            worker.status = turn.status;
            worker.completedAt = turn.completedAt;
            worker.durationMs = worker.startedAt !== null && turn.completedAt !== null ? Math.max(0, turn.completedAt - worker.startedAt) * 1000 : null;
            for (const item of worker.items) this.completedItems.add(item.id);
          }
          this.reviewTurnId = undefined;
          this.reviewWorkerTurns.clear();
        }
        if (notification.method === "turn/completed") for (const item of this.turn(turn.id).items) this.completedItems.add(item.id);
        break;
      }
      case "item/started": case "item/completed": {
        const { turnId, item } = notification.params;
        // Review mode precedes turn/started. Its turnId is canonical; the
        // review/start response instead contains an operation ID.
        if (item.type === "enteredReviewMode") {
          this.reviewTurnId = turnId;
          this.upsertTurn({ id: turnId, status: "inProgress", items: [], itemsView: "notLoaded", error: null, startedAt: null, completedAt: null, durationMs: null });
        }
        const items = this.turn(turnId).items;
        const index = items.findIndex(value => value.id === item.id);
        if (index === -1) items.push(item); else items[index] = item;
        if (notification.method === "item/started") this.itemStarts.set(item.id, notification.params.startedAtMs);
        else this.completedItems.add(item.id);
        break;
      }
      case "item/agentMessage/delta": case "item/plan/delta": {
        const { turnId, itemId, delta } = notification.params;
        const item = this.item(turnId, itemId);
        if (item.type !== "agentMessage" && item.type !== "plan") throw new Error("Unexpected Codex text delta");
        item.text += delta;
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        const { turnId, itemId, delta, summaryIndex } = notification.params;
        const item = this.item(turnId, itemId);
        if (item.type !== "reasoning") throw new Error("Unexpected Codex reasoning delta");
        item.summary[summaryIndex] = (item.summary[summaryIndex] ?? "") + delta;
        break;
      }
      case "item/commandExecution/outputDelta": {
        const { turnId, itemId, delta } = notification.params;
        const item = this.item(turnId, itemId);
        if (item.type !== "commandExecution") throw new Error("Unexpected Codex command delta");
        item.aggregatedOutput = (item.aggregatedOutput ?? "") + delta;
        break;
      }
      case "thread/tokenUsage/updated": this.usage = notification.params.tokenUsage; break;
      case "client/unsupportedRequest": this.notices.push(`Codex requested an interaction this Agent does not support yet: ${notification.params.method}`); break;
      case "error": {
        const error = notification.params;
        if (!error.willRetry) this.notices.push(error.error.message);
        break;
      }
    }
  }
}
