import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {McpOAuthVault} from "../../src/server/mcp-oauth.ts";
import {handleMcpOAuth} from "../../src/server/mcp-oauth-routes.ts";
import {McpConnectionStore,mcpConnections} from "../../src/server/mcp-connections.ts";
import {connectMcpHttp} from "../../src/server/mcp-client.ts";
import type {McpConnection} from "../../src/server/mcp-connections.ts";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),"mcp-oauth-"));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  let exchanges=0,refreshes=0,challenge="";let issuer="",refreshGate=Promise.resolve();
  const server=Bun.serve({port:0,async fetch(request){const url=new URL(request.url);
    if(url.pathname.startsWith("/.well-known/oauth-protected-resource"))return Response.json({resource:issuer+"/mcp",authorization_servers:[issuer]});
    if(url.pathname.startsWith("/.well-known/"))return Response.json({issuer,authorization_endpoint:issuer+"/authorize",token_endpoint:issuer+"/token",registration_endpoint:issuer+"/register",response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"]});
    if(url.pathname==="/register")return Response.json({...await request.json(),client_id:"fixture-client"});
    if(url.pathname==="/token"){
      const body=new URLSearchParams(await request.text());
      if(body.get("grant_type")==="authorization_code"){
        expect(body.get("code")).toBe("fixture-code");const verifier=body.get("code_verifier")!;expect(new Bun.CryptoHasher("sha256").update(verifier).digest("base64url")).toBe(challenge);exchanges++;
        return Response.json({access_token:"private-access",token_type:"Bearer",refresh_token:"private-refresh",expires_in:3600});
      }
      expect(body.get("refresh_token")).toBe("private-refresh");refreshes++;await refreshGate;return Response.json({access_token:"rotated-access",token_type:"Bearer",refresh_token:"rotated-refresh",expires_in:3600});
    }
    if(url.pathname==="/mcp"){
      if(!["Bearer private-access","Bearer rotated-access"].includes(request.headers.get("authorization")??""))return new Response(null,{status:401,headers:{"www-authenticate":`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`}});
      if(request.method==="GET")return new Response(null,{status:405});if(request.method==="DELETE")return new Response(null,{status:200});
      // SAFETY: This isolated fixture is called only by the SDK JSON-RPC client below.
      const rpc=await request.json() as {id?:number;method:string};if(rpc.id===undefined)return new Response(null,{status:202});
      return Response.json({jsonrpc:"2.0",id:rpc.id,result:rpc.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"oauth-fixture",version:"1"}}:{tools:[]}});
    }
    return new Response(null,{status:404});
  }});issuer=server.url.origin;cleanup.push(async()=>{server.stop(true);});
  const config:McpConnection={id:"oauth",name:"oauth",url:issuer+"/mcp",bearer:"",auth:"oauth",allowHttp:true,timeoutSeconds:2,workspaceId:"workspace",agentIds:[],enabled:true,revision:1};
  const vault=new McpOAuthVault(config,directory),redirectUrl="http://localhost:3120/settings/mcp/oauth/oauth/callback";
  return {directory,config,vault,redirectUrl,holdRefresh:(gate:Promise<void>)=>{refreshGate=gate;},setChallenge:(value:string)=>{challenge=value;},get exchanges(){return exchanges;},get refreshes(){return refreshes;}};
}
test("OAuth discovery, PKCE, browser binding, callback replay rejection, reopen and serialized refresh",async()=>{
  const f=await fixture(),start=await f.vault.begin(f.redirectUrl,"fixture-browser");expect(start.kind).toBe("redirect");if(start.kind!=="redirect")throw Error("Expected browser sign-in");
  const authorization=new URL(start.authorizationUrl);expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");f.setChallenge(authorization.searchParams.get("code_challenge")!);
  await expect(f.vault.complete({code:"fixture-code",state:start.state},"wrong-browser",f.redirectUrl)).rejects.toThrow();
  await expect(f.vault.complete({code:"fixture-code",state:"wrong-state"},"fixture-browser",f.redirectUrl)).rejects.toThrow();
  await f.vault.complete({code:"fixture-code",state:start.state},"fixture-browser",f.redirectUrl);expect(f.exchanges).toBe(1);
  await expect(f.vault.complete({code:"fixture-code",state:start.state},"fixture-browser",f.redirectUrl)).rejects.toThrow();expect(f.exchanges).toBe(1);
  const reopened=new McpOAuthVault(f.config,f.directory),auth=reopened.authProvider();expect(await auth.token()).toBe("private-access");
  const connected=await connectMcpHttp(f.config,fetch,auth);expect(connected.tools).toEqual([]);await connected.client.close();await auth.settled();
  const state=(await reopened.load())!;state.tokensExpireAt=1;await reopened.save(state);
  const a=reopened.authProvider(),b=new McpOAuthVault(f.config,f.directory).authProvider();expect(await Promise.all([a.token(),b.token()])).toEqual(["rotated-access","rotated-access"]);expect(f.refreshes).toBe(1);await a.settled();await b.settled();
  expect((await stat(join(f.directory,"mcp/oauth/oauth.json"))).mode&0o777).toBe(0o600);
});
test("OAuth credentials never enter public config and changing endpoint or workspace cannot reuse them",async()=>{
  const f=await fixture(),store=new McpConnectionStore(f.directory);await store.save({...f.config,oauth:{clientId:"registered",clientSecret:"private-client-secret"}});
  expect(JSON.stringify(store.list())).not.toContain("private-client-secret");
  await f.vault.save({serverUrl:f.config.url,tokens:{access_token:"private-access",token_type:"Bearer"}});
  expect(await new McpOAuthVault({...f.config,url:"https://other.example/mcp"},f.directory).load()).toBeUndefined();
  expect(await new McpOAuthVault({...f.config,workspaceId:"other"},f.directory).load()).toBeUndefined();
  await store.remove(f.config.id);expect(await new McpOAuthVault(store.credential(f.config.id)??f.config,f.directory).load()).toBeUndefined();
});
test("OAuth callback routes require the browser cookie, consume state once and sign-out disables access",async()=>{
  const f=await fixture(),old=process.env.KINTSUGI_DATA_DIR;process.env.KINTSUGI_DATA_DIR=f.directory;cleanup.push(async()=>{if(old===undefined)delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR=old;});
  const store=await mcpConnections();await store.save(f.config);
  const startUrl=new URL("http://localhost:3120/settings/mcp/oauth/oauth/start"),start=(await handleMcpOAuth(new Request(startUrl,{method:"POST"}),startUrl))!;
  expect(start.status).toBe(303);const cookie=start.headers.get("set-cookie")!.split(";")[0]!,authorization=new URL(start.headers.get("location")!);expect(start.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax");
  f.setChallenge(authorization.searchParams.get("code_challenge")!);const callback=new URL(f.redirectUrl);callback.searchParams.set("state",authorization.searchParams.get("state")!);callback.searchParams.set("code","fixture-code");
  expect((await handleMcpOAuth(new Request(callback),callback))?.status).toBe(400);
  const completed=(await handleMcpOAuth(new Request(callback,{headers:{cookie}}),callback))!;expect(completed.status).toBe(303);expect(completed.headers.get("referrer-policy")).toBe("no-referrer");expect(completed.headers.get("cache-control")).toBe("no-store");
  expect((await handleMcpOAuth(new Request(callback,{headers:{cookie}}),callback))?.status).toBe(400);expect(f.exchanges).toBe(1);
  const disconnect=new URL("http://localhost:3120/settings/mcp/oauth/oauth/disconnect");expect((await handleMcpOAuth(new Request(disconnect,{method:"POST"}),disconnect))?.status).toBe(303);
  expect(store.credential(f.config.id)?.enabled).toBe(false);expect((await f.vault.load())?.tokens).toBeUndefined();
});
test("sign-out waits for an in-flight refresh and cannot resurrect rotated tokens",async()=>{
  const f=await fixture(),gate=Promise.withResolvers<void>();f.holdRefresh(gate.promise);
  await f.vault.save({serverUrl:f.config.url,clientInformation:{client_id:"fixture-client"},tokensExpireAt:1,tokens:{access_token:"expired",token_type:"Bearer",refresh_token:"private-refresh"}});
  const auth=f.vault.authProvider(),refresh=auth.token();
  for(let n=0;n<100&&f.refreshes===0;n++)await Bun.sleep(5);expect(f.refreshes).toBe(1);
  const clear=f.vault.clear();gate.resolve();await Promise.all([refresh,clear]);await auth.settled();expect((await f.vault.load())?.tokens).toBeUndefined();
});
