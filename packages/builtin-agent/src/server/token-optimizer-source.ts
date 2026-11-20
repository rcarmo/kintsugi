import { isDurableUserEntry } from "./durable-input.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { contentText, type JsonObject, type Message } from "@earendil-works/pi-ai";
import { AssistantEntry, LiveDoc, ToolResultEntry, ToolTask, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness, type ToolDiagnostic, type Tx } from "@earendil-works/pi-durable";
import { ContextSnapshotEntry, FactContextEntry } from "@kintsugi/token-economizer/pi-durable";
import { isJsonObject } from "@kintsugi/core";
import { makeObservation, workEvidence, type ToolMapping } from "@kintsugi/token-economizer/core";
import { decodeArguments, decodeResult } from "@kintsugi/token-economizer/pi-durable";
import { runnerVerdict, statusOfTests } from "@kintsugi/token-economizer/core";
import type { HostSession, Trajectory, ToolResultData } from "@kintsugi/token-economizer/pi-durable";
import type { Observation } from "@kintsugi/token-economizer/core";
import { codemodeCallEntry, type CallStart } from "./codemode-call.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
export function nativeOptimizerTool(name:string):ToolMapping {
  if (name === "codemode") return {semantic:"wrapper",readOnly:false};
  if (name === "bash") return {semantic:"shell",readOnly:false};
  if (["edit","write"].includes(name)) return {semantic:"edit",readOnly:false};
  if (["read","view"].includes(name)) return {semantic:"read",readOnly:true};
  if (["grep","glob","search_history","grep_history","code_search"].includes(name)) return {semantic:"search",readOnly:true};
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
/** The newest assistant entry, searching backwards; one tool round at most in practice. */
export async function lastAssistantEntry(conversation:Conversation):Promise<EntryRecord|undefined> {
  let cursor:Cursor|undefined;
  do {
    const page = await conversation.entries({},200,cursor,context), found = page.items.find(entry => AssistantEntry.is(entry));
    if (found) return found;
    cursor = page.next;
  } while (cursor);
  return undefined;
}
/** The fact IDs recorded with a carried section, searching backwards from the newest entry. */
export async function carriedSnapshotIds(conversation:Conversation,section:string):Promise<string[]> {
  let cursor:Cursor|undefined;
  do {
    const page = await conversation.entries({},200,cursor,context);
    for (const entry of page.items) if ((ContextSnapshotEntry.is(entry) || FactContextEntry.is(entry)) && entry.data.section === section) return entry.data.injectedIds;
    cursor = page.next;
  } while (cursor);
  return [];
}
export function optimizerMessageSections(messages:readonly Message[]) {
  const sections:Record<string,string> = {};
  for (const message of messages) if (message.role === "system") for (const [key,value] of Object.entries(message.sections ?? {})) {if (value === null) delete sections[key];else sections[key] = value;}
  return sections;
}
export function optimizerSections(entries:readonly EntryRecord[]) {
  return optimizerMessageSections(entries.flatMap(entry => FactContextEntry.is(entry) ? [{role:"system" as const,content:"",sections:{"token-economizer":entry.data.section},timestamp:0}] : [...entry.model ?? []]));
}
const modelCallOrigin = Type.Object({kind:Type.Literal("model"),callId:Type.String(),assistant:Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER})});
/** Verify a boundary-straddling result by task ID without reading pre-checkpoint arguments. */
async function callPrecedesRange(harness:Harness,entry:EntryRecord,callId:string,after:number):Promise<boolean> {
  if (!entry.byTaskId || after === 0) return false;
  const task = await harness.getTask(entry.byTaskId,context);
  return task?.kind === ToolTask.definition.name && task.conversationId === entry.conversationId
    && Value.Check(modelCallOrigin,task.input) && task.input.callId === callId && task.input.assistant <= after;
}
/** Old cursors may split a Code Mode pair. Search only the parent task's visible pre-cursor range. */
async function nestedCallPrecedesRange(conversation:Conversation,entry:EntryRecord,callId:string,key:string,after:number):Promise<boolean> {
  if (!entry.byTaskId || entry.byTaskId >= after) return false;
  let cursor:Cursor|undefined;
  do {
    const page = await conversation.entries({minEntryId:entryBound(entry.byTaskId),maxEntryId:entryBound(after)},200,cursor,context);
    for (const candidate of page.items) if (candidate.byTaskId === entry.byTaskId && codemodeCallEntry.is(candidate) && candidate.data.callId === callId && candidate.data.key === key) return candidate.data.phase === "start";
    cursor = page.next;
  } while (cursor);
  return false;
}
type NestedStarts = Map<string,{start:CallStart;entry:EntryRecord}>;
/** A settled wrapper can be interrupted before it records the nested result. That start is not evidence. */
function discardInterruptedStarts(starts:NestedStarts,entry:EntryRecord,message:Extract<Message,{role:"toolResult"}>,diagnostics:readonly ToolDiagnostic[]) {
  if (!entry.byTaskId || message.toolName !== "codemode" || !message.isError) return;
  if (!diagnostics.some(item => ["aborted","interrupted","uncertain","abandoned"].includes(item.code ?? ""))) return;
  for (const [key,pending] of starts) if (pending.entry.byTaskId === entry.byTaskId && codemodeCallEntry.is(pending.entry) && pending.entry.data.callId === message.toolCallId) starts.delete(key);
}
/** One conversation's committed tool results within a session range. */
async function readSource(harness:Harness,conversation:Conversation,entries:readonly EntryRecord[],host:HostSession,after:number) {
  const observed:Observation[] = [], calls = new Map<string,{name:string;args:JsonObject;runId:string}>(), starts:NestedStarts = new Map();
  let prompts = 0, activity = 0, answeredTurns = 0, answeredEnd = 0, awaitingAnswer = false;
  for (const entry of entries) {
    if (isDurableUserEntry(entry)) {prompts++;awaitingAnswer = true;}
    if (AssistantEntry.is(entry)) for (const message of entry.model ?? []) if (message.role === "assistant") {
      if (awaitingAnswer && message.stopReason === "stop" && message.content.some(block => block.type === "text" && block.text.trim()) && !message.content.some(block => block.type === "toolCall")) {answeredTurns++;answeredEnd = observed.length;awaitingAnswer = false;}
      for (const call of message.content) if (call.type === "toolCall") calls.set(call.id,{name:call.name,args:call.arguments,runId:String(entry.byTaskId ?? "unknown")});
    }
    function capture(name:string,args:JsonObject|null,result:ToolResultData,outer:string,nested:string|null,runId:string,at:number) {
      const mapping = nativeOptimizerTool(name);if (mapping.semantic === "wrapper") return;
      const decoded = decodeResult(result), arguments_ = args === null ? {command:"",targets:[],coverage:"partial" as const} : decodeArguments(args), status = mapping.semantic === "shell" ? statusOfTests(arguments_.command) : null, verdict = runnerVerdict(decoded.output);
      observed.push(makeObservation({source:{conversation:String(entry.conversationId),outerCall:outer,nestedKey:nested,phase:"result"},sessionId:host.id,runId,tool:name,mapping,completedNonProcess:mapping.semantic !== "shell",command:arguments_.command,targets:arguments_.targets,output:decoded.output.slice(-16_384),isError:result.isError,exitCode:decoded.exitCode,timedOut:decoded.timedOut,aborted:decoded.aborted,coverage:decoded.output.length > 16_384 || arguments_.coverage === "partial" ? "partial" : decoded.coverage,at,verification:status === null ? null : verdict !== null ? verdict ? "failed" : "passed" : status === "own" && decoded.exitCode !== null ? decoded.exitCode === 0 ? "passed" : "failed" : null}));activity = Math.max(activity,at);
    }
    if (codemodeCallEntry.is(entry)) {
      const data = entry.data, key = JSON.stringify([entry.byTaskId,data.callId,data.key]);
      if (data.phase === "start") starts.set(key,{start:data,entry});
      else {
        const source = starts.get(key);
        if (!source) {
          if (await nestedCallPrecedesRange(conversation,entry,data.callId,data.key,after)) continue;
          return {kind:"unreadable" as const,reason:"Native nested result has no visible start"};
        }
        const args = isJsonObject(source.start.arguments) ? source.start.arguments : null;
        capture(source.start.name,args,{name:source.start.name,structured:null,details:data.details ?? null,output:data.output ?? data.error ?? "",isError:data.isError,diagnostics:data.cancelled ? [{code:"aborted",message:data.error ?? "Cancelled"}] : []},String(entry.byTaskId),data.key,calls.get(data.callId)?.runId ?? "unknown",source.start.issuedAt ?? 0);starts.delete(key);
      }
    } else if (ToolResultEntry.is(entry)) for (const message of entry.model ?? []) if (message.role === "toolResult") {
      const source = calls.get(message.toolCallId);
      if (!source) {
        if (await callPrecedesRange(harness,entry,message.toolCallId,after)) {
          discardInterruptedStarts(starts,entry,message,entry.data.diagnostics);
          continue;
        }
        return {kind:"unreadable" as const,reason:"Tool result has no visible originating arguments"};
      }
      if (source.name === "codemode") discardInterruptedStarts(starts,entry,message,entry.data.diagnostics);
      calls.delete(message.toolCallId);
      capture(source.name,source.args,{name:source.name,structured:null,details:JSON.parse(JSON.stringify(message.details ?? null)),output:contentText(message.content),isError:message.isError,diagnostics:entry.data.diagnostics.map(diagnostic => ({code:diagnostic.code ?? "",message:diagnostic.message}))},String(entry.byTaskId),null,source.runId,message.timestamp);
    }
  }
  return {kind:"read" as const,observations:observed,prompts,activity,answeredTurns,answeredEnd,unfinished:starts};
}
/** Read the shared journal bound and the live states from the same committed snapshot. */
export async function optimizerWatermark(tx:Tx,root:ConversationId,children:readonly ConversationId[],after:number,waitForIdle:boolean):Promise<number|null> {
  let newest=after;
  for (const id of [root,...children]) {
    if (!await tx.conversation(id)) continue;
    const entry=await tx.latestEntryId(id) ?? after;
    if (waitForIdle && (id === root || entry > after)) {
      const live=await tx.doc(LiveDoc,id);
      if (live.run && !live.run.afterRun) return null;
    }
    newest=Math.max(newest,entry);
  }
  return newest;
}
/**
 * Reads only the active fork's committed native source; never executes a tool or imports abandoned history. Subagent
 * and one-shot descendants contribute tool results from the same period (entry IDs are journal-wide), never prompts.
 */
export async function nativeOptimizerTrajectory(harness:Harness,host:HostSession,begin:number,end:number|null,cutoff:string|null,descendants:(tx:Tx)=>Promise<ConversationId[]>,after?:string|null):Promise<Trajectory> {
  const conversation = await harness.conversation(host.conversationId,context);if (!conversation) return {kind:"absent",reason:"Conversation is absent"};
  if (after != null) {
    const value = Number(after);if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid optimizer learning cursor");
    begin = Math.max(begin,value);
  }
  let maximum = end ?? Infinity;
  if (cutoff !== null) {const value = Number(cutoff);if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid saved optimizer source cutoff");maximum = Math.min(maximum,value);}
  // A new journal-wide boundary must cover children as well as the root. Check live state and
  // capture the newest visible entry together. A saved bound already pins its source range.
  const {children,latest} = await harness.commit(async tx => {
    const children=await descendants(tx);
    return {children,latest:await optimizerWatermark(tx,host.conversationId,children,begin,!Number.isFinite(maximum))};
  },context);
  if (latest === null) return {kind:"later",reason:"Agent or subagent run is still recording learning evidence"};
  maximum = Math.min(maximum,latest);
  const root = await readSource(harness,conversation,await optimizerEntries(conversation,{after:begin,upTo:maximum}),host,begin);
  if (root.kind === "unreadable") return root;
  if (root.unfinished.size && maximum < latest) {
    // Legacy saved upper bounds can end between a nested start and end. Look ahead only to
    // confirm pairing; results beyond the pinned boundary cannot become evidence for this fold.
    let cursor:Cursor|undefined;
    do {
      const page = await conversation.entries({order:"ascending",minEntryId:entryBound(maximum),maxEntryId:entryBound(latest)},200,cursor,context);
      for (const entry of page.items) {
        if (entry.id <= maximum) continue;
        if (codemodeCallEntry.is(entry) && entry.data.phase === "end") root.unfinished.delete(JSON.stringify([entry.byTaskId,entry.data.callId,entry.data.key]));
        if (ToolResultEntry.is(entry)) for (const message of entry.model ?? []) if (message.role === "toolResult") discardInterruptedStarts(root.unfinished,entry,message,entry.data.diagnostics);
      }
      cursor = page.next;
    } while (cursor && root.unfinished.size);
  }
  if (root.unfinished.size) return {kind:"unreadable",reason:"Trajectory boundary contains an unfinished native call"};
  const observations = [...root.observations], seen = new Set(observations.map(observation => observation.id));let activity = root.activity;
  for (const id of children) {
    const child = await harness.conversation(id,context);if (!child) continue;
    const read = await readSource(harness,child,await optimizerEntries(child,{after:begin,upTo:maximum}),host,begin);
    // A descendant's unreadable history must not cost the root its learning; skip that conversation.
    if (read.kind === "unreadable") continue;
    for (const observation of read.observations) {
      if (seen.has(observation.id)) continue;
      seen.add(observation.id);observations.push(observation);
    }
    activity = Math.max(activity,read.activity);
  }
  const result:Trajectory = {kind:"ready",cutoff:String(Math.max(begin,maximum)),observations,prompts:root.prompts,transcriptActivity:activity};
  if (root.answeredTurns) result.work = workEvidence(root.observations.slice(0,root.answeredEnd),root.answeredTurns,host.repositoryRoot);
  return result;
}
