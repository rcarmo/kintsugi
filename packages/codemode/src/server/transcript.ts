import type { ConversationView } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentTranscriptSnapshot } from "@kintsugi/agent/server/transcript-contributions";
import { toolDetailsIndicateError, type ToolView } from "@kintsugi/agent/server/transcript";
import { callEndDetails, codemodeCallEntry, type CallEnd, type CallStart } from "./extension.ts";
import { oneShotAgentEntry } from "./one-shot-agent.ts";
import { codemodeScriptFileEntry } from "./script-file.ts";

/** What a one-shot agent used, in its call's details once it has finished. */
const usageDetailsSchema = Type.Object({ usage: Type.Object({ outputTokens: Type.Number(), cost: Type.Number() }) });

/** Each script's calls, from their records, the one-shot agents its calls ran, and the script files scripts ran. */
export function codemodeTranscript(view: Pick<ConversationView, "entries">): Partial<AgentTranscriptSnapshot> {
  // Each script's calls by key, in the order they started. A rerun after a restart records
  // them again: the first start and the last end count.
  const scripts = new Map<string, Map<string, { start?: CallStart; end?: CallEnd }>>();
  // The one-shot agent each call ran, by the call's ID.
  const childAgents = new Map<string, string>();
  const scriptFiles: NonNullable<AgentTranscriptSnapshot["scriptFiles"]> = [];
  for (const entry of view.entries) {
    if (codemodeScriptFileEntry.is(entry)) {
      const { callId, ...file } = entry.data;
      scriptFiles.push({ toolCallId: callId, file });
    }
    if (oneShotAgentEntry.is(entry)) childAgents.set(entry.data.callId, entry.data.agentId);
    if (!codemodeCallEntry.is(entry)) continue;
    const record = entry.data;
    const calls = scripts.get(record.callId) ?? new Map<string, { start?: CallStart; end?: CallEnd }>();
    scripts.set(record.callId, calls);
    const call = calls.get(record.key) ?? {};
    calls.set(record.key, call);
    if (record.phase === "start") call.start ??= record;
    else call.end = record;
  }
  const nested = [...scripts].map(([toolCallId, calls]) => ({ toolCallId, calls: [...calls].flatMap(([key, { start, end }]): ToolView[] => {
    if (!start) return [];
    const callId = `${toolCallId}/${key}`;
    const call: ToolView = { callId, name: start.name, args: start.arguments, status: "running", issuedAt: start.issuedAt };
    const childAgentId = childAgents.get(callId);
    if (childAgentId) call.childAgentId = childAgentId;
    if (end) {
      const details = callEndDetails(end);
      call.status = end.isError || toolDetailsIndicateError(details) ? "error" : "ok";
      call.durationMs = end.durationMs;
      call.resultText = end.output ?? end.error;
      call.details = details;
      if (Value.Check(usageDetailsSchema, end.details)) call.usage = { outputTokens: end.details.usage.outputTokens, cost: end.details.usage.cost };
    }
    return [call];
  }) }));
  return { nested, scriptFiles };
}
