import { agentDelegation } from "./delegation.ts";
import { integrationTranscript } from "./integrations.ts";
import { applyTranscriptContributions } from "@kintsugi/agent/server/transcript-contributions";
import { durableTimingEntry, DurableTurnTiming } from "./durable-timing.ts";
import { durableStopEntry } from "./durable-lifecycle.ts";
import { historyNote } from "@kintsugi/legacy-converter/entries";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { AgentDoc, CompactionEntry, InboxDoc, LiveDoc, ResetEntry, ToolResultEntry, UsageDoc, type AgentState, type ConversationView, type InboxState, type LiveState, type ToolSlot, type UsageState } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isJsonObject } from "@kintsugi/core";
import { codemodeTemplateRunEndEntry } from "./durable-codemode-templates.ts";
import { buildTranscript, isFinalAssistantMessage, isToolViewDetails, toolDetailsIndicateError, type SessionImageRef, type ToolView, type TranscriptItem, type TranscriptRecord } from "@kintsugi/agent/server/transcript";

/** The native watch is an exact committed frame, not an AgentSession event stream. */
export function durableViewState(view: ConversationView) {
  // These documents are owned/versioned by the pinned Harness, not external input.
  return {
    // SAFETY: Harness owns/version-checks pi.agent before mounting this view.
    agent: (view.docs[AgentDoc.definition.kind] ?? {}) as AgentState,
    // SAFETY: Harness owns/version-checks pi.live before mounting this view.
    live: (view.docs[LiveDoc.definition.kind] ?? {}) as LiveState,
    // SAFETY: Harness owns/version-checks pi.inbox before mounting this view.
    inbox: (view.docs[InboxDoc.definition.kind] ?? { items: [] }) as InboxState,
    // SAFETY: Harness owns/version-checks pi.usage before mounting this view.
    usage: (view.docs[UsageDoc.definition.kind] ?? { models: {}, tools: {} }) as UsageState,
  };
}

const textBlockSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });

/** What a running tool published: its output and details, shown until its result replaces them. */
function applySlotProgress(tool: ToolView, slot: Pick<ToolSlot, "output" | "details">) {
  tool.resultText = slot.output;
  let details = slot.details;
  // SDK capability updates are snapshots { content, details }; native bash
  // publishes direct details. Neither should be appended as repeated output.
  if (isJsonObject(details) && Array.isArray(details.content)) {
    tool.resultText = details.content.flatMap(part => Value.Check(textBlockSchema, part) ? [part.text] : []).join("\n");
    details = details.details;
  }
  if (isToolViewDetails(details)) {
    tool.details = details;
    if (toolDetailsIndicateError(details)) tool.status = "error";
    tool.terminalProcessId = details.terminalProcessId;
  }
}

function images(content: Message["content"], entryId: string, offset = 0): SessionImageRef[] {
  return !Array.isArray(content) ? [] : content.flatMap((part, index) => part.type === "image"
    ? [{ entryId, contentIndex: offset + index, mimeType: part.mimeType }] : []);
}

/**
 * Active-context presentation only. Retained history is a separate native scan.
 * Historical turn grouping is inferred from terminal assistant messages, not a
 * persisted run ledger. Only pi.live.run is authoritative for current activity.
 */
export function projectDurableTranscript(view: ConversationView): TranscriptItem[] {
  const contribution = integrationTranscript(view);
  const inherited = contribution?.inheritedContext;
  if (inherited) {
    const index = view.entries.findIndex(entry => String(entry.id) === inherited.boundaryEntryId);
    const prefix = view.entries.slice(0, index);
    const own = projectDurableTranscript({ ...view, entries: view.entries.slice(index + 1) });
    if (!prefix.length) return own;
    return [{ type: "inherited-context", key: `inherited:${inherited.boundaryEntryId}`, source: inherited.source,
      messageCount: prefix.reduce((count, entry) => count + (entry.model?.length ?? 0), 0),
      items: projectDurableTranscript({ ...view, entries: prefix, docs: {} }),
    }, ...own];
  }
  const { live, inbox } = durableViewState(view);
  const records: TranscriptRecord[] = [];
  const completedTools = new Set<string>();
  const partialTools = new Set<string>();
  const turnEnds = new Map<string, { timestamp: number; completed: boolean }>();
  const timings = new Map<string, DurableTurnTiming>();
  let turn: string | undefined;
  let pendingBoundary = true;
  // Code mode template calls that ended their run, as recorded when they finished.
  const runEndingCalls = new Set<string>();

  function appendMessage(message: Message, key: string, imageEntryId: string, offset: number, partial = false, aborted = false) {
    if (message.role === "system") return;
    if (message.role === "user") {
      const startsRun = pendingBoundary || !turn;
      // Input read together, such as a prompt and the steering queued behind it, shares one block.
      const readTogether = records.findLast(record => record.kind !== "runStart")?.kind === "user";
      // Steering read mid-run ends the block it interrupted and starts its own, within the same run.
      if (!startsRun && !readTogether) turnEnds.set(turn!, { timestamp: message.timestamp, completed: true });
      if (startsRun || !readTogether) { turn = key; pendingBoundary = false; timings.set(key, new DurableTurnTiming()); }
      records.push({ kind: "user", id: key, text: contentText(message.content), images: images(message.content, imageEntryId, offset), timestamp: message.timestamp, rewindable: false });
      if (startsRun) records.push({ kind: "runStart", turnEntryId: key, timestamp: message.timestamp, startedAt: message.timestamp });
    } else if (message.role === "assistant") {
      records.push({ kind: "assistant", id: key, timestamp: message.timestamp,
        stopReason: message.stopReason, partial,
        errorMessage: partial ? undefined : message.errorMessage,
        parts: message.content.map(part => part.type === "toolCall"
          ? { type: "toolCall", callId: part.id, name: part.name, args: part.arguments }
          : part.type === "thinking" ? { type: "thinking", text: part.thinking }
          : { type: "text", text: part.text, textSignature: part.textSignature }),
      });
      if (partial) for (const part of message.content) if (part.type === "toolCall") partialTools.add(part.id);
      if (!partial && (isFinalAssistantMessage(message.content, message.stopReason) || message.stopReason === "error" || message.stopReason === "aborted")) {
        if (turn) turnEnds.set(turn, { timestamp: message.timestamp, completed: message.stopReason !== "error" && message.stopReason !== "aborted" });
        pendingBoundary = true;
      }
    } else {
      completedTools.add(message.toolCallId);
      let details = isToolViewDetails(message.details) ? message.details : undefined;
      if (aborted) details = isJsonObject(details) ? { ...details, aborted: true } : { aborted: true };
      records.push({ kind: "toolResult", callId: message.toolCallId, text: contentText(message.content), images: images(message.content, imageEntryId, offset), timestamp: message.timestamp, isError: message.isError, details });
      if (turn && runEndingCalls.has(message.toolCallId) && !aborted) {
        turnEnds.set(turn, { timestamp: message.timestamp, completed: true });
        pendingBoundary = true;
      }
    }
  }

  // ConversationView is already in context order: head marker first, then
  // oldest-to-newest entries. Sorting by ID would misplace compaction summaries.
  for (const entry of view.entries) {
    if (codemodeTemplateRunEndEntry.is(entry)) {
      runEndingCalls.add(entry.data.callId);
      continue;
    }
    if (durableStopEntry.is(entry)) {
      // The aborted tool results that follow still belong to this turn; the next input starts another.
      if (turn) {
        turnEnds.set(turn, { timestamp: entry.data.at, completed: false });
        timings.get(turn)!.stop(entry.data.at);
      }
      pendingBoundary = true;
      continue;
    }
    if (durableTimingEntry.is(entry)) {
      if (turn) timings.get(turn)!.add(entry.data);
      continue;
    }
    if (historyNote.is(entry)) {
      records.push({ kind: "note", id: String(entry.id), text: entry.data.text, tone: entry.data.tone });
      continue;
    }
    if (CompactionEntry.is(entry) || ResetEntry.is(entry)) {
      const text = entry.model?.map(message => contentText(message.content)).join("\n") || "New session";
      // The native compaction envelope is model-facing, not part of the summary.
      const summary = text.replace(/^The conversation history before this point was compacted into the following summary:\n\n<summary>\n([\s\S]*)\n<\/summary>$/, "$1");
      records.push({ kind: "note", id: String(entry.id), text: CompactionEntry.is(entry) ? summary : text, tone: CompactionEntry.is(entry) ? "summary" : "system" });
      pendingBoundary = true;
      continue;
    }
    const traffic = agentDelegation?.attributed(entry);
    if (traffic) {
      if (traffic === "task") {
        const timestamp = entry.model?.find(message => message.role === "user")?.timestamp ?? 0;
        turn = String(entry.id); pendingBoundary = false; timings.set(turn, new DurableTurnTiming());
        records.push({ kind: "taskStart", id: turn, timestamp });
        records.push({ kind: "runStart", turnEntryId: turn, timestamp, startedAt: timestamp });
      }
      continue;
    }
    let offset = 0;
    // Imported legacy tool results can contain only model messages, without native diagnostics.
    const aborted = ToolResultEntry.is(entry) && entry.data?.diagnostics?.some(diagnostic => diagnostic.code === "aborted") === true;
    for (const [index, message] of (entry.model ?? []).entries()) {
      appendMessage(message, index === 0 ? String(entry.id) : `${entry.id}:message:${index}`, String(entry.id), offset, false, aborted);
      offset += Array.isArray(message.content) ? message.content.length : 1;
    }
  }
  const partial = live.generation?.message;
  const partialKey = `generation:${live.run?.taskId ?? view.conversation.id}:${live.generation?.attempt ?? 0}`;
  if (partial) appendMessage(partial, partialKey, partialKey, 0, true);
  const items = buildTranscript(records, { openEnded: Boolean(live.run) });
  const slots = new Map(live.tools?.map(slot => [slot.callId, slot]));
  const nestedSlots = new Map(live.nestedTools?.map(slot => [slot.callId, slot]));

  const nestedCalls = new Map(contribution?.nested?.map(({ toolCallId, calls }) => [toolCallId, calls]));
  const scriptFiles = new Map(contribution?.scriptFiles?.map(({ toolCallId, file }) => [toolCallId, file]));

  /** The calls a tool made to other tools, as an integration recorded them, with live progress while they run. */
  function attachNestedCalls(tool: ToolView) {
    const calls = nestedCalls.get(tool.callId)?.map((recorded): ToolView => {
      if (recorded.status !== "running") return recorded;
      const nested = { ...recorded };
      if (tool.status === "running") {
        const slot = nestedSlots.get(nested.callId);
        if (slot) applySlotProgress(nested, slot);
      } else {
        // The calling tool ended, for example by being stopped, before this call returned.
        nested.status = "error";
        nested.details = { aborted: true };
        nested.resultUnavailable = true;
      }
      return nested;
    });
    if (calls?.length) tool.nested = calls;
  }

  function updateTools(tool: ToolView) {
    // Upstream tool.settle appends the result and finishSlot(done, entry.id) in
    // the same commit. Prefer that entry; done without a result is the explicit
    // scheduler fault/orphan case, not a successful empty tool response.
    if (completedTools.has(tool.callId)) return;
    const slot = slots.get(tool.callId);
    if (partialTools.has(tool.callId)) { tool.status = "streaming"; return; }
    if (!slot || slot.status === "done") {
      // An assistant tool intent is not evidence of successful execution.
      tool.status = "error";
      tool.resultText = "Tool result unavailable: this call did not complete.";
      return;
    }
    tool.status = "running";
    tool.canAbort = slot.taskId !== undefined;
    applySlotProgress(tool, slot);
  }

  function visit(list: TranscriptItem[]) {
    for (const item of list) {
      // Tree/rewind actions need native operations, never old SessionManager IDs.
      item.rewindEntryId = undefined;
      if (item.type === "tool") {
        updateTools(item.tool);
        attachNestedCalls(item.tool);
        const scriptFile = scriptFiles.get(item.tool.callId);
        if (scriptFile) item.tool.scriptFile = scriptFile;
      }
      if ((item.type === "text" || item.type === "thinking") && item.key.startsWith(`${partialKey}:`)) item.live = true;
      if (item.type === "working") {
        const measured = timings.get(item.inputEntryIds?.[0] ?? "");
        const timing = measured?.summary();
        item.durationUnavailable = measured?.startedAt === undefined;
        if (measured?.startedAt !== undefined) item.startedAt = measured.startedAt;
        if (timing) item.timing = timing;
        const end = turnEnds.get(item.inputEntryIds?.[0] ?? "");
        if (end) {
          if (end.completed) { item.completedAt = timing ? measured!.endedAt : end.timestamp; item.stoppedAt = undefined; }
          else { item.stoppedAt = timing ? measured!.endedAt : end.timestamp; item.completedAt = undefined; }
        }
        if (end && !timing) item.durationUnavailable = true;
        if (live.run && item.inputEntryIds?.includes(turn ?? "")) {
          item.live = true;
          item.completedAt = undefined;
          item.stoppedAt = undefined;
        }
        visit(item.items);
      }
    }
  }
  visit(items);
  const retry = live.generation?.retry;
  if (retry) items.push({ type: "note", key: `retry:${live.run?.taskId}`, text: `Retrying after provider error: ${retry.error}`, tone: "warning" });
  if (live.generation?.deferred) items.push({ type: "note", key: `deferred:${live.run?.taskId}`, text: "Waiting for the provider…", tone: "system" });
  for (const compaction of live.compactions ?? []) items.push({ type: "note", key: `compaction:${compaction.taskId}`, text: compaction.retry ? `Retrying compaction: ${compaction.retry.error}` : "Compacting context…", tone: compaction.retry ? "warning" : "system" });
  for (const input of inbox.items) {
    if (input.mode === "write") continue;
    const key = `queued-${input.id}`;
    items.push({ type: "user", key, text: contentText(input.content), images: images(input.content, key), queued: { submissionId: String(input.id), mode: input.mode, stranded: !live.run } });
  }
  return contribution ? applyTranscriptContributions(items, contribution) : items;
}
