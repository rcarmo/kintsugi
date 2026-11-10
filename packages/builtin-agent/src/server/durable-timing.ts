import type { Context } from "@earendil-works/chord/context";
import { defineEntry, defineExtension, GenerationTask, hook, type ConversationId, type TypedEntryDraft } from "@earendil-works/pi-durable";
import type { TurnTimingSummary } from "@kintsugi/agent/server/turn-timing";

/** Bookkeeping entries have no model payload, and travel with native branch history. */
type Measurement = { phase: "inference-start" | "tools-end"; at: number } | {
  phase: "inference-end";
  at: number;
  outputTokens: number;
  usageComplete: boolean;
  tools?: boolean;
};
export const durableTimingEntry = defineEntry<Measurement>("kintsugi.timing");
export type WriteDurableTiming = (conversationId: ConversationId, entry: TypedEntryDraft<Measurement>, context: Context) => Promise<void>;

export function durableTiming(write: WriteDurableTiming, now = Date.now) {
  return defineExtension({ name: "kintsugi.timing", hooks: [hook(GenerationTask, {
    async beforeRequest(_request, api, context) {
      await write(api.conversationId, { data: { phase: "inference-start", at: now() } }, context);
    },
    async afterResponse(message, api, context) {
      await write(api.conversationId, { data: {
        phase: "inference-end", at: now(), outputTokens: message.usage.output,
        usageComplete: message.stopReason !== "error" && message.stopReason !== "aborted",
        tools: message.stopReason === "toolUse" && message.content.some(part => part.type === "toolCall"),
      } }, context);
    },
    async afterTools(_assistant, _results, api, context) {
      await write(api.conversationId, { data: { phase: "tools-end", at: now() } }, context);
    },
  })] });
}

/** A turn's sequential inference and tool-round intervals, not summed tool-call durations. */
export class DurableTurnTiming {
  startedAt?: number;
  endedAt?: number;
  private inferenceStart?: number;
  private toolsStart?: number;
  private inferenceMs = 0;
  private toolMs = 0;
  private outputTokens = 0;
  private usageComplete = true;

  add(event: Measurement) {
    this.startedAt ??= event.at;
    this.endedAt = event.at;
    if (event.phase === "inference-start") {
      // A repeated start after recovery has no terminal usage for the interrupted request.
      if (this.inferenceStart !== undefined) this.usageComplete = false;
      this.inferenceStart = event.at;
    } else if (event.phase === "inference-end") {
      if (this.inferenceStart === undefined) this.usageComplete = false;
      else this.inferenceMs += Math.max(0, event.at - this.inferenceStart);
      this.inferenceStart = undefined;
      this.outputTokens += event.outputTokens;
      this.usageComplete &&= event.usageComplete;
      if (event.tools) this.toolsStart = event.at;
    } else {
      if (this.toolsStart !== undefined) this.toolMs += Math.max(0, event.at - this.toolsStart);
      this.toolsStart = undefined;
    }
  }

  /** Stop ends the turn at `at`, closing a request or tool round it cut off. */
  stop(at: number) {
    if (this.inferenceStart !== undefined) {
      this.inferenceMs += Math.max(0, at - this.inferenceStart);
      this.usageComplete = false;
    }
    if (this.toolsStart !== undefined) this.toolMs += Math.max(0, at - this.toolsStart);
    this.inferenceStart = undefined;
    this.toolsStart = undefined;
    this.startedAt ??= at;
    this.endedAt = at;
  }

  summary(): TurnTimingSummary | undefined {
    if (this.startedAt === undefined || this.endedAt === undefined || this.inferenceStart !== undefined || this.toolsStart !== undefined) return;
    return { elapsedMs: Math.max(0, this.endedAt - this.startedAt), inferenceMs: this.inferenceMs, toolMs: this.toolMs, outputTokens: this.outputTokens, usageComplete: this.usageComplete };
  }
}
