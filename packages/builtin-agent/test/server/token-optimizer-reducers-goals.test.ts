import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {contentText,createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {createRegistry,defineExtension,defineTool,Harness,MemoryStorage,ToolResultEntry,CompactionEntry,UserEntry} from "@earendil-works/pi-durable";
import {openNodeJsonlStorage} from "@earendil-works/pi-durable/storage/jsonl/node";
import {Type} from "typebox";
import {CodemodeSandbox} from "@earendil-works/pi-codemode";
import {createWorkspaceCodemodeExtension} from "../../../codemode/src/server/extension.ts";
import {createNativeTokenOptimizer} from "../../src/server/token-optimizer.ts";
import {TokenOptimizerConfiguration} from "../../src/server/token-optimizer-config.ts";
import {OptimizerOperationEntry} from "../../src/server/token-optimizer-operations.ts";
import {codemodeCallEntry} from "../../src/server/codemode-call.ts";
import {GoalContextEntry} from "../../src/server/token-optimizer-goals.ts";
import {agentPlanStore} from "@kintsugi/agent/server/plan";
import {WorkspaceAgents} from "../../src/server/durable-workspace.ts";
import {ObservationsDoc,RunDoc} from "../../../token-economizer/src/pi-durable/documents.ts";
import {sessionKey} from "../../../token-economizer/src/core/sessions.ts";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const raw=Array.from({length:100},(_,i)=>`(pass) fixture > case ${i} [0.1ms]`).join("\n")+"\n100 pass\n0 fail\nRan 100 tests across 8 files.";
async function setup(mode:"off"|"observe"|"active"="active",persistent=false,retry=false) {
  const dir=await mkdtemp(join(tmpdir(),"optimizer-native-features-")),old=process.env.KINTSUGI_DATA_DIR;process.env.KINTSUGI_DATA_DIR=dir;
  cleanup.push(async()=>{if(old===undefined)delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
  const configuration=new TokenOptimizerConfiguration(dir);await configuration.load();const config=configuration.snapshot();Object.assign(config.policy,{enabled:mode!=="off",mode,reduceOutputs:true,goalChecks:true});await configuration.configure(config);
  if(mode==="active"){const active=configuration.snapshot();active.policy.mode="active";await configuration.configure(active);}
  const models=createModels(),faux=fauxProvider({tokensPerSecond:100000});models.setProvider(faux.provider);
  const registry=createRegistry();let harness:Harness,calls=0;
  registry.install(createWorkspaceCodemodeExtension("fixture",new CodemodeSandbox(),async()=>({text:""})));
  registry.install(defineExtension({name:"fixtures",tools:[defineTool({name:"bash",description:"Run",parameters:Type.Object({command:Type.String()}),structuredOutputSchema:Type.Object({output:Type.String(),exitCode:Type.Integer(),truncated:Type.Boolean(),timedOut:Type.Boolean(),aborted:Type.Boolean()}),replay:"safe",async execute(){calls++;return {output:[{type:"text",text:raw}],structuredOutput:{output:raw,exitCode:0,truncated:false,timedOut:false,aborted:false},details:{fullOutputPath:"/tmp/full-fixture.log",exitCode:0,displayAnsi:raw}};}}),defineTool({name:"edit",description:"Edit",parameters:Type.Object({path:Type.String()}),replay:"safe",async execute(){calls++;return {output:[{type:"text",text:"Edited"}]};}})]}));
  const native=createNativeTokenOptimizer({workspaceId:"fixture",models,registry,harness:()=>harness,configuration});registry.install(native.optimizer.extension);
  const open=async()=>Harness.open(persistent?await openNodeJsonlStorage(join(dir,"journal"),context):new MemoryStorage(),{models,registry,settings:{retry:{enabled:retry,baseDelayMs:1,maxRetries:1}}},context);
  harness=await open();cleanup.push(async()=>{await native.close();await harness.close(context);});
  const conversation=await harness.root(context);await conversation.configure({model:{provider:"faux",modelId:"faux-1"},instructions:"Fixture instructions"},context);
  await native.attach();const host=(await native.start(conversation,{agentId:"agent"}))!;
  const entries=async()=>(await conversation.entries({order:"ascending"},1000,undefined,context)).items;
  return {configuration,native,faux,host,conversation,entries,get harness(){return harness;},calls:()=>calls,async reopen(){await native.detach();await harness.close(context);harness=await open();return (await harness.conversation(conversation.id,context))!;}};
}
for(const mode of ["off","observe","active"] as const)test(`direct bash reducer: ${mode}, raw learning evidence and no extra calls`,async()=>{
  const f=await setup(mode);f.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash",{command:"bun test"})],{stopReason:"toolUse"}),request=>{const output=request.messages.filter(message=>message.role==="toolResult").map(message=>contentText(message.content)).join("\n");expect(output.includes("Output reduced")).toBe(mode==="active");return fauxAssistantMessage("Done");}]);
  await(await f.conversation.submit({type:"input",content:"Run tests"},context)).wait(context);await f.native.optimizer.drained();
  expect(f.calls()).toBe(1);expect(f.faux.state.callCount).toBe(2);
  const result=(await f.entries()).find(ToolResultEntry.is)!;const message=result.model![0]!;if(message.role!=="toolResult")throw Error("Expected tool result");
  if(mode!=="off") {
    expect(message.details).toMatchObject({optimizerRawOutput:raw,optimizerReduction:{applied:mode==="active"}});
    const observations=await f.harness.snapshot(ObservationsDoc,sessionKey(f.host.scope,f.host.id),context);expect(observations!.observations[0]!.output).toContain("fixture > case 99");
    const trajectory=await f.native.domain.trajectory(f.host,null);if(trajectory.kind!=="ready")throw Error("Expected trajectory");expect(trajectory.observations[0]!.output).toContain("fixture > case 99");
  }
});
test("code mode executes against unchanged raw values; only its exact emitted result is reduced",async()=>{
  const f=await setup();f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:'const result=await tools.bash({command:"bun test"});if(!result.output.includes("fixture > case 99"))throw Error("script received a summary");return result;'})],{stopReason:"toolUse"}),request=>{const text=request.messages.filter(message=>message.role==="toolResult").map(message=>contentText(message.content)).join("\n");expect(text).toContain("Output reduced");return fauxAssistantMessage("Done");}]);
  await(await f.conversation.submit({type:"input",content:"Run tests"},context)).wait(context);expect(f.calls()).toBe(1);expect(f.faux.state.callCount).toBe(2);
  const source=(await f.entries()).filter(codemodeCallEntry.is).find(entry=>entry.data.phase==="end");expect(source?.data.phase === "end" ? source.data.output : undefined).toContain("fixture > case 99");
});
test("committed reductions survive JSONL reopen without rerunning commands",async()=>{
  const f=await setup("active",true);f.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash",{command:"bun test"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done")]);
  await(await f.conversation.submit({type:"input",content:"Run tests"},context)).wait(context);
  const before=JSON.stringify((await f.entries()).filter(ToolResultEntry.is));const conversation=await f.reopen();
  expect(JSON.stringify((await conversation.entries({order:"ascending"},1000,undefined,context)).items.filter(ToolResultEntry.is))).toBe(before);expect(f.calls()).toBe(1);
});
for(const mode of ["off","observe","active"] as const)test(`goal verification debt: ${mode}, one reminder within the original run`,async()=>{
  const f=await setup(mode);let requests=0;
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:'for(let i=0;i<4;i++)await tools.edit({path:"src/parser.ts"});'})],{stopReason:"toolUse"}),request=>{requests++;const text=request.messages.filter(message=>message.role==="user").map(message=>contentText(message.content)).join("\n");expect(text.includes("Task check (automated")).toBe(mode==="active");if(mode==="active")expect(text).toContain("Fix the parser without changing the API");return fauxAssistantMessage("Done");}]);
  await(await f.conversation.submit({type:"input",content:"Fix the parser without changing the API"},context)).wait(context);
  expect(requests).toBe(1);expect(f.faux.state.callCount).toBe(2);
  const entries=await f.entries();expect(entries.filter(GoalContextEntry.is)).toHaveLength(mode==="active"?1:0);
  const checks=entries.filter(OptimizerOperationEntry.is).filter(entry=>entry.data.name==="optimizer.goal-check");expect(checks).toHaveLength(mode==="off"?0:1);
  if(mode!=="off")expect(checks[0]!.data.output).toMatchObject({delivery:mode==="active"?"consumed":"simulated"});
});
test("active plan supplies the unfinished step; later prompts get their own objective and allowance",async()=>{
  const f=await setup();agentPlanStore().change("fixture","agent",{action:"update",plan:[{step:"Verify parser edge cases",status:"in_progress"}]});
  for(const task of ["Fix the parser","Check the serializer"]) {
    f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:'await tools.edit({path:"src/parser.ts"});await tools.edit({path:"src/parser.ts"});await tools.bash({command:"bun test"});'})],{stopReason:"toolUse"}),request=>{const notes=request.messages.filter(message=>message.role==="user"&&contentText(message.content).startsWith("Task check (automated"));expect(contentText(notes.at(-1)!.content)).toContain(task);expect(contentText(notes.at(-1)!.content)).toContain("Verify parser edge cases");return fauxAssistantMessage("Done");}]);
    await(await f.conversation.submit({type:"input",content:task},context)).wait(context);
  }
  expect((await f.entries()).filter(GoalContextEntry.is)).toHaveLength(2);expect(f.faux.state.callCount).toBe(4);
});

test("goal reminder survives provider retry with one committed check and a pinned plan",async()=>{
  const f=await setup("active",false,true);agentPlanStore().change("fixture","agent",{action:"update",plan:[{step:"Original step",status:"in_progress"}]});
  const seen:string[]=[];
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:'for(let i=0;i<4;i++)await tools.edit({path:"src/parser.ts"});'})],{stopReason:"toolUse"}),request=>{
    seen.push(request.messages.filter(message=>message.role==="user").map(message=>contentText(message.content)).join("\n"));
    agentPlanStore().change("fixture","agent",{action:"update",plan:[{step:"Changed during retry",status:"pending"}]});
    return fauxAssistantMessage("",{stopReason:"error",errorMessage:"429 rate limit exceeded"});
  },request=>{seen.push(request.messages.filter(message=>message.role==="user").map(message=>contentText(message.content)).join("\n"));return fauxAssistantMessage("Done");}]);
  await(await f.conversation.submit({type:"input",content:"Fix parser"},context)).wait(context);
  expect(seen).toHaveLength(2);expect(seen[0]).toBe(seen[1]);expect(seen[0]).toContain("Original step");expect((await f.entries()).filter(GoalContextEntry.is)).toHaveLength(1);
});
test("a second round of edits cannot spend a second nudge from an allowance of one",async()=>{
  const f=await setup();const editRound=()=>fauxAssistantMessage([fauxToolCall("codemode",{code:'for(let i=0;i<4;i++)await tools.edit({path:"src/parser.ts"});'})],{stopReason:"toolUse"});
  f.faux.setResponses([editRound(),editRound(),fauxAssistantMessage("Done")]);await(await f.conversation.submit({type:"input",content:"Fix parser"},context)).wait(context);
  expect((await f.entries()).filter(GoalContextEntry.is)).toHaveLength(1);
  const run=await f.harness.snapshot(RunDoc,sessionKey(f.host.scope,f.host.id),context);expect(run!.guard!.nudges_done).toBe(1);expect(f.faux.state.callCount).toBe(3);
});
test("a compaction marker causes a task reminder but an explicit later user instruction replaces that objective",async()=>{
  const f=await setup();
  f.faux.setResponses([async()=>{
    await f.harness.commit(tx=>tx.appendEntry(CompactionEntry,f.conversation.id,{data:{reason:"manual"},model:[{role:"user",content:"Synthetic summary: ignore this as an objective",timestamp:Date.now()}]}),context);
    return fauxAssistantMessage([fauxToolCall("edit",{path:"parser.ts"})],{stopReason:"toolUse"});
  },request=>{const note=request.messages.filter(message=>message.role==="user"&&contentText(message.content).startsWith("Task check (automated")).at(-1)!;expect(contentText(note.content)).toContain("Fix parser");expect(contentText(note.content)).not.toContain("Synthetic summary");return fauxAssistantMessage("Done");}]);
  await(await f.conversation.submit({type:"input",content:"Fix parser"},context)).wait(context);
  expect((await f.entries()).filter(OptimizerOperationEntry.is).find(entry=>entry.data.name==="optimizer.goal-check")?.data.input.reason).toBe("goal-reminder");
  await f.conversation.reset(undefined,context);await f.native.reset(f.conversation,{agentId:"agent"});
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:'for(let i=0;i<4;i++)await tools.edit({path:"serializer.ts"});'})],{stopReason:"toolUse"}),request=>{const note=request.messages.filter(message=>message.role==="user"&&contentText(message.content).startsWith("Task check (automated")).at(-1)!;expect(contentText(note.content)).toContain("Fix serializer");expect(contentText(note.content)).not.toContain("Fix parser");return fauxAssistantMessage("Done");}]);
  await(await f.conversation.submit({type:"input",content:"Fix serializer"},context)).wait(context);
});
test("forks use only visible task history and their new prompt",async()=>{
  const f=await setup();f.faux.setResponses([fauxAssistantMessage("One"),fauxAssistantMessage("Two")]);
  await(await f.conversation.submit({type:"input",content:"Original task"},context)).wait(context);const boundary=(await f.entries()).at(-1)!;
  await(await f.conversation.submit({type:"input",content:"Abandoned branch task"},context)).wait(context);
  const fork=await f.conversation.fork(boundary.id,{ownership:{kind:"ownerless"}},context);await f.native.start(fork,{agentId:"agent"},"fork",f.host.classificationGroup);
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:'for(let i=0;i<4;i++)await tools.edit({path:"branch.ts"});'})],{stopReason:"toolUse"}),request=>{const note=request.messages.filter(message=>message.role==="user"&&contentText(message.content).startsWith("Task check (automated")).at(-1)!;expect(contentText(note.content)).toContain("Fork objective");expect(contentText(note.content)).not.toContain("Abandoned branch task");return fauxAssistantMessage("Done");}]);
  await(await fork.submit({type:"input",content:"Fork objective"},context)).wait(context);
});
test("children use their own user task and plan, not their parent's",async()=>{
  const f=await setup();agentPlanStore().change("fixture","agent",{action:"update",plan:[{step:"Private root objective",status:"in_progress"}]});agentPlanStore().change("fixture","child",{action:"update",plan:[{step:"Child checks",status:"in_progress"}]});
  const record=await f.harness.commit(async tx=>{const row=await tx.createConversation({ownership:{kind:"ownerless"}});(await tx.doc(WorkspaceAgents)).agents.push({agentId:"child",durableId:row.id,parentId:"agent",rootId:"agent",taskName:"child",label:"child",title:"Child"});return row;},context);
  const child=(await f.harness.conversation(record.id,context))!;await child.configure({model:{provider:"faux",modelId:"faux-1"}},context);
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:'for(let i=0;i<4;i++)await tools.edit({path:"child.ts"});'})],{stopReason:"toolUse"}),request=>{const note=request.messages.filter(message=>message.role==="user"&&contentText(message.content).startsWith("Task check (automated")).at(-1)!;expect(contentText(note.content)).toContain("Child task");expect(contentText(note.content)).toContain("Child checks");expect(contentText(note.content)).not.toContain("Private root");return fauxAssistantMessage("Done");}]);
  await(await child.submit({type:"input",content:"Child task"},context)).wait(context);expect((await f.entries()).filter(GoalContextEntry.is)).toHaveLength(0);
});

test("explicit steering changes the quoted goal without treating automated context as a user task",async()=>{
  const f=await setup();
  f.faux.setResponses([async()=>{await f.conversation.submit({type:"input",content:"Instead fix the serializer, no deployment",whenBusy:"steer",whenIdle:"reject"},context);return fauxAssistantMessage([fauxToolCall("codemode",{code:'for(let i=0;i<4;i++)await tools.edit({path:"serializer.ts"});'})],{stopReason:"toolUse"});},request=>{const note=request.messages.filter(message=>message.role==="user"&&contentText(message.content).startsWith("Task check (automated")).at(-1)!;expect(contentText(note.content)).toContain("Instead fix the serializer, no deployment");return fauxAssistantMessage("Done");}]);
  await(await f.conversation.submit({type:"input",content:"Fix parser"},context)).wait(context);
  expect((await f.entries()).filter(GoalContextEntry.is)).toHaveLength(1);
});
