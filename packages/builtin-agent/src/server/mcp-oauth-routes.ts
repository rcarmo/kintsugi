import {mcpConnections} from "./mcp-connections.ts";
import {mcpOAuthVault} from "./mcp-oauth.ts";
import {mcpFailure} from "./mcp-client.ts";
export async function handleMcpOAuth(request:Request,url:URL):Promise<Response|undefined>{
  const match=/^\/settings\/mcp\/oauth\/([a-zA-Z0-9_-]{1,128})\/(start|callback|disconnect)$/.exec(url.pathname);if(!match)return;
  const [,id,action]=match;if(request.method!==(action==="callback"?"GET":"POST"))return new Response("Method not allowed",{status:405});
  const store=await mcpConnections(),config=store.credential(id);
  if(!config||config.transport==="stdio"||config.auth!=="oauth")return new Response("Unknown OAuth connection",{status:404});
  const vault=mcpOAuthVault(config),callbackUrl=new URL(`/settings/mcp/oauth/${id}/callback`,url.origin).href,cookieName=`mcp_oauth_${id}`;
  const cookie=(value:string,age:number)=>`${cookieName}=${value}; Path=/settings/mcp/oauth/${id}; HttpOnly; SameSite=Lax; Max-Age=${age}${url.protocol==="https:"?"; Secure":""}`;
  const headers={"cache-control":"no-store","referrer-policy":"no-referrer"};
  try {
    if(action==="disconnect"){
      await vault.clear();await store.save({...config,enabled:false});
      return new Response(null,{status:303,headers:{...headers,location:"/settings?section=mcp","set-cookie":cookie("",0)}});
    }
    if(!config.enabled)throw new Error("Enable the connection before signing in.");
    if(action==="start"){
      const browserToken=crypto.randomUUID()+crypto.randomUUID(),result=await vault.begin(callbackUrl,browserToken);
      if(result.kind==="authorized"){await store.save(config);return new Response(null,{status:303,headers:{...headers,location:"/settings?section=mcp"}});}
      return new Response(null,{status:303,headers:{...headers,location:result.authorizationUrl,"set-cookie":cookie(browserToken,600)}});
    }
    const browserToken=request.headers.get("cookie")?.split(";").map(item=>item.trim()).find(item=>item.startsWith(cookieName+"="))?.slice(cookieName.length+1)??"";
    const code=url.searchParams.get("code"),state=url.searchParams.get("state");if(!code||!state||url.searchParams.has("error"))throw new Error("MCP sign-in was cancelled.");
    await vault.complete({code,state,iss:url.searchParams.get("iss")??undefined},browserToken,callbackUrl);
    // A connection may have changed while exchanging the code. Never re-enable or overwrite it.
    const current=store.credential(id);if(!current||current.revision!==config.revision)throw new Error("Connection changed during sign-in.");
    await store.save(current);
    return new Response(null,{status:303,headers:{...headers,location:"/settings?section=mcp","set-cookie":cookie("",0)}});
  }catch(error){return new Response(`${mcpFailure(error)} Return to MCP Settings and start sign-in again.`,{status:400,headers:{...headers,"content-type":"text/plain; charset=utf-8"}});}
}
