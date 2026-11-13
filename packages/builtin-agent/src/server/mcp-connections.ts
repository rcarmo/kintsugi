import {McpRecallSettingsSchema} from "@kintsugi/token-economizer/core";
import {join} from "node:path";
import {McpOAuthVault} from "./mcp-oauth.ts";
import {Type,type Static} from "typebox";
import {Value} from "typebox/value";
import {getKintsugiRuntimeContext,isNotFoundError,writeJsonAtomic} from "@kintsugi/core";
import {mcpEndpoint,type McpHttpConnection} from "./mcp-client.ts";
const idSchema=Type.String({pattern:"^[a-zA-Z0-9_-]{1,128}$"});
const accessIdentity=(server:McpConnection)=>JSON.stringify([server.workspaceId,server.url,server.bearer,server.transport,server.auth,server.command,server.workdir,server.oauth]);
const serverSchema=Type.Object({id:idSchema,name:Type.String({pattern:"^[a-z][a-z0-9_]{0,31}$"}),url:Type.String({maxLength:2048}),bearer:Type.String({maxLength:8192}),transport:Type.Optional(Type.Enum(["http","stdio"])),auth:Type.Optional(Type.Enum(["bearer","oauth"])),command:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:4096}),{minItems:1,maxItems:128})),workdir:Type.Optional(Type.String({maxLength:4096})),oauth:Type.Optional(Type.Object({clientId:Type.Optional(Type.String({maxLength:2048})),clientSecret:Type.Optional(Type.String({maxLength:8192})),scope:Type.Optional(Type.String({maxLength:2048}))},{additionalProperties:false})),allowHttp:Type.Boolean(),timeoutSeconds:Type.Integer({minimum:1,maximum:300}),enabled:Type.Boolean(),workspaceId:idSchema,agentIds:Type.Array(idSchema,{maxItems:100}),revision:Type.Integer({minimum:1}),accessEpoch:Type.Optional(Type.String({maxLength:128})),recall:Type.Optional(McpRecallSettingsSchema)},{additionalProperties:false});
const storeSchema=Type.Object({version:Type.Literal(1),servers:Type.Array(serverSchema,{maxItems:100})},{additionalProperties:false});
export type McpConnection=Static<typeof serverSchema>;
export type PublicMcpConnection=Omit<McpConnection,"bearer"|"oauth"> & {oauth?:Omit<NonNullable<McpConnection["oauth"]>,"clientSecret">};
export class McpConnectionStore {
  private servers:McpConnection[]=[];
  private loaded:Promise<void>|undefined;
  private tail=Promise.resolve();
  private readonly listeners=new Set<()=>Promise<void>>();
  constructor(private readonly directory:string){}
  async load(){this.loaded??=(async()=>{try{const data=Value.Parse(storeSchema,await Bun.file(join(this.directory,"mcp/connections.json")).json());this.servers=data.servers;}catch(error){if(!isNotFoundError(error))throw error;}})();await this.loaded;}
  list():PublicMcpConnection[]{return this.servers.map(({bearer:_bearer,...server})=>structuredClone({...server,oauth:server.oauth?{clientId:server.oauth.clientId,scope:server.oauth.scope}:undefined}));}
  credential(id:string):McpConnection|undefined {const server=this.servers.find(item=>item.id===id);return server?structuredClone(server):undefined;}
  watch(listener:()=>Promise<void>){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  async save(input:Omit<McpConnection,"revision">){
    const result=this.tail.then(async()=>{await this.load();const previous=this.servers.find(item=>item.id===input.id);const candidate={...input,revision:(previous?.revision??0)+1};if(candidate.transport==="stdio"){
        if(!candidate.command?.length||candidate.command.some(arg=>arg.includes("\0"))||candidate.workdir&&!candidate.workdir.startsWith("/"))throw new Error("Use a command argument list and an absolute workspace directory.");
        candidate.url="";candidate.bearer="";delete candidate.oauth;delete candidate.auth;
      }else {candidate.url=mcpEndpoint(candidate.url,candidate.allowHttp);delete candidate.command;delete candidate.workdir;
        if(candidate.auth!=="oauth"&&!candidate.bearer)throw new Error("Enter a bearer token or choose OAuth.");
        if(candidate.auth==="oauth")candidate.bearer="";else delete candidate.oauth;
      }Value.Assert(serverSchema,candidate);if(/[\r\n]/.test(candidate.bearer))throw new Error("Token must not contain line breaks.");
      candidate.accessEpoch=previous&&accessIdentity(previous)===accessIdentity(candidate)?input.accessEpoch??previous.accessEpoch??crypto.randomUUID():crypto.randomUUID();
      if(this.servers.some(item=>item.id!==candidate.id&&item.workspaceId===candidate.workspaceId&&item.name===candidate.name))throw new Error("This workspace already has an MCP server with that name.");
      const next=[...this.servers.filter(item=>item.id!==candidate.id),candidate];Value.Assert(storeSchema,{version:1,servers:next});await writeJsonAtomic(join(this.directory,"mcp/connections.json"),{version:1,servers:next},{mode:0o600});this.servers=next;
      await Promise.all([...this.listeners].map(listener=>listener()));return candidate.id;});this.tail=result.then(()=>{},()=>{});return result;
  }
  async remove(id:string){const result=this.tail.then(async()=>{await this.load();const previous=this.servers.find(item=>item.id===id);if(previous?.auth==="oauth")await new McpOAuthVault(previous,this.directory).clear();const next=this.servers.filter(item=>item.id!==id);await writeJsonAtomic(join(this.directory,"mcp/connections.json"),{version:1,servers:next},{mode:0o600});this.servers=next;await Promise.all([...this.listeners].map(listener=>listener()));});this.tail=result.catch(()=>{});await result;}
}
let instance:{directory:string;store:McpConnectionStore}|undefined;
export async function mcpConnections(){const directory=getKintsugiRuntimeContext().kintsugiDataDir;if(instance?.directory!==directory)instance={directory,store:new McpConnectionStore(directory)};await instance.store.load();return instance.store;}
export function mcpConnectionConfig(server:McpConnection):McpHttpConnection{return {id:server.id,name:server.name,url:server.url,bearer:server.bearer,allowHttp:server.allowHttp,timeoutSeconds:server.timeoutSeconds};}
