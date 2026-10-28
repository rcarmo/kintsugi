import type { AgentRenderContext } from "./render-context.ts";
/** Renderer-friendly transcript model for the pi-backed runtime. */

import type { TurnTimingSummary } from "./turn-timing.ts";
import { Type, type Static } from "typebox";
import type { StopReason } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { isJsonObject, type JsonValue } from "@kintsugi/core";

export interface SessionImageRef {
  entryId: string;
  contentIndex: number;
  mimeType?: string;
  width?: number;
  height?: number;
}

type AssistantPart =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string; textSignature?: string }
  | { type: "toolCall"; callId: string; name: string; args: unknown };

type AssistantTextPhase = "commentary" | "final_answer";

function assistantTextPhase(textSignature?: string): AssistantTextPhase | undefined {
  if (!textSignature?.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(textSignature);
    if (!isJsonObject(parsed) || parsed.v !== 1) return undefined;
    return parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined;
  } catch {
    return undefined;
  }
}

export type TranscriptRecord =
  | { kind: "runStart"; turnEntryId: string; startedAt: number; timestamp: number }
  | { kind: "timing"; timing: TurnTimingSummary; turnEntryId?: string; outcome?: "completed" | "stopped"; timestamp: number }
  | { kind: "taskStart"; id: string; timestamp: number }
  | { kind: "user"; id: string; text: string; images: SessionImageRef[]; timestamp: number; rewindable?: boolean }
  | { kind: "assistant"; id: string; parts: AssistantPart[]; stopReason: StopReason; partial?: boolean; errorMessage?: string; timestamp: number }
  | { kind: "toolResult"; callId: string; text: string; images: SessionImageRef[]; isError: boolean; timestamp: number; details?: ToolViewDetails }
  | { kind: "note"; id?: string; text: string; tone: NoteTone; timestamp?: number };

// Shared by live completion and persisted transcript reconstruction.
function assistantErrorText(message: { stopReason: string; errorMessage?: string }): string | undefined {
  return message.errorMessage || (message.stopReason === "aborted" ? "Run aborted" : message.stopReason === "error" ? "Provider request failed" : undefined);
}

type NoteTone = "system" | "summary" | "warning" | "error";

const toolViewDetailsSchema = Type.Object({
  aborted: Type.Optional(Type.Boolean()),
  timedOut: Type.Optional(Type.Boolean()),
  exitCode: Type.Optional(Type.Number()),
  patch: Type.Optional(Type.String()),
  displayAnsi: Type.Optional(Type.String()),
  terminalProcessId: Type.Optional(Type.String()),
  workspaceId: Type.Optional(Type.String()),
});

const toolViewDetailsValidator = Compile(toolViewDetailsSchema);

export type ToolViewDetails = Static<typeof toolViewDetailsSchema> & { [key: string]: JsonValue | undefined };

export function isToolViewDetails(value: unknown): value is ToolViewDetails {
  if (!toolViewDetailsValidator.Check(value)) return false;
  const definedEntries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return isJsonObject(Object.fromEntries(definedEntries));
}

/** A script file as a code mode call ran it: its contents when the call started. */
export type ScriptFileView = { path: string; sha256: string; code: string };

export interface ToolView {
  callId: string;
  name: string;
  args: unknown;
  status: "streaming" | "running" | "ok" | "error";
  resultText?: string;
  resultImages?: SessionImageRef[];
  /** The terminal process a running bash call can be watched in. */
  terminalProcessId?: string;
  canAbort?: boolean;
  durationMs?: number;
  details?: ToolViewDetails;
  /** Timestamp of the assistant entry that issued this call. */
  issuedAt?: number;
  /** Calls this tool made to other tools, such as a code mode script's. */
  nested?: ToolView[];
  /** The script file a code mode call ran, as it was when the call started. */
  scriptFile?: ScriptFileView;
  /** A finished call whose result was not kept, so only its arguments and error can show. */
  resultUnavailable?: boolean;
  /** The child agent this call runs, such as a script's one-shot agent, whose conversation opens from its row. */
  childAgentId?: string;
  /** Inference this call ran beyond the Agent's own, such as a one-shot agent's, once it has finished. */
  usage?: { outputTokens: number; cost: number };
}

interface TranscriptItemBase {
  timestamp?: number;
  anchor?: string;
  key: string;
  /** Rewind to immediately before this persisted session entry. */
  rewindEntryId?: string;
}

export type WorkingTranscriptItem = TranscriptItemBase & {
  type: "working";
  /** The user entries, read together, whose activity this block shows. */
  inputEntryIds?: string[];
  startedAt: number;
  completedAt?: number;
  hasFinalAnswer?: boolean;
  stoppedAt?: number;
  timing?: TurnTimingSummary;
  /** Native message timestamps do not measure execution duration. */
  durationUnavailable?: boolean;
  live?: boolean;
  items: TranscriptItem[];
};

/** Input waiting in the inbox. `stranded` when no run will pick it up, as after a turn that ended in an error. */
export type QueuedInput = { submissionId: string; mode: "steer" | "followUp"; stranded: boolean };

export type TranscriptItem =
  | (TranscriptItemBase & { type: "extension"; render(ctx: AgentRenderContext): string })
  | (TranscriptItemBase & { type: "user"; text: string; images: SessionImageRef[]; queued?: QueuedInput })
  | (TranscriptItemBase & { type: "inherited-context"; source: string; messageCount: number; items: TranscriptItem[] })
  | WorkingTranscriptItem
  | (TranscriptItemBase & { type: "thinking"; text: string; live?: boolean })
  | (TranscriptItemBase & { type: "text"; text: string; final: boolean; live?: boolean })
  | (TranscriptItemBase & { type: "tool"; tool: ToolView })
  | (TranscriptItemBase & { type: "note"; text: string; tone: NoteTone })
  | (TranscriptItemBase & { type: "error"; text: string });

export function findTranscriptItem(items: TranscriptItem[], key: string): TranscriptItem | undefined {
  for (const item of items) {
    if (item.key === key) return item;
    if (item.type === "working" || item.type === "inherited-context") {
      const nested = findTranscriptItem(item.items, key);
      if (nested) return nested;
    }
  }
  return undefined;
}

function isFinalAssistantStopReason(reason: StopReason): boolean {
  return reason === "stop" || reason === "length" || reason === "deferred";
}

type AssistantContentPart = { type: string; text?: string; textSignature?: string };

/** Select final-answer content once for both streaming promotion and persisted history. */
export function finalAssistantTextIndexes(parts: ReadonlyArray<AssistantContentPart>): number[] {
  const phased = parts.some((part) => part.type === "text" && assistantTextPhase(part.textSignature) !== undefined);
  return parts.flatMap((part, index) => part.type === "text"
    && (!phased || assistantTextPhase(part.textSignature) === "final_answer") ? [index] : []);
}

export function isFinalAssistantMessage(parts: ReadonlyArray<AssistantContentPart>, stopReason: StopReason): boolean {
  return isFinalAssistantStopReason(stopReason)
    && !parts.some((part) => part.type === "toolCall")
    && finalAssistantTextIndexes(parts).some((index) => Boolean(parts[index]!.text?.trim()));
}

export function finalAssistantText(parts: ReadonlyArray<AssistantContentPart>): string {
  return finalAssistantTextIndexes(parts).map((index) => parts[index]!.text ?? "").join("");
}

/** A JSON answer's source: models may fence it as a code block. */
export function unfencedJson(text: string): string {
  return /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text)?.[1] ?? text;
}

/**
 * Every user input the Agent reads starts a new block, including steering mid-run; inputs read
 * together share one. Run markers make only the run's end, not an answer, finish the block.
 */
export function buildTranscript(records: TranscriptRecord[], options: { openEnded?: boolean } = {}): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, ToolView>();
  const runStarts = new Set(records.filter((record) => record.kind === "runStart").map((record) => record.turnEntryId));
  let working: WorkingTranscriptItem | undefined;
  let runScoped = false;
  let lastTimestamp = 0;
  let previousKind: TranscriptRecord["kind"] | undefined;

  const appendActivity = (item: TranscriptItem, timestamp: number): void => {
    item.timestamp = timestamp;
    (working?.items ?? items).push(item);
  };
  const stopWorking = (timestamp: number): void => {
    if (working && working.completedAt === undefined) working.stoppedAt = Math.max(working.startedAt, timestamp);
    working = undefined;
    runScoped = false;
  };

  for (const [recordIndex, record] of records.entries()) {
    lastTimestamp = record.timestamp ?? lastTimestamp;
    const follows = previousKind;
    if (record.kind !== "runStart") previousKind = record.kind;
    if (record.kind === "runStart") {
      if (working?.key === `${record.turnEntryId}:working`) {
        working.startedAt = record.startedAt;
        runScoped = true;
      }
      continue;
    }
    if (record.kind === "timing") {
      const target = items.findLast((item) => item.type === "working"
        && (record.turnEntryId === undefined || item.key === `${record.turnEntryId}:working`));
      if (target?.type === "working") {
        target.timing = record.timing;
        const endedAt = target.startedAt + record.timing.elapsedMs;
        if (record.outcome === "stopped" || (record.outcome === undefined && target.stoppedAt !== undefined)) {
          target.stoppedAt = endedAt;
          target.completedAt = undefined;
        } else {
          target.completedAt = endedAt;
          target.stoppedAt = undefined;
        }
        if (working === target) { working = undefined; runScoped = false; }
      }
      continue;
    }
    if (record.kind === "user" || record.kind === "taskStart") {
      const user: TranscriptItem | undefined = record.kind === "user" ? {
        type: "user",
        timestamp: record.timestamp,
        key: record.id,
        rewindEntryId: record.rewindable === false ? undefined : record.id,
        text: record.text,
        images: record.images,
      } : undefined;
      // Input read together with the previous one, before any activity, joins its block.
      if (user && working && follows === "user" && !runStarts.has(record.id)) {
        items.splice(items.length - 1, 0, user);
        working.inputEntryIds!.push(record.id);
        continue;
      }
      if (user) items.push(user);
      // A new run cuts the old one short. Steering continues the run in a new block; the block it interrupted has done its work.
      if (working) {
        if (runScoped && runStarts.has(record.id)) working.stoppedAt = Math.max(working.startedAt, record.timestamp);
        else working.completedAt = Math.max(working.startedAt, record.timestamp);
      }
      runScoped &&= !runStarts.has(record.id);
      working = { type: "working", timestamp: record.timestamp, key: `${record.id}:working`, inputEntryIds: [record.id], startedAt: record.timestamp, items: [] };
      items.push(working);
      continue;
    }

    if (record.kind === "assistant") {
      const final = isFinalAssistantMessage(record.parts, record.stopReason);
      // Pi can announce a final answer while it is still streaming. Placement
      // follows that signal; only a committed message may finish the turn.
      const finalIndexes = new Set(final ? finalAssistantTextIndexes(record.parts) : []);
      let first = true;
      record.parts.forEach((part, index) => {
        const rewindEntryId = first ? record.id : undefined;
        if (part.type === "thinking" && part.text.trim()) {
          appendActivity({ type: "thinking", key: `${record.id}:thinking:${index}`, rewindEntryId, text: part.text }, record.timestamp);
          first = false;
        } else if (part.type === "text" && part.text.trim()) {
          const finalPart = finalIndexes.has(index);
          const item: TranscriptItem = { type: "text", timestamp: record.timestamp, key: `${record.id}:text:${index}`, rewindEntryId, text: part.text, final: finalPart };
          if (finalPart) items.push(item);
          else appendActivity(item, record.timestamp);
          first = false;
        } else if (part.type === "toolCall") {
          const tool: ToolView = { callId: part.callId, name: part.name, args: part.args, status: "ok", issuedAt: record.timestamp };
          tools.set(part.callId, tool);
          appendActivity({ type: "tool", key: `tool:${part.callId}`, rewindEntryId, tool }, record.timestamp);
          first = false;
        }
      });
      if (final && !record.partial) {
        if (working) working.hasFinalAnswer = true;
        if (!runScoped) {
          if (working) working.completedAt = Math.max(working.startedAt, record.timestamp);
          working = undefined;
        }
      } else if (!record.partial) {
        const errorText = assistantErrorText(record);
        const nextBoundary = record.stopReason === "error"
          ? records.slice(recordIndex + 1).find((next) =>
            next.kind === "assistant" || next.kind === "timing" || next.kind === "runStart"
            || (!runScoped && (next.kind === "user" || next.kind === "taskStart")))
          : undefined;
        const retry = record.stopReason === "error" && nextBoundary?.kind === "assistant";
        // An aborted attempt that the same run continues without new input was
        // interrupted by a host restart, not stopped by the user: durable recovery
        // already re-issued it. Keep the turn open and mark the seam in the activity.
        const interruptedRun = record.stopReason === "aborted" && !record.errorMessage
          && records.slice(recordIndex + 1).find((next) =>
            next.kind === "assistant" || next.kind === "runStart"
            || ((next.kind === "user" || next.kind === "taskStart") && (!runScoped || runStarts.has(next.id))))?.kind === "assistant";
        if (interruptedRun) {
          appendActivity({ type: "note", key: `${record.id}:interrupted`, text: "Interrupted by a restart — continued automatically", tone: "system" }, record.timestamp);
        } else if (errorText) {
          const error: TranscriptItem = { type: "error", key: `${record.id}:${record.stopReason === "aborted" && !record.errorMessage ? "aborted" : "error"}`, text: errorText, timestamp: record.timestamp };
          if (retry) appendActivity(error, record.timestamp);
          else items.push(error);
        }
        if (!retry && !interruptedRun && (record.stopReason === "error" || record.stopReason === "aborted")) stopWorking(record.timestamp);
      }
      continue;
    }

    if (record.kind === "toolResult") {
      const tool = tools.get(record.callId);
      if (tool) {
        tool.resultText = record.text;
        if (record.images.length) tool.resultImages = record.images;
        tool.details = record.details;
        tool.status = record.isError || toolDetailsIndicateError(record.details) ? "error" : "ok";
        if (tool.issuedAt && record.timestamp) tool.durationMs = Math.max(0, record.timestamp - tool.issuedAt);
      }
      continue;
    }

    items.push({
      type: "note",
      timestamp: lastTimestamp,
      key: record.id ?? `note:${recordIndex}`,
      rewindEntryId: record.id,
      text: record.text,
      tone: record.tone,
    });
  }
  if (!options.openEnded) stopWorking(lastTimestamp);
  return items;
}

/** How a finished tool call ended, in a word or two, or "" when it succeeded. */
export function toolOutcomeLabel(details: ToolViewDetails | undefined, isError: boolean): string {
  if (details?.timedOut === true) return "timed out";
  if (details?.aborted === true) return "aborted";
  if (details?.exitCode !== undefined && details.exitCode !== 0) return `exitcode ${details.exitCode}`;
  return isError ? "failed" : "";
}

export function toolDetailsIndicateError(details: ToolViewDetails | undefined): boolean {
  return details?.aborted === true || details?.timedOut === true || (details?.exitCode !== undefined && details.exitCode !== 0);
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(".0", "")}k`;
  return String(count);
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function formatCost(cost: number): string {
  if (cost >= 10) return `$${cost.toFixed(0)}`;
  if (cost >= 0.0995) return `$${cost.toFixed(2)}`;
  if (cost >= 0.0005) return `$${cost.toFixed(3)}`;
  return "$0.00";
}

export function isBashTool(name: string): boolean {
  return name === "bash";
}
