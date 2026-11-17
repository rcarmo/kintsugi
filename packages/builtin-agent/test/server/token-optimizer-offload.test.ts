import {afterEach,expect,test,spyOn} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtemp,rm} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {contentText,createModels,fauxProvider,fauxAssistantMessage,fauxToolCall,type Context as ModelContext} from "@earendil-works/pi-ai";
import {createRegistry,defineExtension,defineTool,Harness,MemoryStorage,ToolResultEntry} from "@earendil-works/pi-durable";
import {openNodeJsonlStorage} from "@earendil-works/pi-durable/storage/jsonl/node";
import {Type} from "typebox";
import {CodemodeSandbox} from "@earendil-works/pi-codemode";
import {createWorkspaceCodemodeExtension} from "../../../codemode/src/server/extension.ts";
import {createNativeTokenOptimizer} from "../../src/server/token-optimizer.ts";
import {agentDatabasePath,closeAgentDatabase,workspaceAgentDatabase,type AgentDatabase} from "../../src/server/agent-database.ts";
import {TokenOptimizerConfiguration} from "../../src/server/token-optimizer-config.ts";
import {OptimizerOperationEntry} from "../../src/server/token-optimizer-operations.ts";
import {JobsDoc,ObservationsDoc} from "../../../token-economizer/src/pi-durable/documents.ts";
import {sessionKey} from "../../../token-economizer/src/core/sessions.ts";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const big=Array.from({length:300},(_,i)=>i===249?"line 250: NEEDLE-ALPHA failed in src/parser.ts":`line ${i+1}: value-${i+1}`).join("\n");
const huge=Array.from({length:1000},(_,i)=>i===0?"HEAD-MARKER first line":`row ${i+1}`).join("\n");
const outputs=new Map(Object.entries({"cat big.log":{text:big,truncated:false},"cat huge.log":{text:huge.split("\n").slice(-100).join("\n")+"\n\n[Output truncated: showing the last 1 KB of output. Full output: /home/agent/.local/state/kintsugi/agent-bash/00000000-0000-4000-8000-000000000000/output.log]",truncated:true},"echo small":{text:"one\ntwo",truncated:false}}));
type Options={mode?:"observe"|"active";summaries?:boolean;persistent?:boolean;database?:AgentDatabase};
async function setup(options:Options={}) {
  const mode=options.mode??"active",dir=await mkdtemp(join(tmpdir(),"optimizer-offload-")),old=process.env.KINTSUGI_DATA_DIR;process.env.KINTSUGI_DATA_DIR=dir;
  cleanup.push(async()=>{if(old===undefined)delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
  const configuration=new TokenOptimizerConfiguration(dir);await configuration.load();const config=configuration.snapshot();
  Object.assign(config.policy,{enabled:true,mode,offloadOutputs:true,outputSummaries:options.summaries??false,generativeModel:{provider:"faux",id:"faux-1"}});await configuration.configure(config);
  if(mode==="active"){const active=configuration.snapshot();active.policy.mode="active";await configuration.configure(active);}
  const models=createModels(),faux=fauxProvider({tokensPerSecond:100000});models.setProvider(faux.provider);
  const registry=createRegistry();let harness:Harness,calls=0;const reads:string[]=[];
  registry.install(createWorkspaceCodemodeExtension("fixture",new CodemodeSandbox(),async()=>({text:""})));
  registry.install(defineExtension({name:"fixtures",tools:[defineTool({name:"bash",description:"Run",parameters:Type.Object({command:Type.String()}),structuredOutputSchema:Type.Object({output:Type.String(),exitCode:Type.Integer(),truncated:Type.Boolean(),timedOut:Type.Boolean(),aborted:Type.Boolean(),fullOutputPath:Type.Optional(Type.String())}),replay:"safe",async execute(input){
    calls++;const output=outputs.get(input.command)!,path="/home/agent/.local/state/kintsugi/agent-bash/00000000-0000-4000-8000-000000000000/output.log";
    const structuredOutput={output:output.text,exitCode:0,truncated:output.truncated,timedOut:false,aborted:false};
    return {output:[{type:"text",text:output.text}],structuredOutput:output.truncated?{...structuredOutput,fullOutputPath:path}:structuredOutput,details:{fullOutputPath:path,exitCode:0}};
  }})]}));
  const native=createNativeTokenOptimizer({workspaceId:"fixture",models,registry,harness:()=>harness,configuration,database:options.database,readSavedOutput:async path=>{reads.push(path);return {status:"available",text:huge,truncated:false};}});
  registry.install(native.optimizer.extension);
  const open=async()=>Harness.open(options.persistent?await openNodeJsonlStorage(join(dir,"journal"),context):new MemoryStorage(),{models,registry},context);
  harness=await open();cleanup.push(async()=>{await native.close();await harness.close(context);await closeAgentDatabase("fixture");});
  const conversation=await harness.root(context);await conversation.configure({model:{provider:"faux",modelId:"faux-1"},instructions:"Fixture instructions"},context);
  await native.attach();const host=(await native.start(conversation,{agentId:"agent"}))!;
  const entries=async()=>(await conversation.entries({order:"ascending"},1000,undefined,context)).items;
  const file=await agentDatabasePath("fixture");
  const stored=()=>{if(!existsSync(file))return [];const db=new Database(file,{readonly:true});try{return db.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE name='tool_outputs'").get()?db.query<{id:string;owner:string;lines:number;complete:number},[]>("SELECT id,owner,lines,complete FROM tool_outputs").all():[];}finally{db.close();}};
  return {native,faux,host,conversation,entries,stored,reads,calls:()=>calls,get harness(){return harness;},async reopen(){await native.detach();await harness.close(context);harness=await open();return (await harness.conversation(conversation.id,context))!;}};
}
const toolTexts=(request:ModelContext)=>request.messages.filter(message=>message.role==="toolResult").map(message=>contentText(message.content));
const isSummary=(request:ModelContext)=>JSON.stringify(request.messages).includes("Summarise this tool output");

test("long bash output is stored once; the Agent searches and reads it back in bounded windows",async()=>{
  const f=await setup();let id="";
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash",{command:"cat big.log"})],{stopReason:"toolUse"}),
    request=>{const text=toolTexts(request).at(-1)!;expect(text).toContain("[Stored bash output out_");expect(text).not.toContain("line 150:");expect(text).toContain("line 300:");id=/out_[a-f0-9]{32}/.exec(text)![0];return fauxAssistantMessage([fauxToolCall("read_tool_output",{id,start:249,lines:2})],{stopReason:"toolUse"});},
    request=>{const read=JSON.parse(toolTexts(request).at(-1)!);expect(read).toMatchObject({startLine:249,endLine:250,totalLines:300});expect(read.text).toContain("NEEDLE-ALPHA");return fauxAssistantMessage([fauxToolCall("search_tool_output",{query:"NEEDLE ALPHA parser"})],{stopReason:"toolUse"});},
    request=>{const found=JSON.parse(toolTexts(request).at(-1)!);expect(found.results).toHaveLength(1);expect(found.results[0]).toMatchObject({id,tool:"bash",label:"cat big.log"});return fauxAssistantMessage("Done");},
  ]);
  expect((await(await f.conversation.submit({type:"input",content:"Inspect the log"},context)).wait(context)).status).toBe("done");
  expect(f.calls()).toBe(1);expect(f.faux.state.callCount).toBe(4);expect(f.stored()).toEqual([{id,owner:"agent",lines:300,complete:1}]);
  const message=(await f.entries()).find(ToolResultEntry.is)!.model![0]!;if(message.role!=="toolResult")throw Error("Expected tool result");
  expect(message.details).toMatchObject({optimizerRawOutput:big,optimizerOffload:{id,lines:300,summarized:false,applied:true}});
  // Learning keeps using the raw output, not the preview.
  expect((await f.harness.snapshot(ObservationsDoc,sessionKey(f.host.scope,f.host.id),context))!.observations[0]!.output).toContain("line 150:");
});

test("Watch only measures the saving without storing or changing what the Agent sees; short output is untouched",async()=>{
  const f=await setup({mode:"observe"});
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash",{command:"cat big.log"})],{stopReason:"toolUse"}),request=>{expect(toolTexts(request).at(-1)).toBe(big);return fauxAssistantMessage([fauxToolCall("bash",{command:"echo small"})],{stopReason:"toolUse"});},request=>{expect(toolTexts(request).at(-1)).toBe("one\ntwo");return fauxAssistantMessage("Done");}]);
  await(await f.conversation.submit({type:"input",content:"Inspect"},context)).wait(context);
  const [long,short]=(await f.entries()).filter(ToolResultEntry.is).map(entry=>entry.model![0]!);
  expect(long?.role==="toolResult"&&long.details).toMatchObject({optimizerOffload:{id:null,lines:300,applied:false}});
  expect(short?.role==="toolResult"&&short.details).not.toHaveProperty("optimizerOffload");expect(f.stored()).toEqual([]);
});

test("a truncated bash result stores the complete saved log, including lines the model never saw",async()=>{
  const f=await setup();
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash",{command:"cat huge.log"})],{stopReason:"toolUse"}),request=>{const text=toolTexts(request).at(-1)!;expect(text).toContain("1000 lines");expect(text).toContain("HEAD-MARKER");return fauxAssistantMessage([fauxToolCall("read_tool_output",{id:/out_[a-f0-9]{32}/.exec(text)![0],start:1,lines:1})],{stopReason:"toolUse"});},request=>{expect(JSON.parse(toolTexts(request).at(-1)!).text).toBe("HEAD-MARKER first line");return fauxAssistantMessage("Done");}]);
  await(await f.conversation.submit({type:"input",content:"Inspect"},context)).wait(context);
  expect(f.reads).toEqual(["/home/agent/.local/state/kintsugi/agent-bash/00000000-0000-4000-8000-000000000000/output.log"]);expect(f.stored()[0]).toMatchObject({lines:1000,complete:1});
});

test("code mode scripts keep raw values; only the emitted result is stored, and retrieval results are never stored again",async()=>{
  const f=await setup();let id="";
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode",{code:'const result=await tools.bash({command:"cat big.log"});if(!result.output.includes("line 150:"))throw Error("script received a preview");return result.output;'})],{stopReason:"toolUse"}),
    request=>{const text=toolTexts(request).at(-1)!;expect(text).toContain("[Stored codemode output out_");id=/out_[a-f0-9]{32}/.exec(text)![0];return fauxAssistantMessage([fauxToolCall("codemode",{code:`return (await tools.read_tool_output({id:"${id}",fromEnd:true,lines:300})).text;`})],{stopReason:"toolUse"});},
    request=>{const text=toolTexts(request).at(-1)!;expect(text).toContain("line 150:");expect(text).not.toContain("[Stored");return fauxAssistantMessage("Done");},
  ]);
  expect((await(await f.conversation.submit({type:"input",content:"Inspect"},context)).wait(context)).status).toBe("done");
  expect(f.stored().map(row=>row.id)).toEqual([id]);
});

test("optional summaries use the optimizer model through its accounted queue; failures fall back to the preview",async()=>{
  const f=await setup({summaries:true});
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash",{command:"cat big.log"})],{stopReason:"toolUse"}),
    request=>{expect(isSummary(request)).toBe(true);const prompt=JSON.stringify(request.messages);expect(prompt).toContain("cat big.log");expect(prompt).toContain("untrusted data");return fauxAssistantMessage("Summary\n- 300 numbered lines; line 250 reports NEEDLE-ALPHA in src/parser.ts.\nWarnings/errors\n- none");},
    request=>{const text=toolTexts(request).at(-1)!;expect(text).toContain("Summary written by the optimizer model");expect(text).toContain("line 250 reports NEEDLE-ALPHA");expect(text).toContain("line 300:");return fauxAssistantMessage([fauxToolCall("bash",{command:"cat huge.log"})],{stopReason:"toolUse"});},
    request=>{expect(isSummary(request)).toBe(true);return fauxAssistantMessage("",{stopReason:"error",errorMessage:"provider unavailable"});},
    request=>{const text=toolTexts(request).at(-1)!;expect(text).toContain("Preview (first and last lines)");expect(text).not.toContain("Summary written");return fauxAssistantMessage("Done");},
  ]);
  expect((await(await f.conversation.submit({type:"input",content:"Inspect"},context)).wait(context)).status).toBe("done");
  const jobs=Object.values((await f.harness.snapshot(JobsDoc,context))!.jobs).filter(job=>job.request.purpose==="output-summary");
  expect(jobs.map(job=>job.status).sort()).toEqual(["complete","failed"]);expect(jobs.every(job=>job.request.deadlineMs<=15_000)).toBe(true);
  expect((await f.entries()).filter(OptimizerOperationEntry.is).some(entry=>entry.data.name==="optimizer.output-summary"&&entry.data.status==="complete")).toBe(true);
  const results=(await f.entries()).filter(ToolResultEntry.is).map(entry=>entry.model![0]!);
  expect(results.map(message=>message.role==="toolResult"?message.details:null)).toMatchObject([{optimizerOffload:{summarized:true}},{optimizerOffload:{summarized:false}}]);
});

test("the committed projection survives JSONL reopen without rerunning, re-storing or re-summarising",async()=>{
  const f=await setup({persistent:true,summaries:true});
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash",{command:"cat big.log"})],{stopReason:"toolUse"}),fauxAssistantMessage("Summary\n- 300 lines including NEEDLE-ALPHA.\nWarnings/errors\n- none"),fauxAssistantMessage("Done")]);
  await(await f.conversation.submit({type:"input",content:"Inspect"},context)).wait(context);
  const before=JSON.stringify((await f.entries()).filter(ToolResultEntry.is)),stored=f.stored();const conversation=await f.reopen();
  expect(JSON.stringify((await conversation.entries({order:"ascending"},1000,undefined,context)).items.filter(ToolResultEntry.is))).toBe(before);
  expect(f.calls()).toBe(1);expect(f.faux.state.callCount).toBe(3);expect(f.stored()).toEqual(stored);
});

test("retrieval tools are protected from tool pruning",async()=>{
  const f=await setup(),tools=(await f.native.domain.catalogue(f.host)).tools.filter(tool=>tool.name.endsWith("_tool_output"));
  expect(tools.map(tool=>[tool.name,tool.protected]).sort()).toEqual([["read_tool_output",true],["search_tool_output",true]]);
});

test("Settings store offloading limits and opt-in summaries, and refuse summaries without a model",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"optimizer-offload-settings-")),old=process.env.KINTSUGI_DATA_DIR;process.env.KINTSUGI_DATA_DIR=dir;
  cleanup.push(async()=>{if(old===undefined)delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
  const {tokenOptimizerSettingsContribution}=await import("../../src/server/token-optimizer-settings.ts"),{tokenOptimizerConfiguration}=await import("../../src/server/token-optimizer-config.ts");
  const post=async(fields:[string,string][])=>{const body=new FormData();for(const [name,value] of fields)body.append(name,value);const request=new Request("http://fixture/settings/token-optimizer",{method:"POST",body});const response=(await tokenOptimizerSettingsContribution.handleAction!({request,url:new URL(request.url)}))!;return {status:response.status,html:await response.text()};};
  expect((await post([["mode","observe"],["preset","basic"]])).status).toBe(200);
  expect(tokenOptimizerConfiguration().snapshot().policy).toMatchObject({offloadOutputs:true,reduceOutputs:true,outputSummaries:false});
  // Basic promises no extra model calls, even if a hidden summaries box was ticked earlier.
  expect((await post([["mode","observe"],["preset","basic"],["model",JSON.stringify({provider:"faux",id:"faux-1"})],["outputSummaries","true"]])).status).toBe(200);expect(tokenOptimizerConfiguration().snapshot().policy.outputSummaries).toBe(false);
  const refused=await post([["mode","observe"],["preset","custom"],["model",""],["outputSummaries","true"]]);
  expect(refused.status).toBe(422);expect(refused.html).toContain("Pick a model for optimizer calls to summarise stored outputs");
  expect((await post([["mode","observe"],["preset","custom"],["nativeChecks","true"],["offloadOutputs","true"],["model",JSON.stringify({provider:"faux",id:"faux-1"})],["outputSummaries","true"],["offload.lines","50"],["offload.kilobytes","4"],["offload.retentionDays","3"]])).status).toBe(200);
  expect(tokenOptimizerConfiguration().snapshot().policy).toMatchObject({offloadOutputs:true,outputSummaries:true,offload:{lines:50,bytes:4096,retentionDays:3}});
  const invalid=await post([["mode","observe"],["preset","custom"],["offload.lines","50"],["offload.kilobytes","4"],["offload.retentionDays","31"]]);
  expect(invalid.status).toBe(422);expect(invalid.html).toContain("Days to keep stored outputs must be a whole number from 1 to 30");
  expect(tokenOptimizerConfiguration().snapshot().policy.offload?.retentionDays).toBe(3);
});

test("detach drains in-flight output housekeeping before storage can close",async()=>{
  const original=globalThis.setInterval;let tick:(()=>Promise<number>)|undefined;
  const implementation=(...args:Parameters<typeof globalThis.setInterval>)=>{
    const [callback,ms]=args,handle=original(...args);
    if(ms===3_600_000){
      // SAFETY: this exact hourly interval is the output-prune callback, whose declared return is Promise<number>.
      tick=callback as ()=>Promise<number>;
    }
    return handle;
  };
  // SAFETY: this backend fixture uses only native function/Timer overloads, and restores the original after the test.
  const timer=spyOn(globalThis,"setInterval").mockImplementation(implementation as typeof globalThis.setInterval);
  const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();let calls=0;
  const database:AgentDatabase=async()=>{if(++calls===2){entered.resolve();await finish.promise;}return workspaceAgentDatabase("fixture")();};
  try {
    const f=await setup({database});await f.native.optimizer.drained();expect(tick).toBeDefined();
    const pruning=tick!();await entered.promise;let detached=false;
    const closing=f.native.detach().then(()=>{detached=true;});
    await Bun.sleep(5);expect(detached).toBe(false);finish.resolve();await pruning;await closing;
  }finally{finish.resolve();timer.mockRestore();}
});
test("incomplete-copy presentation does not incorrectly claim a tail-only capture",async()=>{
  const {offloadPresentation}=await import("@kintsugi/token-economizer/core");
  const text=offloadPresentation({id:"out_"+"a".repeat(32),tool:"bash",label:"fixture",lines:20,bytes:1024,complete:false,expiresAt:Date.now()+60000,exitCode:0},{summary:null,text:"captured prefix"});
  expect(text).toContain("stored copy is incomplete");expect(text).not.toContain("only the visible tail");
});
