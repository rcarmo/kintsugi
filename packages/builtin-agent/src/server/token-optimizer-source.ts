import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { contentText, type JsonObject, type Message } from "@earendil-works/pi-ai";
import { AssistantEntry, LiveDoc, ToolResultEntry, UserEntry, type Conversation, type Cursor, type EntryId, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import { ContextSnapshotEntry } from "../../../token-economizer/src/pi-durable/documents.ts";
import { isJsonObject } from "@kintsugi/core";
import { makeObservation, type ToolMapping } from "../../../token-economizer/src/core/observations.ts";
import { decodeArguments, decodeResult } from "../../../token-economizer/src/pi-durable/decode.ts";
import { runnerVerdict, statusOfTests } from "../../../token-economizer/src/core/loopguard/verification.ts";
import type { HostSession, Trajectory, ToolResultData } from "../../../token-economizer/src/pi-durable/domain.ts";
import type { Observation } from "../../../token-economizer/src/core/types.ts";
import { codemodeCallEntry, type CallStart } from "./codemode-call.ts";
export function nativeOptimizerTool(name:string):ToolMapping {
  if (name === "codemode") return {semantic:"wrapper",readOnly:false};
  if (name === "bash") return {semantic:"shell",readOnly:false};
  if (["edit","write"].includes(name)) return {semantic:"edit",readOnly:false};
  if (["read","view"].includes(name)) return {semantic:"read",readOnly:true};
  if (["grep","glob","search_history","code_search"].includes(name)) return {semantic:"search",readOnly:true};
  return {semantic:"other",readOnly:false};
}
/** A forward scan bounded to one optimizer session. */
type EntryRange = {order:"ascending";minEntryId?:EntryId;maxEntryId?:EntryId};
// SAFETY: Optimizer session bounds are persisted copies of committed entry IDs and are used only as scan bounds.
const entryBound = (value:number) => value as EntryId;
/** Entries after `after` (exclusive) up to `upTo` (inclusive), oldest first; never the whole history unless asked. */
export async function optimizerEntries(conversation:Conversation,bounds:{after:number;upTo:number}):Promise<EntryRecord[]> {
  const entries:EntryRecord[] = [];let cursor:Cursor|undefined;
  const query:EntryRange = {order:"ascending"};
  if (bounds.after > 0) query.minEntryId = entryBound(bounds.after);
  if (Number.isFinite(bounds.upTo)) query.maxEntryId = entryBound(bounds.upTo);
  do {const page = await conversation.entries(query,500,cursor,context);entries.push(...page.items.filter(entry => entry.id > bounds.after));cursor = page.next;} while (cursor);
  return entries;
}
/** The newest visible entry ID, without reading the transcript. */
export async function latestOptimizerEntry(conversation:Conversation):Promise<number|null> {
  return (await conversation.entries({},1,undefined,context)).items[0]?.id ?? null;
}
/** The fact IDs recorded with a carried section, searching backwards from the newest entry. */
export async function carriedSnapshotIds(conversation:Conversation,section:string):Promise<string[]> {
  let cursor:Cursor|undefined;
  do {
    const page = await conversation.entries({},200,cursor,context);
    for (const entry of page.items) if (ContextSnapshotEntry.is(entry) && entry.data.section === section) return entry.data.injectedIds;
    cursor = page.next;
  } while (cursor);
  return [];
}
export function optimizerMessageSections(messages:readonly Message[]) {
  const sections:Record<string,string> = {};
  for (const message of messages) if (message.role === "system") for (const [key,value] of Object.entries(message.sections ?? {})) {if (value === null) delete sections[key];else sections[key] = value;}
  return sections;
}
export function optimizerSections(entries:readonly EntryRecord[]) {return optimizerMessageSections(entries.flatMap(entry => [...entry.model ?? []]));}
/** Reads only the active fork's committed native source; never executes a tool or imports abandoned history. */
export async function nativeOptimizerTrajectory(harness:Harness,host:HostSession,begin:number,end:number|null,cutoff:string|null):Promise<Trajectory> {
  const conversation = await harness.conversation(host.conversationId,context);if (!conversation) return {kind:"absent",reason:"Conversation is absent"};
  let maximum = end ?? Infinity;
  if (cutoff !== null) {const value = Number(cutoff);if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid saved optimizer source cutoff");maximum = Math.min(maximum,value);}
  const entries = await optimizerEntries(conversation,{after:begin,upTo:maximum}), latest = await latestOptimizerEntry(conversation), observed:Observation[] = [];
  const calls = new Map<string,{name:string;args:JsonObject;runId:string}>(), starts = new Map<string,{start:CallStart;entry:EntryRecord}>();
  let prompts = 0, activity = 0;
  for (const entry of entries) {
    if (UserEntry.is(entry)) prompts++;
    if (AssistantEntry.is(entry)) for (const message of entry.model ?? []) if (message.role === "assistant") for (const call of message.content) if (call.type === "toolCall") calls.set(call.id,{name:call.name,args:call.arguments,runId:String(entry.byTaskId ?? "unknown")});
    function capture(name:string,args:JsonObject|null,result:ToolResultData,outer:string,nested:string|null,runId:string,at:number) {
      const mapping = nativeOptimizerTool(name);if (mapping.semantic === "wrapper") return;
      const decoded = decodeResult(result), arguments_ = args === null ? {command:"",targets:[],coverage:"partial" as const} : decodeArguments(args), status = mapping.semantic === "shell" ? statusOfTests(arguments_.command) : null, verdict = runnerVerdict(decoded.output);
      observed.push(makeObservation({source:{conversation:String(entry.conversationId),outerCall:outer,nestedKey:nested,phase:"result"},sessionId:host.id,runId,tool:name,mapping,completedNonProcess:mapping.semantic !== "shell",command:arguments_.command,targets:arguments_.targets,output:decoded.output.slice(-16_384),isError:result.isError,exitCode:decoded.exitCode,timedOut:decoded.timedOut,aborted:decoded.aborted,coverage:decoded.output.length > 16_384 || arguments_.coverage === "partial" ? "partial" : decoded.coverage,at,verification:status === null ? null : verdict !== null ? verdict ? "failed" : "passed" : status === "own" && decoded.exitCode !== null ? decoded.exitCode === 0 ? "passed" : "failed" : null}));activity = Math.max(activity,at);
    }
    if (codemodeCallEntry.is(entry)) {
      const data = entry.data, key = JSON.stringify([entry.byTaskId,data.callId,data.key]);
      if (data.phase === "start") starts.set(key,{start:data,entry});
      else {
        const source = starts.get(key);if (!source) return {kind:"unreadable",reason:"Native nested result has no visible start"};
        const args = isJsonObject(source.start.arguments) ? source.start.arguments : null;
        capture(source.start.name,args,{name:source.start.name,structured:null,details:data.details ?? null,output:data.output ?? data.error ?? "",isError:data.isError,diagnostics:data.cancelled ? [{code:"aborted",message:data.error ?? "Cancelled"}] : []},String(entry.byTaskId),data.key,calls.get(data.callId)?.runId ?? "unknown",source.start.issuedAt ?? 0);starts.delete(key);
      }
    } else if (ToolResultEntry.is(entry)) for (const message of entry.model ?? []) if (message.role === "toolResult") {
      const source = calls.get(message.toolCallId);if (!source) return {kind:"unreadable",reason:"Tool result has no visible originating arguments"};
      capture(source.name,source.args,{name:source.name,structured:null,details:null,output:contentText(message.content),isError:message.isError,diagnostics:entry.data.diagnostics.map(diagnostic => ({code:diagnostic.code ?? "",message:diagnostic.message}))},String(entry.byTaskId),null,source.runId,message.timestamp);
    }
  }
  if (starts.size) return (await harness.snapshot(LiveDoc,host.conversationId,context))?.run ? {kind:"later",reason:"Native calls are still running"} : {kind:"unreadable",reason:"Ended trajectory contains an unfinished native call"};
  return {kind:"ready",cutoff:String(Math.min(maximum,latest ?? begin)),observations:observed,prompts,transcriptActivity:activity};
}
