import {createMcpRecallExtension} from "./mcp-recall.ts";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {McpConnectionClosedError} from "@earendil-works/pi-mcp";
import {defineExtension,type Registry,type Harness} from "@earendil-works/pi-durable";
import {WorkspaceAgents} from "./durable-workspace.ts";
import {connectMcp} from "./mcp-connect.ts";
import {lostMcpSession,mcpFailure,mcpToolsExtension,retryableMcpFailure} from "./mcp-client.ts";
import {type McpConnectionStore,type McpConnection} from "./mcp-connections.ts";
export type McpConnectionStatus={state:"connecting"|"retrying"|"connected"|"unavailable";tools:string[];resources?:string[];templates?:string[];message:string;nextRetryAt?:number};
const statuses=new Map<string,McpConnectionStatus>();
export const mcpConnectionStatus=(id:string)=>statuses.get(id);
const discoveryConcurrency=4,retryDelaysMs=[1000,5000,15000];
type Connection=Awaited<ReturnType<typeof connectMcp>>;
type Slot={config:McpConnection;failures:number;connection?:Connection;unlisten?:()=>void;abort?:AbortController;timer?:ReturnType<typeof setTimeout>;healthyTimer?:ReturnType<typeof setTimeout>};
/** Discovery runs in a bounded background pool. Only connection setup is retried, never remote tool effects. */
export function createWorkspaceMcpRuntime(workspaceId:string,registry:Registry,harness:()=>Harness,store:McpConnectionStore) {
  registry.install(createMcpRecallExtension({workspaceId,harness,connections:store}));
  const slots=new Map<string,Slot>(),queue=new Set<Slot>(),pending=new Set<Promise<void>>(),waiters=new Set<()=>void>(),cleanupErrors:Error[]=[];
  let stop:(()=>void)|undefined,closed=false,active=0;
  const current=(slot:Slot)=>!closed&&slots.get(slot.config.id)===slot&&store.credential(slot.config.id)?.revision===slot.config.revision;
  function drained(){if(!pending.size&&!queue.size&&!active){for(const resolve of waiters)resolve();waiters.clear();}}
  function ready(){return !pending.size&&!queue.size&&!active?Promise.resolve():new Promise<void>(resolve=>waiters.add(resolve));}
  function closeConnection(slot:Slot){
    slot.unlisten?.();slot.unlisten=undefined;
    const connection=slot.connection;slot.connection=undefined;
    if(!connection)return;
    const job=connection.close().catch(error=>{cleanupErrors.push(new Error(mcpFailure(error)));}).finally(()=>{pending.delete(job);drained();});pending.add(job);
  }
  function withdraw(slot:Slot){
    clearTimeout(slot.timer);slot.timer=undefined;clearTimeout(slot.healthyTimer);slot.healthyTimer=undefined;queue.delete(slot);slot.abort?.abort();
    registry.uninstall(defineExtension({name:`kintsugi.mcp.${slot.config.id}`}));closeConnection(slot);
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK/network failures are external input, never displayed raw.
  function failed(slot:Slot,error:unknown){
    if(!current(slot))return;
    withdraw(slot);slot.failures++;
    const delay=retryDelaysMs[slot.failures-1];
    if(retryableMcpFailure(error)&&delay!==undefined){
      statuses.set(slot.config.id,{state:"retrying",tools:[],nextRetryAt:Date.now()+delay,message:`${mcpFailure(error)} Retrying in ${delay/1000}s.`});
      slot.timer=setTimeout(()=>{slot.timer=undefined;if(current(slot)){queue.add(slot);pump();}},delay);slot.timer.unref();
    }else statuses.set(slot.config.id,{state:"unavailable",tools:[],message:`${mcpFailure(error)} Reconnect after checking the connection.`});
  }
  async function discover(slot:Slot){
    slot.abort=new AbortController();
    statuses.set(slot.config.id,{state:"connecting",tools:[],message:"Discovering MCP tools…"});
    try {
      const connection=await connectMcp(slot.config,AbortSignal.any([slot.abort.signal,AbortSignal.timeout(slot.config.timeoutSeconds*1000)]));
      if(!current(slot)){await connection.close();return;}
      if(connection.client.connectionState!=="connected"){await connection.close();failed(slot,new McpConnectionClosedError());return;}
      slot.connection=connection;
      // A flapping server must not get a fresh retry budget after every handshake.
      slot.healthyTimer=setTimeout(()=>{slot.healthyTimer=undefined;if(current(slot)&&slot.connection===connection)slot.failures=0;},30_000);slot.healthyTimer.unref();
      slot.unlisten=connection.client.onClose(()=>failed(slot,new McpConnectionClosedError()));
      const config=slot.config;
      registry.install(mcpToolsExtension(config,connection.tools,async conversationId=>{
        if(!current(slot))throw new Error("MCP connection changed or was disabled. Reconnect before using it.");
        const agents=(await harness().snapshot(WorkspaceAgents,context))?.agents??[],agent=agents.find(agent=>agent.durableId===conversationId||agent.branches?.includes(conversationId));
        if(!agent||agent.readOnly||config.agentIds.length&&!config.agentIds.includes(agent.agentId))throw new Error("This Agent has no access to the MCP connection.");
        const client=slot.connection?.client;if(!client||client.connectionState!=="connected")throw new Error("MCP connection is recovering. Try again after it reconnects.");
        return client;
      },error=>{if(lostMcpSession(error))failed(slot,error);}));
      statuses.set(config.id,{state:"connected",tools:connection.tools.map(tool=>tool.name),message:"Connected"});
    }catch(error){failed(slot,error);}
  }
  function pump(){
    while(!closed&&active<discoveryConcurrency&&queue.size){
      const slot=queue.values().next().value;if(!slot)break;queue.delete(slot);if(!current(slot))continue;
      active++;const job=discover(slot).finally(()=>{active--;pending.delete(job);pump();drained();});pending.add(job);
    }
    drained();
  }
  function refresh(){
    if(closed)return;
    const desired=store.list().filter(server=>server.enabled&&server.workspaceId===workspaceId);
    for(const [id,slot] of slots)if(!desired.some(server=>server.id===id&&server.revision===slot.config.revision)){slots.delete(id);withdraw(slot);statuses.delete(id);}
    for(const summary of desired)if(!slots.has(summary.id)){
      const config=store.credential(summary.id)!;const slot:Slot={config,failures:0};slots.set(config.id,slot);queue.add(slot);
      statuses.set(config.id,{state:"connecting",tools:[],message:"Waiting for MCP discovery…"});
    }
    pump();
  }
  return {
    async attach(){if(stop||closed)throw new Error("MCP runtime is already attached or closed.");stop=store.watch(async()=>refresh());refresh();},
    /** Wait for current discovery/cleanup, not future retry timers. Useful for explicit readiness checks. */
    ready,
    async close(){closed=true;stop?.();for(const [id,slot] of slots){slots.delete(id);withdraw(slot);statuses.delete(id);}await ready();if(cleanupErrors.length)throw new AggregateError(cleanupErrors,"MCP cleanup failed.");},
  };
}
export async function testMcpConnection(config:McpConnection){
  const {client,tools,close}=await connectMcp(config);
  try {const resources=client.serverCapabilities?.resources?await client.listResources():[],templates=client.serverCapabilities?.resources?await client.listResourceTemplates():[];const status={state:"connected" as const,tools:tools.map(tool=>tool.name),resources:resources.map(resource=>resource.uri),templates:templates.map(template=>template.uriTemplate),message:`${tools.length} tools · ${resources.length} resources · ${templates.length} templates`};statuses.set(config.id,status);return status;}
  finally{await close();}
}
