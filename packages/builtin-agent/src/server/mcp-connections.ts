import {canonicalMcpAccess,mcpAccess,mcpAccessOverlaps,mcpAccessSchema} from "./mcp-policy.ts";
import {McpRecallSettingsSchema} from "@kintsugi/token-economizer/core";
import {join} from "node:path";
import {McpOAuthVault} from "./mcp-oauth.ts";
import {Type,type Static} from "typebox";
import {Value} from "typebox/value";
import {getKintsugiRuntimeContext,isNotFoundError,writeJsonAtomic} from "@kintsugi/core";
import {mcpEndpoint,type McpHttpConnection} from "./mcp-client.ts";
const idSchema=Type.String({pattern:"^[a-zA-Z0-9_-]{1,128}$"});
const accessIdentity=(server:McpConnection)=>JSON.stringify([server.workspaceId,canonicalMcpAccess(mcpAccess(server)),server.url,server.credentialUrl??server.url,server.bearer,server.transport??"http",server.auth??"bearer",server.command,server.workdir,server.oauth]);
const serverSchema=Type.Object({id:idSchema,name:Type.String({pattern:"^[a-z][a-z0-9_]{0,31}$"}),url:Type.String({maxLength:2048}),credentialUrl:Type.Optional(Type.String({maxLength:2048})),bearer:Type.String({maxLength:8192}),transport:Type.Optional(Type.Enum(["http","stdio"])),auth:Type.Optional(Type.Enum(["bearer","oauth"])),command:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:4096}),{minItems:1,maxItems:128})),workdir:Type.Optional(Type.String({maxLength:4096})),oauth:Type.Optional(Type.Object({clientId:Type.Optional(Type.String({maxLength:2048})),clientSecret:Type.Optional(Type.String({maxLength:8192})),scope:Type.Optional(Type.String({maxLength:2048}))},{additionalProperties:false})),allowHttp:Type.Boolean(),timeoutSeconds:Type.Integer({minimum:1,maximum:300}),enabled:Type.Boolean(),workspaceId:idSchema,agentIds:Type.Array(idSchema,{maxItems:100}),access:Type.Optional(mcpAccessSchema),revision:Type.Integer({minimum:1}),accessEpoch:Type.Optional(Type.String({maxLength:128})),recall:Type.Optional(McpRecallSettingsSchema)},{additionalProperties:false});
const storeSchema=Type.Object({version:Type.Literal(2),servers:Type.Array(serverSchema,{maxItems:100})},{additionalProperties:false});
const savedStoreSchema=Type.Union([Type.Object({version:Type.Literal(1),servers:Type.Array(Type.Omit(serverSchema,["access","credentialUrl"]),{maxItems:100})},{additionalProperties:false}),storeSchema]);
export type McpConnection=Static<typeof serverSchema>;
export type PublicMcpConnection=Omit<McpConnection,"bearer"|"oauth"|"credentialUrl"> & {hasSavedCredentials:boolean;needsCredentialApproval:boolean;oauth?:Omit<NonNullable<McpConnection["oauth"]>,"clientSecret">};
export class McpConnectionValidationError extends Error {}
export class McpConnectionStore {
  private servers:McpConnection[]=[];
  private loaded:Promise<void>|undefined;
  private tail=Promise.resolve();
  private readonly listeners=new Set<()=>Promise<void>>();
  constructor(private readonly directory:string){}
  async load(){this.loaded??=(async()=>{try{const data=Value.Parse(savedStoreSchema,await Bun.file(join(this.directory,"mcp/connections.json")).json());this.servers=data.servers;}catch(error){if(!isNotFoundError(error))throw error;}})();await this.loaded;}
  list():PublicMcpConnection[]{return this.servers.map(({bearer,credentialUrl,...server})=>structuredClone({...server,hasSavedCredentials:Boolean(bearer||server.oauth?.clientSecret),needsCredentialApproval:(credentialUrl??server.url)!==server.url,oauth:server.oauth?{clientId:server.oauth.clientId,scope:server.oauth.scope}:undefined}));}
  credential(id:string):McpConnection|undefined {const server=this.servers.find(item=>item.id===id);return server?structuredClone(server):undefined;}
  watch(listener:()=>Promise<void>){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  async save(input:Omit<McpConnection,"revision">){
    const result=this.tail.then(async()=>{await this.load();const previous=this.servers.find(item=>item.id===input.id);const candidate={...input,revision:(previous?.revision??0)+1};
      if(candidate.access){candidate.access=canonicalMcpAccess(Value.Parse(mcpAccessSchema,candidate.access));if(candidate.access.kind==="workspaces"&&new Set(candidate.access.grants.map(grant=>grant.workspaceId)).size!==candidate.access.grants.length)throw new McpConnectionValidationError("Choose each workspace only once.");}
      if(candidate.transport==="stdio"){
        const access=mcpAccess(candidate);if(access.kind!=="workspaces"||access.grants.length!==1||access.grants[0]!.workspaceId!==candidate.workspaceId)throw new McpConnectionValidationError("Workspace stdio needs one execution workspace. Use HTTP to share a server across workspaces.");
        if(!candidate.command?.length||candidate.command.some(arg=>arg.includes("\0"))||candidate.workdir&&!candidate.workdir.startsWith("/"))throw new McpConnectionValidationError("Use a command argument list and an absolute workspace directory.");
        candidate.url="";candidate.bearer="";delete candidate.credentialUrl;delete candidate.oauth;delete candidate.auth;
      }else {candidate.url=mcpEndpoint(candidate.url,candidate.allowHttp);candidate.credentialUrl=mcpEndpoint(candidate.credentialUrl??candidate.url,true);delete candidate.command;delete candidate.workdir;
        if(candidate.enabled&&(candidate.credentialUrl!==candidate.url||candidate.auth!=="oauth"&&!candidate.bearer))throw new McpConnectionValidationError("Enter credentials or approve saved credentials for this endpoint before enabling it.");
        if(candidate.auth==="oauth")candidate.bearer="";else delete candidate.oauth;
      }Value.Assert(serverSchema,candidate);if(/[\r\n]/.test(candidate.bearer))throw new McpConnectionValidationError("Token must not contain line breaks.");
      candidate.accessEpoch=previous&&accessIdentity(previous)===accessIdentity(candidate)?input.accessEpoch??previous.accessEpoch??crypto.randomUUID():crypto.randomUUID();
      if(this.servers.some(item=>item.id!==candidate.id&&item.name===candidate.name&&mcpAccessOverlaps(item,candidate)))throw new McpConnectionValidationError("An MCP server with that name already has access to one of these workspaces.");
      const next=[...this.servers.filter(item=>item.id!==candidate.id),candidate];Value.Assert(storeSchema,{version:2,servers:next});await writeJsonAtomic(join(this.directory,"mcp/connections.json"),{version:2,servers:next},{mode:0o600});this.servers=next;
      await Promise.all([...this.listeners].map(listener=>listener()));return candidate.id;});this.tail=result.then(()=>{},()=>{});return result;
  }
  async remove(id:string){const result=this.tail.then(async()=>{await this.load();const previous=this.servers.find(item=>item.id===id);if(previous?.auth==="oauth")await new McpOAuthVault(previous,this.directory).clear();const next=this.servers.filter(item=>item.id!==id);await writeJsonAtomic(join(this.directory,"mcp/connections.json"),{version:2,servers:next},{mode:0o600});this.servers=next;await Promise.all([...this.listeners].map(listener=>listener()));});this.tail=result.catch(()=>{});await result;}
}
let instance:{directory:string;store:McpConnectionStore}|undefined;
export async function mcpConnections(){const directory=getKintsugiRuntimeContext().kintsugiDataDir;if(instance?.directory!==directory)instance={directory,store:new McpConnectionStore(directory)};await instance.store.load();return instance.store;}
export function mcpConnectionConfig(server:McpConnection):McpHttpConnection{if(server.credentialUrl!==undefined&&server.credentialUrl!==server.url)throw new McpConnectionValidationError("Approve saved credentials for this endpoint before connecting.");return {id:server.id,name:server.name,url:server.url,bearer:server.bearer,allowHttp:server.allowHttp,timeoutSeconds:server.timeoutSeconds};}
