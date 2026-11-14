import {Type} from "typebox";
import {Value} from "typebox/value";
import {McpRecallSettingsSchema,defaultMcpRecallSettings} from "@kintsugi/token-economizer/core";
import {canonicalMcpAccess,mcpAccessSchema,mcpIdentitySchema,type McpAccess,type McpWorkspaceGrant} from "./mcp-policy.ts";
import {mcpEndpoint} from "./mcp-client.ts";
import type {McpConnection} from "./mcp-connections.ts";
export class McpSettingsInputError extends Error {}

export function mcpFormAccess(form:FormData):McpAccess {
  if(form.get("accessMode")==="all")return {kind:"all"};
  if(form.get("accessMode")!=="workspaces")throw new McpSettingsInputError("Choose which workspaces can use this server.");
  const ids=form.getAll("workspaceIds");
  if(!Value.Check(Type.Array(mcpIdentitySchema,{minItems:1,maxItems:100}),ids))throw new McpSettingsInputError("Select at least one workspace.");
  const grants:McpWorkspaceGrant[]=[...new Set(ids)].map(workspaceId=>{
    const mode=form.get(`agentsMode_${workspaceId}`);
    if(mode==="all")return {workspaceId,agentIds:"all"};
    if(mode!=="selected")throw new McpSettingsInputError("Choose all Agents or selected Agents for each workspace.");
    const agents=form.getAll(`agentIds_${workspaceId}`);
    if(!Value.Check(Type.Array(mcpIdentitySchema,{minItems:1,maxItems:100}),agents))throw new McpSettingsInputError("Select at least one Agent, or choose all Agents.");
    return {workspaceId,agentIds:[...new Set(agents)]};
  });
  return canonicalMcpAccess(Value.Parse(mcpAccessSchema,{kind:"workspaces",grants}));
}
export function mcpSettingsInput(form:FormData,previous?:McpConnection){
  const access=mcpFormAccess(form),transport=form.get("transport")==="stdio"?"stdio":"http",auth=form.get("auth")==="oauth"?"oauth":"bearer",allowHttp=form.get("allowHttp")==="true";
  if(transport==="stdio"&&(access.kind!=="workspaces"||access.grants.length!==1))throw new McpSettingsInputError("Workspace stdio needs one workspace. Use HTTP to share a server.");
  let endpoint="";
  if(transport==="http")try{endpoint=mcpEndpoint(String(form.get("url")??""),allowHttp);}catch{throw new McpSettingsInputError("Use an HTTP(S) endpoint without credentials, query or fragment. Allow HTTP explicitly for a trusted network.");}
  const sameEndpoint=previous?.transport!=="stdio"&&previous?.url===endpoint&&(previous?.auth??"bearer")===auth;
  const clientId=String(form.get("clientId")??"");
  const enteredBearer=String(form.get("bearer")??"").trim(),enteredSecret=String(form.get("clientSecret")??"");
  const bearer=enteredBearer||(previous?.auth!=="oauth"?previous?.bearer:"")||"";
  const hasSavedCredentials=auth==="oauth"?Boolean(previous?.oauth?.clientSecret&&previous.oauth.clientId===clientId):Boolean(previous?.bearer&&previous.auth!=="oauth");
  const approvedUrl=previous?.credentialUrl??previous?.url;
  const credentialUrl=(auth==="bearer"&&enteredBearer)||(auth==="oauth"&&enteredSecret)||form.get("reuseCredentials")==="true"||!hasSavedCredentials?endpoint:approvedUrl??endpoint;
  if(transport==="http"&&auth==="bearer"&&!bearer&&!previous)throw new McpSettingsInputError("Enter a bearer token to connect this server.");
  if(/[\r\n]/.test(bearer))throw new McpSettingsInputError("The token must not contain line breaks.");
  const command=(()=>{
    if(transport!=="stdio")return [];
    let value:unknown;try{value=JSON.parse(String(form.get("command")??"[]"));}catch{throw new McpSettingsInputError("Use a JSON array of command arguments.");}
    if(!Value.Check(Type.Array(Type.String()),value))throw new McpSettingsInputError("Use a JSON array of command arguments.");
    return value;
  })();
  let profiles:unknown;
  try{profiles=JSON.parse(String(form.get("recallProfiles")??"[]"));}catch{throw new McpSettingsInputError("Profiles must be valid JSON.");}
  const recall=form.has("recallMode")?{mode:String(form.get("recallMode")),maxAgeDays:Number(form.get("recallDays")),maxItems:Number(form.get("recallItems")),maxBytes:Number(form.get("recallBytes")),profiles}:previous?.recall??defaultMcpRecallSettings();
  if(!Value.Check(McpRecallSettingsSchema,recall))throw new McpSettingsInputError("Check recall limits and profile fields, kinds and item limits.");
  const first=access.kind==="workspaces"?access.grants[0]:undefined;
  // HTTP's legacy workspace field anchors existing OAuth credentials; the access policy owns grants.
  const workspaceId=transport==="stdio"?first!.workspaceId:previous?.workspaceId??first?.workspaceId??"all";
  const agentIds=first?.agentIds==="all"?[]:first?.agentIds??[];
  const changed=previous!==undefined&&!sameEndpoint;
  const needsCredentials=transport==="http"&&(auth==="bearer"&&!bearer||credentialUrl!==endpoint);
  const enabled=needsCredentials||transport==="http"&&auth==="oauth"&&changed?false:previous?.enabled??true;
  const connection={id:String(form.get("id")??""),name:String(form.get("name")??""),url:endpoint,credentialUrl,transport,auth,bearer,workspaceId,agentIds,access,command,workdir:String(form.get("workdir")??"/work"),recall,allowHttp,timeoutSeconds:Number(form.get("timeoutSeconds")??30),enabled,
    oauth:{clientId:clientId||undefined,clientSecret:enteredSecret||(previous?.oauth?.clientId===clientId?previous?.oauth?.clientSecret:undefined),scope:String(form.get("oauthScope")??"")||undefined},
  } satisfies Omit<McpConnection,"revision">;
  const message=needsCredentials?auth==="oauth"?"Saved. Enter OAuth credentials or approve reuse, save, then enable and sign in.":"Saved. Enter a token or approve reuse, then save and enable this connection.":transport==="http"&&auth==="oauth"&&changed?"Saved. Enable this connection, then sign in again.":!enabled?"Saved. This connection is disabled.":transport==="http"&&auth==="oauth"?"Saved. Sign in if this server needs authorisation.":"Saved. Connection discovery runs in the background.";
  return {connection,message};
}
