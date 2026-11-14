import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {createRegistry,Harness,MemoryStorage} from "@earendil-works/pi-durable";
import {CodemodeSandbox} from "@earendil-works/pi-codemode";
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {McpHttpError,McpSessionExpiredError,McpTimeoutError,McpConnectionClosedError} from "@earendil-works/pi-mcp";
import {McpOAuthAuthorizationRequiredError} from "@earendil-works/pi-mcp/oauth";
import {createWorkspaceCodemodeExtension} from "../../../codemode/src/server/extension.ts";
import {createWorkspaceMcpRuntime,mcpConnectionStatus} from "../../src/server/mcp-runtime.ts";
import {mcpConnections} from "../../src/server/mcp-connections.ts";
import {WorkspaceAgents} from "../../src/server/durable-workspace.ts";
import {retryableMcpFailure} from "../../src/server/mcp-client.ts";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function until(probe:()=>boolean,timeout=3000){const deadline=Date.now()+timeout;while(!probe()){if(Date.now()>deadline)throw Error("MCP condition did not settle");await Bun.sleep(10);}}
type Rpc={id?:number;method:string};
async function fixture(endpoints:Record<string,(rpc:Rpc,request:Request)=>Promise<Response>|Response>){
  const directory=await mkdtemp(join(tmpdir(),"mcp-background-")),old=process.env.KINTSUGI_DATA_DIR;process.env.KINTSUGI_DATA_DIR=directory;
  cleanup.push(async()=>{if(old===undefined)delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR=old;await rm(directory,{recursive:true,force:true});});
  const server=Bun.serve({port:0,async fetch(request){if(request.method==="GET")return new Response(null,{status:405});if(request.method==="DELETE")return new Response(null,{status:200});
    // SAFETY: Only the SDK clients in this test send JSON-RPC to this loopback fixture.
    const rpc=await request.json() as Rpc;if(rpc.id===undefined)return new Response(null,{status:202});return endpoints[new URL(request.url).pathname.slice(1)]!(rpc,request);
  }});cleanup.push(async()=>{server.stop(true);});
  const store=await mcpConnections();for(const id of Object.keys(endpoints))await store.save({id,name:id,url:new URL(id,server.url).href,bearer:"private-test-token",allowHttp:true,timeoutSeconds:10,enabled:true,workspaceId:"workspace",agentIds:["agent"]});
  const registry=createRegistry();registry.install(createWorkspaceCodemodeExtension("workspace",new CodemodeSandbox(),async()=>({text:""})));
  const models=createModels(),faux=fauxProvider({tokensPerSecond:100000});models.setProvider(faux.provider);
  const harness=await Harness.open(new MemoryStorage(),{registry,models},context);const conversation=await harness.root(context);await conversation.configure({model:{provider:"faux",modelId:"faux-1"}},context);
  await harness.commit(async tx=>{(await tx.doc(WorkspaceAgents)).agents.push({agentId:"agent",durableId:conversation.id,label:"Agent",title:"Agent"});},context);
  const runtime=createWorkspaceMcpRuntime("workspace",registry,()=>harness,store);cleanup.push(async()=>{await runtime.close();await harness.close(context);});
  return {runtime,store,conversation,faux,async call(){faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"return await tools.mcp__remote__identity({});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Done")]);return(await(await conversation.submit({type:"input",content:"Call remote"},context)).wait(context)).status;}};
}
function success(rpc:Rpc){return Response.json({jsonrpc:"2.0",id:rpc.id,result:rpc.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}:rpc.method==="tools/list"?{tools:[{name:"identity",inputSchema:{type:"object",properties:{}},outputSchema:{type:"object",properties:{value:{type:"string"}},required:["value"]}}]}:{content:[{type:"text",text:"ok"}],structuredContent:{value:"ok"}}},{headers:{"mcp-session-id":"fixture-session"}});}
test("discovery does not block attach or healthy connections and close cancels a stalled initialize",async()=>{
  const held=Promise.withResolvers<Response>(),started=Promise.withResolvers<void>();cleanup.push(async()=>held.resolve(new Response(null,{status:503})));
  const f=await fixture({slow:rpc=>{started.resolve();return held.promise;},healthy:success});
  const began=Date.now();await f.runtime.attach();expect(Date.now()-began).toBeLessThan(1000);await started.promise;
  await until(()=>mcpConnectionStatus("healthy")?.state==="connected");expect(mcpConnectionStatus("slow")?.state).toBe("connecting");
  const closing=Date.now();await f.runtime.close();expect(Date.now()-closing).toBeLessThan(1000);expect(mcpConnectionStatus("slow")).toBeUndefined();held.resolve(new Response(null,{status:503}));
});
test("background discovery has a four-connection limit",async()=>{
  const release=Promise.withResolvers<void>();cleanup.push(async()=>release.resolve());let active=0,peak=0,started=0;
  const endpoints=Object.fromEntries(Array.from({length:8},(_,n)=>[`server${n}`,async(rpc:Rpc)=>{if(rpc.method==="initialize"){started++;active++;peak=Math.max(peak,active);await release.promise;active--;}return success(rpc);} ]));
  const f=await fixture(endpoints);await f.runtime.attach();await until(()=>started===4);expect(peak).toBe(4);await Bun.sleep(30);expect(started).toBe(4);release.resolve();await f.runtime.ready();expect(started).toBe(8);expect(peak).toBeLessThanOrEqual(4);
});
test("transient discovery failures retry without running any remote tool",async()=>{
  let initializations=0,toolCalls=0;const f=await fixture({remote:rpc=>{if(rpc.method==="tools/call")toolCalls++;if(rpc.method==="initialize"&&++initializations===1)return new Response("private-test-token",{status:503});return success(rpc);}});
  await f.runtime.attach();await f.runtime.ready();expect(mcpConnectionStatus("remote")?.state).toBe("retrying");expect(mcpConnectionStatus("remote")?.nextRetryAt).toBeGreaterThan(Date.now());expect(JSON.stringify(mcpConnectionStatus("remote"))).not.toContain("private-test-token");await until(()=>mcpConnectionStatus("remote")?.state==="connected");expect(initializations).toBe(2);expect(toolCalls).toBe(0);
});
test("authentication failures require user action and never retry automatically",async()=>{
  let attempts=0;const f=await fixture({auth:()=>{attempts++;return new Response("private-test-token",{status:401});}});await f.runtime.attach();await f.runtime.ready();expect(mcpConnectionStatus("auth")?.state).toBe("unavailable");expect(mcpConnectionStatus("auth")?.nextRetryAt).toBeUndefined();await Bun.sleep(1150);expect(attempts).toBe(1);expect(JSON.stringify(mcpConnectionStatus("auth"))).not.toContain("private-test-token");
});
test("changing configuration cancels a scheduled retry and old discovery cannot resurrect a connection",async()=>{
  let attempts=0;const f=await fixture({remote:(rpc,request)=>{if(rpc.method==="initialize")attempts++;if(request.headers.get("authorization")==="Bearer private-test-token")return new Response(null,{status:503});return success(rpc);}});
  await f.runtime.attach();await f.runtime.ready();expect(mcpConnectionStatus("remote")?.state).toBe("retrying");await f.store.save({...f.store.credential("remote")!,bearer:"replacement-token"});await f.runtime.ready();expect(mcpConnectionStatus("remote")?.state).toBe("connected");await Bun.sleep(1150);expect(attempts).toBe(2);
  await f.store.save({...f.store.credential("remote")!,enabled:false});await f.runtime.ready();expect(mcpConnectionStatus("remote")).toBeUndefined();expect((await f.conversation.agent(context)).callable.some(tool=>tool.name.startsWith("mcp__remote__"))).toBe(false);
});
test("disabling an in-flight discovery prevents its late schema publication",async()=>{
  const release=Promise.withResolvers<Response>(),started=Promise.withResolvers<void>();cleanup.push(async()=>release.resolve(new Response(null,{status:503})));
  const f=await fixture({remote:rpc=>{if(rpc.method==="initialize"){started.resolve();return release.promise;}return success(rpc);}});await f.runtime.attach();await started.promise;
  await f.store.save({...f.store.credential("remote")!,enabled:false});await f.runtime.ready();release.resolve(success({id:1,method:"initialize"}));await Bun.sleep(50);expect(mcpConnectionStatus("remote")).toBeUndefined();expect((await f.conversation.agent(context)).callable.some(tool=>tool.name.startsWith("mcp__remote__"))).toBe(false);
});
test("session expiry reconnects for future calls without replaying the failed tool effect",async()=>{
  let initializations=0,toolCalls=0;const f=await fixture({remote:rpc=>{if(rpc.method==="initialize")initializations++;if(rpc.method==="tools/call"&&++toolCalls===1)return new Response(null,{status:404});return success(rpc);}});await f.runtime.attach();await f.runtime.ready();expect(await f.call()).toBe("done");expect(toolCalls).toBe(1);await until(()=>initializations===2&&mcpConnectionStatus("remote")?.state==="connected");expect(toolCalls).toBe(1);expect(await f.call()).toBe("done");expect(toolCalls).toBe(2);
});
test("retry budget is exhausted after the initial attempt and three backoffs",async()=>{
  let attempts=0;const f=await fixture({remote:()=>{attempts++;return new Response(null,{status:503});}});await f.runtime.attach();await until(()=>mcpConnectionStatus("remote")?.state==="unavailable",28000);expect(attempts).toBe(4);expect(mcpConnectionStatus("remote")?.nextRetryAt).toBeUndefined();
},35000);
test("retry classification accepts transient failures but not authentication, TLS or protocol errors",()=>{
  for(const error of [new McpHttpError(503,"offline"),new McpHttpError(429,"slow down"),new McpTimeoutError(100),new McpConnectionClosedError(),new McpSessionExpiredError()])expect(retryableMcpFailure(error)).toBe(true);
  for(const error of [new McpHttpError(401,"no"),new McpHttpError(403,"no"),new McpHttpError(404,"no endpoint"),new McpHttpError(400,"bad request"),new McpOAuthAuthorizationRequiredError(),new Error("certificate invalid"),new Error("invalid MCP schema")])expect(retryableMcpFailure(error)).toBe(false);
});

test("a briefly successful handshake does not reset a flapping connection's retry budget",async()=>{
  let initializations=0;const f=await fixture({remote:rpc=>{if(rpc.method==="initialize"&&++initializations===1)return new Response(null,{status:503});if(rpc.method==="tools/call")return new Response(null,{status:404});return success(rpc);}});
  await f.runtime.attach();await until(()=>initializations===2&&mcpConnectionStatus("remote")?.state==="connected");await f.call();expect(mcpConnectionStatus("remote")?.state).toBe("retrying");expect(mcpConnectionStatus("remote")?.nextRetryAt).toBeGreaterThan(Date.now()+3500);
});
