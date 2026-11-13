import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {lock} from "proper-lockfile";
import {Type,type Static} from "typebox";
import {Value} from "typebox/value";
import {getKintsugiRuntimeContext,isNotFoundError,writeJsonAtomic} from "@kintsugi/core";
import {startMcpSignIn,completeMcpSignIn,createMcpAuthProvider,type McpOAuthState,type McpOAuthServerStore,type McpAuthorizationResponse} from "@earendil-works/pi-mcp/oauth";
import type {McpConnection} from "./mcp-connections.ts";
const clientSchema=Type.Object({client_id:Type.String(),client_secret:Type.Optional(Type.String())},{additionalProperties:true});
const tokensSchema=Type.Object({access_token:Type.String(),token_type:Type.String(),refresh_token:Type.Optional(Type.String()),expires_in:Type.Optional(Type.Number()),scope:Type.Optional(Type.String())},{additionalProperties:true});
const stateSchema=Type.Unsafe<McpOAuthState>(Type.Object({serverUrl:Type.String(),clientInformation:Type.Optional(clientSchema),tokens:Type.Optional(tokensSchema),tokensExpireAt:Type.Optional(Type.Number()),codeVerifier:Type.Optional(Type.String()),oauthState:Type.Optional(Type.String()),discovery:Type.Optional(Type.Object({authorizationServerUrl:Type.String(),authorizationServerMetadata:Type.Optional(Type.Object({}, {additionalProperties:true})),resourceMetadata:Type.Optional(Type.Object({}, {additionalProperties:true})),resourceMetadataUrl:Type.Optional(Type.String())}))}));
const redirectSchema=Type.Object({kind:Type.Literal("redirect"),authorizationUrl:Type.String(),redirectUrl:Type.String(),state:Type.String(),scope:Type.Optional(Type.String())});
const envelopeSchema=Type.Object({binding:Type.String(),state:Type.Optional(stateSchema),pending:Type.Optional(Type.Object({authorization:redirectSchema,redirectUrl:Type.String(),browserHash:Type.String(),expires:Type.Number()}))});
const digest=(value:string)=>new Bun.CryptoHasher("sha256").update(value).digest("hex");
export class McpOAuthVault implements McpOAuthServerStore {
  private readonly path:string;
  readonly binding:string;
  constructor(readonly config:McpConnection,directory:string){
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(config.id))throw new Error("Invalid connection ID.");
    this.path=join(directory,"mcp/oauth",`${config.id}.json`);
    this.binding=digest(JSON.stringify([config.id,config.workspaceId,config.url,config.auth,config.oauth??{}]));
  }
  private async read():Promise<Static<typeof envelopeSchema>>{try{const stored=Value.Parse(envelopeSchema,await Bun.file(this.path).json());return stored.binding===this.binding?stored:{binding:this.binding};}catch(error){if(!isNotFoundError(error))throw error;return {binding:this.binding};}}
  private async locked<T>(suffix:string,fn:()=>Promise<T>):Promise<T>{
    await mkdir(join(this.path,".."),{recursive:true,mode:0o700});
    const release=await lock(this.path+suffix,{realpath:false,retries:{retries:100,minTimeout:10,maxTimeout:100},stale:30_000});
    try{return await fn();}finally{await release();}
  }
  private async update(change:(value:Static<typeof envelopeSchema>)=>void){
    await this.locked(".write",async()=>{const stored=await this.read();change(stored);await writeJsonAtomic(this.path,stored,{mode:0o600});});
  }
  async load(){return (await this.read()).state;}
  async save(state:McpOAuthState){Value.Assert(stateSchema,state);await this.update(stored=>{stored.state=state;});}
  withRefreshLock<T>(fn:()=>Promise<T>){return this.locked(".refresh",fn);}
  private options(redirectUrl:string){return {serverUrl:this.config.url,store:this,settings:{...this.config.oauth,clientRegistration:"dcr" as const},clientName:"Kintsugi",redirectUrl};}
  async begin(redirectUrl:string,browserToken:string){
    return this.locked(".flow",async()=>{
      const result=await startMcpSignIn(this.options(redirectUrl));
      await this.update(stored=>{if(result.kind==="redirect")stored.pending={authorization:result,redirectUrl,browserHash:digest(browserToken),expires:Date.now()+600_000};else delete stored.pending;});
      return result;
    });
  }
  async complete(response:McpAuthorizationResponse,browserToken:string,redirectUrl:string){
    await this.locked(".flow",async()=>{
      const stored=await this.read(),pending=stored.pending;
      if(!pending||pending.expires<Date.now()||pending.redirectUrl!==redirectUrl||pending.browserHash!==digest(browserToken)||pending.authorization.state!==response.state)throw new Error("MCP sign-in expired or belongs to another browser. Start again.");
      // Consume before exchanging: a callback is single-use even if the token endpoint fails.
      await this.update(value=>{delete value.pending;});
      await completeMcpSignIn({...this.options(redirectUrl),authorization:pending.authorization,response});
    });
  }
  authProvider(){return createMcpAuthProvider({serverUrl:this.config.url,store:this,settings:()=>({...this.config.oauth,clientRegistration:"dcr"}),clientName:"Kintsugi",onChallenge:()=>{}});}
  async clear(){await this.locked(".flow",()=>this.withRefreshLock(()=>this.update(stored=>{delete stored.state;delete stored.pending;})));}
}
export function mcpOAuthVault(config:McpConnection){return new McpOAuthVault(config,getKintsugiRuntimeContext().kintsugiDataDir);}
