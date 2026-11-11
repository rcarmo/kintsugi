import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { defaultPolicy, type Policy } from "../src/core/config.ts";
import { sessionKey } from "../src/core/sessions.ts";
import { JobsDoc, KnowledgeDoc, SessionsDoc } from "../src/pi-durable/documents.ts";
import { createInferenceQueue } from "../src/pi-durable/sidecall.ts";
import { createSessionLifecycle } from "../src/pi-durable/lifecycle.ts";
import { decodeArguments, decodeResult } from "../src/pi-durable/decode.ts";
import type { HostDomain, HostSession } from "../src/pi-durable/domain.ts";
import { scopeKey, type InferenceResult, type SideCall } from "../src/core/types.ts";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const reply: InferenceResult = {text:"result",model:{provider:"fixture",id:"small"},usage:{input:4,output:2,cacheRead:0,cacheWrite:{default:0},reasoning:null},cost:.01,durationMs:1,authUnavailable:false,error:null};
async function setup(kind: "memory" | "sqlite" | "jsonl", sideCall: SideCall = async () => reply) {
  const directory = await mkdtemp(join(tmpdir(),"token-economizer-"));
  closes.push(() => rm(directory,{recursive:true,force:true}));
  const openStorage = async (): Promise<Storage> => kind === "memory" ? new MemoryStorage() : kind === "sqlite" ? openNodeSqliteStorage(join(directory,"state.sqlite")) : openNodeJsonlStorage(join(directory,"journal"),context);
  const policy:Policy = {...defaultPolicy(),enabled:true,mode:"active" as const,microSkills:"both" as const,loop:"judge" as const};
  const registry = createRegistry(); let harness: Harness;
  const queue = createInferenceQueue({harness:() => harness,policy:() => policy,sideCall}); registry.install(queue.extension);
  const folds: string[] = [], trajectories = new Map<string,"ready" | "later" | "unreadable">();
  const domain: HostDomain = {integrationId:"portable-fixture",session:async () => null,tool:() => ({semantic:"shell",readOnly:false}),arguments:(_name,args) => decodeArguments(args),decode:decodeResult,setTools:async () => {},catalogue:async () => ({revision:"1",source:"fixture",complete:true,tools:[]}),
    trajectory:async host => {
      const kind = trajectories.get(host.id) ?? "ready";
      return kind === "ready" ? {kind,cutoff:`end-${host.id}`,observations:[],prompts:1,transcriptActivity:0} : {kind,reason:"fixture"};
    }};
  const lifecycle = createSessionLifecycle({harness:() => harness,domain,policy:() => policy,fold:async ({session,knowledge}) => {folds.push(session.id);return {environment:knowledge.environment,distiller:knowledge.distiller,tools:knowledge.tools,render:`prefix-${session.id}\n`,injectedIds:[session.id]};}});
  registry.install(lifecycle.extension);
  harness = await Harness.open(await openStorage(),{registry,models:createModels()},context);
  const root = await harness.root(context);
  closes.push(() => harness.close(context));
  const host = (id: string): HostSession => ({id,conversationId:root.id,scope:{host:"portable-fixture",repository:"repo",environment:"v1"},repositoryRoot:"/repo",environmentRevision:"v1",classificationGroup:"group",delegated:false});
  const start = {event:"new" as const,visibleHistory:false,carriedSections:{},carriedIds:[]};
  async function settleFolds() {
    const tasks = (await harness.inspect(context)).tasks.filter(row => ["token-economizer.fold","token-economizer.checkpoint"].includes(row.record.kind));
    for (const task of tasks) await harness.waitForTask(task.record.id,context);
  }
  return {get harness() {return harness;},domain,queue,policy,root,host,start,lifecycle,folds,trajectories,settleFolds,
    async reopen() {await harness.close(context);harness = await Harness.open(await openStorage(),{registry,models:createModels()},context);}};
}
for (const kind of ["memory","sqlite","jsonl"] as const) test(`portable ${kind}: automatic end, deferred recovery, once-only fold and stable render`, async () => {
  const f = await setup(kind);
  expect((await f.lifecycle.sessionStarted(f.host("one"),f.start))!.section).toBe("");
  await f.lifecycle.sessionEnded(f.host("one")); await f.lifecycle.sessionEnded(f.host("one"));
  await f.settleFolds(); expect(f.folds).toEqual(["one"]);
  expect((await f.lifecycle.sessionStarted(f.host("two"),f.start))!.section).toBe("prefix-one\n");
  f.trajectories.set("two","later"); await f.lifecycle.sessionEnded(f.host("two")); await f.settleFolds();
  expect(f.folds).toEqual(["one"]);
  if (kind !== "memory") await f.reopen();
  f.trajectories.set("two","ready");
  await f.lifecycle.sessionStarted(f.host("three"),f.start); await f.settleFolds();
  expect(f.folds).toEqual(["one","two"]);
  expect((await f.lifecycle.sessionStarted(f.host("one"),{...f.start,event:"resume"}))!.section).toBe("");
  await f.lifecycle.sessionEnded(f.host("one")); await f.settleFolds(); expect(f.folds).toEqual(["one","two"]);
  expect((await f.harness.snapshot(SessionsDoc,context))!.sessions[sessionKey(f.host("one").scope,"one")].folded).toBe(true);
  expect((await f.harness.snapshot(KnowledgeDoc,JSON.stringify(["portable-fixture","repo","v1"]),context))!.foldOrder).toHaveLength(2);
},15_000);

test("isolated queue: master gate, atomic reservations, auth pause, retry and exact accounting", async () => {
  let calls = 0;
  const f = await setup("memory",async () => {calls++;return calls === 1 ? {...reply,authUnavailable:true,error:"signed out",cost:0} : reply;});
  const request = (id: string) => ({id,purpose:"proposer" as const,model:reply.model,prompt:"bounded digest",maxOutputTokens:9999,deadlineMs:1000});
  const origin = {sessionKey:"session",account:"account",runId:null,revision:"1",digest:"digest",estimatedMaximumCost:null};
  f.policy.enabled = false;
  expect((await f.queue.enqueue(f.root.id,request("off"),origin)).reason).toBe("disabled"); expect(calls).toBe(0);
  f.policy.enabled = true;f.policy.microSkills = "off";
  expect((await f.queue.enqueue(f.root.id,request("child-off"),origin)).reason).toBe("disabled");expect(calls).toBe(0);
  f.policy.microSkills = "both";
  const first = await f.queue.enqueue(f.root.id,request("first"),origin);
  await f.harness.waitForTask(first.job!.taskId!,context);
  expect((await f.queue.enqueue(f.root.id,request("paused"),origin)).reason).toBe("auth_paused");
  await f.queue.retry("account");
  const second = await f.queue.enqueue(f.root.id,request("second"),origin);
  expect(second.job!.request.maxOutputTokens).toBe(f.policy.budget.maxOutputTokens);
  await f.harness.waitForTask(second.job!.taskId!,context);
  expect((await f.queue.enqueue(f.root.id,request("second"),origin)).reason).toBe("duplicate");
  const state = (await f.harness.snapshot(JobsDoc,context))!;
  expect(state.budget.ledger).toHaveLength(2); expect(calls).toBe(2);
  expect(state.jobs.second.result?.usage).toEqual(reply.usage); expect(state.worker).toBeNull();
},15_000);

test("restart during provider work records uncertain billing and never repeats a call", async () => {
  const entered = Promise.withResolvers<void>(); let calls = 0;
  const f = await setup("jsonl",async (_request,signal) => {calls++;entered.resolve();return new Promise((_,reject) => signal.addEventListener("abort",() => reject(signal.reason),{once:true}));});
  const queued = await f.queue.enqueue(f.root.id,{id:"uncertain",purpose:"loop-judge",model:reply.model,prompt:"bounded",maxOutputTokens:10,deadlineMs:1000},{sessionKey:"session",account:"account",runId:"run",revision:"1",digest:"digest",estimatedMaximumCost:null});
  f.harness.resume(); await entered.promise; await f.reopen();
  await f.harness.waitForTask(queued.job!.taskId!,context);
  const state = (await f.harness.snapshot(JobsDoc,context))!;
  expect(calls).toBe(1); expect(state.jobs.uncertain.status).toBe("unknown");
  expect(state.budget.reserved.uncertain).toBeDefined(); expect(state.budget.ledger[0].cost).toBeNull();
  await f.queue.reconcile("uncertain",reply);
  expect((await f.harness.snapshot(JobsDoc,context))!.budget.ledger).toHaveLength(1);
},15_000);

for (const kind of ["memory","sqlite","jsonl"] as const) test(`portable ${kind}: live checkpoint replay is deduplicated and its cursor survives reopen`,async () => {
  const f = await setup(kind);f.domain.incrementalLearning = true;
  const cursors:(string|null|undefined)[] = [];
  f.domain.trajectory = async (host,_cutoff,after) => {cursors.push(after);return {kind:"ready",cutoff:`end-${host.id}-${cursors.length}`,observations:[],prompts:1,transcriptActivity:0};};
  await f.lifecycle.sessionStarted(f.host("live"),f.start);
  await f.lifecycle.runCompleted(f.host("live"),"run-1");await f.settleFolds();
  let row = (await f.harness.snapshot(SessionsDoc,context))!.sessions[sessionKey(f.host("live").scope,"live")];
  expect(row.folded).toBe(false);expect(row.ended).toBeNull();expect(row.learning?.processed).toBe(1);
  const cutoff = row.learning!.cutoff;
  await f.lifecycle.runCompleted(f.host("live"),"run-1");await f.settleFolds();expect(f.folds).toHaveLength(1);
  if (kind !== "memory") await f.reopen();
  await f.lifecycle.sessionStarted(f.host("live"),{...f.start,event:"resume"});
  await f.lifecycle.runCompleted(f.host("live"),"run-2");await f.settleFolds();
  row = (await f.harness.snapshot(SessionsDoc,context))!.sessions[sessionKey(f.host("live").scope,"live")];
  expect(row.learning?.processed).toBe(2);expect(cursors[1]).toBe(cutoff);expect(row.section).toBe("");
  await f.lifecycle.sessionEnded(f.host("live"));await f.settleFolds();
  expect((await f.harness.snapshot(KnowledgeDoc,scopeKey(f.host("live").scope),context))!.foldOrder).toHaveLength(1);
  await f.harness.commit(async tx => {delete (await tx.doc(SessionsDoc)).sessions[sessionKey(f.host("live").scope,"live")].learning;},context);
  await f.lifecycle.sessionStarted(f.host("live"),{...f.start,event:"resume"});
  await f.lifecycle.runCompleted(f.host("live"),"legacy-resume");await f.settleFolds();
  expect((await f.harness.snapshot(SessionsDoc,context))!.sessions[sessionKey(f.host("live").scope,"live")].learning?.toolCounted).toBe(true);
  expect((await f.harness.snapshot(KnowledgeDoc,scopeKey(f.host("live").scope),context))!.foldOrder).toHaveLength(1);
},15_000);
