import { tokenOptimizerSettingsContribution } from "../../src/server/token-optimizer-settings.ts";
import { carriedSnapshotIds, latestOptimizerEntry, optimizerEntries, optimizerMessageSections } from "../../src/server/token-optimizer-source.ts";
import { openDurableWorkspace, WorkspaceAgents } from "../../src/server/durable-workspace.ts";
import { openDurableAgentRuntime } from "../../src/server/durable-runtime.ts";
import { renderAgentPaneComposerFooter } from "../../src/server/render-composer.ts";
import type { WorkspaceAgentToolOptions } from "@kintsugi/agent/server/tools";
import type { WriteDurableTiming } from "../../src/server/durable-timing.ts";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { isJsonObject, type JsonObject } from "@kintsugi/core";
import { ContextSnapshotEntry, KnowledgeDoc, JobsDoc, RunDoc } from "../../../token-economizer/src/pi-durable/documents.ts";
import { scopeKey } from "../../../token-economizer/src/core/types.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { contentText, createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, normalizeContext, type Model } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { AgentDoc, AssistantEntry, LiveDoc, UserEntry, type AgentChange, type ConversationId, createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createWorkspaceCodemodeExtension } from "../../../codemode/src/server/extension.ts";
import { createNativeTokenOptimizer, OptimizerNotice, tokenOptimizerIntegration } from "../../src/server/token-optimizer.ts";
import { SessionsDoc } from "../../../token-economizer/src/pi-durable/documents.ts";
import { sessionKey } from "../../../token-economizer/src/core/sessions.ts";
import { emptyGuard } from "../../../token-economizer/src/core/loopguard/turn.ts";
import { runIdentity } from "../../../token-economizer/src/pi-durable/run-identity.ts";
import { ids } from "@kintsugi/agent/server/render-context";
import { OptimizerOperationEntry, recordOptimizerOperation } from "../../src/server/token-optimizer-operations.ts";
import { TokenOptimizerConfiguration, tokenOptimizerConfiguration } from "../../src/server/token-optimizer-config.ts";
const cleanups:(() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});
async function settleLearning(harness:Harness) {
  const waited = new Set<number>();
  for (;;) {
    const pending = (await harness.inspect(context)).tasks.filter(row => ["token-economizer.fold","token-economizer.checkpoint"].includes(row.record.kind) && !waited.has(row.record.id));
    if (!pending.length) return;
    for (const row of pending) {await harness.waitForTask(row.record.id,context);waited.add(row.record.id);}
  }
}
async function setup(kind:"memory"|"sqlite"|"jsonl" = "memory",overrideConfig?:TokenOptimizerConfiguration) {
  const path = await mkdtemp(join(tmpdir(),"native-optimizer-"));cleanups.push(() => rm(path,{recursive:true,force:true}));
  const configuration = overrideConfig ?? new TokenOptimizerConfiguration(path);await configuration.load();
  const models = createModels(), faux = fauxProvider({tokensPerSecond:100_000});models.setProvider(faux.provider);
  const registry = createRegistry();let harness:Harness, failing = false, failureOutput = "AssertionError: repeated test failure", gate:Promise<void>|null = null;const entered = Promise.withResolvers<void>();
  registry.install(createWorkspaceCodemodeExtension("fixture",new CodemodeSandbox(),async () => ({text:""})));
  registry.install(defineExtension({name:"fixture-tools",tools:[defineTool({name:"bash",description:"Run",parameters:Type.Object({command:Type.String()}),structuredOutputSchema:Type.Object({output:Type.String(),exitCode:Type.Integer(),aborted:Type.Boolean(),timedOut:Type.Boolean(),truncated:Type.Boolean()}),replay:"safe",async execute() {if (gate) {entered.resolve();await gate;gate = null;}return {structuredOutput:{output:failing ? failureOutput : "passed",exitCode:failing ? 1 : 0,aborted:false,timedOut:false,truncated:false},details:{exitCode:failing ? 1 : 0,aborted:false,timedOut:false}};}}),defineTool({name:"rare",description:"Rare helper",parameters:Type.Object({}),execute:async () => ({output:[{type:"text",text:"done"}]})}),defineTool({name:"plan",description:"Plan",parameters:Type.Object({}),execute:async () => ({output:[{type:"text",text:"done"}]})})]}));
  const native = createNativeTokenOptimizer({workspaceId:"fixture",models,registry,harness:() => harness,configuration});registry.install(native.optimizer.extension);
  harness = await Harness.open(kind === "memory" ? new MemoryStorage() : kind === "sqlite" ? await openNodeSqliteStorage(join(path,"state.sqlite")) : await openNodeJsonlStorage(join(path,"journal"),context),{models,registry},context);cleanups.push(async () => {await native.close();await harness.close(context);});
  const root = await harness.commit(tx => tx.createConversation({ownership:{kind:"ownerless"}}),context), conversation = (await harness.conversation(root.id,context))!;
  await conversation.configure({model:{provider:"faux",modelId:"faux-1"},instructions:"Main instructions"},context);
  await native.attach();const host = (await native.start(conversation,{agentId:"agent"}))!;
  return {native,configuration,harness,conversation,host,faux,models,fail:(output = "AssertionError: repeated test failure") => {failing = true;failureOutput = output;},hold:() => {const release = Promise.withResolvers<void>();gate = release.promise;cleanups.push(async () => release.resolve());return {entered:entered.promise,release:() => release.resolve()};}};
}
for (const kind of ["memory","sqlite","jsonl"] as const) test(`native ${kind}: default Off, active receipts, once-only folding, protection and sticky restore`,async () => {
  const f = await setup(kind);expect((await f.conversation.agent(context)).callable.some(tool => tool.name === "rare")).toBe(true);
  const config = f.configuration.snapshot();config.policy.enabled = true;config.policy.microSkills = "envfacts";config.policy.pruning = "propose";config.policy.evidenceSessions = 1;config.policy.evidenceMinSessions = 1;config.policy.evidencePrompts = 1;
  await f.configuration.configure(config);const active = f.configuration.snapshot();active.policy.mode = "active";await f.configuration.configure(active);
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"await tools.bash({command:'bun test'});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done")]);
  await (await f.conversation.submit({type:"input",content:"Test",requestId:"run"},context)).wait(context);
  const trajectory = await f.native.domain.trajectory(f.host,null);expect(trajectory.kind).toBe("ready");
  if (trajectory.kind !== "ready") throw new Error("Expected native trajectory");
  expect(trajectory.prompts).toBe(1);expect(trajectory.observations).toHaveLength(1);expect(trajectory.observations[0]).toMatchObject({tool:"bash",nested:true,exitCode:0,outcome:"success",coverage:"complete"});
  await f.native.end(f.conversation.id);
  await settleLearning(f.harness);
  expect((await f.native.optimizer.status(f.host)).session?.folded).toBe(true);
  expect((await f.native.optimizer.apply(f.host,["plan"])).added).toEqual([]);
  expect((await f.native.optimizer.apply(f.host,["rare"])).added).toEqual(["rare"]);
  const resumed = (await f.native.start(f.conversation,{agentId:"agent"},"resume"))!;expect(resumed.id).toBe(f.host.id);
  expect((await f.conversation.agent(context)).callable.some(tool => tool.name === "rare")).toBe(false);
  await f.native.optimizer.restore(resumed,["rare"]);await f.native.start(f.conversation,{agentId:"agent"},"resume");
  expect((await f.conversation.agent(context)).callable.some(tool => tool.name === "rare")).toBe(true);
  expect((await f.native.optimizer.status(resumed)).knowledge?.tools.kept).toContain("rare");expect(f.faux.state.callCount).toBe(2);
},20_000);
test("native adapter: reset gets a fresh ID; delegated roots are excluded; external masks are never overwritten",async () => {
  const f = await setup();expect(await f.native.start(f.conversation,{agentId:"child",parentId:"agent"})).toBeUndefined();
  await f.conversation.reset(undefined,context);const next = (await f.native.reset(f.conversation,{agentId:"agent"}))!;expect(next.id).not.toBe(f.host.id);
  await f.harness.commit(async tx => {(await tx.doc(AgentDoc,f.conversation.id)).tools = {remove:["rare"]};},context);
  await expect(f.native.domain.setTools(next,[])).rejects.toThrow("another owner");
  expect((await f.conversation.agent(context)).callable.some(tool => tool.name === "rare")).toBe(false);
},15_000);

test("native cached fact prefix survives real provider serialization on requests two and three with networking blocked",async () => {
  const f = await setup(), captured:JsonObject[] = [];let networkCalls = 0;
  const model:Model<"anthropic-messages"> = {id:"offline-serialization",name:"Offline",provider:"fixture",api:"anthropic-messages",baseUrl:"https://never-contact.invalid",reasoning:false,input:["text"],contextWindow:200000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  f.models.getModel = () => model;
  f.models.streamSimple = (_selected,request,options) => stream(model,normalizeContext(request),{...options,apiKey:"offline-only",async onPayload(payload,ref) {const rewritten = await options?.onPayload?.(payload,ref) ?? payload;if (!isJsonObject(rewritten)) throw new Error("Expected serialized request");captured.push(rewritten);throw new Error("STOP_BEFORE_NETWORK");},fetch:Object.assign(async () => {networkCalls++;throw new Error("Network forbidden");},{preconnect() {}})});
  const config = f.configuration.snapshot();config.policy.enabled = true;config.policy.microSkills = "envfacts";await f.configuration.configure(config);const active = f.configuration.snapshot();active.policy.mode = "active";await f.configuration.configure(active);
  await f.harness.commit(async tx => {const knowledge = await tx.doc(KnowledgeDoc,scopeKey(f.host.scope),f.host.scope);knowledge.render = "Fixture repository fact.";knowledge.renders = {environment:knowledge.render,distilled:"",ids:["fixture-fact"]};knowledge.injectedIds = ["fixture-fact"];},context);
  const record = await f.harness.commit(tx => tx.createConversation({ownership:{kind:"ownerless"}}),context), root = (await f.harness.conversation(record.id,context))!;
  await root.configure({model:{provider:model.provider,modelId:model.id},instructions:"Shared instructions. ".repeat(200)},context);await f.native.start(root,{agentId:"cached-agent"});
  for (let i = 0;i < 3;i++) await (await root.submit({type:"input",content:"Request "+i,requestId:"cache-"+i},context)).wait(context);
  expect(captured).toHaveLength(3);expect(networkCalls).toBe(0);
  expect(JSON.stringify(captured[1].system)).toBe(JSON.stringify(captured[2].system));expect(JSON.stringify(captured[1].system)).toContain("Fixture repository fact.");
  expect(JSON.stringify(captured[1])).toContain("cache_control");
},20_000);
test("native host executes all four isolated generative paths through its SDK transport without network or inherited instructions",async () => {
  const f = await setup(), seen = new Set<string>();let mainCalls = 0;
  f.faux.setResponses(Array.from({length:20},() => (request) => {
    if (request.messages.some(message => message.role === "system" && JSON.stringify(message).includes("Main instructions"))) {
      mainCalls++;return mainCalls === 1 || mainCalls === 3 ? fauxAssistantMessage([fauxToolCall("codemode",{code:mainCalls === 1 ? "for(let i=0;i<45;i++) await tools.bash({command:'bun test'});" : "await tools.bash({command:'bun test'});"})],{stopReason:"toolUse"}) : fauxAssistantMessage("Done");
    }
    expect(JSON.stringify(request)).not.toContain("Main instructions");const prompt = contentText(request.messages[0]?.content ?? "");
    if (prompt.includes("Return the JSON verdict:")) {seen.add("loop-judge");return fauxAssistantMessage(JSON.stringify({stuck:true,confidence:1,reason:"Repeated failure"}));}
    if (prompt.includes("Write the redirect:")) {seen.add("writer");return fauxAssistantMessage("Try a different hypothesis and check the result.");}
    if (prompt.startsWith("You configure tools")) {seen.add("tool-judge");return fauxAssistantMessage(JSON.stringify({rare:{load:false}}));}
    if (prompt.includes("You mine a DURABLE")) {seen.add("proposer");return fauxAssistantMessage(JSON.stringify({facts:[]}));}
    throw new Error("Unexpected optimizer prompt");
  }));
  const config = f.configuration.snapshot();Object.assign(config.policy,{enabled:true,microSkills:"both",loop:"judge",pruning:"propose",toolJudge:"generative",generativeModel:{provider:"faux",id:"faux-1"},thresholds:{min_turns:8,gate_min_turns:8,error_outputs:3}});await f.configuration.configure(config);const active = f.configuration.snapshot();active.policy.mode = "active";await f.configuration.configure(active);
  await f.harness.commit(async tx => {(await tx.doc(KnowledgeDoc,scopeKey(f.host.scope),f.host.scope)).envelope.resolved_turns = [20,20,20,20,20];},context);
  await f.native.prepare(f.host,"Run tests without the rare helper","task-native");f.fail();
  const outcome = await (await f.conversation.submit({type:"input",content:"Run tests",requestId:"all-paths"},context)).wait(context);expect(outcome.status).toBe("done");
  for (const row of (await f.harness.inspect(context)).tasks.filter(row => row.record.kind === "token-economizer.guard-judge")) await f.harness.waitForTask(row.record.id,context);
  await f.native.end(f.conversation.id);
  await settleLearning(f.harness);
  await f.conversation.reset(undefined,context);await f.native.reset(f.conversation,{agentId:"agent"});
  await (await f.conversation.submit({type:"input",content:"Second session",requestId:"second"},context)).wait(context);await f.native.end(f.conversation.id);
  await settleLearning(f.harness);
  expect([...seen].sort()).toEqual(["loop-judge","proposer","tool-judge","writer"]);
  const ledger = (await f.harness.snapshot(JobsDoc,context))!.budget.ledger;expect(f.faux.state.callCount-mainCalls).toBe(ledger.length);expect(ledger.every(row => row.model.provider === "faux" && row.usage !== null)).toBe(true);
},30_000);
test("native JSONL reopen preserves epochs and pending end folds; raw storage close is not a session end",async () => {
  const path = await mkdtemp(join(tmpdir(),"native-optimizer-reopen-"));cleanups.push(() => rm(path,{recursive:true,force:true}));
  const configuration = new TokenOptimizerConfiguration(path);const config = await configuration.load();config.policy.enabled = true;config.policy.microSkills = "envfacts";await configuration.configure(config);const active = configuration.snapshot();active.policy.mode = "active";await configuration.configure(active);
  const models = createModels(), faux = fauxProvider({tokensPerSecond:100_000});models.setProvider(faux.provider);
  const open = async () => {
    const registry = createRegistry();let workspace:Awaited<ReturnType<typeof openDurableWorkspace>>;
    const native = createNativeTokenOptimizer({workspaceId:"reopen",models,registry,harness:() => workspace.harness,configuration});registry.install(native.optimizer.extension);
    workspace = await openDurableWorkspace(join(path,"journal"),"reopen",{models,registry});await native.attach();
    let closed = false;const close = async (graceful:boolean) => {if (closed) return;closed = true;if (graceful) await native.close();else await native.detach();await workspace.close();};cleanups.push(() => close(true));
    return {workspace,native,close};
  };
  let owner = await open();let root = await owner.workspace.agent({agentId:"retained",label:"Root",title:"Reopen"},{model:{provider:"faux",modelId:"faux-1"}});
  const original = (await owner.native.start(root,{agentId:"retained"}))!;faux.setResponses([fauxAssistantMessage("Done")]);await (await root.submit({type:"input",content:"First",requestId:"one"},context)).wait(context);
  await owner.close(true);owner = await open();root = await owner.workspace.agent({agentId:"retained",label:"Root",title:"Reopen"});expect(owner.native.host(root.id).id).toBe(original.id);
  await settleLearning(owner.workspace.harness);
  expect((await owner.native.optimizer.status(original)).session?.folded).toBe(true);expect((await owner.native.optimizer.status(original)).knowledge?.foldOrder).toHaveLength(1);
  const second = await owner.workspace.agent({agentId:"crash",label:"Other",title:"Raw close"},{model:{provider:"faux",modelId:"faux-1"}}), pending = (await owner.native.start(second,{agentId:"crash"}))!;
  faux.setResponses([fauxAssistantMessage("Done")]);await (await second.submit({type:"input",content:"Unended",requestId:"two"},context)).wait(context);await owner.close(false);
  owner = await open();const record = (await owner.native.optimizer.status(pending)).session;expect(record?.ended).toBeNull();expect(record?.folded).toBe(false);expect(owner.native.host(second.id).id).toBe(pending.id);
},20_000);
test("native fork/rewind retains the visible frozen fact snapshot and IDs; real compaction replays the resulting map",async () => {
  const f = await setup(), config = f.configuration.snapshot();config.policy.enabled = true;config.policy.microSkills = "envfacts";await f.configuration.configure(config);const active = f.configuration.snapshot();active.policy.mode = "active";await f.configuration.configure(active);
  await f.harness.commit(async tx => {const knowledge = await tx.doc(KnowledgeDoc,scopeKey(f.host.scope),f.host.scope);knowledge.render = "Original repository fact.";knowledge.renders = {environment:knowledge.render,distilled:"",ids:["original"]};knowledge.injectedIds = ["original"];},context);
  const record = await f.harness.commit(tx => tx.createConversation({ownership:{kind:"ownerless"}}),context), root = (await f.harness.conversation(record.id,context))!;await root.configure({model:{provider:"faux",modelId:"faux-1"}},context);
  const source = (await f.native.start(root,{agentId:"timeline"}))!;f.faux.setResponses([fauxAssistantMessage("One"),fauxAssistantMessage("Two")]);
  for (let i = 0;i < 2;i++) expect((await (await root.submit({type:"input",content:"Prompt "+i,requestId:"timeline-"+i},context)).wait(context)).status).toBe("done");
  const entries = (await root.entries({order:"ascending"},500,undefined,context)).items, first = entries.find(entry => AssistantEntry.is(entry))!, unshown = entries.find(entry => UserEntry.is(entry))!, before = entries.find(entry => ContextSnapshotEntry.is(entry))!;
  await f.harness.commit(async tx => {const knowledge = await tx.doc(KnowledgeDoc,scopeKey(f.host.scope),f.host.scope);knowledge.render = "Newer fact must not replace carried text.";knowledge.renders = {environment:knowledge.render,distilled:"",ids:["newer"]};knowledge.injectedIds = ["newer"];},context);
  for (const at of [first,unshown,before]) {
    const branch = await f.harness.commit(tx => tx.forkConversation(root.id,at.id,{ownership:{kind:"ownerless"}}),context), child = (await f.harness.conversation(branch.id,context))!;
    const host = (await f.native.start(child,{agentId:"timeline"},"fork",source.classificationGroup))!, state = (await f.native.optimizer.status(host)).session!;
    expect(host.id).not.toBe(source.id);expect(state.group).toBe(source.classificationGroup);expect(state.section).toBe(at === first ? (await f.native.optimizer.status(source)).session!.section : "");
    expect(state.injectedIds).toEqual(at === first ? ["original"] : []);const trajectory = await f.native.domain.trajectory(host,null);expect(trajectory.kind).toBe("ready");if (trajectory.kind === "ready") expect(trajectory.prompts).toBe(at === before ? 0 : 1);
  }
  f.faux.setResponses([fauxAssistantMessage("Summary of two prompts.")]);await f.harness.waitForTask(await root.compact(undefined,context),context);
  // Drain the native commit observer without ending the logical session.
  await f.native.detach();const sections = optimizerMessageSections((await root.context(context)).messages), state = (await f.native.optimizer.status(source)).session!;
  expect(state.section).toBe(sections["token-economizer"] ?? "");expect(state.section).not.toContain("Newer fact");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), trajectory = f.native.domain.trajectory;cleanups.push(async () => release.resolve());
  f.native.domain.trajectory = async (host,cutoff) => {if (host.id === source.id) {entered.resolve();await release.promise;}return trajectory(host,cutoff);};
  await f.native.end(root.id);await entered.promise;await root.reset(undefined,context);const fresh = (await f.native.reset(root,{agentId:"timeline"}))!;
  const frozen = (await f.native.optimizer.status(fresh)).session!.section;expect(fresh.id).not.toBe(source.id);expect(frozen).toContain("Newer fact");
  release.resolve();await settleLearning(f.harness);
  expect((await f.native.optimizer.status(source)).session?.folded).toBe(true);expect((await f.native.optimizer.status(fresh)).session?.section).toBe(frozen);
},20_000);
test("Settings backend routes validate policies and native actions without starting an Agent or provider",async () => {
  const path = await mkdtemp(join(tmpdir(),"native-optimizer-routes-")), prior = process.env.KINTSUGI_DATA_DIR;cleanups.push(() => rm(path,{recursive:true,force:true}));process.env.KINTSUGI_DATA_DIR = path;cleanups.push(async () => {if (prior === undefined) delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR = prior;});
  const f = await setup("memory",tokenOptimizerConfiguration()), service = tokenOptimizerConfiguration();
  const action = async (suffix:string,body:JsonObject) => {const request = new Request("http://fixture/settings/token-optimizer"+suffix,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return (await tokenOptimizerSettingsContribution.handleAction!({request,url:new URL(request.url)}))!;};
  const config = service.snapshot();config.policy.enabled = true;config.policy.mode = "active";config.policy.microSkills = "envfacts";config.policy.pruning = "propose";
  expect((await action("",config)).status).toBe(200);expect(service.snapshot().policy.mode).toBe("observe");config.policy.mode = "active";expect((await action("",config)).status).toBe(200);
  const target = {workspaceId:"fixture",agentId:"agent"};expect((await action("/apply",{...target,names:["rare"]})).status).toBe(200);expect((await action("/restore",target)).status).toBe(200);expect((await action("/retry",target)).status).toBe(200);
  expect((await action("/clear",target)).status).toBe(400);expect((await action("/clear",{...target,confirmed:true})).status).toBe(200);expect((await action("/review",{...target,sampleId:"missing",label:0})).status).toBe(400);
  expect((await action("/override",{workspaceId:"fixture",mode:"off"})).status).toBe(200);expect((await action("/override",{...target,mode:"active"})).status).toBe(200);expect(service.policy("fixture","agent").mode).toBe("off");expect((await action("/refit",target)).status).toBe(400);
  const invalid = service.snapshot();invalid.policy.loop = "judge";expect((await action("",invalid)).status).toBe(400);expect((await action("/prepare",{...target,task:""})).status).toBe(400);
  const html = await tokenOptimizerSettingsContribution.render();expect(html).toContain('name="mode" value="active" checked');expect(html).toContain('name="preset" value="custom" checked');expect(html).toContain("Troubleshooting");expect(html).toMatch(/Off(?: · [^<]*)?</);
  const post = async (fields:[string,string][]) => {const body = new FormData();for (const [name,value] of fields) body.append(name,value);const request = new Request("http://fixture/settings/token-optimizer",{method:"POST",body});return (await tokenOptimizerSettingsContribution.handleAction!({request,url:new URL(request.url)}))!;};
  const refused = await post([["mode","active"],["preset","assisted"],["model",""]]);expect(refused.status).toBe(422);expect(await refused.text()).toContain("Pick a model for Model-assisted");expect(service.snapshot().policy.loop).toBe("off");
  expect((await post([["mode","observe"],["preset","basic"],["budget.callsPerSession","0"]])).status).toBe(422);
  const basic = await post([["mode","observe"],["preset","basic"],["microSkills","both"]]);expect(basic.status).toBe(200);expect(service.snapshot().policy).toMatchObject({enabled:true,mode:"observe",microSkills:"envfacts",loop:"rules",pruning:"propose",toolJudge:"none"});
  expect((await post([["mode","observe"],["preset","assisted"],["model",JSON.stringify({provider:"faux",id:"faux-1"})]])).status).toBe(200);expect(service.snapshot().policy).toMatchObject({microSkills:"both",loop:"judge",toolJudge:"generative",inferenceInObserve:false,generativeModel:{provider:"faux",id:"faux-1"}});
  expect((await post([["mode","off"],["preset","custom"],["loop","rules"],["savers.auditPercent","5"],["savers.templates","true"]])).status).toBe(200);expect(service.snapshot().policy).toMatchObject({enabled:false,loop:"rules",savers:{templates:true}});expect(f.native.host(f.conversation.id).id).toBe(f.host.id);expect(f.faux.state.callCount).toBe(0);
},20_000);
test("resuming a live native script freezes its mask until an idle start reads newly published policy",async () => {
  const f = await setup(), config = f.configuration.snapshot();config.policy.enabled = true;config.policy.pruning = "propose";await f.configuration.configure(config);const active = f.configuration.snapshot();active.policy.mode = "active";await f.configuration.configure(active);
  const gate = f.hold();f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"await tools.bash({command:'bun test'});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done")]);const submitted = await f.conversation.submit({type:"input",content:"Run",requestId:"live-mask"},context);await gate.entered;
  expect((await f.native.optimizer.apply(f.host,["rare"])).added).toEqual(["rare"]);await f.native.start(f.conversation,{agentId:"agent"},"resume");expect((await f.conversation.agent(context)).callable.some(tool => tool.name === "rare")).toBe(true);expect((await f.native.optimizer.status(f.host)).session?.frozenMask).toEqual([]);
  gate.release();expect((await submitted.wait(context)).status).toBe("done");await f.native.start(f.conversation,{agentId:"agent"},"resume");expect((await f.conversation.agent(context)).callable.some(tool => tool.name === "rare")).toBe(false);expect((await f.native.optimizer.status(f.host)).session?.frozenMask).toEqual(["rare"]);
},20_000);
test("prompt-time tool picks, learned-state views, context removal, saved overrides and Stop on stuck notices",async () => {
  const path = await mkdtemp(join(tmpdir(),"native-optimizer-features-")), prior = process.env.KINTSUGI_DATA_DIR;cleanups.push(() => rm(path,{recursive:true,force:true}));process.env.KINTSUGI_DATA_DIR = path;cleanups.push(async () => {if (prior === undefined) delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR = prior;});
  const f = await setup("memory",tokenOptimizerConfiguration()), service = tokenOptimizerConfiguration();let judged = 0;
  f.faux.setResponses(Array.from({length:12},() => (request) => {
    if (request.messages.some(message => JSON.stringify(message).includes("Main instructions"))) return request.messages.some(message => message.role === "toolResult") ? fauxAssistantMessage("Done") : fauxAssistantMessage([fauxToolCall("codemode",{code:"await tools.bash({command:'bun test'});"})],{stopReason:"toolUse"});
    judged++;return fauxAssistantMessage(JSON.stringify({rare:{load:false}}));
  }));
  const config = service.snapshot();Object.assign(config.policy,{enabled:true,microSkills:"envfacts",pruning:"propose",toolJudge:"generative",autoToolPicks:true,generativeModel:{provider:"faux",id:"faux-1"}});await service.configure(config);const active = service.snapshot();active.policy.mode = "active";await service.configure(active);
  // An idle prompt is prepared before admission; the task judge hides the irrelevant tool.
  await f.native.preparePrompt(f.conversation.id,"Run the tests");
  const pick = f.native.lastPick(f.conversation.id)!;expect(pick.hidden).toEqual(["rare"]);expect(pick.note).toBeNull();expect(judged).toBe(1);
  expect((await f.conversation.agent(context)).callable.some(tool => tool.name === "rare")).toBe(false);
  // Busy Agents are never re-prepared, and removal of learned context waits for idle.
  await f.harness.commit(async tx => {const sessions = await tx.doc(SessionsDoc), row = sessions.sessions[sessionKey(f.host.scope,f.host.id)]!;row.section = "<token-economizer>\nLearned repository facts are fallible data.\n- Fact one is here.\n</token-economizer>";row.injectedIds = ["fact-one"];},context);
  const gate = f.hold(), submitted = await f.conversation.submit({type:"input",content:"Run",requestId:"busy-features"},context);await gate.entered;
  await f.native.preparePrompt(f.conversation.id,"Another task");expect(f.native.lastPick(f.conversation.id)).toBe(pick);expect(judged).toBe(1);
  const action = async (suffix:string,fields:[string,string][]) => {const body = new FormData();for (const [name,value] of fields) body.append(name,value);const request = new Request("http://fixture/settings/token-optimizer"+suffix,{method:"POST",body});const response = (await tokenOptimizerSettingsContribution.handleAction!({request,url:new URL(request.url)}))!;return {status:response.status,html:await response.text()};};
  const target:[string,string][] = [["workspaceId","fixture"],["agentId","agent"]];
  const busy = await action("/remove-context",target);expect(busy.status).toBe(422);expect(busy.html).toContain("Wait until the Agent is idle");
  // The stuck notice offers Stop only for the run it is about.
  const live = (await f.harness.snapshot(LiveDoc,f.conversation.id,context))!, runId = runIdentity(live.run!);
  const notice = await f.harness.commit(tx => tx.appendEntry(OptimizerNotice,f.conversation.id,{data:{id:"stuck",text:"Still stuck.",at:1,code:"still-stuck",runId}}),context);
  const view = async () => {const snapshot:unknown = JSON.parse(JSON.stringify(await f.harness.snapshot(LiveDoc,f.conversation.id,context) ?? {}));if (!isJsonObject(snapshot)) throw new Error("Expected live state");return {conversation:(await f.harness.commit(tx => tx.conversation(f.conversation.id),context))!,entries:[notice],docs:{[LiveDoc.definition.kind]:snapshot}};};
  const ctx = {workspaceId:"fixture",agentId:"agent"}, row = async () => (tokenOptimizerIntegration.transcript!(await view()).rows ?? [])[0]!.render(ctx);
  expect(await row()).toContain(`form="${ids.abortForm(ctx)}"`);
  gate.release();expect((await submitted.wait(context)).status).toBe("done");
  expect(await row()).not.toContain("abort_form");expect(await row()).toContain("Still stuck.");
  // Settings shows the learned state, then removes this Agent's facts on request.
  let html = await tokenOptimizerSettingsContribution.render();
  for (const text of ["Fact one is here.","Remove facts from this Agent","Hidden in this session for the current task: rare","Last automatic pick","Pick tools before each new prompt","Nudges"]) expect(html).toContain(text);
  const removed = await action("/remove-context",target);expect(removed.status).toBe(200);expect(removed.html).toContain("next request won’t include learned facts");
  expect((await f.native.optimizer.status(f.host)).session?.section).toBe("");
  // Overrides for workspaces that aren't running stay visible, and Use main setting clears them.
  config.workspaces["parked-workspace"] = "off";const saved = service.snapshot();saved.workspaces["parked-workspace"] = "off";await service.configure(saved);
  html = await tokenOptimizerSettingsContribution.render();expect(html).toContain("Saved settings for other workspaces (1)");
  expect((await action("/override",[["workspaceId","parked-workspace"],["agentId",""],["mode","inherit"]])).status).toBe(200);expect(Object.hasOwn(service.snapshot().workspaces,"parked-workspace")).toBe(false);
},30_000);
test("Off writes no activity per transcript entry, enabling restarts the quiet clock, and transcript reads stay bounded",async () => {
  const f = await setup();
  const activity = async () => (await f.native.optimizer.status(f.host)).session!.transcriptActivity;
  const before = await activity();
  f.faux.setResponses([fauxAssistantMessage("One"),fauxAssistantMessage("Two")]);
  for (const id of ["off-1","off-2"]) expect((await (await f.conversation.submit({type:"input",content:"Hello",requestId:id},context)).wait(context)).status).toBe("done");
  await Bun.sleep(5);expect(await activity()).toBe(before);
  const config = f.configuration.snapshot();config.policy.enabled = true;config.policy.microSkills = "envfacts";await f.configuration.configure(config);
  expect(await activity()).toBeGreaterThan(before);
  // Bounded scans: an exclusive lower bound, an inclusive upper bound and the newest entry, without the rest of history.
  const all = (await f.conversation.entries({order:"ascending"},500,undefined,context)).items.map(entry => entry.id);expect(all.length).toBeGreaterThan(4);
  expect((await optimizerEntries(f.conversation,{after:all[1]!,upTo:all[3]!})).map(entry => entry.id)).toEqual([all[2],all[3]]);
  expect((await optimizerEntries(f.conversation,{after:all.at(-2)!,upTo:Infinity})).map(entry => entry.id)).toEqual([all.at(-1)!]);
  expect(await latestOptimizerEntry(f.conversation)).toBe(all.at(-1)!);
  for (const [section,ids] of [["Older facts",["old"]],["Newer facts",["new"]],["Older facts",["older-again"]]] as const) await f.harness.commit(tx => tx.appendEntry(ContextSnapshotEntry,f.conversation.id,{data:{sessionId:"s",section,injectedIds:[...ids]}}),context);
  expect(await carriedSnapshotIds(f.conversation,"Older facts")).toEqual(["older-again"]);expect(await carriedSnapshotIds(f.conversation,"Missing")).toEqual([]);
},20_000);
test("downgrade: a journal written with the optimizer On reopens and runs without the optimizer installed",async () => {
  const path = await mkdtemp(join(tmpdir(),"native-optimizer-downgrade-"));cleanups.push(() => rm(path,{recursive:true,force:true}));
  const tools = defineExtension({name:"tools",tools:[defineTool({name:"bash",description:"Run",parameters:Type.Object({command:Type.String()}),replay:"safe",async execute() {return {output:[{type:"text",text:"AssertionError: failed"}]};}})]});
  const configuration = new TokenOptimizerConfiguration(path), config = await configuration.load();
  Object.assign(config.policy,{enabled:true,microSkills:"envfacts",loop:"rules",pruning:"propose"});await configuration.configure(config);const active = configuration.snapshot();active.policy.mode = "active";await configuration.configure(active);
  const models = createModels(), faux = fauxProvider({tokensPerSecond:100_000});models.setProvider(faux.provider);
  let harness:Harness;const registry = createRegistry();registry.install(tools);
  const native = createNativeTokenOptimizer({workspaceId:"downgrade",models,registry,harness:() => harness,configuration});registry.install(native.optimizer.extension);
  harness = await Harness.open(await openNodeJsonlStorage(join(path,"journal"),context),{models,registry},context);
  const record = await harness.commit(tx => tx.createConversation({ownership:{kind:"ownerless"}}),context), conversation = (await harness.conversation(record.id,context))!;
  await conversation.configure({model:{provider:"faux",modelId:"faux-1"}},context);await native.attach();await native.start(conversation,{agentId:"agent"});
  faux.setResponses([fauxAssistantMessage([fauxToolCall("bash",{command:"bun test"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done")]);
  expect((await (await conversation.submit({type:"input",content:"Run",requestId:"one"},context)).wait(context)).status).toBe("done");
  await native.end(conversation.id);
  // Leave an unfinished optimizer task behind, as an abrupt upgrade-then-downgrade would.
  expect((await harness.inspect(context)).tasks.some(row => row.record.kind.startsWith("token-economizer."))).toBe(true);
  await native.detach();await harness.close(context);
  const plain = createRegistry();plain.install(tools);
  const older = await Harness.open(await openNodeJsonlStorage(join(path,"journal"),context),{models,registry:plain},context);cleanups.push(() => older.close(context));
  const reopened = (await older.conversation(record.id,context))!;faux.setResponses([fauxAssistantMessage("Still works")]);
  expect((await (await reopened.submit({type:"input",content:"Again",requestId:"two"},context)).wait(context)).status).toBe("done");
},30_000);
async function subagent(f:Awaited<ReturnType<typeof setup>>,agentId:string,instructions:string) {
  const record = await f.harness.commit(async tx => {
    const created = await tx.createConversation({ownership:{kind:"ownerless"}});
    (await tx.doc(WorkspaceAgents)).agents.push({agentId,durableId:created.id,parentId:"agent",rootId:"agent",taskName:agentId,label:agentId,title:agentId});
    return created;
  },context);
  const conversation = (await f.harness.conversation(record.id,context))!;
  await conversation.configure({model:{provider:"faux",modelId:"faux-1"},instructions},context);
  return conversation;
}
test("subagents see the root's facts and their tool use protects tools from being hidden",async () => {
  const f = await setup(), config = f.configuration.snapshot();
  Object.assign(config.policy,{enabled:true,microSkills:"envfacts",pruning:"propose",evidenceSessions:1,evidenceMinSessions:1,evidencePrompts:1});
  await f.configuration.configure(config);const active = f.configuration.snapshot();active.policy.mode = "active";await f.configuration.configure(active);
  await f.harness.commit(async tx => {const row = (await tx.doc(SessionsDoc)).sessions[sessionKey(f.host.scope,f.host.id)]!;row.section = "<token-economizer>\n- Root fact for everyone.\n</token-economizer>";row.injectedIds = ["root-fact"];},context);
  const seen:string[] = [];
  f.faux.setResponses(Array.from({length:6},() => (request) => {
    const text = JSON.stringify(request);
    if (text.includes("Subagent instructions")) {seen.push(text);return request.messages.some(message => message.role === "toolResult") ? fauxAssistantMessage("Done") : fauxAssistantMessage([fauxToolCall("rare",{})],{stopReason:"toolUse"});}
    return fauxAssistantMessage("Root done");
  }));
  const child = await subagent(f,"helper","Subagent instructions");
  expect((await (await child.submit({type:"input",content:"Use the rare helper",requestId:"child"},context)).wait(context)).status).toBe("done");
  expect(seen[0]).toContain("Root fact for everyone.");
  expect((await (await f.conversation.submit({type:"input",content:"Summarise",requestId:"root"},context)).wait(context)).status).toBe("done");
  await f.native.end(f.conversation.id);
  await settleLearning(f.harness);
  const tools = (await f.native.optimizer.status(f.host)).knowledge!.tools;
  expect(tools.used).toContain("rare");expect(tools.proposal).not.toContain("rare");
  expect((await f.native.optimizer.apply(f.host,["rare"])).added).toEqual([]);
  // One-shot and read-only Agents get no facts or nudges; their work still counts through the root's trajectory.
  const oneShot = await f.harness.commit(async tx => {const created = await tx.createConversation({ownership:{kind:"ownerless"}});(await tx.doc(WorkspaceAgents)).agents.push({agentId:"script",durableId:created.id,parentId:"agent",rootId:"agent",label:"script",title:"script",readOnly:true,oneShotCallId:"call"});return created;},context);
  expect(await f.native.domain.session(oneShot.id)).toBeNull();
  expect(await f.native.domain.session(child.id)).toMatchObject({parent:f.host.id,conversationId:child.id});
},20_000);
test("subagents get their own nudges and budget without reshaping the root's envelope",async () => {
  const f = await setup(), config = f.configuration.snapshot();
  Object.assign(config.policy,{enabled:true,loop:"rules",thresholds:{min_turns:8,gate_min_turns:8,error_outputs:3}});
  await f.configuration.configure(config);const active = f.configuration.snapshot();active.policy.mode = "active";await f.configuration.configure(active);
  await f.harness.commit(async tx => {(await tx.doc(KnowledgeDoc,scopeKey(f.host.scope),f.host.scope)).envelope.resolved_turns = [20,20,20,20,20];},context);
  f.faux.setResponses(Array.from({length:6},() => (request) => request.messages.some(message => message.role === "toolResult") ? fauxAssistantMessage("Done") : fauxAssistantMessage([fauxToolCall("codemode",{code:"for(let i=0;i<45;i++) await tools.bash({command:i%2 ? 'bun test' : \"sed -i 's/a/b/' src/parser.ts\"});"})],{stopReason:"toolUse"})));
  f.fail();const child = await subagent(f,"looper","Subagent instructions");
  expect((await (await child.submit({type:"input",content:"Fix the tests",requestId:"loop"},context)).wait(context)).status).toBe("done");
  const [sub] = await f.native.subagentsOf(f.host);expect(sub?.label).toBe("looper");
  const decisions = (await f.native.optimizer.status(sub!.host)).run?.decisions ?? [];
  expect(decisions.some(decision => decision.action === "redirect" && decision.submissionId !== null)).toBe(true);
  const nudges = (await child.entries({order:"ascending"},500,undefined,context)).items.filter(OptimizerOperationEntry.is).filter(entry => entry.data.name === "optimizer.nudge");
  expect(nudges.some(entry => isJsonObject(entry.data.output) && entry.data.output.delivery === "queued")).toBe(true);
  expect(nudges.some(entry => isJsonObject(entry.data.output) && entry.data.output.delivery === "consumed")).toBe(true);
  expect((await f.native.optimizer.status(f.host)).run?.decisions ?? []).toEqual([]);
  expect((await f.harness.snapshot(KnowledgeDoc,scopeKey(f.host.scope),context))!.envelope.resolved_turns).toEqual([20,20,20,20,20]);
},30_000);
test("the real submission path picks tools for an idle prompt, with attachments, before the Agent's first request",async () => {
  const path = await mkdtemp(join(tmpdir(),"native-optimizer-runtime-"));cleanups.push(() => rm(path,{recursive:true,force:true}));
  const configuration = new TokenOptimizerConfiguration(path), config = await configuration.load();
  Object.assign(config.policy,{enabled:true,pruning:"propose",toolJudge:"generative",autoToolPicks:true,generativeModel:{provider:"faux",id:"faux-1"}});await configuration.configure(config);
  const active = configuration.snapshot();active.policy.mode = "active";await configuration.configure(active);
  const models = createModels(), faux = fauxProvider({tokensPerSecond:100_000,models:[{id:"faux-1",input:["text","image"]}]});models.setProvider(faux.provider);
  const registry = createRegistry(), order:string[] = [];let judged = "", mainTools:string[] = [];
  registry.install(defineExtension({name:"fixture-tools",tools:["rare","bash"].map(name => defineTool({name,description:`The ${name} tool`,parameters:Type.Object({}),replay:"safe",async execute() {return {output:[{type:"text",text:"ok"}]};}}))}));
  faux.setResponses(Array.from({length:4},() => (request) => {
    if (JSON.stringify(request).includes("Committed instructions")) {order.push("main");mainTools = request.messages.flatMap(message => message.role === "system" ? (message.toolsAdded ?? []).map(tool => tool.name).filter(name => !request.messages.some(other => other.role === "system" && other.toolsRemoved?.some(removed => removed.name === name))) : []);return fauxAssistantMessage("Done");}
    order.push("judge");judged = JSON.stringify(request);return fauxAssistantMessage(JSON.stringify({rare:{load:false},bash:{load:true}}));
  }));
  const load = {
    harness:async (_workspace:string,_options:WorkspaceAgentToolOptions,_timing:WriteDurableTiming,harness:() => Harness) => {const native = createNativeTokenOptimizer({workspaceId:"native-workspace",models,registry,harness,configuration});registry.install(native.optimizer.extension);return {models,registry,tokenOptimizer:native};},
    prepare:async ():Promise<AgentChange> => ({model:{provider:"faux",modelId:"faux-1"},instructions:"Committed instructions",thinkingLevel:"off"}),
    expand:async (_workspace:string,text:string) => text,
    validateModel:async () => {},
    ready:async () => {},
  };
  const runtime = await openDurableAgentRuntime(join(path,"journal"),"native-workspace",{},load);cleanups.push(() => runtime.suspend());
  const agent = await runtime.agent({agentId:"tab",label:"Agent 1",title:"Picks"});
  const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
  const submitted = await agent.submit({requestId:"picked",text:"Summarise the attached chart",images:[{type:"image",data:png,mimeType:"image/png"}]});
  expect((await submitted.wait(context)).status).toBe("done");
  expect(order).toEqual(["judge","main"]);expect(judged).toContain("Summarise the attached chart");
  expect(mainTools).toContain("bash");expect(mainTools).not.toContain("rare");
},30_000);
test("the footer chip follows mode, facts, hidden tools and suggestions, and opens the Agent's Settings row",async () => {
  const path = await mkdtemp(join(tmpdir(),"native-optimizer-chip-")), prior = process.env.KINTSUGI_DATA_DIR;cleanups.push(() => rm(path,{recursive:true,force:true}));process.env.KINTSUGI_DATA_DIR = path;cleanups.push(async () => {if (prior === undefined) delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR = prior;});
  const f = await setup("memory",tokenOptimizerConfiguration()), service = tokenOptimizerConfiguration(), changed:ConversationId[] = [];
  const unsubscribe = f.native.subscribeChips(id => changed.push(id));cleanups.push(async () => unsubscribe());
  // Chips refresh after a short debounce once optimizer state or Settings change.
  const settle = () => Bun.sleep(600);
  await settle();expect(f.native.chip(f.conversation.id)).toBeUndefined();
  const config = service.snapshot();Object.assign(config.policy,{enabled:true,microSkills:"envfacts",pruning:"propose"});await service.configure(config);
  await settle();expect(f.native.chip(f.conversation.id)).toMatchObject({mode:"observe",facts:0,hidden:0,suggestions:0,nudged:false,focus:JSON.stringify(["fixture","agent"])});
  changed.length = 0;
  await f.harness.commit(async tx => {
    const row = (await tx.doc(SessionsDoc)).sessions[sessionKey(f.host.scope,f.host.id)]!;row.injectedIds = ["one","two"];row.frozenMask = ["rare"];
    (await tx.doc(KnowledgeDoc,scopeKey(f.host.scope),f.host.scope)).tools.proposal = ["bash"];
  },context);
  await settle();expect(changed).toContain(f.conversation.id);
  expect(f.native.chip(f.conversation.id)).toMatchObject({facts:2,hidden:1,suggestions:1});
  const footer = renderAgentPaneComposerFooter({workspaceId:"fixture",agentId:"agent"},{contextPercent:null,compactAvailable:false,inputTokens:null,outputTokens:null,cost:null,modelName:"faux-1",thinkingLevel:"off",thinkingLevels:[],models:[],optimizer:f.native.chip(f.conversation.id)});
  expect(footer).toContain("✦</span>Watching · 2 facts · 1 hidden");expect(footer).toContain('data-footer-drop="0"');expect(footer).toContain("token-optimizer-chip--attention");
  expect(footer).toContain(`href="/settings?section=token-optimizer&amp;focus=${encodeURIComponent(JSON.stringify(["fixture","agent"]))}"`);expect(footer).toContain("1 tool suggestion waiting.");
  expect(renderAgentPaneComposerFooter({workspaceId:"fixture",agentId:"agent"},{contextPercent:null,compactAvailable:false,inputTokens:null,outputTokens:null,cost:null,modelName:"faux-1",thinkingLevel:"off",thinkingLevels:[],models:[]})).not.toContain("token-optimizer-chip");
  // A decision in the still-open run lights the attention dot; Watch only says it would have nudged.
  await f.harness.commit(async tx => {const run = await tx.doc(RunDoc,sessionKey(f.host.scope,f.host.id),null);run.guard = emptyGuard("run-1");run.closed = false;run.decisions = [{id:"d",runId:"run-1",action:"redirect",mode:"observe",status:"simulated",submissionId:null,reason:"envelope",text:"Try another approach.",at:1}];},context);
  await settle();expect(f.native.chip(f.conversation.id)?.nudged).toBe(true);
  expect(renderAgentPaneComposerFooter({workspaceId:"fixture",agentId:"agent"},{contextPercent:null,compactAvailable:false,inputTokens:null,outputTokens:null,cost:null,modelName:"faux-1",thinkingLevel:"off",thinkingLevels:[],models:[],optimizer:f.native.chip(f.conversation.id)})).toContain("Would have nudged this run.");
  // The focused Settings view opens this Agent's row.
  const focused = await tokenOptimizerSettingsContribution.renderFocused!(JSON.stringify(["fixture","agent"]));
  expect(focused).toMatch(/<details class="disclosure" open>[\s\S]*?agent/);
  const off = service.snapshot();off.policy.enabled = false;await service.configure(off);
  await settle();expect(f.native.chip(f.conversation.id)).toBeUndefined();
},30_000);

for (const kind of ["memory","sqlite","jsonl"] as const) test(`native ${kind}: learns between runs with loop guard off, without closing, re-counting evidence or changing its prefix`,async () => {
  const f = await setup(kind), config = f.configuration.snapshot();
  Object.assign(config.policy,{enabled:true,microSkills:"envfacts",loop:"off",pruning:"propose"});
  await f.configuration.configure(config);const active = f.configuration.snapshot();active.policy.mode = "active";await f.configuration.configure(active);
  const original = (await f.native.optimizer.status(f.host)).session!.section;
  f.fail("pytest: command not found");
  for (let i = 0;i < 4;i++) {
    f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"await tools.bash({command:'pytest'});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done")]);
    await (await f.conversation.submit({type:"input",content:"Check tests",requestId:`learn-${i}`},context)).wait(context);
    for (let wait = 0;wait < 200 && ((await f.native.optimizer.status(f.host)).session!.learning?.processed ?? 0) < i+1;wait++) {await settleLearning(f.harness);await Bun.sleep(5);}
    expect((await f.native.optimizer.status(f.host)).session!.learning?.processed).toBe(i+1);
    const status = await f.native.optimizer.status(f.host);
    expect(status.session!.ended).toBeNull();expect(status.session!.folded).toBe(false);
    expect(status.session!.section).toBe(original);
    expect(status.knowledge!.tools.sessions).toBe(1);
    expect(status.knowledge!.environment.facts.find(fact => fact.id === "absent_tool:pytest")!.life.confirms).toHaveLength(1);
    expect(status.knowledge!.environment.facts.find(fact => fact.id === "absent_tool:pytest")!.life.fire_den).toBe(1);
    const entries = (await f.conversation.entries({order:"ascending"},500,undefined,context)).items;
    const checkpoint = entries.filter(OptimizerOperationEntry.is).findLast(entry => entry.data.name === "optimizer.learn" && entry.data.status === "complete")!;
    expect(checkpoint.data.output).toMatchObject({changes:{facts:i === 0 ? [{id:"absent_tool:pytest",state:"CANDIDATE"}] : []}});
  }
  expect(f.faux.state.callCount).toBe(8); // Only the Agent's own requests: Basic makes no learning calls.
  const before = (await f.native.optimizer.status(f.host)).knowledge!.environment.now;
  f.faux.setResponses([fauxAssistantMessage("A text-only answer")]);
  await (await f.conversation.submit({type:"input",content:"Thanks",requestId:"empty-evidence"},context)).wait(context);
  for (let wait = 0;wait < 200 && ((await f.native.optimizer.status(f.host)).session!.learning?.processed ?? 0) < 5;wait++) {await settleLearning(f.harness);await Bun.sleep(5);}
  expect((await f.native.optimizer.status(f.host)).session!.learning?.processed).toBe(5);
  expect((await f.native.optimizer.status(f.host)).knowledge!.environment.now).toBe(before);
  await f.native.end(f.conversation.id);await settleLearning(f.harness);
  const ended = await f.native.optimizer.status(f.host);
  expect(ended.session!.folded).toBe(true);expect(ended.knowledge!.tools.sessions).toBe(1);expect(ended.knowledge!.tools.prompts).toBe(5);
  expect(ended.knowledge!.environment.facts.find(fact => fact.id === "absent_tool:pytest")!.life.confirms).toHaveLength(1);
  await f.native.start(f.conversation,{agentId:"agent"},"resume");
  f.fail("ruff: command not found");
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"await tools.bash({command:'ruff'});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done")]);
  await (await f.conversation.submit({type:"input",content:"Check lint",requestId:"resumed-learning"},context)).wait(context);
  for (let wait = 0;wait < 200 && ((await f.native.optimizer.status(f.host)).session!.learning?.processed ?? 0) < 6;wait++) {await settleLearning(f.harness);await Bun.sleep(5);}
  const resumed = await f.native.optimizer.status(f.host);
  expect(resumed.session!.learning?.processed).toBe(6);
  expect(resumed.knowledge!.environment.facts.find(fact => fact.id === "absent_tool:ruff")!.life.confirms).toHaveLength(1);
  expect(resumed.knowledge!.tools.sessions).toBe(1);expect(resumed.knowledge!.tools.prompts).toBe(6);expect(resumed.knowledge!.foldOrder).toHaveLength(1);
},20_000);

test("slow live learning does not block later prompts; completions coalesce and session end reconciles once",async () => {
  const f = await setup(), config = f.configuration.snapshot();
  Object.assign(config.policy,{enabled:true,microSkills:"envfacts",loop:"off",pruning:"propose"});
  await f.configuration.configure(config);const active = f.configuration.snapshot();active.policy.mode = "active";await f.configuration.configure(active);
  f.fail("pytest: command not found");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();let block = true;
  cleanups.push(async () => release.resolve());
  const original = f.native.domain.trajectory;
  f.native.domain.trajectory = async (host,cutoff,after) => {if (block) {block = false;entered.resolve();await release.promise;}return original(host,cutoff,after);};
  for (let i = 0;i < 2;i++) {
    f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"await tools.bash({command:'pytest'});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done")]);
    expect((await (await f.conversation.submit({type:"input",content:"Check",requestId:`while-learning-${i}`},context)).wait(context)).status).toBe("done");
    if (i === 0) await entered.promise;
  }
  await f.native.end(f.conversation.id);
  expect((await f.harness.inspect(context)).tasks.filter(row => ["token-economizer.fold","token-economizer.checkpoint"].includes(row.record.kind))).toHaveLength(1);
  release.resolve();await settleLearning(f.harness);
  const status = await f.native.optimizer.status(f.host);
  expect(status.session!.folded).toBe(true);expect(status.knowledge!.tools.sessions).toBe(1);expect(status.knowledge!.tools.prompts).toBe(2);
  expect(status.knowledge!.environment.facts[0]!.life.confirms).toHaveLength(1);expect(f.faux.state.callCount).toBe(4);
},20_000);

for (const kind of ["memory","sqlite","jsonl"] as const) test(`native ${kind}: optimizer operation receipts are durable display data, not model context or extra calls`,async () => {
  const f = await setup(kind);
  f.faux.setResponses([fauxAssistantMessage("Off")]);
  await (await f.conversation.submit({type:"input",content:"Hello",requestId:"off-receipts"},context)).wait(context);
  expect((await f.conversation.entries({order:"ascending"},500,undefined,context)).items.filter(OptimizerOperationEntry.is)).toHaveLength(0);
  const config = f.configuration.snapshot();Object.assign(config.policy,{enabled:true,microSkills:"envfacts",pruning:"propose"});await f.configuration.configure(config);
  const active = f.configuration.snapshot();active.policy.mode = "active";await f.configuration.configure(active);
  f.fail("pytest: command not found");f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"await tools.bash({command:'pytest'});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done")]);
  await (await f.conversation.submit({type:"input",content:"Check",requestId:"learning-receipts"},context)).wait(context);
  for (let wait = 0;wait < 200 && ((await f.native.optimizer.status(f.host)).session!.learning?.processed ?? 0) < 1;wait++) {await settleLearning(f.harness);await Bun.sleep(5);}
  const operations = (await f.conversation.entries({order:"ascending"},500,undefined,context)).items.filter(OptimizerOperationEntry.is);
  const learned = operations.filter(entry => entry.data.name === "optimizer.learn");
  expect(learned.map(entry => entry.data.status)).toEqual(["running","complete"]);
  expect(learned[0]!.data.id).toBe(learned[1]!.data.id);
  expect(learned[0]!.data.input.observations).toBe(1);
  expect(learned[1]!.data.output).toMatchObject({newFacts:["absent_tool:pytest"],changes:{facts:[{id:"absent_tool:pytest",state:"CANDIDATE"}],suggestedTools:[],withdrawnTools:[]},activePrefixChanged:false});
  expect(learned[0]!.data.startedAt).toBe(learned[0]!.data.at);
  const final = (await f.conversation.entries({order:"ascending"},500,undefined,context)).items.filter(AssistantEntry.is).at(-1)!;
  expect(learned[0]!.data.startedAt).toBeGreaterThanOrEqual(final.model![0]!.timestamp);
  expect(operations.every(entry => entry.model === undefined)).toBe(true);
  expect(JSON.stringify((await f.conversation.context(context)).messages)).not.toContain("activePrefixChanged");
  expect(f.faux.state.callCount).toBe(3);
  await f.native.optimizer.apply(f.host,["rare"]);await f.native.optimizer.restore(f.host,["rare"]);
  const actions = (await f.conversation.entries({order:"ascending"},500,undefined,context)).items.filter(OptimizerOperationEntry.is).map(entry => entry.data.name);
  expect(actions).toContain("optimizer.apply-tools");expect(actions).toContain("optimizer.restore-tools");
},20_000);

test("optimizer model receipts follow the originating Agent, include actual usage, and deduplicate replay",async () => {
  const f = await setup(), config = f.configuration.snapshot();
  Object.assign(config.policy,{enabled:true,pruning:"propose",toolJudge:"generative",generativeModel:{provider:"faux",id:"faux-1"}});await f.configuration.configure(config);
  const active = f.configuration.snapshot();active.policy.mode = "active";await f.configuration.configure(active);
  f.faux.setResponses([fauxAssistantMessage(JSON.stringify({rare:{load:false}}))]);
  await f.native.prepare(f.host,"Work without the rare tool","operation-receipt");
  const operations = (await f.conversation.entries({order:"ascending"},500,undefined,context)).items.filter(OptimizerOperationEntry.is);
  const calls = operations.filter(entry => entry.data.name === "optimizer.tool-judge");
  expect(calls.map(entry => entry.data.status)).toEqual(["queued","running","complete"]);
  expect(calls[0]!.data.input.model).toEqual({provider:"faux",id:"faux-1"});
  const job = Object.values((await f.harness.snapshot(JobsDoc,context))!.jobs)[0]!;
  expect(job.conversationId).toBe(f.conversation.id);
  expect(calls[2]!.data.output).toMatchObject({result:job.result!.text,usage:job.result!.usage,cost:job.result!.cost});
  const preparation = operations.find(entry => entry.data.name === "optimizer.prepare-tools")!;
  expect(preparation.data.at).toBeGreaterThanOrEqual(calls[2]!.data.at);
  expect(operations.indexOf(preparation)).toBeGreaterThan(operations.indexOf(calls[2]!));
  expect((await (await f.harness.root(context)).entries({order:"ascending"},500,undefined,context)).items.filter(OptimizerOperationEntry.is)).toHaveLength(0);
  await f.harness.commit(tx => recordOptimizerOperation(tx,f.conversation.id,calls[2]!.data),context);
  expect((await f.conversation.entries({order:"ascending"},500,undefined,context)).items.filter(OptimizerOperationEntry.is)).toHaveLength(operations.length);
  expect(JSON.stringify((await f.conversation.context(context)).messages)).not.toContain("operation-receipt");
  expect(f.faux.state.callCount).toBe(1);
});

test("optimizer display receipts redact and bound nested values without changing their source",async () => {
  const f = await setup(), input = {token:"must-not-persist",prompt:"Authorization: Bearer another-secret",text:"x".repeat(20_000)}, original = JSON.stringify(input);
  await f.harness.commit(tx => recordOptimizerOperation(tx,f.conversation.id,{id:"privacy",name:"optimizer.proposer",status:"complete",startedAt:1,at:2,input,output:{result:"sk-abcdefghijklmnopqrstuv",cost:null,usage:null}}),context);
  const receipt = (await f.conversation.entries({order:"ascending"},500,undefined,context)).items.filter(OptimizerOperationEntry.is)[0]!;
  expect(JSON.stringify(receipt.data)).not.toContain("must-not-persist");expect(JSON.stringify(receipt.data)).not.toContain("another-secret");expect(JSON.stringify(receipt.data)).not.toContain("sk-abcdefghijklmnopqrstuv");
  expect(String(receipt.data.input.text)).toContain("[display truncated]");expect(JSON.stringify(input)).toBe(original);
  expect(receipt.model).toBeUndefined();expect(receipt.data.output).toMatchObject({cost:null,usage:null});
});
