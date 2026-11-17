import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Type} from "typebox";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {createRegistry,Harness,MemoryStorage,defineExtension,defineTool} from "@earendil-works/pi-durable";
import {CodemodeSandbox} from "@earendil-works/pi-codemode";
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {defaultMcpRecallSettings} from "@kintsugi/token-economizer/core";
import {createWorkspaceCodemodeExtension} from "../../../codemode/src/server/extension.ts";
import {createWorkspaceMcpRuntime,mcpConnectionStatus} from "../../src/server/mcp-runtime.ts";
import {createMcpRecallStore} from "../../src/server/mcp-recall-store.ts";
import {mcpConnections} from "../../src/server/mcp-connections.ts";
import {WorkspaceAgents} from "../../src/server/durable-workspace.ts";

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
test("shared HTTP discovery, schema isolation, Agent grants, stale-call revocation, recall isolation and future-workspace access",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"mcp-shared-runtime-")),old=process.env.KINTSUGI_DATA_DIR;process.env.KINTSUGI_DATA_DIR=directory;
  cleanup.push(async()=>{if(old===undefined)delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR=old;await rm(directory,{recursive:true,force:true});});
  let calls=0;
  const server=Bun.serve({port:0,async fetch(request){
    expect(request.headers.get("authorization")).toBe("Bearer private-shared-token");
    if(request.method==="GET")return new Response(null,{status:405});if(request.method==="DELETE")return new Response(null,{status:200});
    // SAFETY: Only our SDK clients send JSON-RPC to this loopback fixture.
    const rpc=await request.json() as {id?:number;method:string};if(rpc.id===undefined)return new Response(null,{status:202});
    const result=rpc.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"shared",version:"1"}}:rpc.method==="tools/list"?{tools:[{name:"identity",description:"Shared-only private catalogue",inputSchema:{type:"object",properties:{}},outputSchema:{type:"object",properties:{value:{type:"string"}},required:["value"]}}]}:{content:[{type:"text",text:JSON.stringify({value:`shared-result-${++calls}`})}],structuredContent:{value:`shared-result-${calls}`}};
    return Response.json({jsonrpc:"2.0",id:rpc.id,result});
  }});cleanup.push(async()=>{server.stop(true);});
  const connections=await mcpConnections();await connections.save({id:"shared",name:"shared",url:server.url.href,bearer:"private-shared-token",allowHttp:true,timeoutSeconds:2,enabled:true,workspaceId:"alpha",agentIds:["agent_a"],access:{kind:"workspaces",grants:[{workspaceId:"alpha",agentIds:["agent_a"]},{workspaceId:"beta",agentIds:"all"}]},recall:{...defaultMcpRecallSettings(),mode:"observe"}});
  const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();cleanup.push(async()=>release.resolve());
  async function workspace(id:string,agentId:string){
    const registry=createRegistry();registry.install(createWorkspaceCodemodeExtension(id,new CodemodeSandbox(),async()=>({text:""})));
    registry.install(defineExtension({name:"shared-test-gate",tools:[defineTool({name:"local_wait",description:"Wait for the test gate",callers:["tools"],parameters:Type.Object({}),async execute(){started.resolve();await release.promise;return {output:[{type:"text",text:"released"}]};}})]}));
    const models=createModels(),faux=fauxProvider({tokensPerSecond:100000});models.setProvider(faux.provider);
    const harness=await Harness.open(new MemoryStorage(),{registry,models},context),conversation=await harness.root(context);await conversation.configure({model:{provider:"faux",modelId:"faux-1"}},context);
    await harness.commit(async tx=>{const doc=await tx.doc(WorkspaceAgents);doc.workspaceId=id;doc.agents.push({agentId,durableId:conversation.id,label:agentId,title:agentId});},context);
    const runtime=createWorkspaceMcpRuntime(id,registry,()=>harness,connections);cleanup.push(async()=>{await runtime.close();await harness.close(context);});await runtime.attach();await runtime.ready();
    const recall=createMcpRecallStore(id,()=>harness,connections);
    return {runtime,recall,conversation,async run(allowed:boolean,code="return await tools.mcp__shared__identity({});"){
      faux.setResponses([request=>{if(!allowed)expect(JSON.stringify(request)).not.toContain("Shared-only private catalogue");expect(JSON.stringify(request)).not.toContain("private-shared-token");return fauxAssistantMessage([fauxToolCall("codemode",{code})],{stopReason:"toolUse"});},fauxAssistantMessage("Done")]);
      expect((await(await conversation.submit({type:"input",content:"Use the remote service"},context)).wait(context)).status).toBe("done");
    }};
  }
  const alpha=await workspace("alpha","agent_a"),beta=await workspace("beta","agent_b"),gamma=await workspace("gamma","agent_c");
  expect(mcpConnectionStatus("shared","alpha")!.state).toBe("connected");expect(mcpConnectionStatus("shared","beta")!.state).toBe("connected");expect(mcpConnectionStatus("shared","gamma")).toBeUndefined();expect(mcpConnectionStatus("shared")!.message).toBe("2/2 workspaces connected");
  await alpha.run(true);await beta.run(true);await gamma.run(false);expect(calls).toBe(2);
  const alphaRows=await alpha.recall.list(alpha.conversation.id,context),betaRows=await beta.recall.list(beta.conversation.id,context);const raws=async(w:typeof alpha,rows:typeof alphaRows)=>(await Promise.all(rows.map(row=>w.recall.get(w.conversation.id,row.id,context)))).map(row=>row!.raw).join(),alphaRaw=await raws(alpha,alphaRows),betaRaw=await raws(beta,betaRows);expect(alphaRows.length).toBeGreaterThan(0);expect(betaRows.length).toBeGreaterThan(0);expect(alphaRaw).toContain("shared-result-1");expect(alphaRaw).not.toContain("shared-result-2");expect(betaRaw).toContain("shared-result-2");expect(betaRaw).not.toContain("shared-result-1");expect(await gamma.recall.list(gamma.conversation.id,context)).toHaveLength(0);
  // Retain a live code-mode scope across revocation: its captured tool definitions must not authorise a later call.
  const pending=alpha.run(true,"await tools.local_wait({});return await tools.mcp__shared__identity({});");await started.promise;
  await connections.save({...connections.credential("shared")!,access:{kind:"workspaces",grants:[{workspaceId:"beta",agentIds:["different_agent"]}]}});
  release.resolve();await pending;await Promise.all([alpha.runtime.ready(),beta.runtime.ready(),gamma.runtime.ready()]);
  expect(calls).toBe(2);expect(mcpConnectionStatus("shared","alpha")).toBeUndefined();expect(mcpConnectionStatus("shared","beta")!.state).toBe("connected");
  await beta.run(false);expect(calls).toBe(2);expect(await alpha.recall.list(alpha.conversation.id,context)).toHaveLength(0);expect(await beta.recall.list(beta.conversation.id,context)).toHaveLength(0);
  expect(JSON.stringify((await alpha.conversation.entries({order:"ascending"},100,undefined,context)).items)).toContain("shared-result");
  await connections.save({...connections.credential("shared")!,access:{kind:"all"}});await Promise.all([alpha.runtime.ready(),beta.runtime.ready(),gamma.runtime.ready()]);
  await gamma.run(true);expect(calls).toBe(3);const future=await workspace("future","future_agent");await future.run(true);expect(calls).toBe(4);expect(mcpConnectionStatus("shared")!.message).toBe("4/4 workspaces connected");
  await future.runtime.close();expect(mcpConnectionStatus("shared","future")).toBeUndefined();expect(mcpConnectionStatus("shared")!.message).toBe("3/3 workspaces connected");
},15000);
