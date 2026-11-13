import {createMcpRecallExtension} from "./mcp-recall.ts";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import type {McpClient} from "@earendil-works/pi-mcp";
import {defineExtension,type Registry,type Harness} from "@earendil-works/pi-durable";
import {WorkspaceAgents} from "./durable-workspace.ts";
import {connectMcp} from "./mcp-connect.ts";
import {mcpFailure,mcpToolsExtension} from "./mcp-client.ts";
import {type McpConnectionStore,type McpConnection} from "./mcp-connections.ts";
export type McpConnectionStatus={state:"connected"|"unavailable";tools:string[];resources?:string[];templates?:string[];message:string};
const statuses=new Map<string,McpConnectionStatus>();
export const mcpConnectionStatus=(id:string)=>statuses.get(id);
/** Registry updates replace schemas; the wrapper also checks revocation on every call. */
export function createWorkspaceMcpRuntime(workspaceId:string,registry:Registry,harness:()=>Harness,store:McpConnectionStore) {
  registry.install(createMcpRecallExtension({workspaceId,harness,connections:store}));
  const clients=new Map<string,{revision:number;client:McpClient;close:()=>Promise<void>}>();let stop:(()=>void)|undefined,closed=false;
  let tail=Promise.resolve();
  async function refreshNow(){
    const desired=store.list().filter(server=>server.enabled&&server.workspaceId===workspaceId);
    for(const [id,existing] of clients)if(!desired.some(server=>server.id===id&&server.revision===existing.revision)){registry.uninstall(defineExtension({name:`kintsugi.mcp.${id}`}));clients.delete(id);statuses.delete(id);await existing.close();}
    for(const summary of desired){
      if(closed||clients.has(summary.id))continue;
      const config=store.credential(summary.id)!;
      try {
        const connection=await connectMcp(config);
        if(closed){await connection.close();return;}
        clients.set(config.id,{revision:config.revision,client:connection.client,close:connection.close});
        const extension=mcpToolsExtension(config,connection.tools,async conversationId=>{
          const current=store.credential(config.id);if(!current?.enabled||current.revision!==config.revision||current.workspaceId!==workspaceId)throw new Error("MCP connection changed or was disabled. Reconnect before using it.");
          const agents=(await harness().snapshot(WorkspaceAgents,context))?.agents??[];const agent=agents.find(agent=>agent.durableId===conversationId||agent.branches?.includes(conversationId));
          if(!agent||agent.readOnly||current.agentIds.length&&!current.agentIds.includes(agent.agentId))throw new Error("This Agent has no access to the MCP connection.");
          return connection.client;
        });
        registry.install(extension);statuses.set(config.id,{state:"connected",tools:connection.tools.map(tool=>tool.name),message:"Connected"});
      }catch(error){statuses.set(config.id,{state:"unavailable",tools:[],message:mcpFailure(error)});}
    }
  }
  function refresh(){const work=tail.then(refreshNow);tail=work.catch(()=>{});return work;}
  return {async attach(){stop=store.watch(refresh);await refresh();},async close(){closed=true;stop?.();await tail;await Promise.all([...clients.values()].map(({close})=>close()));for(const id of clients.keys())statuses.delete(id);clients.clear();}};
}
export async function testMcpConnection(config:McpConnection){
  const {client,tools,close}=await connectMcp(config);
  try {const resources=client.serverCapabilities?.resources?await client.listResources():[],templates=client.serverCapabilities?.resources?await client.listResourceTemplates():[];const status={state:"connected" as const,tools:tools.map(tool=>tool.name),resources:resources.map(resource=>resource.uri),templates:templates.map(template=>template.uriTemplate),message:`${tools.length} tools · ${resources.length} resources · ${templates.length} templates`};statuses.set(config.id,status);return status;}
  finally{await close();}
}
