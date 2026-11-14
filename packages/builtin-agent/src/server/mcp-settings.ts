import {defaultMcpRecallSettings} from "@kintsugi/token-economizer/core";
import {handleMcpOAuth} from "./mcp-oauth-routes.ts";
import {escapeHtml as h,turboStream,turboStreamResponse,type SettingsContribution} from "@kintsugi/shared";
import {buttonHtml} from "@kintsugi/design-system/button";
import {disclosureHtml} from "@kintsugi/design-system/disclosure";
import {destructiveConfirmationHtml} from "@kintsugi/design-system/destructive-confirmation";
import {mcpScopeCatalog,mcpScopeSummary,mcpAccessEditor,type McpScopeWorkspace} from "./mcp-access-editor.ts";
import type {McpAccess} from "./mcp-policy.ts";
import {mcpFormAccess,mcpSettingsInput,McpSettingsInputError} from "./mcp-settings-input.ts";
import {mcpConnections,McpConnectionValidationError,type PublicMcpConnection} from "./mcp-connections.ts";
import {mcpConnectionStatus,testMcpConnection} from "./mcp-runtime.ts";
import {mcpFailure} from "./mcp-client.ts";
interface McpEditorDraft {id:string;name:string;url:string;transport:"http"|"stdio";auth:"bearer"|"oauth";allowHttp:boolean;access?:McpAccess}
function draftAccess(form:FormData):McpAccess|undefined {try{return mcpFormAccess(form);}catch(error){if(error instanceof McpSettingsInputError)return;throw error;}}
const panel="mcp_connection_controls";
const button=(caption:string,action?:string,disabled=false)=>buttonHtml({type:"submit",variant:"secondary",content:{kind:"caption",caption},disabled,attributesHtml:action?`formaction="/settings/mcp/${action}"`:undefined});
const field=(label:string,input:string)=>`<label class="settings-field"><span>${label}</span>${input}</label>`;
function recallEditor(server?:PublicMcpConnection){
  const settings=server?.recall??defaultMcpRecallSettings();
  return disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Output recall"}},bodyHtml:
    field("Model output",`<select class="popup-select" data-controller="popup-select" name="recallMode">${[["off","Off"],["observe","Watch"],["active","On"]].map(([value,label])=>`<option value="${value}"${settings.mode===value?" selected":""}>${label}</option>`).join("")}</select>`)+
    `<p class="settings-help">Off blocks capture and access to retained copies. Watch keeps originals. On also shortens large MCP-only output for the model. Scripts keep full values. Sensitive tools and detected secrets are excluded from recall. No model calls.</p>`+
    field("Days since last capture",`<input class="text-field" type="number" name="recallDays" min="1" max="90" required value="${settings.maxAgeDays}">`)+
    field("Retained items per conversation",`<input class="text-field" type="number" name="recallItems" min="1" max="256" required value="${settings.maxItems}">`)+
    field("Retained payload bytes per conversation",`<input class="text-field" type="number" name="recallBytes" min="4096" max="16777216" required value="${settings.maxBytes}">`)+
    disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Declarative profiles (JSON)"}},bodyHtml:field("Profiles",`<textarea class="text-field" name="recallProfiles" rows="5" spellcheck="false">${h(JSON.stringify(settings.profiles,null,2))}</textarea>`)+`<p class="settings-help">Up to 32 profiles. Tool names support *. Kinds: json-list, browser-snapshot, text. Optional path, fields and maxItems (1–20). First matching profile wins.</p><pre><code>${h(JSON.stringify([{name:"issues",tool:"mcp__*__issues",kind:"json-list",path:"items",fields:["id","title","status"],maxItems:8}],null,2))}</code></pre>`})+
    `<p class="settings-help">Limits apply to each conversation’s recall index, not total disk use. Reading does not extend retention. Pins obey storage caps. Off does not erase copies; enabling recall restores access to unexpired copies. Forget and expiry leave journal evidence intact. Maximum result: 1 MiB.</p>`});
}
async function editor(server:PublicMcpConnection|undefined,catalog:readonly McpScopeWorkspace[],draft?:McpEditorDraft){const id=draft?.id??server?.id??crypto.randomUUID(),transport=draft?.transport??server?.transport,auth=draft?.auth??server?.auth;return `<form method="post" action="/settings/mcp/save" data-turbo="true" class="form-stack mcp-connection-editor" data-controller="mcp-access" data-action="change->mcp-access#sync"><input type="hidden" name="id" value="${h(id)}">
  ${field("Name",`<input class="text-field" name="name" required pattern="[a-z][a-z0-9_]{0,31}" value="${h(draft?.name??server?.name??"")}" placeholder="my_server">`)}
  ${field("Transport",`<select class="popup-select" data-controller="popup-select" name="transport" data-mcp-access-target="transport"><option value="http">Streamable HTTP</option><option value="stdio"${transport==="stdio"?" selected":""}>Workspace stdio</option></select>`)}
  <fieldset class="mcp-transport-fields" data-mcp-access-target="http"${transport==="stdio"?" hidden disabled":""}>
  ${field("Streamable HTTP endpoint",`<input class="text-field" type="url" name="url" value="${h(draft?.url??server?.url??"")}" placeholder="https://mcp.example.com/mcp">`)}
  ${field("HTTP authentication",`<select class="popup-select" data-controller="popup-select" name="auth"><option value="bearer">Bearer token</option><option value="oauth"${auth==="oauth"?" selected":""}>OAuth browser sign-in</option></select>`)}
  ${field("Bearer token",`<input class="text-field" type="password" name="bearer" autocomplete="new-password"  placeholder="${server?.hasSavedCredentials?"Blank keeps the saved token":"Access token"}">`)}
  ${disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"OAuth client (optional)"}},bodyHtml:field("Client ID",`<input class="text-field" name="clientId" value="${h(server?.oauth?.clientId??"")}" autocomplete="off">`)+field("Client secret",`<input class="text-field" type="password" name="clientSecret" autocomplete="new-password" placeholder="Leave blank to keep saved secret">`)+field("Scopes",`<input class="text-field" name="oauthScope" value="${h(server?.oauth?.scope??"")}">`)+`<p class="settings-help">Leave the client ID blank for dynamic registration. For a fixed client, use this app’s origin plus <code>/settings/mcp/oauth/${h(id)}/callback</code> as the redirect URL.</p>`})}
  ${server?.hasSavedCredentials?`<label class="mcp-credential-reuse"><input type="checkbox" name="reuseCredentials" value="true"> Use saved credentials for the new endpoint</label><p class="settings-help">Only select this if the new endpoint should receive the same credentials. OAuth requires a new sign-in after a URL change.</p>`:""}
  ${server?.needsCredentialApproval?`<p class="settings-help">Saved credentials belong to another endpoint. Enter new credentials or approve reuse before connecting.</p>`:""}
  </fieldset>
  <fieldset class="mcp-transport-fields" data-mcp-access-target="stdio"${transport==="stdio"?"":" hidden disabled"}>
  ${disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Workspace command (stdio)"}},bodyHtml:field("Command arguments (JSON array)",`<textarea class="text-field" name="command" rows="3" placeholder='["bun", "/work/mcp-server.ts"]'>${h(JSON.stringify(server?.command??[]))}</textarea>`)+field("Working directory",`<input class="text-field" name="workdir" value="${h(server?.workdir??"/work")}">`)+`<p class="settings-help">Runs inside the selected workspace as agent, not on the app host. No shell expansion. Stdout must contain only MCP messages.</p>`})}
  </fieldset>
  ${mcpAccessEditor(server,catalog,draft?.access)}
  ${recallEditor(server)}
  ${field("Request timeout (seconds)",`<input class="text-field" type="number" name="timeoutSeconds" min="1" max="300" value="${server?.timeoutSeconds??30}">`)}
  <label><input type="checkbox" name="allowHttp" value="true"${(draft?.allowHttp??server?.allowHttp)?" checked":""}> Allow HTTP on a trusted network</label>
  <p class="settings-help">Use the authentication method required by your server. HTTP credentials stay outside Agent sandboxes.</p>
  ${button(server?"Save changes":"Save and connect")}</form>`;}
export async function renderMcpSettings(message="",draft?:McpEditorDraft,openId?:string){
  const store=await mcpConnections(),catalog=await mcpScopeCatalog();const rows=await Promise.all(store.list().map(async server=>{
    const status=mcpConnectionStatus(server.id);const label=server.enabled?status?.message??"Not connected yet": "Disabled";
    return disclosureHtml({element:{id:`mcp_server_${server.id}`},open:server.id===draft?.id||server.id===openId,summary:{kind:"multiline",label:{kind:"text",text:server.name},description:`${server.transport==="stdio"?"Workspace stdio":server.url} · ${label}`},bodyHtml:`<div class="form-stack"><p class="settings-help">Access: ${h(mcpScopeSummary(server,catalog))}</p>
    <form method="post" action="/settings/mcp/test" data-turbo="true"><input type="hidden" name="id" value="${h(server.id)}">${button("Refresh status","refresh")}${button("Test connection")}${server.enabled?button("Reconnect","reconnect"):""}${button(server.enabled?"Disable":"Enable",server.enabled?"disable":"enable")}${destructiveConfirmationHtml({id:`mcp_remove_${server.id}`,trigger:{type:"button",variant:"danger",content:{kind:"caption",caption:"Remove"}},confirmCaption:"Remove connection",cancelCaption:"Cancel",confirmFormAction:"/settings/mcp/remove"})}</form>
    ${server.auth==="oauth"?`<form method="post" action="/settings/mcp/oauth/${server.id}/start" data-turbo="false">${button("Sign in",undefined,!server.enabled)}</form><form method="post" action="/settings/mcp/oauth/${server.id}/disconnect" data-turbo="false">${button("Sign out and disable")}</form>`:""}
    ${status?.tools.length?disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:`Tools (${status.tools.length})`}},bodyHtml:`<ul>${status.tools.map(name=>`<li><code>${h(name)}</code></li>`).join("")}</ul>`}):""}
    ${status?.resources?.length||status?.templates?.length?disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Resources"}},bodyHtml:`<ul>${[...status.resources??[],...status.templates??[]].map(uri=>`<li><code>${h(uri)}</code></li>`).join("")}</ul>`}):""}
    ${disclosureHtml({open:server.id===draft?.id||server.id===openId,summary:{kind:"compact",label:{kind:"text",text:"Edit connection"}},bodyHtml:await editor(server,catalog,server.id===draft?.id?draft:undefined)})}</div>`});
  }));
  return `<div id="${panel}" class="form-stack">${message?`<p role="status">${h(message)}</p>`:""}<p>Configure an MCP server once and choose which workspaces and Agents can use it. Remote tools run on that server; code mode can process their results locally.</p>${rows.join("")}${disclosureHtml({open:Boolean(draft&&!store.list().some(server=>server.id===draft.id)),summary:{kind:"compact",label:{kind:"text",text:"Add MCP server"}},bodyHtml:await editor(undefined,catalog,draft&&!store.list().some(server=>server.id===draft.id)?draft:undefined)})}</div>`;
}
export const mcpSettingsContribution:SettingsContribution={id:"mcp",label:"MCP servers",order:76,render:renderMcpSettings,renderFocused:id=>renderMcpSettings("",undefined,id),async handleAction({request,url}){
  const oauth=await handleMcpOAuth(request,url);if(oauth)return oauth;
  const match=/^\/settings\/mcp\/(save|test|refresh|reconnect|enable|disable|remove)$/.exec(url.pathname);if(!match||request.method!=="POST")return;
  const form=await request.formData(),store=await mcpConnections(),id=String(form.get("id")??""),previous=store.credential(id);let message="Connection updated.";
  try {
    if(match[1]==="save"){
      const input=mcpSettingsInput(form,previous);
      await store.save(input.connection);
      message=input.message;
    }else if(!previous)throw new Error("Unknown connection");
    else if(match[1]==="refresh")message="Connection status refreshed.";
    else if(match[1]==="test")message=(await testMcpConnection(previous)).message;
    else if(match[1]==="remove"){await store.remove(id);message="Connection removed.";}
    else {await store.save({...previous,enabled:match[1]!=="disable"});message=match[1]==="reconnect"?"Reconnect requested.":match[1]==="enable"?"Connection enabled.":"Connection disabled.";}
    return turboStreamResponse(turboStream("replace",panel,await renderMcpSettings(message,undefined,match[1]==="save"?id:undefined)));
  }catch(error){return turboStreamResponse(turboStream("replace",panel,await renderMcpSettings(`Not saved: ${error instanceof McpSettingsInputError||error instanceof McpConnectionValidationError?error.message:mcpFailure(error)}`,match[1]==="save"?{id,name:String(form.get("name")??"").slice(0,128),url:String(form.get("url")??"").slice(0,2048),transport:form.get("transport")==="stdio"?"stdio":"http",auth:form.get("auth")==="oauth"?"oauth":"bearer",allowHttp:form.get("allowHttp")==="true",access:draftAccess(form)}:undefined)),{status:422});}
}};
