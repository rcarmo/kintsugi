import { tokenOptimizerSettingsContribution } from "../../src/server/token-optimizer-settings.ts";
import { carriedSnapshotIds, latestOptimizerEntry, optimizerEntries, optimizerMessageSections } from "../../src/server/token-optimizer-source.ts";
import { openDurableWorkspace } from "../../src/server/durable-workspace.ts";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { isJsonObject, type JsonObject } from "@kintsugi/core";
import { ContextSnapshotEntry, KnowledgeDoc, JobsDoc } from "../../../token-economizer/src/pi-durable/documents.ts";
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
import { AgentDoc, AssistantEntry, LiveDoc, UserEntry, createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createWorkspaceCodemodeExtension } from "../../../codemode/src/server/extension.ts";
import { createNativeTokenOptimizer, OptimizerNotice, tokenOptimizerIntegration } from "../../src/server/token-optimizer.ts";
import { SessionsDoc } from "../../../token-economizer/src/pi-durable/documents.ts";
import { sessionKey } from "../../../token-economizer/src/core/sessions.ts";
import { runIdentity } from "../../../token-economizer/src/pi-durable/run-identity.ts";
import { ids } from "@kintsugi/agent/server/render-context";
import { TokenOptimizerConfiguration, tokenOptimizerConfiguration } from "../../src/server/token-optimizer-config.ts";
const cleanups:(() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});
async function setup(kind:"memory"|"sqlite"|"jsonl" = "memory",overrideConfig?:TokenOptimizerConfiguration) {
  const path = await mkdtemp(join(tmpdir(),"native-optimizer-"));cleanups.push(() => rm(path,{recursive:true,force:true}));
  const configuration = overrideConfig ?? new TokenOptimizerConfiguration(path);await configuration.load();
  const models = createModels(), faux = fauxProvider({tokensPerSecond:100_000});models.setProvider(faux.provider);
  const registry = createRegistry();let harness:Harness, failing = false, gate:Promise<void>|null = null;const entered = Promise.withResolvers<void>();
  registry.install(createWorkspaceCodemodeExtension("fixture",new CodemodeSandbox(),async () => ({text:""})));
  registry.install(defineExtension({name:"fixture-tools",tools:[defineTool({name:"bash",description:"Run",parameters:Type.Object({command:Type.String()}),structuredOutputSchema:Type.Object({output:Type.String(),exitCode:Type.Integer(),aborted:Type.Boolean(),timedOut:Type.Boolean(),truncated:Type.Boolean()}),replay:"safe",async execute() {if (gate) {entered.resolve();await gate;gate = null;}return {structuredOutput:{output:failing ? "AssertionError: repeated test failure" : "passed",exitCode:failing ? 1 : 0,aborted:false,timedOut:false,truncated:false},details:{exitCode:failing ? 1 : 0,aborted:false,timedOut:false}};}}),defineTool({name:"rare",description:"Rare helper",parameters:Type.Object({}),execute:async () => ({output:[{type:"text",text:"done"}]})}),defineTool({name:"plan",description:"Plan",parameters:Type.Object({}),execute:async () => ({output:[{type:"text",text:"done"}]})})]}));
  const native = createNativeTokenOptimizer({workspaceId:"fixture",models,registry,harness:() => harness,configuration});registry.install(native.optimizer.extension);
  harness = await Harness.open(kind === "memory" ? new MemoryStorage() : kind === "sqlite" ? await openNodeSqliteStorage(join(path,"state.sqlite")) : await openNodeJsonlStorage(join(path,"journal"),context),{models,registry},context);cleanups.push(async () => {await native.close();await harness.close(context);});
  const root = await harness.commit(tx => tx.createConversation({ownership:{kind:"ownerless"}}),context), conversation = (await harness.conversation(root.id,context))!;
  await conversation.configure({model:{provider:"faux",modelId:"faux-1"},instructions:"Main instructions"},context);
  await native.attach();const host = (await native.start(conversation,{agentId:"agent"}))!;
  return {native,configuration,harness,conversation,host,faux,models,fail:() => {failing = true;},hold:() => {const release = Promise.withResolvers<void>();gate = release.promise;cleanups.push(async () => release.resolve());return {entered:entered.promise,release:() => release.resolve()};}};
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
  for (const task of (await f.harness.inspect(context)).tasks.filter(task => task.record.kind === "token-economizer.fold")) await f.harness.waitForTask(task.record.id,context);
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
      mainCalls++;return mainCalls === 1 ? fauxAssistantMessage([fauxToolCall("codemode",{code:"for(let i=0;i<45;i++) await tools.bash({command:'bun test'});"})],{stopReason:"toolUse"}) : fauxAssistantMessage("Done");
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
  const outcome = await (await f.conversation.submit({type:"input",content:"Run tests",requestId:"all-paths"},context)).wait(context);expect(outcome.status).toBe("done");await f.native.end(f.conversation.id);
  for (const row of (await f.harness.inspect(context)).tasks.filter(row => row.record.kind === "token-economizer.fold")) await f.harness.waitForTask(row.record.id,context);
  await f.conversation.reset(undefined,context);await f.native.reset(f.conversation,{agentId:"agent"});
  await (await f.conversation.submit({type:"input",content:"Second session",requestId:"second"},context)).wait(context);await f.native.end(f.conversation.id);
  for (const row of (await f.harness.inspect(context)).tasks.filter(row => row.record.kind === "token-economizer.fold")) await f.harness.waitForTask(row.record.id,context);
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
  for (const row of (await owner.workspace.harness.inspect(context)).tasks.filter(row => row.record.kind === "token-economizer.fold")) await owner.workspace.harness.waitForTask(row.record.id,context);
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
  release.resolve();for (const row of (await f.harness.inspect(context)).tasks.filter(row => row.record.kind === "token-economizer.fold")) await f.harness.waitForTask(row.record.id,context);
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
