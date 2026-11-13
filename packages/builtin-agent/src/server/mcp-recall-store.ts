import {createHash} from "node:crypto";
import {defineDoc,type Harness,type ConversationId,type DocumentReader} from "@earendil-works/pi-durable";
import type {Context} from "@earendil-works/chord/context";
import {defaultMcpRecallSettings,type McpRecallSettings} from "@kintsugi/token-economizer/core";
import {WorkspaceAgents} from "./durable-workspace.ts";
import type {McpConnection,McpConnectionStore} from "./mcp-connections.ts";
export type McpRecallGrant={connectionId:string;epoch:string};
export type McpRecallRecord={id:string;owner:string;grants:McpRecallGrant[];tool:string;kind:"mcp-envelope"|"emitted-text";raw:string;summary:string;handler:string;sources:string[];bytes:number;createdAt:number;lastSeen:number;hits:number;pinned:boolean;isError:boolean};
export const McpRecallDoc=defineDoc<{records:Record<string,McpRecallRecord>}>({kind:"kintsugi.mcp-recall",version:1,scope:"conversation",history:"rewindable",fork:"asOf",initial:()=>({records:{}}),checkpointWhen:()=>false});
export const mcpAccessEpoch=(config:McpConnection)=>config.accessEpoch??`legacy:${config.revision}`;
export async function mcpRecallOwner(conversationId:ConversationId,read:DocumentReader,context:Context){
  const agent=(await read.snapshot(WorkspaceAgents,context))?.agents.find(row=>row.durableId===conversationId||row.branches?.includes(conversationId));
  if(!agent||agent.readOnly)throw new Error("No editable Agent owns this MCP recall store.");return agent.agentId;
}
export function mcpRecallAllowed(config:McpConnection|undefined,workspaceId:string,owner:string):config is McpConnection {
  return Boolean(config?.enabled&&config.workspaceId===workspaceId&&(!config.agentIds.length||config.agentIds.includes(owner)));
}
const copy=(row:McpRecallRecord):McpRecallRecord=>({...row,grants:row.grants.map(grant=>({...grant})),sources:[...row.sources]});
/** Retention bounds the live recall index. It never deletes committed source journal evidence. */
export function pruneMcpRecall(records:Record<string,McpRecallRecord>,configs:readonly McpConnection[],now:number){
  const configFor=(grant:McpRecallGrant)=>configs.find(config=>config.id===grant.connectionId&&mcpAccessEpoch(config)===grant.epoch);
  for(const [id,row] of Object.entries(records)){
    const settings=row.grants.map(grant=>configFor(grant)).map(config=>config?(config.recall??defaultMcpRecallSettings()):undefined);
    if(settings.some(value=>!value)||!row.pinned&&settings.some(value=>now-row.lastSeen>value!.maxAgeDays*86_400_000))delete records[id];
  }
  function cap(rows:McpRecallRecord[],maxItems:number,maxBytes:number){let bytes=rows.reduce((sum,row)=>sum+row.bytes,0),items=rows.length;for(const row of rows.sort((a,b)=>Number(a.pinned)-Number(b.pinned)||a.lastSeen-b.lastSeen||a.id.localeCompare(b.id))){if(items<=maxItems&&bytes<=maxBytes)break;delete records[row.id];items--;bytes-=row.bytes;}}
  for(const config of configs){const settings=config.recall??defaultMcpRecallSettings();cap(Object.values(records).filter(row=>row.grants.some(grant=>grant.connectionId===config.id)),settings.maxItems,settings.maxBytes);}
  cap(Object.values(records),256,16*1024*1024);
}
export function createMcpRecallStore(workspaceId:string,harness:()=>Harness,connections:McpConnectionStore,now:()=>number=Date.now){
  function configs(){return connections.list().flatMap(row=>{const config=connections.credential(row.id);return config?[config]:[];});}
  const allowed=(row:McpRecallRecord,owner:string)=>row.owner===owner&&row.grants.every(grant=>{const config=connections.credential(grant.connectionId);return mcpRecallAllowed(config,workspaceId,owner)&&mcpAccessEpoch(config)===grant.epoch;});
  async function read(conversationId:ConversationId,context:Context){
    const owner=await mcpRecallOwner(conversationId,harness(),context);
    return harness().commit(async tx=>{const doc=await tx.doc(McpRecallDoc,conversationId);pruneMcpRecall(doc.records,configs(),now());return Object.values(doc.records).filter(row=>allowed(row,owner)).map(copy);},context);
  }
  async function capture(conversationId:ConversationId,input:Pick<McpRecallRecord,"grants"|"tool"|"kind"|"raw"|"summary"|"handler"|"sources"|"isError">,context:Context){
    const owner=await mcpRecallOwner(conversationId,harness(),context),bytes=Buffer.byteLength(input.raw);
    if(!bytes||bytes>1024*1024||!input.grants.length)return null;
    const id="mcp_"+createHash("sha256").update(JSON.stringify([owner,input.grants,input.tool,input.kind,input.raw])).digest("hex");
    return harness().commit(async tx=>{
      const doc=await tx.doc(McpRecallDoc,conversationId);pruneMcpRecall(doc.records,configs(),now());
      const row:McpRecallRecord={...input,grants:input.grants.map(grant=>({...grant})),sources:[...input.sources],owner,id,bytes,createdAt:now(),lastSeen:now(),hits:1,pinned:false};
      if(!allowed(row,owner))return null;
      const previous=doc.records[id];if(previous){previous.hits++;previous.lastSeen=now();return copy(previous);}
      doc.records[id]=row;pruneMcpRecall(doc.records,configs(),now());return doc.records[id]?copy(doc.records[id]):null;
    },context);
  }
  async function change(conversationId:ConversationId,action:"pin"|"forget",id:string|undefined,all:boolean,pinned:boolean,context:Context){
    const owner=await mcpRecallOwner(conversationId,harness(),context);
    return harness().commit(async tx=>{const doc=await tx.doc(McpRecallDoc,conversationId);pruneMcpRecall(doc.records,configs(),now());let changed=0;
      for(const row of Object.values(doc.records))if(allowed(row,owner)&&(row.id===id||all&&action==="forget")){if(action==="forget")delete doc.records[row.id];else row.pinned=pinned;changed++;}return changed;
    },context);
  }
  function settings(row:McpRecallRecord):McpRecallSettings[] {return row.grants.map(grant=>connections.credential(grant.connectionId)?.recall??defaultMcpRecallSettings());}
  return {read,capture,change,settings};
}
export type McpRecallStore=ReturnType<typeof createMcpRecallStore>;
