import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createTokenEconomizer } from "../../../token-economizer/src/pi-durable/controller.ts";
import { defaultPolicy, type Policy } from "../../../token-economizer/src/core/config.ts";
import { scopeKey, type InferenceRequest } from "../../../token-economizer/src/core/types.ts";
import { emptyGuard } from "../../../token-economizer/src/core/loopguard/turn.ts";
import { sessionKey } from "../../../token-economizer/src/core/sessions.ts";
import { KnowledgeDoc, ObservationsDoc, RunDoc } from "../../../token-economizer/src/pi-durable/documents.ts";
import { decodeArguments, decodeResult } from "../../../token-economizer/src/pi-durable/decode.ts";
import type { HostDomain, HostSession } from "../../../token-economizer/src/pi-durable/domain.ts";
const closes:(() => Promise<void>)[] = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
async function setup(enabled:boolean,mode:"active"|"observe" = "active") {
  const models = createModels(), faux = fauxProvider({tokensPerSecond:100_000});models.setProvider(faux.provider);
  const policy:Policy = {...defaultPolicy(),enabled,mode,microSkills:"both" as const,loop:"judge" as const,pruning:"propose" as const,toolJudge:"generative" as const,generativeModel:{provider:"fixture",id:"small"}};
  policy.thresholds = {min_turns:8,gate_min_turns:8,error_outputs:3};policy.savers.auditPercent = 0;
  const calls:InferenceRequest[] = [], masks:string[][] = [], errors:Error[] = [];
  let harness:Harness, host:HostSession;
  const domain:HostDomain = {integrationId:"controller-test",session:async id => host?.conversationId === id ? host : null,
    tool:name => ({semantic:name === "codemode" ? "wrapper" : name === "bash" ? "shell" : "other",readOnly:false}),arguments:(_name,args) => decodeArguments(args),decode:decodeResult,
    catalogue:async () => ({revision:"1",source:"registered",complete:true,tools:[{name:"bash",description:"Run a command",revision:"1",highRisk:true,exposed:true,protected:true},{name:"rare",description:"Unused helper",revision:"1",highRisk:false,exposed:true,protected:false}]}),setTools:async (_host,names) => {masks.push([...names]);},
    trajectory:async source => ({kind:"ready",cutoff:`end-${source.id}`,observations:(await harness.snapshot(ObservationsDoc,sessionKey(source.scope,source.id),context))?.observations ?? [],prompts:1,transcriptActivity:Date.now()})};
  const optimizer = createTokenEconomizer({harness:() => harness,domain,policy:() => policy,onError:error => {errors.push(error);},sideCall:async request => {
    calls.push(request);
    const text = request.purpose === "loop-judge" ? JSON.stringify({stuck:true,confidence:1,reason:"Repeated identical failure"}) : request.purpose === "writer" ? "Try a different hypothesis, then check the result." : request.purpose === "tool-judge" ? JSON.stringify({rare:{load:false}}) : "[]";
    return {text,model:request.model,usage:{input:10,output:5,cacheRead:0,cacheWrite:{default:0},reasoning:null},cost:.001,durationMs:1,authUnavailable:false,error:null};
  }});
  const registry = createRegistry();registry.install(createCodemodeExtension({sandbox:new CodemodeSandbox()}));registry.install(optimizer.extension);
  registry.install(defineExtension({name:"fixture-tools",tools:[defineTool({name:"bash",description:"Run",parameters:Type.Object({command:Type.String()}),structuredOutputSchema:Type.Object({output:Type.String(),exitCode:Type.Integer(),timedOut:Type.Boolean(),aborted:Type.Boolean(),truncated:Type.Boolean()}),replay:"safe",execute:async () => ({structuredOutput:{output:"AssertionError: repeated test failure",exitCode:1,timedOut:false,aborted:false,truncated:false}})})]}));
  harness = await Harness.open(new MemoryStorage(),{models,registry},context);
  closes.push(async () => {await optimizer.close();await harness.close(context);});
  const root = await harness.root(context);await root.configure({model:{provider:"faux",modelId:"faux-1"},instructions:"PRIVATE_MAIN_AGENT_INSTRUCTIONS"},context);
  host = {id:"first",conversationId:root.id,scope:{host:"fixture",repository:"repo",environment:"v1"},repositoryRoot:"/repo",environmentRevision:"v1",classificationGroup:"first",delegated:false};
  await optimizer.attach();
  const start = {event:"new" as const,visibleHistory:false,carriedSections:{},carriedIds:[]};
  await optimizer.sessionStarted(host,start);
  if (enabled) await harness.commit(async tx => {(await tx.doc(KnowledgeDoc,scopeKey(host.scope),host.scope)).envelope.resolved_turns = [20,20,20,20,20];},context);
  return {harness,root,host,optimizer,policy,calls,masks,errors,faux,start,setHost:(next:HostSession) => {host = next;}};
}
test("installed optimizer: Off with every child selected leaves requests and tools unchanged",async () => {
  const f = await setup(false);
  await f.optimizer.prepareTools(f.host,"Read the code");f.faux.setResponses([fauxAssistantMessage("Done")]);
  await (await f.root.submit({type:"input",content:"Read",requestId:"off"},context)).wait(context);
  await f.optimizer.sessionEnded(f.host);
  expect(f.calls).toEqual([]);expect(f.masks.every(mask => mask.length === 0)).toBe(true);expect(f.errors).toEqual([]);
},15_000);
test("installed optimizer: live nested observations, isolated judge/writer, task judge and session proposer",async () => {
  const f = await setup(true);
  await f.optimizer.prepareTools(f.host,"Read the code; no rare helper needed");
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"for(let i=0;i<45;i++) await tools.bash({command:'pytest -q'});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done"),fauxAssistantMessage("Done")]);
  await (await f.root.submit({type:"input",content:"Run tests",requestId:"active"},context)).wait(context);
  await f.optimizer.sessionEnded(f.host);
  for (const row of (await f.harness.inspect(context)).tasks.filter(row => row.record.kind.startsWith("token-economizer."))) await f.harness.waitForTask(row.record.id,context);
  const status = await f.optimizer.status(f.host);
  expect((await f.harness.snapshot(ObservationsDoc,sessionKey(f.host.scope,f.host.id),context))?.observations).toHaveLength(45);
  expect(f.calls.some(call => call.purpose === "loop-judge")).toBe(true);
  expect(f.calls.some(call => call.purpose === "writer")).toBe(true);
  expect(f.calls.some(call => call.purpose === "tool-judge")).toBe(true);
  expect(status.run?.decisions.some(decision => decision.submissionId !== null)).toBe(true);
  // Settings shows what each nudge said and when.
  expect(status.run?.decisions.every(decision => Boolean(decision.text) && Number.isFinite(decision.at))).toBe(true);
  expect(f.calls.every(call => !call.prompt.includes("PRIVATE_MAIN_AGENT_INSTRUCTIONS"))).toBe(true);
  const next = {...f.host,id:"second",classificationGroup:"second"};f.setHost(next);await f.optimizer.sessionStarted(next,f.start);await f.optimizer.sessionEnded(next);
  for (const row of (await f.harness.inspect(context)).tasks.filter(row => row.record.kind === "token-economizer.fold")) await f.harness.waitForTask(row.record.id,context);
  expect(f.calls.some(call => call.purpose === "proposer")).toBe(true);expect(f.errors).toEqual([]);
},60_000);
test("session end closes retained guard state with the master Off without learning or spending",async () => {
  const f = await setup(false), key = sessionKey(f.host.scope,f.host.id);
  await f.harness.commit(async tx => {const run = await tx.doc(RunDoc,key,null);run.guard = emptyGuard("old-run");run.guard.cum_turns = 12;run.closed = false;},context);
  await f.optimizer.sessionEnded(f.host,true);
  const status = await f.optimizer.status(f.host);
  expect(status.run?.closed).toBe(true);expect(status.run?.guard?.cum_turns).toBe(12);expect(status.knowledge?.envelope.resolved_turns).toEqual([]);expect(f.calls).toEqual([]);
},15_000);
test("template redirects skip writer inference without changing the reference judge path",async () => {
  const f = await setup(true);f.policy.savers.templates = true;
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"for(let i=0;i<35;i++) await tools.bash({command:'pytest -q'});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done"),fauxAssistantMessage("Done")]);
  await (await f.root.submit({type:"input",content:"Run tests",requestId:"template"},context)).wait(context);
  await f.optimizer.sessionEnded(f.host);
  expect(f.calls.some(call => call.purpose === "loop-judge")).toBe(true);expect(f.calls.filter(call => call.purpose === "writer")).toHaveLength(0);
  expect((await f.optimizer.status(f.host)).run?.decisions.some(decision => decision.submissionId !== null)).toBe(true);expect(f.errors).toEqual([]);
},15_000);
test("novelty alternative defers only proposer cadence; clocks advance and a changed environment allows another call",async () => {
  const f = await setup(true);f.policy.microSkills = "distiller";f.policy.loop = "off";f.policy.pruning = "off";f.policy.savers.novelty = true;
  async function fold(index:number,revision = "v1") {
    const host = {...f.host,id:`novelty-${index}`,classificationGroup:`novelty-${index}`,environmentRevision:revision};f.setHost(host);
    await f.optimizer.sessionStarted(host,f.start);await f.optimizer.sessionEnded(host);
    for (const row of (await f.harness.inspect(context)).tasks.filter(row => row.record.kind === "token-economizer.fold")) await f.harness.waitForTask(row.record.id,context);
    return f.optimizer.status(host);
  }
  let status = await fold(1);for (let index = 2;index <= 14;index++) status = await fold(index);
  expect(status.knowledge?.distiller.now).toBe(14);expect(status.knowledge?.distiller.last_propose).toBe(8);expect(status.knowledge?.novelty.skips).toBe(2);
  expect(f.calls.filter(call => call.purpose === "proposer")).toHaveLength(3);
  for (let index = 15;index <= 17;index++) status = await fold(index,"v2");
  expect(status.knowledge?.distiller.now).toBe(17);expect(f.calls.filter(call => call.purpose === "proposer")).toHaveLength(4);expect(f.errors).toEqual([]);
},20_000);
test("compact digests and exact reuse do not suppress changed counters or manufacture reference labels",async () => {
  const f = await setup(true);f.policy.savers.compact = true;f.policy.savers.reuse = true;f.policy.savers.templates = true;
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"for(let i=0;i<35;i++) await tools.bash({command:'node missing-script.js'});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done"),fauxAssistantMessage("Done")]);
  await (await f.root.submit({type:"input",content:"Check repeated failure",requestId:"compact"},context)).wait(context);await f.optimizer.sessionEnded(f.host);
  const judges = f.calls.filter(call => call.purpose === "loop-judge");expect(judges.length).toBeGreaterThanOrEqual(2);expect(judges.some(call => call.prompt.includes("[repeated"))).toBe(true);
  const status = await f.optimizer.status(f.host);expect(status.run?.guard?.cum_turns).toBe(35);
  expect(status.classifiers?.samples.every(sample => sample.label === null)).toBe(true);expect(f.errors).toEqual([]);
},15_000);
test("whole prompt-turn budget and counters survive SDK generation handovers across tool rounds",async () => {
  const f = await setup(true);f.policy.savers.templates = true;
  const round = () => fauxAssistantMessage([fauxToolCall("codemode",{code:"for(let i=0;i<20;i++) await tools.bash({command:'pytest -q'});"})],{stopReason:"toolUse"});
  f.faux.setResponses([round(),round(),fauxAssistantMessage("Done"),fauxAssistantMessage("Done")]);
  await (await f.root.submit({type:"input",content:"Two rounds",requestId:"handover"},context)).wait(context);await f.optimizer.sessionEnded(f.host);
  const status = await f.optimizer.status(f.host);expect(status.run?.guard?.cum_turns).toBe(40);expect(status.run?.guard?.nudges_done).toBe(1);
  expect(status.run?.decisions.filter(decision => decision.action === "redirect")).toHaveLength(1);expect(f.errors).toEqual([]);
},15_000);
