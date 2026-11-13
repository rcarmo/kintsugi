import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {createRegistry,Harness,MemoryStorage,ToolResultEntry,AssistantEntry,defineExtension,defineTool} from "@earendil-works/pi-durable";
import {openNodeJsonlStorage} from "@earendil-works/pi-durable/storage/jsonl/node";
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall,contentText} from "@earendil-works/pi-ai";
import {Type} from "typebox";
import {CodemodeSandbox} from "@earendil-works/pi-codemode";
import {defaultMcpRecallSettings} from "@kintsugi/token-economizer/core";
import {createWorkspaceCodemodeExtension} from "../../../codemode/src/server/extension.ts";
import {createWorkspaceMcpRuntime} from "../../src/server/mcp-runtime.ts";
import {mcpConnections} from "../../src/server/mcp-connections.ts";
import {createMcpRecallStore,McpRecallDoc,mcpAccessEpoch} from "../../src/server/mcp-recall-store.ts";
import {WorkspaceAgents} from "../../src/server/durable-workspace.ts";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const items=Array.from({length:100},(_,id)=>({id,title:`Issue ${id}`,body:`needle-${id} `+"Long description ".repeat(40)}));
async function setup(mode:"off"|"observe"|"active"="active",persistent=false){
  const directory=await mkdtemp(join(tmpdir(),"mcp-recall-")),old=process.env.KINTSUGI_DATA_DIR;process.env.KINTSUGI_DATA_DIR=directory;
  cleanup.push(async()=>{if(old===undefined)delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR=old;await rm(directory,{recursive:true,force:true});});
  let calls=0,isError=false,image=false,responseItems=items;
  const server=Bun.serve({port:0,async fetch(request){if(request.method==="GET")return new Response(null,{status:405});if(request.method==="DELETE")return new Response(null,{status:200});
    // SAFETY: Only the test SDK client sends JSON-RPC to this loopback fixture.
    const rpc=await request.json() as {id?:number;method:string};if(rpc.id===undefined)return new Response(null,{status:202});
    const result=rpc.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}:rpc.method==="tools/list"?{tools:[{name:"items",inputSchema:{type:"object",properties:{}},outputSchema:{type:"object",properties:{items:{type:"array",items:{type:"object"}}},required:["items"]}}]}:(calls++,{isError,content:image?[{type:"image",data:"aGVsbG8=",mimeType:"image/png"}]:[{type:"text",text:JSON.stringify({items:responseItems})}],structuredContent:{items:responseItems}});
    return Response.json({jsonrpc:"2.0",id:rpc.id,result});
  }});cleanup.push(async()=>{server.stop(true);});
  const connections=await mcpConnections();await connections.save({id:"fixture",name:"fixture",url:server.url.href,allowHttp:true,bearer:"offline-token",timeoutSeconds:2,enabled:true,workspaceId:"workspace",agentIds:["agent"],recall:{...defaultMcpRecallSettings(),mode}});
  const registry=createRegistry();registry.install(createWorkspaceCodemodeExtension("workspace",new CodemodeSandbox(),async()=>({text:""})));
  registry.install(defineExtension({name:"fixture.local",tools:[defineTool({name:"local_probe",description:"Local fixture data",callers:["tools"],parameters:Type.Object({}),async execute(){return {output:[{type:"text",text:"local result"}]};}})]}));
  const models=createModels(),faux=fauxProvider({tokensPerSecond:100000});models.setProvider(faux.provider);let harness:Harness;
  const open=async()=>Harness.open(persistent?await openNodeJsonlStorage(join(directory,"journal"),context):new MemoryStorage(),{registry,models},context);harness=await open();
  const conversation=await harness.root(context);await conversation.configure({model:{provider:"faux",modelId:"faux-1"}},context);await harness.commit(async tx=>{const catalog=await tx.doc(WorkspaceAgents);catalog.workspaceId="workspace";catalog.agents.push({agentId:"agent",durableId:conversation.id,label:"Agent",title:"Agent"});},context);
  const runtime=createWorkspaceMcpRuntime("workspace",registry,()=>harness,connections);await runtime.attach();cleanup.push(async()=>{await runtime.close();await harness.close(context);});
  let now=Date.now();const store=createMcpRecallStore("workspace",()=>harness,connections,()=>now);
  async function run(code:string,check?:(text:string)=>void){faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code})],{stopReason:"toolUse"}),request=>{check?.(request.messages.filter(message=>message.role==="toolResult").map(message=>contentText(message.content)).at(-1)??"");return fauxAssistantMessage("Done");}]);expect((await(await conversation.submit({type:"input",content:"Use MCP"},context)).wait(context)).status).toBe("done");}
  return {directory,registry,connections,faux,conversation,store,run,get harness(){return harness;},get calls(){return calls;},advance:(ms:number)=>{now+=ms;},setItems:(value:typeof items)=>{responseItems=value;},failure:()=>{isError=true;},multimodal:()=>{image=true;},async reopen(){await harness.close(context);harness=await open();}};
}
for(const mode of ["off","observe","active"] as const)test(`MCP recall ${mode}: full script values, model-only overview, no extra RPCs`,async()=>{
  const f=await setup(mode);let id="";
  await f.run("const r=await tools.mcp__fixture__items({});if(r.items.length!==100||!r.items[99].body.includes('needle-99'))throw Error('modified script result');return r;",text=>{expect(text.includes("[MCP recall")).toBe(mode==="active");if(mode==="active"){id=text.match(/mcp_[a-f0-9]{64}/)![0];expect(text).not.toContain("needle-99");}});
  expect(f.calls).toBe(1);expect(f.faux.state.callCount).toBe(2);const rows=await f.store.read(f.conversation.id,context);expect(rows.length).toBe(mode==="off"?0:2);
  if(mode!=="off"){
    const tool=(await f.conversation.entries({order:"ascending"},100,undefined,context)).items.filter(ToolResultEntry.is).at(-1)!;const message=tool.model![0]!;if(message.role!=="toolResult")throw Error("Expected result");expect(JSON.stringify(message.details)).toContain("needle-99");
    if(mode==="active"){
      await f.run(`return await tools.mcp_recall_retrieve({id:'${id}',mode:'peek',query:'needle-99',maxChars:1200});`,text=>{expect(text).toContain("needle-99");expect(text).not.toContain("[MCP recall");});expect(f.calls).toBe(1);
      await f.run("return await tools.mcp_recall_search({query:'needle-99'});",text=>{expect(text).toContain(id);});expect(f.calls).toBe(1);
    }
  }
});
test("MCP recall survives JSONL reopen and deduplicates content without caching remote effects",async()=>{
  const f=await setup("active",true);await f.run("return await tools.mcp__fixture__items({});");const before=await f.store.read(f.conversation.id,context);expect(before).toHaveLength(2);
  await f.reopen();expect((await f.store.read(f.conversation.id,context)).map(row=>row.id).sort()).toEqual(before.map(row=>row.id).sort());
  const conversation=(await f.harness.conversation(f.conversation.id,context))!;f.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"return await tools.mcp__fixture__items({});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done")]);await(await conversation.submit({type:"input",content:"Again"},context)).wait(context);
  const after=await f.store.read(conversation.id,context);expect(after).toHaveLength(2);expect(after.every(row=>row.hits===2)).toBe(true);expect(f.calls).toBe(2);
});
test("retention, paging, pins and forgetting are bounded and leave source journal evidence intact",async()=>{
  const f=await setup();await f.run("return await tools.mcp__fixture__items({});");const rows=await f.store.read(f.conversation.id,context),row=rows.find(row=>row.kind==="emitted-text")!;
  await f.run(`return await tools.mcp_recall_retrieve({id:'${row.id}',mode:'full',maxChars:512});`,text=>{expect(text).toMatch(/"nextOffset"\s*:\s*512/);expect(text.length).toBeLessThan(1600);});
  await f.store.change(f.conversation.id,"pin",row.id,false,true,context);f.advance(8*86_400_000);expect((await f.store.read(f.conversation.id,context)).map(row=>row.id)).toEqual([row.id]);
  await f.store.change(f.conversation.id,"forget",row.id,false,false,context);expect(await f.store.read(f.conversation.id,context)).toHaveLength(0);
  expect(JSON.stringify((await f.conversation.entries({order:"ascending"},100,undefined,context)).items)).toContain("needle-99");
});
test("Agent/branch scope and current connection grants protect archived results",async()=>{
  const f=await setup();await f.run("return await tools.mcp__fixture__items({});");const rows=await f.store.read(f.conversation.id,context),boundary=(await f.conversation.entries({order:"ascending"},100,undefined,context)).items.filter(AssistantEntry.is).at(-1)!;
  const fork=await f.conversation.fork(boundary.id,{ownership:{kind:"ownerless"}},context);await f.harness.commit(async tx=>{(await tx.doc(WorkspaceAgents)).agents[0]!.branches=[f.conversation.id,fork.id];},context);expect((await f.store.read(fork.id,context)).map(row=>row.id).sort()).toEqual(rows.map(row=>row.id).sort());
  const other=await f.harness.commit(async tx=>{const record=await tx.createConversation({ownership:{kind:"ownerless"}});(await tx.doc(WorkspaceAgents)).agents.push({agentId:"other",durableId:record.id,label:"Other",title:"Other"});return record;},context);expect(await f.store.read(other.id,context)).toHaveLength(0);
  const config=f.connections.credential("fixture")!,epoch=mcpAccessEpoch(config);await f.connections.save({...config,recall:{...config.recall!,maxItems:1}});expect(mcpAccessEpoch(f.connections.credential("fixture")!)).toBe(epoch);expect(await f.store.read(f.conversation.id,context)).toHaveLength(1);
  await f.connections.save({...f.connections.credential("fixture")!,enabled:false});expect(await f.store.read(f.conversation.id,context)).toHaveLength(0);
  await f.connections.save({...f.connections.credential("fixture")!,enabled:true,bearer:"different-principal"});expect(mcpAccessEpoch(f.connections.credential("fixture")!)).not.toBe(epoch);expect(await f.store.read(f.conversation.id,context)).toHaveLength(0);
});
test("MCP error results and multimodal responses do not become model summaries",async()=>{
  const f=await setup();f.failure();await f.run("return await tools.mcp__fixture__items({});",text=>{expect(text).not.toContain("[MCP recall");});expect((await f.store.read(f.conversation.id,context)).every(row=>row.kind==="mcp-envelope")).toBe(true);
  const g=await setup();g.multimodal();await g.run("const r=await tools.mcp__fixture__items({});return {count:r.items.length};",text=>{expect(text).not.toContain("[MCP recall");});expect(await g.store.read(g.conversation.id,context)).toHaveLength(0);
});

test("small filtered values stay verbatim; profiles affect only the final overview",async()=>{
  const f=await setup();await f.run("const r=await tools.mcp__fixture__items({});return {title:r.items[99].title};",text=>{expect(text).toContain("Issue 99");expect(text).not.toContain("[MCP recall");});expect(await f.store.read(f.conversation.id,context)).toHaveLength(1);
  await f.connections.save({...f.connections.credential("fixture")!,recall:{...defaultMcpRecallSettings(),mode:"active",profiles:[{name:"titles",tool:"mcp__*__items",kind:"json-list",fields:["title"],maxItems:2}]}});
  await f.run("return await tools.mcp__fixture__items({});",text=>{expect(text).toContain("Issue 1");expect(text).not.toContain("Issue 2");});
  expect((await f.store.read(f.conversation.id,context)).find(row=>row.kind==="emitted-text")?.handler).toBe("profile:titles");expect(f.calls).toBe(2);
});
test("oversize values pass through without a retained partial substitute",async()=>{
  const f=await setup();f.setItems([{id:0,title:"Large",body:"x".repeat(1100000)}]);await f.run("const r=await tools.mcp__fixture__items({});if(r.items[0].body.length!==1100000)throw Error('clipped script value');return r;",text=>{expect(text).not.toContain("[MCP recall");});expect(await f.store.read(f.conversation.id,context)).toHaveLength(0);expect(f.calls).toBe(1);
});
test("hard payload caps respect pins and invalid profiles cannot enter the connection store",async()=>{
  const f=await setup();const config=f.connections.credential("fixture")!;
  await f.connections.save({...config,recall:{...defaultMcpRecallSettings(),mode:"active",maxBytes:4096}});
  const capture=(raw:string)=>f.store.capture(f.conversation.id,{grants:[{connectionId:config.id,epoch:mcpAccessEpoch(config)}],tool:"fixture",kind:"emitted-text",raw,summary:"",handler:"passthrough",sources:[],isError:false},context);
  const first=(await capture("a".repeat(3000)))!;await f.store.change(f.conversation.id,"pin",first.id,false,true,context);expect(await capture("b".repeat(5000))).toBeNull();expect((await f.store.read(f.conversation.id,context)).map(row=>row.id)).toEqual([first.id]);
  await f.connections.save({...f.connections.credential("fixture")!,recall:{...defaultMcpRecallSettings(),mode:"active",maxBytes:4096,maxItems:1}});expect(await capture("c".repeat(3000))).toBeNull();
  await expect(f.connections.save({...config,recall:{...defaultMcpRecallSettings(),profiles:[{name:"bad",tool:"*",kind:"text",maxItems:21}]}})).rejects.toThrow();
});

test("mixed-source scripts are not reduced and a fork before capture has no future data",async()=>{
  const f=await setup();await f.run("const r=await tools.mcp__fixture__items({});await tools.local_probe({});return r;",text=>{expect(text).not.toContain("[MCP recall");});expect(await f.store.read(f.conversation.id,context)).toHaveLength(1);
  const boundary=(await f.conversation.entries({order:"ascending"},100,undefined,context)).items.filter(AssistantEntry.is)[0]!;
  const fork=await f.conversation.fork(boundary.id,{ownership:{kind:"ownerless"}},context);await f.harness.commit(async tx=>{(await tx.doc(WorkspaceAgents)).agents[0]!.branches=[f.conversation.id,fork.id];},context);expect(await f.store.read(fork.id,context)).toHaveLength(0);
});
test("reducing hard caps can evict a pinned retained copy",async()=>{
  const f=await setup();await f.run("return await tools.mcp__fixture__items({});");const row=(await f.store.read(f.conversation.id,context))[0]!;await f.store.change(f.conversation.id,"pin",row.id,false,true,context);
  await f.connections.save({...f.connections.credential("fixture")!,recall:{...defaultMcpRecallSettings(),mode:"active",maxBytes:4096}});expect(await f.store.read(f.conversation.id,context)).toHaveLength(0);
});

test("recall never expands a deliberately tiny code-mode output budget",async()=>{
  const f=await setup();await f.run('// @options: {"max_output_tokens": 100}\nreturn await tools.mcp__fixture__items({});',text=>{expect(text).not.toContain("[MCP recall");expect(text.length).toBeLessThan(1000);});expect(f.calls).toBe(1);
});
test("parallel duplicate MCP calls retain one source and leave script values intact",async()=>{
  const f=await setup();await f.run("const r=await Promise.all([tools.mcp__fixture__items({}),tools.mcp__fixture__items({})]);if(r[1].items.length!==100)throw Error('modified');return r[0];",text=>{expect(text).toContain("[MCP recall");});const rows=await f.store.read(f.conversation.id,context);expect(rows).toHaveLength(2);expect(rows.find(row=>row.kind==="mcp-envelope")?.hits).toBe(2);expect(f.calls).toBe(2);
});
test("a script mixing On and Off connections is never reduced",async()=>{
  const f=await setup();await f.connections.save({...f.connections.credential("fixture")!,id:"fixture-off",name:"fixture_off",recall:defaultMcpRecallSettings()});await f.run("const a=await tools.mcp__fixture__items({});const b=await tools.mcp__fixture_off__items({});return {a,b};",text=>{expect(text).not.toContain("[MCP recall");});const rows=await f.store.read(f.conversation.id,context);expect(rows).toHaveLength(1);expect(rows[0]?.kind).toBe("mcp-envelope");expect(f.calls).toBe(2);
});
