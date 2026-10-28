import type { TranscriptItem, ToolView, WorkingTranscriptItem } from "@kintsugi/agent/server/transcript";
import type {
  ThreadItem,
  Turn,
} from "../protocol.ts";

function status(value: string): ToolView["status"] {
  if (value === "inProgress") return "running";
  if (value === "failed" || value === "declined") return "error";
  return "ok";
}

/** Codex reports its shell invocation as a quoted command, not an argv array. */
function bashStatement(command: string): string {
  const wrapper = /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh)\s+-[il]*c\s+(['"])([\s\S]*)\1$/.exec(command);
  if (!wrapper) return command;
  const quote = wrapper[1]!;
  const script = wrapper[2]!;
  let statement = "";
  for (let index = 0; index < script.length; index++) {
    const character = script[index]!;
    if (character === quote) return command; // Not a single quoted script argument.
    if (quote === '"' && character === "\\" && index + 1 < script.length) {
      const next = script[index + 1]!;
      if ('"\\$`\n'.includes(next)) {
        if (next !== "\n") statement += next;
        index++;
        continue;
      }
    }
    statement += character;
  }
  return statement;
}

/** Codex items retain their own IDs and semantics; no Pi messages or journal entries. */
function projectCodexItem(item: ThreadItem, live: boolean): TranscriptItem {
  const key = item.id;
  switch (item.type) {
    case "userMessage": return { type: "user", key, text: item.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n"), images: item.content.flatMap((part, index) => part.type === "image" || part.type === "localImage" ? [{ entryId: item.id, contentIndex: index }] : []) };
    case "agentMessage": return { type: "text", key, text: item.text, final: item.phase === "final_answer", live };
    case "reasoning": return { type: "thinking", key, text: (item.summary.length ? item.summary : item.content).join("\n\n"), live };
    case "plan": return { type: "text", key, text: item.text, final: false, live };
    case "commandExecution": return { type: "tool", key, tool: { callId: key, name: "bash", args: { command: bashStatement(item.command) }, status: status(item.status), resultText: item.aggregatedOutput ?? "", durationMs: item.durationMs ?? undefined, details: item.exitCode === null ? undefined : { exitCode: item.exitCode } } };
    case "fileChange": return { type: "tool", key, tool: { callId: key, name: "Codex file changes", args: { paths: item.changes.map(change => change.path) }, status: status(item.status), resultText: item.changes.map(change => `${change.path}\n${change.diff}`).join("\n\n") } };
    case "mcpToolCall": return { type: "tool", key, tool: { callId: key, name: item.tool, args: item.arguments, status: status(item.status), resultText: item.error?.message ?? (item.result ? JSON.stringify(item.result.content, null, 2) : ""), durationMs: item.durationMs ?? undefined } };
    case "dynamicToolCall": return { type: "tool", key, tool: { callId: key, name: item.tool, args: item.arguments, status: item.success === false ? "error" : status(item.status), resultText: item.contentItems ? JSON.stringify(item.contentItems, null, 2) : "" } };
    case "contextCompaction": return { type: "note", key, text: "Codex compacted the conversation.", tone: "summary" };
    case "webSearch": return { type: "tool", key, tool: { callId: key, name: "Codex web search", args: { query: item.query }, status: live ? "running" : "ok", resultText: JSON.stringify(item.action, null, 2) } };
    case "collabAgentToolCall": return { type: "tool", key, tool: { callId: key, name: `Codex ${item.tool}`, args: { prompt: item.prompt, threads: item.receiverThreadIds }, status: status(item.status), resultText: JSON.stringify(item.agentsStates, null, 2) } };
    default: return { type: "note", key, text: JSON.stringify(item, null, 2), tone: "system" };
  }
}

/**
 * One block per run of input Codex read: steering it took mid-turn ends the block it interrupted and starts its own.
 * Codex's history only times whole turns, so a block steering started is timed only once `itemStarts`, from live
 * notifications, has its first item.
 * A sub-agent's own transcript has no `subagents`: its sub-agents aren't the Agent's background activities.
 */
export function projectCodexTurns(turns: readonly Turn[], completedItems: ReadonlySet<string>, itemStarts: ReadonlyMap<string, number> = new Map()): TranscriptItem[] {
  return turns.flatMap(turn => {
    const busy = turn.status === "inProgress";
    const messages = turn.items.filter(item => item.type === "agentMessage");
    const unphasedFinal = turn.status === "completed" && messages.every(message => message.phase === null) ? messages.at(-1)?.id : undefined;
    const turnStartedAt = (turn.startedAt ?? 0) * 1000;
    const turnEndedAt = turn.completedAt === null ? turnStartedAt + (turn.durationMs ?? 0) : turn.completedAt * 1000;
    const segments: { key: string; users: TranscriptItem[]; activity: TranscriptItem[]; startedAt?: number }[] = [{ key: turn.id, users: [], activity: [], startedAt: turnStartedAt }];
    const finals: TranscriptItem[] = [];
    for (const item of turn.items) {
      const projected = projectCodexItem(item, busy && !completedItems.has(item.id));
      if (projected.type === "text" && projected.key === unphasedFinal) projected.final = true;
      let segment = segments.at(-1)!;
      if (projected.type === "user" && segment.users.length && segment.activity.length) {
        segment = { key: `${turn.id}:${item.id}`, users: [], activity: [] };
        segments.push(segment);
      }
      if (projected.type === "user") segment.users.push(projected);
      else if (projected.type === "text" && projected.final) finals.push(projected);
      else { segment.activity.push(projected); segment.startedAt ??= itemStarts.get(item.id); }
    }
    const last = segments.at(-1)!;
    if (turn.error) last.activity.push({ type: "error", key: `${turn.id}:error`, text: turn.error.message });
    if (turn.status === "interrupted") last.activity.push({ type: "note", key: `${turn.id}:stopped`, text: "Stopped", tone: "system" });
    return segments.flatMap((segment, index) => {
      const next = segments[index + 1];
      const endedAt = next ? next.startedAt : turnEndedAt;
      const startedAt = segment.startedAt ?? turnStartedAt;
      const working: WorkingTranscriptItem = { type: "working", key: segment.key, startedAt, items: segment.activity, live: busy && !next,
        hasFinalAnswer: !next && finals.length > 0, durationUnavailable: segment.startedAt === undefined || endedAt === undefined ? true : undefined };
      if (next || !busy) {
        if (!next && turn.status === "interrupted") working.stoppedAt = turnEndedAt;
        else working.completedAt = endedAt ?? startedAt;
      }
      return [...segment.users, working, ...next ? [] : finals];
    });
  });
}
