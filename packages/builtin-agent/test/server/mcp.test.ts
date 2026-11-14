import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {createRegistry,Harness,MemoryStorage} from "@earendil-works/pi-durable";
import {createWorkspaceCodemodeExtension} from "../../../codemode/src/server/extension.ts";
import {createWorkspaceMcpRuntime} from "../../src/server/mcp-runtime.ts";
import {WorkspaceAgents} from "../../src/server/durable-workspace.ts";
import {CodemodeSandbox} from "@earendil-works/pi-codemode";
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall,contentText} from "@earendil-works/pi-ai";
import {connectMcpHttp,mcpEndpoint,mcpFailure} from "../../src/server/mcp-client.ts";
import {McpConnectionStore,mcpConnections} from "../../src/server/mcp-connections.ts";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const config={id:"fixture",name:"fixture",url:"https://memory.example/mcp",bearer:"private-fixture-token",allowHttp:false,timeoutSeconds:2};
test("MCP endpoints require explicit HTTP and reject URL credentials, queries and fragments",()=>{
  expect(mcpEndpoint(config.url)).toBe(config.url);
  expect(()=>mcpEndpoint("http://localhost/mcp")).toThrow();
  expect(mcpEndpoint("http://localhost/mcp",true)).toBe("http://localhost/mcp");
  for(const endpoint of ["https://user:pass@memory.example/mcp","https://memory.example/mcp?token=x","https://memory.example/mcp#secret","file:///tmp/socket"])expect(()=>mcpEndpoint(endpoint,true)).toThrow();
  expect(mcpFailure(new Error(config.bearer))).not.toContain(config.bearer);
});
test("MCP bearer requests cannot follow redirects or leave the configured endpoint",async()=>{
  let leaked=0;const destination=Bun.serve({port:0,fetch(){leaked++;return new Response("leak");}});cleanup.push(async()=>{destination.stop(true);});
  const redirect=Bun.serve({port:0,fetch(){return Response.redirect(destination.url,307);}});cleanup.push(async()=>{redirect.stop(true);});
  await expect(connectMcpHttp({...config,url:redirect.url.href,allowHttp:true})).rejects.toThrow();expect(leaked).toBe(0);
});
test("MCP connection persistence is private, redacts listings and revisions revoke stale credentials",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"kintsugi-mcp-"));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const store=new McpConnectionStore(directory);await store.load();let changes=0;store.watch(async()=>{changes++;});
  await store.save({...config,enabled:true,workspaceId:"workspace",agentIds:["agent"]});
  expect(JSON.stringify(store.list())).not.toContain(config.bearer);expect(store.credential(config.id)?.revision).toBe(1);
  expect((await stat(join(directory,"mcp/connections.json"))).mode&0o777).toBe(0o600);
  const reopened=new McpConnectionStore(directory);await reopened.load();expect(reopened.credential(config.id)?.bearer).toBe(config.bearer);
  await store.save({...store.credential(config.id)!,enabled:false});expect(store.credential(config.id)?.revision).toBe(2);
  await store.remove(config.id);expect(store.list()).toHaveLength(0);expect(changes).toBe(3);
});
test("native MCP adapter exposes only code mode, preserves structured results and rechecks access on every call",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"mcp-runtime-")),old=process.env.KINTSUGI_DATA_DIR;process.env.KINTSUGI_DATA_DIR=directory;
  cleanup.push(async()=>{if(old===undefined)delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR=old;await rm(directory,{recursive:true,force:true});});
  let rpcCalls=0,stall=false;const methods:string[]=[],started=Promise.withResolvers<void>(),pending=Promise.withResolvers<Response>();
  cleanup.push(async()=>{pending.resolve(Response.json({}));});
  const server=Bun.serve({port:0,async fetch(request){
    expect(request.headers.get("authorization")).toBe(`Bearer ${config.bearer}`);
    if(request.method==="GET")return new Response(null,{status:405});
    if(request.method==="DELETE")return new Response(null,{status:200});
    // SAFETY: This loopback test server receives only JSON-RPC requests from the SDK client below.
    const rpc=await request.json() as {id?:number;method:string};methods.push(rpc.method);
    if(rpc.id===undefined)return new Response(null,{status:202});
    if(rpc.method==="tools/call"&&stall){rpcCalls++;started.resolve();return pending.promise;}
    const result=(()=>{switch(rpc.method){
      case "initialize":return {protocolVersion:"2025-03-26",capabilities:{tools:{},resources:{}},serverInfo:{name:"fixture",version:"1"}};
      case "tools/list":return {tools:[{name:"items",description:"List items",inputSchema:{type:"object",properties:{}},outputSchema:{type:"object",properties:{items:{type:"array",items:{type:"string"}}},required:["items"]}}]};
      case "tools/call":rpcCalls++;return {content:[{type:"text",text:'{"items":["alpha","beta"]}'}],structuredContent:{items:["alpha","beta"]}};
      case "resources/list":return {resources:[{uri:"memory://catalog",name:"catalog"}]};
      case "resources/templates/list":return {resourceTemplates:[]};
      case "resources/read":return {contents:[{uri:"memory://catalog",text:"Fixture catalog"}]};
      default:throw new Error(`Unexpected RPC ${rpc.method}`);
    }})();
    return Response.json({jsonrpc:"2.0",id:rpc.id,result},{headers:{"mcp-session-id":"fixture-session"}});
  }});cleanup.push(async()=>{server.stop(true);});
  const store=await mcpConnections();await store.save({...config,url:server.url.href,allowHttp:true,enabled:true,workspaceId:"workspace",agentIds:["allowed"]});
  const registry=createRegistry();registry.install(createWorkspaceCodemodeExtension("workspace",new CodemodeSandbox(),async()=>({text:""})));
  const models=createModels(),faux=fauxProvider({tokensPerSecond:100000});models.setProvider(faux.provider);
  const harness=await Harness.open(new MemoryStorage(),{registry,models},context);cleanup.push(()=>harness.close(context));
  const conversation=await harness.root(context);await conversation.configure({model:{provider:"faux",modelId:"faux-1"}},context);
  await harness.commit(async tx=>{(await tx.doc(WorkspaceAgents)).agents.push({agentId:"allowed",durableId:conversation.id,label:"Allowed",title:"Allowed"});},context);
  const runtime=createWorkspaceMcpRuntime("workspace",registry,()=>harness,store);await runtime.attach();await runtime.ready();cleanup.push(()=>runtime.close());
  faux.setResponses([request=>{expect(request.messages.flatMap(message=>message.role==="system"?(message.toolsAdded??[]).map(tool=>tool.name):[])).toEqual(["codemode"]);return fauxAssistantMessage([fauxToolCall("codemode",{code:"const r=await tools.mcp__fixture__items({});const catalog=await tools.mcp__fixture__resource_read({uri:'memory://catalog'});return {first:r.items[0],catalog};"})],{stopReason:"toolUse"});},request=>{
    const output=request.messages.filter(message=>message.role==="toolResult").map(message=>contentText(message.content)).join("\n");expect(output).toContain("alpha");expect(output).not.toContain("beta");expect(output).toContain("Fixture catalog");expect(JSON.stringify(request)).not.toContain(config.bearer);return fauxAssistantMessage("Done");
  }]);
  expect((await(await conversation.submit({type:"input",content:"Get items"},context)).wait(context)).status).toBe("done");expect(rpcCalls).toBe(1);expect(methods).toContain("resources/read");
  const other=await harness.commit(async tx=>{const row=await tx.createConversation({ownership:{kind:"ownerless"}});(await tx.doc(WorkspaceAgents)).agents.push({agentId:"denied",durableId:row.id,label:"Denied",title:"Denied"});return row;},context);
  const denied=(await harness.conversation(other.id,context))!;await denied.configure({model:{provider:"faux",modelId:"faux-1"}},context);
  faux.setResponses([request=>{expect(JSON.stringify(request)).not.toContain("List items");return fauxAssistantMessage([fauxToolCall("codemode",{code:"await tools.mcp__fixture__items({});"})],{stopReason:"toolUse"});},fauxAssistantMessage("Denied")]);
  await(await denied.submit({type:"input",content:"Try ungranted server"},context)).wait(context);expect(rpcCalls).toBe(1);
  await store.save({...store.credential(config.id)!,enabled:false});faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"await tools.mcp__fixture__items({});"})],{stopReason:"toolUse"}),fauxAssistantMessage("Denied")]);
  await(await conversation.submit({type:"input",content:"Try again"},context)).wait(context);expect(rpcCalls).toBe(1);
  // Reconnect replaces the old registry schemas and client; Stop must cancel a waiting remote call.
  await store.save({...store.credential(config.id)!,enabled:true});await runtime.ready();stall=true;
  faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code:"await tools.mcp__fixture__items({});"})],{stopReason:"toolUse"})]);
  const blocked=await conversation.submit({type:"input",content:"Wait for remote result"},context);await started.promise;
  await conversation.abort(context);expect((await blocked.status(context)).status).toBe("unanswered");expect(rpcCalls).toBe(2);
});
