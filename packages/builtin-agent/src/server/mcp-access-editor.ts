import {escapeHtml as h} from "@kintsugi/shared";
import {disclosureHtml} from "@kintsugi/design-system/disclosure";
import {listWorkspaces} from "@kintsugi/workspace";
import {listWorkspaceAgents} from "./agent-store.ts";
import {mcpAccess,type McpAccess} from "./mcp-policy.ts";
import type {PublicMcpConnection} from "./mcp-connections.ts";
export interface McpScopeWorkspace {id:string;title:string;agents:{id:string;title:string}[]}
export async function mcpScopeCatalog():Promise<McpScopeWorkspace[]> {
  const catalog:McpScopeWorkspace[]=[];
  for(const workspace of (await listWorkspaces({inspectImages:false})).workspaces){
    const agents=(await listWorkspaceAgents(workspace.id)).filter(agent=>!agent.readOnly).map(agent=>({id:agent.agentId,title:agent.title||agent.label}));
    catalog.push({id:workspace.id,title:workspace.title||workspace.id,agents});
  }
  return catalog;
}
export function mcpScopeSummary(server:PublicMcpConnection,catalog:readonly McpScopeWorkspace[]):string {
  const access=mcpAccess(server);
  if(access.kind==="all")return "All workspaces · all Agents";
  return access.grants.map(grant=>`${catalog.find(workspace=>workspace.id===grant.workspaceId)?.title??grant.workspaceId} · ${grant.agentIds==="all"?"all Agents":`${grant.agentIds.length} selected Agent${grant.agentIds.length===1?"":"s"}`}`).join("; ");
}
export function mcpAccessEditor(server:PublicMcpConnection|undefined,catalog:readonly McpScopeWorkspace[],override?:McpAccess):string {
  const access=override??(server?mcpAccess(server):undefined),all=access?.kind==="all",grants=access?.kind==="workspaces"?access.grants:[],stdio=server?.transport==="stdio";
  const workspaces=catalog.map(workspace=>({...workspace,agents:[...workspace.agents]}));
  for(const grant of grants){
    if(!workspaces.some(workspace=>workspace.id===grant.workspaceId))workspaces.push({id:grant.workspaceId,title:`Unavailable workspace ${grant.workspaceId}`,agents:[]});
    const workspace=workspaces.find(workspace=>workspace.id===grant.workspaceId)!;
    if(grant.agentIds!=="all")for(const id of grant.agentIds)if(!workspace.agents.some(agent=>agent.id===id))workspace.agents.push({id,title:`Unavailable Agent ${id}`});
  }
  const rows=workspaces.map(workspace=>{
    const grant=grants.find(grant=>grant.workspaceId===workspace.id),selected=Boolean(grant),restricted=grant?.agentIds!==undefined&&grant.agentIds!=="all";
    const agents=workspace.agents.map(agent=>`<label class="mcp-agent-choice"><input type="checkbox" name="agentIds_${h(workspace.id)}" value="${h(agent.id)}"${grant?.agentIds!=="all"&&grant?.agentIds.includes(agent.id)?" checked":""}><span>${h(agent.title)}</span></label>`).join("");
    const agentEditor=disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Agent access"}},bodyHtml:`<label class="settings-field"><span>Agents</span><select class="popup-select" data-controller="popup-select" name="agentsMode_${h(workspace.id)}" data-mcp-access-target="agentMode"><option value="all">All Agents</option><option value="selected"${restricted?" selected":""}>Selected Agents</option></select></label><fieldset class="mcp-agent-choices" data-mcp-access-target="agentChoices"${restricted?"":" hidden disabled"}><legend>Selected Agents</legend>${agents||'<p class="settings-help">No editable Agents in this workspace.</p>'}</fieldset>`});
    return `<div class="managed-list__item mcp-access-row" data-search-text="${h(workspace.title+" "+workspace.id)}" data-mcp-access-target="workspace"><label class="managed-list__label mcp-workspace-choice"><input type="checkbox" name="workspaceIds" value="${h(workspace.id)}" data-mcp-access-target="workspaceChoice"${selected?" checked":""}><span class="managed-list__label-text">${h(workspace.title)}</span></label><fieldset class="mcp-agent-settings" data-mcp-access-target="agentSettings"${selected?"":" hidden disabled"}>${agentEditor}</fieldset></div>`;
  }).join("");
  return `<section class="mcp-access-editor"><label class="settings-field"><span>Access</span><select class="popup-select" data-controller="popup-select" name="accessMode" data-mcp-access-target="mode"><option value="workspaces">Selected workspaces</option><option value="all"${all?" selected":""}${stdio?" disabled":""}>All workspaces</option></select></label><p class="settings-help">All workspaces includes future workspaces and all their Agents. Workspace stdio stays in one workspace.</p><fieldset class="mcp-access-workspaces" data-mcp-access-target="choices"${all?" hidden disabled":""}><legend>Workspaces <span class="settings-help" data-mcp-access-target="count">${grants.length} selected</span></legend><div class="managed-list" data-controller="managed-list"><div class="managed-list__filter"><input class="text-field" type="search" placeholder="Filter workspaces…" aria-label="Filter MCP workspaces"></div><div class="managed-list__items">${rows}<p class="managed-list__empty"${rows?" hidden":""}>No matching workspaces.</p></div></div></fieldset></section>`;
}
