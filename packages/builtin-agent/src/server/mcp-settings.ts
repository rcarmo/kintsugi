import {defaultMcpRecallSettings,McpRecallSettingsSchema} from "@kintsugi/token-economizer/core";
import {handleMcpOAuth} from "./mcp-oauth-routes.ts";
import {Type} from "typebox";
import {Value} from "typebox/value";
import {escapeHtml as h,turboStream,turboStreamResponse,type SettingsContribution} from "@kintsugi/shared";
import {buttonHtml} from "@kintsugi/design-system/button";
import {disclosureHtml} from "@kintsugi/design-system/disclosure";
import {destructiveConfirmationHtml} from "@kintsugi/design-system/destructive-confirmation";
import {listWorkspaces} from "@kintsugi/workspace";
import {listWorkspaceAgents} from "./agent-store.ts";
import {mcpConnections,type PublicMcpConnection} from "./mcp-connections.ts";
import {mcpConnectionStatus,testMcpConnection} from "./mcp-runtime.ts";
import {mcpFailure} from "./mcp-client.ts";
class McpRecallSettingsError extends Error {}
const panel="mcp_connection_controls";
const button=(caption:string,action?:string)=>buttonHtml({type:"submit",variant:"secondary",content:{kind:"caption",caption},attributesHtml:action?`formaction="/settings/mcp/${action}"`:undefined});
const field=(label:string,input:string)=>`<label class="settings-field"><span>${label}</span>${input}</label>`;
async function scopeOptions(selected?:PublicMcpConnection){
  const workspaces=(await listWorkspaces({inspectImages:false})).workspaces;
  const options:{value:string;label:string}[]=[];
  for(const workspace of workspaces){options.push({value:JSON.stringify([workspace.id,""]),label:`${workspace.title||workspace.id} — all Agents`});for(const agent of await listWorkspaceAgents(workspace.id))if(!agent.readOnly)options.push({value:JSON.stringify([workspace.id,agent.agentId]),label:`${workspace.title||workspace.id} — ${agent.title||agent.label}`});}
  const current=selected?JSON.stringify([selected.workspaceId,selected.agentIds[0]??""]):"";
  if(current&&!options.some(item=>item.value===current))options.push({value:current,label:`${selected!.workspaceId} — ${selected!.agentIds.join(", ")||"all Agents"}`});
  return `<select class="popup-select" data-controller="popup-select" name="scope" aria-label="Access" required><option value="">Choose workspace or Agent…</option>${options.map(item=>`<option value="${h(item.value)}"${item.value===current?" selected":""}>${h(item.label)}</option>`).join("")}</select>`;
}
function recallEditor(server?:PublicMcpConnection){
  const settings=server?.recall??defaultMcpRecallSettings();
  return disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Output recall"}},bodyHtml:
    field("Model output",`<select class="popup-select" data-controller="popup-select" name="recallMode">${[["off","Off"],["observe","Watch"],["active","On"]].map(([value,label])=>`<option value="${value}"${settings.mode===value?" selected":""}>${label}</option>`).join("")}</select>`)+
    `<p class="settings-help">Watch keeps originals. On also shortens large MCP-only output for the model. Scripts keep full values. No model calls.</p>`+
    field("Retention (days)",`<input class="text-field" type="number" name="recallDays" min="1" max="90" required value="${settings.maxAgeDays}">`)+
    field("Retained items",`<input class="text-field" type="number" name="recallItems" min="1" max="256" required value="${settings.maxItems}">`)+
    field("Retained payload bytes",`<input class="text-field" type="number" name="recallBytes" min="4096" max="16777216" required value="${settings.maxBytes}">`)+
    disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Declarative profiles (JSON)"}},bodyHtml:field("Profiles",`<textarea class="text-field" name="recallProfiles" rows="5" spellcheck="false">${h(JSON.stringify(settings.profiles,null,2))}</textarea>`)+`<p class="settings-help">Up to 32 profiles. Tool names support *. Kinds: json-list, browser-snapshot, text. Optional path, fields and maxItems (1–20). First matching profile wins.</p><pre><code>${h(JSON.stringify([{name:"issues",tool:"mcp__*__issues",kind:"json-list",path:"items",fields:["id","title","status"],maxItems:8}],null,2))}</code></pre>`})+
    `<p class="settings-help">Recall tools search and retrieve this Agent’s retained data. Pins obey storage caps. Forget and expiry leave journal evidence intact. Maximum result: 1 MiB.</p>`});
}
async function editor(server?:PublicMcpConnection){const id=server?.id??crypto.randomUUID();return `<form method="post" action="/settings/mcp/save" data-turbo="true" class="form-stack"><input type="hidden" name="id" value="${h(id)}">
  ${field("Name",`<input class="text-field" name="name" required pattern="[a-z][a-z0-9_]{0,31}" value="${h(server?.name??"")}" placeholder="my_server">`)}
  ${field("Transport",`<select class="popup-select" data-controller="popup-select" name="transport"><option value="http">Streamable HTTP</option><option value="stdio"${server?.transport==="stdio"?" selected":""}>Workspace stdio</option></select>`)}
  ${field("Streamable HTTP endpoint",`<input class="text-field" type="url" name="url" value="${h(server?.url??"")}" placeholder="https://mcp.example.com/mcp">`)}
  ${field("HTTP authentication",`<select class="popup-select" data-controller="popup-select" name="auth"><option value="bearer">Bearer token</option><option value="oauth"${server?.auth==="oauth"?" selected":""}>OAuth browser sign-in</option></select>`)}
  ${field("Bearer token",`<input class="text-field" type="password" name="bearer" autocomplete="new-password"  placeholder="${server?"Leave blank to keep saved token":"Access token"}">`)}
  ${disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"OAuth client (optional)"}},bodyHtml:field("Client ID",`<input class="text-field" name="clientId" value="${h(server?.oauth?.clientId??"")}" autocomplete="off">`)+field("Client secret",`<input class="text-field" type="password" name="clientSecret" autocomplete="new-password" placeholder="Leave blank to keep saved secret">`)+field("Scopes",`<input class="text-field" name="oauthScope" value="${h(server?.oauth?.scope??"")}">`)+`<p class="settings-help">Leave the client ID blank for dynamic registration. For a fixed client, use this app’s origin plus <code>/settings/mcp/oauth/${h(id)}/callback</code> as the redirect URL.</p>`})}
  ${disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Workspace command (stdio)"}},bodyHtml:field("Command arguments (JSON array)",`<textarea class="text-field" name="command" rows="3" placeholder='["bun", "/work/mcp-server.ts"]'>${h(JSON.stringify(server?.command??[]))}</textarea>`)+field("Working directory",`<input class="text-field" name="workdir" value="${h(server?.workdir??"/work")}">`)+`<p class="settings-help">Runs inside the selected workspace as agent, not on the app host. No shell expansion. Stdout must contain only MCP messages.</p>`})}
  ${field("Access",await scopeOptions(server))}
  ${recallEditor(server)}
  ${field("Request timeout (seconds)",`<input class="text-field" type="number" name="timeoutSeconds" min="1" max="300" value="${server?.timeoutSeconds??30}">`)}
  <label><input type="checkbox" name="allowHttp" value="true"${server?.allowHttp?" checked":""}> Allow HTTP on a trusted network</label>
  <p class="settings-help">Use the authentication method required by your server. HTTP credentials stay outside Agent sandboxes.</p>
  ${button(server?"Save and reconnect":"Save and connect")}</form>`;}
export async function renderMcpSettings(message=""){
  const store=await mcpConnections();const rows=await Promise.all(store.list().map(async server=>{
    const status=mcpConnectionStatus(server.id);const label=server.enabled?status?.message??"Not connected yet": "Disabled";
    return disclosureHtml({element:{id:`mcp_server_${server.id}`},summary:{kind:"multiline",label:{kind:"text",text:server.name},description:`${server.transport==="stdio"?"Workspace stdio":server.url} · ${label}`},bodyHtml:`<div class="form-stack"><p>Access: ${h(server.workspaceId)} · ${h(server.agentIds.join(", ")||"all Agents")}</p>
    <form method="post" action="/settings/mcp/test" data-turbo="true"><input type="hidden" name="id" value="${h(server.id)}">${button("Refresh status","refresh")}${button("Test connection")}${server.enabled?button("Reconnect","reconnect"):""}${button(server.enabled?"Disable":"Enable",server.enabled?"disable":"enable")}${destructiveConfirmationHtml({id:`mcp_remove_${server.id}`,trigger:{type:"button",variant:"danger",content:{kind:"caption",caption:"Remove"}},confirmCaption:"Remove connection",cancelCaption:"Cancel",confirmFormAction:"/settings/mcp/remove"})}</form>
    ${server.auth==="oauth"?`<form method="post" action="/settings/mcp/oauth/${server.id}/start" data-turbo="false">${button("Sign in")}</form><form method="post" action="/settings/mcp/oauth/${server.id}/disconnect" data-turbo="false">${button("Sign out and disable")}</form>`:""}
    ${status?.tools.length?disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:`Tools (${status.tools.length})`}},bodyHtml:`<ul>${status.tools.map(name=>`<li><code>${h(name)}</code></li>`).join("")}</ul>`}):""}
    ${status?.resources?.length||status?.templates?.length?disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Resources"}},bodyHtml:`<ul>${[...status.resources??[],...status.templates??[]].map(uri=>`<li><code>${h(uri)}</code></li>`).join("")}</ul>`}):""}
    ${disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Edit connection"}},bodyHtml:await editor(server)})}</div>`});
  }));
  return `<div id="${panel}" class="form-stack">${message?`<p role="status">${h(message)}</p>`:""}<p>Connect an MCP server for the selected workspace or Agent. Remote tools run on that server; code mode can process their results locally.</p>${rows.join("")}${disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Add MCP server"}},bodyHtml:await editor()})}</div>`;
}
export const mcpSettingsContribution:SettingsContribution={id:"mcp",label:"MCP servers",order:76,render:renderMcpSettings,async handleAction({request,url}){
  const oauth=await handleMcpOAuth(request,url);if(oauth)return oauth;
  const match=/^\/settings\/mcp\/(save|test|refresh|reconnect|enable|disable|remove)$/.exec(url.pathname);if(!match||request.method!=="POST")return;
  const form=await request.formData(),store=await mcpConnections(),id=String(form.get("id")??""),previous=store.credential(id);let message="Connection updated.";
  try {
    if(match[1]==="save"){
      const scope:unknown=JSON.parse(String(form.get("scope")??"null"));if(!Value.Check(Type.Tuple([Type.String(),Type.String()]),scope))throw new Error("Invalid scope");
      const endpoint=String(form.get("url")??""),sameEndpoint=previous?.url===endpoint&&previous.workspaceId===scope[0];
      const clientId=String(form.get("clientId")??"");
      const command:unknown=JSON.parse(String(form.get("command")??"[]"));if(!Value.Check(Type.Array(Type.String()),command))throw new Error("Use a JSON command argument array.");
      const transport=form.get("transport")==="stdio"?"stdio":"http",auth=form.get("auth")==="oauth"?"oauth":"bearer";
      let profiles:unknown;
      try {profiles=JSON.parse(String(form.get("recallProfiles")??"[]"));}catch {throw new McpRecallSettingsError("Profiles must be valid JSON.");}
      const recall=form.has("recallMode")?{mode:String(form.get("recallMode")),maxAgeDays:Number(form.get("recallDays")),maxItems:Number(form.get("recallItems")),maxBytes:Number(form.get("recallBytes")),profiles}:previous?.recall??defaultMcpRecallSettings();
      if(!Value.Check(McpRecallSettingsSchema,recall))throw new McpRecallSettingsError("Check recall limits and profile fields, kinds and item limits.");
      await store.save({id,transport,auth,command,recall,workdir:String(form.get("workdir")??"/work"),oauth:{clientId:clientId||undefined,clientSecret:String(form.get("clientSecret")??"")||(sameEndpoint&&previous?.oauth?.clientId===clientId?previous?.oauth?.clientSecret:undefined),scope:String(form.get("oauthScope")??"")||undefined},name:String(form.get("name")??""),url:endpoint,bearer:String(form.get("bearer")??"").trim()||(sameEndpoint?previous?.bearer:"")||"",workspaceId:scope[0],agentIds:scope[1]?[scope[1]]:[],allowHttp:form.get("allowHttp")==="true",timeoutSeconds:Number(form.get("timeoutSeconds")??30),enabled:true});
      message=transport!=="stdio"&&auth==="oauth"?"Saved. Sign in to connect.":"Saved. Connection discovery runs in the background.";
    }else if(!previous)throw new Error("Unknown connection");
    else if(match[1]==="refresh")message="Connection status refreshed.";
    else if(match[1]==="test")message=(await testMcpConnection(previous)).message;
    else if(match[1]==="remove"){await store.remove(id);message="Connection removed.";}
    else {await store.save({...previous,enabled:match[1]!=="disable"});message=match[1]==="reconnect"?"Reconnect requested.":match[1]==="enable"?"Connection enabled.":"Connection disabled.";}
    return turboStreamResponse(turboStream("replace",panel,await renderMcpSettings(message)));
  }catch(error){return turboStreamResponse(turboStream("replace",panel,await renderMcpSettings(error instanceof McpRecallSettingsError?error.message:mcpFailure(error))),{status:422});}
}};
