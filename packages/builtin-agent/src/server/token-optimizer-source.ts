import { createHash } from "node:crypto";
import { isDurableUserEntry } from "./durable-input.ts";
import { BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";
import { ownedSlice } from "@earendil-works/chord/delta";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { AssistantEntry, LiveDoc, ToolResultEntry, ToolTask, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness, type ToolDiagnostic, type Tx } from "@earendil-works/pi-durable";
import { ContextSnapshotEntry, FactContextEntry } from "@kintsugi/token-economizer/pi-durable";
import { isJsonObject } from "@kintsugi/core";
import { makeObservation, workEvidence, type ToolMapping } from "@kintsugi/token-economizer/core";
import { decodeArguments, decodeResult } from "@kintsugi/token-economizer/pi-durable";
import { runnerVerdict, statusOfTests } from "@kintsugi/token-economizer/core";
import type { HostSession, Trajectory, ToolResultData } from "@kintsugi/token-economizer/pi-durable";
import type { Observation } from "@kintsugi/token-economizer/core";
import { codemodeCallEntry } from "./codemode-call.ts";
import { optimizerHistoryRead, optimizerOversizedEntry } from "./optimizer-history-budget.ts";
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
// SAFETY: Optimizer session bounds are persisted copies of committed entry IDs and are used only as scan bounds.
const entryBound = (value:number) => value as EntryId;
type EntryReader = Pick<Conversation,"entries">;
// Entry IDs increase across the journal. One shared window bounds catch-up work
// for the root and its descendants, even when a checkpoint has fallen far behind.
export const optimizerHistoryWindow = 512;
const maxDescendants = 32;
const maxPendingCalls = 64;
export const optimizerEvidenceBytes = 256 * 1024;
const maxObservations = 128;
const maxScanEntries = 1024;
const analysisPageSize = 4;
type ScanBudget = {remaining:number; exhausted:boolean};
/** Keep only the current page of decoded history and let other requests run before fetching the next page. */
async function* entryStream(conversation:EntryReader,query:Parameters<Conversation["entries"]>[0],budget?:ScanBudget,readContext:Context=context):AsyncGenerator<EntryRecord> {
  let cursor:Cursor|undefined;
  do {
    if (budget && budget.remaining === 0) {budget.exhausted = true;return;}
    const pageSize = budget ? Math.min(analysisPageSize,budget.remaining) : 32;
    const page = budget ? await optimizerHistoryRead.run("analysis",()=>conversation.entries(query,pageSize,cursor,readContext))
      : await conversation.entries(query,pageSize,cursor,readContext);
    if (budget) budget.remaining -= page.items.length;
    yield* page.items;
    cursor = page.next;
    if (cursor) await yieldToLoop();
  } while (cursor);
}
/** Entries after `after` (exclusive) up to `upTo` (inclusive), oldest first; never the whole history unless asked. */
export async function* optimizerEntries(conversation:EntryReader,{after,upTo}:{after:number;upTo:number},budget?:ScanBudget):AsyncGenerator<EntryRecord> {
  if (after >= upTo) return;
  const query = {order:"ascending" as const,minEntryId:after > 0 ? entryBound(after+1) : undefined,maxEntryId:Number.isFinite(upTo) ? entryBound(upTo) : undefined};
  yield* entryStream(conversation,query,budget);
}
/** The newest visible entry ID, without reading the transcript. */
export async function latestOptimizerEntry(conversation:EntryReader,readContext:Context=context):Promise<number|null> {
  return optimizerHistoryRead.run("id",async()=> (await conversation.entries({},1,undefined,readContext)).items[0]?.id ?? null);
}
/** Read a small, pinned ledger for exact output reduction, without hydrating unrelated media. */
export async function* recentOptimizerEntries(conversation:EntryReader,window:number,readContext:Context) {
  const latest = await latestOptimizerEntry(conversation,readContext);
  if (latest === null) return;
  const query = {order:"ascending" as const,minEntryId:entryBound(Math.max(1,latest-window+1)),maxEntryId:entryBound(latest)};
  yield* entryStream(conversation,query,{remaining:window,exhausted:false},readContext);
}
/** The newest assistant entry, searching backwards; one tool round at most in practice. */
export async function lastAssistantEntry(conversation:EntryReader):Promise<EntryRecord|undefined> {
  for await (const entry of entryStream(conversation,{})) if (AssistantEntry.is(entry)) return entry;
  return undefined;
}
/** The fact IDs recorded with a carried section, searching backwards from the newest entry. */
export async function carriedSnapshotIds(conversation:EntryReader,section:string):Promise<string[]> {
  for await (const entry of entryStream(conversation,{})) {
    if ((ContextSnapshotEntry.is(entry) || FactContextEntry.is(entry)) && entry.data.section === section) return entry.data.injectedIds;
  }
  return [];
}
function applyOptimizerSections(sections:Record<string,string>,messages:readonly Message[]) {
  for (const message of messages) if (message.role === "system") for (const [key,value] of Object.entries(message.sections ?? {})) {if (value === null) delete sections[key];else sections[key] = value;}
}
export function optimizerMessageSections(messages:readonly Message[]) {
  const sections:Record<string,string> = {};
  applyOptimizerSections(sections,messages);
  return sections;
}
export function optimizerSections(entries:readonly EntryRecord[]) {
  const sections:Record<string,string> = {};
  for (const entry of entries) {
    if (FactContextEntry.is(entry)) sections["token-economizer"] = entry.data.section;
    else if (entry.model) applyOptimizerSections(sections,entry.model);
  }
  return sections;
}
const modelCallOrigin = Type.Object({kind:Type.Literal("model"),callId:Type.String(),assistant:Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER})});
/** Verify a boundary-straddling result by task ID without reading pre-checkpoint arguments. */
async function callPrecedesRange(harness:Harness,entry:EntryRecord,callId:string,after:number):Promise<boolean | "oversized"> {
  if (!entry.byTaskId || after === 0) return false;
  const task = await optimizerHistoryRead.run("analysis",()=>harness.getTask(entry.byTaskId!,context));
  if (task?.kind === optimizerOversizedEntry) return "oversized";
  return task?.kind === ToolTask.definition.name && task.conversationId === entry.conversationId
    && Value.Check(modelCallOrigin,task.input) && task.input.callId === callId && task.input.assistant <= after;
}
/** Old cursors may split Code Mode pairs. Index the visible pre-cursor window once, only if needed. */
async function earlierNestedStarts(conversation:Conversation,historyFloor:number,after:number,budget:ScanBudget) {
  const starts = new Set<string>();let partial = false;
  for await (const entry of optimizerEntries(conversation,{after:historyFloor,upTo:after},budget)) {
    if (entry.kind === optimizerOversizedEntry) partial = true;
    if (codemodeCallEntry.is(entry) && entry.data.phase === "start") starts.add(nestedKey(entry,entry.data.callId,entry.data.key));
  }
  return {starts,partial:partial || budget.exhausted};
}
function shortKey(value:string) {
  return value.length <= 256 ? `=${value}` : createHash("sha256").update(value).digest("hex");
}
function nestedKey(entry:EntryRecord,callId:string,key:string) {
  return JSON.stringify([entry.byTaskId,shortKey(callId),shortKey(key)]);
}
type CallArguments = ReturnType<typeof decodeArguments>;
const noArguments:CallArguments = {command:"",targets:[],coverage:"partial"};
function boundedArguments(args:CallArguments):CallArguments {
  const command = ownedSlice(args.command,0,2048), targets = args.targets.slice(0,8).map(target=>ownedSlice(target,0,256));
  return {command,targets,coverage:command.length < args.command.length || targets.length < args.targets.length || targets.some((target,i)=>target.length < args.targets[i]!.length) ? "partial" : args.coverage};
}

type CapturedObservation = { id:EntryId; root:boolean; observation:Observation; bytes:number };
/** Keep the newest observations across all branches without ever keeping a full per-branch copy. */
class RecentEvidence {
  readonly items:CapturedObservation[] = [];
  private bytes = 2; // Array brackets; reserve a separator for each retained observation.
  partial = false;
  add(entry:EntryRecord,observation:Observation,root:boolean) {
    if (this.items.some(item=>item.observation.id === observation.id)) return;
    const bytes = 1+Buffer.byteLength(JSON.stringify(observation));
    let index = this.items.findIndex(item=>item.id > entry.id);
    if (index === -1) index = this.items.length;
    this.items.splice(index,0,{id:entry.id,root,observation,bytes});
    this.bytes += bytes;
    while (this.items.length > maxObservations || this.bytes > optimizerEvidenceBytes) {this.bytes -= this.items.shift()!.bytes;this.partial = true;}
  }
}
type NestedStarts = Map<string,{task:EntryRecord["byTaskId"];callId:string;name:string;args:CallArguments;issuedAt:number}>;
/** A settled wrapper can be interrupted before it records the nested result. That start is not evidence. */
function discardInterruptedStarts(starts:NestedStarts,entry:EntryRecord,message:Extract<Message,{role:"toolResult"}>,diagnostics:readonly ToolDiagnostic[]) {
  if (!entry.byTaskId || message.toolName !== "codemode" || !message.isError) return;
  if (!diagnostics.some(item => ["aborted","interrupted","uncertain","abandoned"].includes(item.code ?? ""))) return;
  const callId = shortKey(message.toolCallId);
  for (const [key,pending] of starts) if (pending.task === entry.byTaskId && pending.callId === callId) starts.delete(key);
}
/** One conversation's committed tool results within a session range. */
async function readSource(harness:Harness,conversation:Conversation,host:HostSession,after:number,upTo:number,historyFloor:number,evidence:RecentEvidence,budget:ScanBudget,partial:boolean,isRoot:boolean) {
  const calls = new Map<string,{name:string;args:CallArguments;runId:string}>(), starts:NestedStarts = new Map();
  let prompts = 0, activity = 0, answeredTurns = 0, answeredEnd = 0, awaitingAnswer = false;
  let preCursorStarts: Awaited<ReturnType<typeof earlierNestedStarts>>|undefined;
  function remember<T>(map:Map<string,T>,key:string,value:T) {
    if (!map.has(key) && map.size === maxPendingCalls) {map.delete(map.keys().next().value!);partial = true;}
    map.set(key,value);
  }
  for await (const entry of optimizerEntries(conversation,{after,upTo},budget)) {
    if (entry.kind === optimizerOversizedEntry) {partial = true;continue;}
    if (isDurableUserEntry(entry)) {prompts++;awaitingAnswer = true;}
    if (AssistantEntry.is(entry)) for (const message of entry.model ?? []) if (message.role === "assistant") {
      if (awaitingAnswer && message.stopReason === "stop" && message.content.some(block => block.type === "text" && block.text.trim()) && !message.content.some(block => block.type === "toolCall")) {answeredTurns++;answeredEnd = entry.id;awaitingAnswer = false;}
      for (const call of message.content) if (call.type === "toolCall") {
        if (call.name.length > 256) {partial = true;continue;}
        remember(calls,shortKey(call.id),{name:ownedSlice(call.name,0),args:boundedArguments(decodeArguments(call.arguments)),runId:String(entry.byTaskId ?? "unknown")});
      }
    }
    function capture(name:string,args:CallArguments,result:ToolResultData,outer:string,nested:string|null,runId:string,at:number) {
      const mapping = nativeOptimizerTool(name);if (mapping.semantic === "wrapper") return;
      if (outer.length > 256 || (nested?.length ?? 0) > 256) {partial = true;return;}
      const decoded = decodeResult(result), output = ownedSlice(decoded.output,Math.max(0,decoded.output.length-16_384));
      const status = mapping.semantic === "shell" ? statusOfTests(args.command) : null, verdict = runnerVerdict(output);
      evidence.add(entry,makeObservation({source:{conversation:String(entry.conversationId),outerCall:outer,nestedKey:nested,phase:"result"},sessionId:host.id,runId,tool:name,mapping,completedNonProcess:mapping.semantic !== "shell",command:args.command,targets:args.targets,output,isError:result.isError,exitCode:decoded.exitCode,timedOut:decoded.timedOut,aborted:decoded.aborted,coverage:output.length < decoded.output.length || args.coverage === "partial" ? "partial" : decoded.coverage,at,verification:status === null ? null : verdict !== null ? verdict ? "failed" : "passed" : status === "own" && decoded.exitCode !== null ? decoded.exitCode === 0 ? "passed" : "failed" : null}),isRoot);activity = Math.max(activity,at);
    }
    if (codemodeCallEntry.is(entry)) {
      const data = entry.data, callId = shortKey(data.callId), key = nestedKey(entry,data.callId,data.key);
      if (data.phase === "start") {
        if (data.name.length > 256) {partial = true;continue;}
        remember(starts,key,{task:entry.byTaskId,callId,name:ownedSlice(data.name,0),args:isJsonObject(data.arguments) ? boundedArguments(decodeArguments(data.arguments)) : noArguments,issuedAt:data.issuedAt ?? 0});
      }
      else {
        const source = starts.get(key);
        if (!source) {
          // A wrapper from before the retained window may have started this
          // call outside it. Do not fetch its old arguments or count the result.
          if (entry.byTaskId && entry.byTaskId <= historyFloor) partial = true;
          if (partial) continue;
          if (entry.byTaskId && entry.byTaskId < after) {
            preCursorStarts ??= await earlierNestedStarts(conversation,historyFloor,after,budget);
            partial ||= preCursorStarts.partial;
            if (preCursorStarts.starts.has(key) || partial) continue;
          }
          return {kind:"unreadable" as const,reason:"Native nested result has no visible start"};
        }
        capture(source.name,source.args,{name:source.name,structured:null,details:data.details ?? null,output:data.output ?? data.error ?? "",isError:data.isError,diagnostics:data.cancelled ? [{code:"aborted",message:data.error ?? "Cancelled"}] : []},String(entry.byTaskId),data.key,calls.get(callId)?.runId ?? "unknown",source.issuedAt);starts.delete(key);
      }
    } else if (ToolResultEntry.is(entry)) for (const message of entry.model ?? []) if (message.role === "toolResult") {
      const callId = shortKey(message.toolCallId), source = calls.get(callId);
      if (!source) {
        if (partial) continue;
        const before = await callPrecedesRange(harness,entry,message.toolCallId,after);
        if (before === "oversized") {partial = true;continue;}
        if (before) {
          discardInterruptedStarts(starts,entry,message,entry.data.diagnostics);
          continue;
        }
        return {kind:"unreadable" as const,reason:"Tool result has no visible originating arguments"};
      }
      if (source.name === "codemode") discardInterruptedStarts(starts,entry,message,entry.data.diagnostics);
      calls.delete(callId);
      // SAFETY: Durable storage only persists JSON-compatible tool result details.
      capture(source.name,source.args,{name:source.name,structured:null,details:(message.details ?? null) as ToolResultData["details"],output:contentText(message.content),isError:message.isError,diagnostics:entry.data.diagnostics.map(diagnostic => ({code:diagnostic.code ?? "",message:diagnostic.message}))},String(entry.byTaskId),null,source.runId,message.timestamp);
    }
  }
  return {kind:"read" as const,prompts,activity,answeredTurns,answeredEnd,unfinished:starts,partial};
}
type DescendantHeads = { recent:{id:ConversationId;entry:number}[]; omitted:number; at:number };
/** Read the shared journal bound and the live states from the same committed snapshot. */
export async function optimizerWatermark(tx:Tx,root:ConversationId,children:Iterable<ConversationId>,after:number,waitForIdle:boolean,heads?:DescendantHeads):Promise<number|null> {
  let newest=after;
  async function visit(id:ConversationId) {
    if (!await tx.conversation(id)) return true;
    const entry=await optimizerHistoryRead.run("id",()=>tx.latestEntryId(id)) ?? after;
    if (waitForIdle && (id === root || entry > after)) {
      const live=await tx.doc(LiveDoc,id);
      if (live.run && !live.run.afterRun) return false;
    }
    newest=Math.max(newest,entry);
    if (id === root || !heads || entry <= after) return true;
    // A newer child head must not hide an eligible child when folding a pinned cutoff.
    const visible = entry <= heads.at ? entry : await optimizerHistoryRead.run("id",async()=>
      (await tx.scanEntries({conversationId:id,minEntryId:entryBound(after+1),maxEntryId:entryBound(heads.at)},1)).items[0]?.id ?? after);
    if (visible > after && !heads.recent.some(item=>item.id===id)) {
      const index = heads.recent.findIndex(item=>item.entry<visible);
      heads.recent.splice(index<0 ? heads.recent.length : index,0,{id,entry:visible});
      if (heads.recent.length > maxDescendants) heads.omitted = Math.max(heads.omitted,heads.recent.pop()!.entry);
    }
    return true;
  }
  if (!await visit(root)) return null;
  for (const id of children) if (id !== root && !await visit(id)) return null;
  return newest;
}
/**
 * Reads only the active fork's committed native source; never executes a tool or imports abandoned history. Subagent
 * and one-shot descendants contribute tool results from the same period (entry IDs are journal-wide), never prompts.
 */
export async function nativeOptimizerTrajectory(harness:Harness,host:HostSession,begin:number,end:number|null,cutoff:string|null,descendants:(tx:Tx)=>Promise<Iterable<ConversationId>>,after?:string|null):Promise<Trajectory> {
  const conversation = await harness.conversation(host.conversationId,context);if (!conversation) return {kind:"absent",reason:"Conversation is absent"};
  if (after != null) {
    const value = Number(after);if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid optimizer learning cursor");
    begin = Math.max(begin,value);
  }
  let maximum = end ?? Infinity;
  if (cutoff !== null) {const value = Number(cutoff);if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid saved optimizer source cutoff");maximum = Math.min(maximum,value);}
  // A new journal-wide boundary must cover children as well as the root. Check live state and
  // capture the newest visible entry together. A saved bound already pins its source range.
  const {heads,latest} = await harness.commit(async tx => {
    const heads:DescendantHeads = {recent:[],omitted:0,at:maximum}, children=await descendants(tx);
    return {heads,latest:await optimizerWatermark(tx,host.conversationId,children,begin,!Number.isFinite(maximum),heads)};
  },context);
  if (latest === null) return {kind:"later",reason:"Agent or subagent run is still recording learning evidence"};
  maximum = Math.min(maximum,latest);
  const historyFloor = Math.max(0,maximum-optimizerHistoryWindow);
  const recentBegin = Math.max(begin,historyFloor);
  let partial = recentBegin > begin;
  const evidence = new RecentEvidence(), budget:ScanBudget = {remaining:maxScanEntries,exhausted:false};
  const root = await readSource(harness,conversation,host,recentBegin,maximum,historyFloor,evidence,budget,recentBegin > begin,true);
  if (root.kind === "unreadable") return root;
  partial ||= root.partial;
  if (root.unfinished.size && maximum < latest) {
    // Legacy saved upper bounds can end between a nested start and end. Look ahead only to
    // confirm pairing; results beyond the pinned boundary cannot become evidence for this fold.
    const lookAhead = Math.min(latest,maximum+optimizerHistoryWindow);
    for await (const entry of optimizerEntries(conversation,{after:maximum,upTo:lookAhead},budget)) {
      if (entry.kind === optimizerOversizedEntry) partial = true;
      if (codemodeCallEntry.is(entry) && entry.data.phase === "end") root.unfinished.delete(nestedKey(entry,entry.data.callId,entry.data.key));
      if (ToolResultEntry.is(entry)) for (const message of entry.model ?? []) if (message.role === "toolResult") discardInterruptedStarts(root.unfinished,entry,message,entry.data.diagnostics);
      if (!root.unfinished.size) break;
    }
    if (root.unfinished.size && lookAhead < latest) {root.unfinished.clear();partial = true;}
  }
  if (root.unfinished.size && !partial && !budget.exhausted) return {kind:"unreadable",reason:"Trajectory boundary contains an unfinished native call"};
  if (heads.omitted > recentBegin) partial = true;
  let activity = root.activity;
  for (const {id,entry} of heads.recent) {
    if (entry <= recentBegin) break;
    if (!budget.remaining) {budget.exhausted = true;break;}
    const child = await harness.conversation(id,context);if (!child) {partial = true;continue;}
    const read = await readSource(harness,child,host,recentBegin,maximum,historyFloor,evidence,budget,recentBegin > begin,false);
    // An incomplete child must not cost the root its evidence or vote for disuse.
    if (read.kind === "unreadable") {partial = true;continue;}
    partial ||= read.partial || read.unfinished.size > 0;
    activity = Math.max(activity,read.activity);
  }
  const result:Trajectory = {kind:"ready",cutoff:String(Math.max(begin,maximum)),observations:evidence.items.map(item=>item.observation),prompts:root.prompts,transcriptActivity:activity};
  if (partial || evidence.partial || budget.exhausted) result.partial = true;
  if (root.answeredTurns && !result.partial) result.work = workEvidence(evidence.items.filter(item=>item.root && item.id<=root.answeredEnd).map(item=>item.observation),root.answeredTurns,host.repositoryRoot);
  return result;
}
