import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm,stat} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {McpConnectionStore,mcpConnectionConfig,mcpConnections,type McpConnection} from "../../src/server/mcp-connections.ts";
import {mcpFormAccess,mcpSettingsInput} from "../../src/server/mcp-settings-input.ts";
import {mcpSettingsContribution} from "../../src/server/mcp-settings.ts";
import {McpOAuthVault} from "../../src/server/mcp-oauth.ts";
import {mcpAccess,mcpAgentAllowed,mcpWorkspaceAllowed} from "../../src/server/mcp-policy.ts";

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const original={id:"memory",name:"memory",url:"https://memory.example/mcp",bearer:"private-saved-bearer",enabled:true,workspaceId:"alpha",agentIds:["agent_a"],allowHttp:false,timeoutSeconds:2,revision:1} satisfies McpConnection;
function form(changes:Record<string,string>={}){
  const value=new FormData();
  for(const [key,text] of Object.entries({id:"memory",name:"memory",url:original.url,transport:"http",auth:"bearer",bearer:"",accessMode:"workspaces",workspaceIds:"alpha",agentsMode_alpha:"selected",agentIds_alpha:"agent_a",timeoutSeconds:"2",...changes}))value.set(key,text);
  return value;
}
async function fixture(){const directory=await mkdtemp(join(tmpdir(),"mcp-sharing-input-"));cleanup.push(()=>rm(directory,{recursive:true,force:true}));const store=new McpConnectionStore(directory);await store.load();return {directory,store};}

test("an endpoint edit persists without losing or silently forwarding the saved bearer token",async()=>{
  const {directory,store}=await fixture();await store.save(original);
  const input=mcpSettingsInput(form({url:"https://replacement.example/mcp"}),store.credential("memory"));
  expect(input.connection.enabled).toBe(false);await store.save(input.connection);
  const saved=store.credential("memory")!;expect(saved.url).toBe("https://replacement.example/mcp");expect(saved.bearer).toBe(original.bearer);expect(saved.credentialUrl).toBe(original.url);
  expect(()=>mcpConnectionConfig(saved)).toThrow("Approve");await expect(store.save({...saved,enabled:true})).rejects.toThrow("approve");
  expect(store.list()[0]!.needsCredentialApproval).toBe(true);expect(JSON.stringify(store.list())).not.toContain(original.bearer);
  const reopened=new McpConnectionStore(directory);await reopened.load();expect(reopened.credential("memory")!.url).toBe(saved.url);expect(reopened.credential("memory")!.bearer).toBe(original.bearer);
  expect((await stat(join(directory,"mcp/connections.json"))).mode&0o777).toBe(0o600);
});
test("normalising the same URL keeps approved credentials without asking for reuse",()=>{
  const input=mcpSettingsInput(form({url:"  https://MEMORY.example/mcp  "}),original);
  expect(input.connection.url).toBe(original.url);expect(input.connection.enabled).toBe(true);expect(input.connection.bearer).toBe(original.bearer);expect(input.connection.credentialUrl).toBe(original.url);
});
test("explicit reuse or a replacement token binds credentials to the new endpoint",async()=>{
  const {store}=await fixture();await store.save(original);
  await store.save(mcpSettingsInput(form({url:"https://replacement.example/mcp"}),store.credential("memory")).connection);
  const reused=mcpSettingsInput(form({url:"https://replacement.example/mcp",reuseCredentials:"true"}),store.credential("memory"));
  await store.save(reused.connection);await store.save({...store.credential("memory")!,enabled:true});
  expect(mcpConnectionConfig(store.credential("memory")!).bearer).toBe(original.bearer);
  const replacement=mcpSettingsInput(form({url:"https://third.example/mcp",bearer:"new-private-token"}),store.credential("memory"));
  expect(replacement.connection.credentialUrl).toBe("https://third.example/mcp");expect(replacement.connection.bearer).toBe("new-private-token");expect(replacement.connection.enabled).toBe(true);
});
test("OAuth endpoint changes retain saved client secrets privately but block their use until approved",async()=>{
  const previous={...original,auth:"oauth" as const,bearer:"",oauth:{clientId:"registered",clientSecret:"private-client-secret"}};
  const input=mcpSettingsInput(form({auth:"oauth",clientId:"registered",url:"https://new.example/mcp"}),previous);
  expect(input.connection.enabled).toBe(false);expect(input.connection.oauth!.clientSecret).toBe(previous.oauth.clientSecret);expect(input.connection.credentialUrl).toBe(original.url);
  const {directory}=await fixture();const vault=new McpOAuthVault({...input.connection,revision:2},directory);
  expect(()=>vault.authProvider()).toThrow("Approve");
  const store=new McpConnectionStore(directory);await store.load();await expect(store.save({...input.connection,enabled:true})).rejects.toThrow("approve");
  const approved=mcpSettingsInput(form({auth:"oauth",clientId:"registered",url:"https://new.example/mcp",reuseCredentials:"true"}),{...input.connection,revision:2});
  expect(approved.connection.credentialUrl).toBe(approved.connection.url);
  // Entering an irrelevant bearer field must never approve an old OAuth client secret.
  const irrelevant=mcpSettingsInput(form({auth:"oauth",clientId:"registered",url:"https://new.example/mcp",bearer:"unrelated-token"}),previous);
  expect(irrelevant.connection.credentialUrl).toBe(original.url);expect(irrelevant.connection.enabled).toBe(false);
});
test("sharing an OAuth connection retains its approved login and credential anchor",async()=>{
  const {directory,store}=await fixture();await store.save({...original,auth:"oauth",bearer:"",oauth:{clientId:"registered",clientSecret:"private-client-secret"}});
  const before=store.credential("memory")!,vault=new McpOAuthVault(before,directory);
  await vault.save({serverUrl:before.url,clientInformation:{client_id:"registered"},tokens:{access_token:"private-access-token",token_type:"Bearer"},tokensExpireAt:Date.now()+3_600_000});
  await store.save(mcpSettingsInput(form({auth:"oauth",clientId:"registered",accessMode:"all"}),before).connection);
  const shared=store.credential("memory")!;expect(shared.workspaceId).toBe(before.workspaceId);expect(shared.accessEpoch).not.toBe(before.accessEpoch);
  const a=new McpOAuthVault(shared,directory).authProvider(),b=new McpOAuthVault(shared,directory).authProvider();
  expect(await Promise.all([a.token(),b.token()])).toEqual(["private-access-token","private-access-token"]);await a.settled();await b.settled();
});
test("selected workspace sharing preserves per-workspace Agent restrictions and never turns an empty Agent choice into all Agents",()=>{
  const selected=form();selected.append("workspaceIds","beta");selected.set("agentsMode_beta","all");
  const input=mcpSettingsInput(selected,original);const owner={...input.connection,revision:2};
  expect(mcpWorkspaceAllowed(owner,"alpha")).toBe(true);expect(mcpAgentAllowed(owner,"alpha","agent_a")).toBe(true);expect(mcpAgentAllowed(owner,"alpha","other")).toBe(false);
  expect(mcpAgentAllowed(owner,"beta","any_agent")).toBe(true);expect(mcpAgentAllowed(owner,"gamma","any_agent")).toBe(false);
  selected.delete("agentIds_alpha");expect(()=>mcpFormAccess(selected)).toThrow("Select at least one Agent");
  expect(mcpSettingsInput(form({accessMode:"all"}),original).connection.access).toEqual({kind:"all"});
});
test("old saved connections load without a rewrite or broadened grant; changed access writes explicit version 2",async()=>{
  const {directory}=await fixture();await Bun.write(join(directory,"mcp/connections.json"),JSON.stringify({version:1,servers:[original]}));
  const store=new McpConnectionStore(directory);await store.load();expect(mcpAccess(store.credential("memory")!)).toEqual({kind:"workspaces",grants:[{workspaceId:"alpha",agentIds:["agent_a"]}]});
  expect((await Bun.file(join(directory,"mcp/connections.json")).json()).version).toBe(1);
  await store.save(mcpSettingsInput(form({accessMode:"all"}),store.credential("memory")).connection);
  expect((await Bun.file(join(directory,"mcp/connections.json")).json()).version).toBe(2);
  const reopened=new McpConnectionStore(directory);await reopened.load();expect(mcpAgentAllowed(reopened.credential("memory"),"future_workspace","new_agent")).toBe(true);
});
test("ordering equivalent workspace and Agent grants does not revoke recall, but removing a grant does",async()=>{
  const {store}=await fixture();await store.save({...original,access:{kind:"workspaces",grants:[{workspaceId:"beta",agentIds:"all"},{workspaceId:"alpha",agentIds:["agent_z","agent_a"]}]}});
  const epoch=store.credential("memory")!.accessEpoch;
  await store.save({...store.credential("memory")!,access:{kind:"workspaces",grants:[{workspaceId:"alpha",agentIds:["agent_a","agent_z"]},{workspaceId:"beta",agentIds:"all"}]}});
  expect(store.credential("memory")!.accessEpoch).toBe(epoch);
  await store.save({...store.credential("memory")!,access:{kind:"workspaces",grants:[{workspaceId:"alpha",agentIds:["agent_a"]},{workspaceId:"beta",agentIds:"all"}]}});
  expect(store.credential("memory")!.accessEpoch).not.toBe(epoch);
});
test("MCP names cannot collide across overlapping shared workspace grants",async()=>{
  const {store}=await fixture();await store.save(original);await store.save({...original,id:"beta_only",workspaceId:"beta",agentIds:[]});
  await expect(store.save({...store.credential("memory")!,access:{kind:"all"}})).rejects.toThrow("already has access");
  expect(store.credential("memory")!.access).toBeUndefined();
});
test("workspace stdio cannot gain cross-workspace execution through the shared HTTP picker",()=>{
  expect(()=>mcpSettingsInput(form({transport:"stdio",accessMode:"all",command:'["bun","server.ts"]'}),original)).toThrow("one workspace");
  const selected=form({transport:"stdio",command:'["bun","server.ts"]'});selected.append("workspaceIds","beta");selected.set("agentsMode_beta","all");
  expect(()=>mcpSettingsInput(selected,original)).toThrow("one workspace");
});
test("HTTP Settings save persists the edited URL and reports approval errors without exposing credentials",async()=>{
  const {directory}=await fixture(),old=process.env.KINTSUGI_DATA_DIR;process.env.KINTSUGI_DATA_DIR=directory;
  cleanup.push(async()=>{if(old===undefined)delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR=old;});
  const store=await mcpConnections();await store.save(original);
  async function action(name:string,data:FormData){const url=new URL(`http://localhost/settings/mcp/${name}`);return mcpSettingsContribution.handleAction!({request:new Request(url,{method:"POST",body:data}),url});}
  const response=await action("save",form({url:"https://replacement.example/mcp"}));expect(response!.status).toBe(200);expect(store.credential("memory")!.url).toBe("https://replacement.example/mcp");expect(await response!.text()).not.toContain(original.bearer);
  const enable=new FormData();enable.set("id","memory");expect((await action("enable",enable))!.status).toBe(422);expect(store.credential("memory")!.enabled).toBe(false);
});
