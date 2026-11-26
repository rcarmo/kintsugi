import type { JsonObject } from "@kintsugi/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { KintsugiCoreError, invalidArguments, readJsonObject, requestAcceptsJson } from "@kintsugi/core";
import { buttonHtml } from "@kintsugi/design-system/button";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { Icons } from "@kintsugi/design-system/icons";
import { domId, escapeHtml as h, type WorkspaceModule, type WorkspaceWorkViewPresentation } from "@kintsugi/shared";
import { jsonResponse, stream, update } from "@kintsugi/shared/http";
import { AgentPlanConflict, agentPlanStore, agentPlanInputSchema, requirePlanAgent, type AgentPlan, type PlanAgent } from "./plan.ts";

export const planContentId = (workspaceId: string) => domId("agent_plan_content", workspaceId);
const signalId = (workspaceId: string, agentId: string) => domId("agent_plan_signal", workspaceId, agentId);
const statusId = (workspaceId: string) => domId("agent_plan_status", workspaceId);
function signal(plan: AgentPlan) { return `<span hidden data-agent-plan-target="version" data-agent-id="${h(plan.agentId)}" data-revision="${plan.revision}"></span>`; }
function button(caption: string, action: string, primary = false): string { return buttonHtml({ type: "button", variant: primary ? "primary" : "secondary", content: { kind: "caption", caption }, attributesHtml: `data-action="agent-plan#${action}"${action === "edit" ? ' data-agent-plan-target="editButton"' : ""}` }); }
export const planPresentation: WorkspaceWorkViewPresentation = { reference: { type: "plan" }, sourceKey: "plan", label: "Plan", kind: "contextual", iconHtml: Icons.Check, availability: { phase: "live" }, initiallyOpen: false };
const stepStatuses = {
  pending: { label: "Pending", icon: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
  in_progress: { label: "In progress", icon: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.5v11a5.5 5.5 0 0 0 0-11Z" fill="currentColor"/>' },
  completed: { label: "Completed", icon: '<path d="m3.5 8 3 3 6-6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' },
};
function planForm(workspaceId: string, agent: PlanAgent, plan: AgentPlan) {
  const completed = plan.plan.filter(item => item.status === "completed").length;
  const steps = plan.plan.map(({ step, status }) => {
    const { label, icon } = stepStatuses[status];
    return `<li class="agent-plan-step ${status}"><span class="agent-plan-step-icon" role="img" aria-label="${label}"><svg viewBox="0 0 16 16" aria-hidden="true">${icon}</svg></span><span class="agent-plan-step-text">${h(step)}</span></li>`;
  }).join("");
  return `<form class="agent-plan-editor" data-agent-plan-target="form" data-agent-id="${h(agent.id)}" data-action="submit->agent-plan#save" action="/workspaces/${encodeURIComponent(workspaceId)}/agent-plans/${encodeURIComponent(agent.id)}" method="post">
    <header class="work-view-toolbar agent-plan-toolbar"><div class="agent-plan-title"><strong>Plan</strong><span title="${h(agent.title)}">${h(agent.title)}</span></div><div class="agent-plan-progress"><progress max="${plan.plan.length || 1}" value="${completed}" aria-label="Plan completion"></progress><span>${completed}/${plan.plan.length}</span></div></header>
    <input type="hidden" name="expectedRevision" value="${plan.revision}" data-agent-plan-target="revision">
    <div id="${signalId(workspaceId, agent.id)}">${signal(plan)}</div>
    <div class="agent-plan-checklist agent-plan-view-only">
      ${plan.explanation ? `<p class="agent-plan-explanation">${h(plan.explanation)}</p>` : ""}
      ${steps ? `<ol role="list" aria-label="Plan steps">${steps}</ol>` : '<p class="agent-plan-empty">No checklist items yet.</p>'}
    </div>
    <div class="agent-plan-input agent-plan-edit-only">
      <pre class="agent-plan-highlight" data-agent-plan-target="highlight" aria-hidden="true"></pre>
      <textarea class="textarea agent-plan-text" name="markdown" aria-label="Agent plan Markdown" spellcheck="false" maxlength="65536" data-agent-plan-target="editor" data-action="input->agent-plan#edited scroll->agent-plan#scrollHighlight"${agent.readOnly ? " readonly" : ""}>${h(plan.markdown)}</textarea>
    </div>
    <footer class="agent-plan-footer">${agent.readOnly ? "" : '<p class="agent-plan-edit-only">Markdown checklist: [ ] pending · [-] in progress · [x] complete. One item may be in progress.</p>'}
    <div class="agent-plan-actions">
      <div class="agent-plan-view-only">${button(agent.readOnly ? "View Markdown" : "Edit", "edit")}</div>
      <div class="agent-plan-edit-only">${agent.readOnly ? button("Done", "cancelEdit") : `${button("Save", "save", true)}${button("Cancel", "cancelEdit")}`}</div>
      ${button("Refresh", "refresh")}${agent.readOnly ? "" : `<div class="agent-plan-view-only">${button("Reset", "reset")}</div><span class="agent-plan-spacer"></span>${button("Submit to model", "submitToModel")}`}
    </div></footer>
  </form>`;
}
function shell(workspaceId: string): string {
  const confirm = dialogHtml({ element: { id: domId("agent_plan_confirm", workspaceId), attributesHtml: 'data-agent-plan-target="confirmation"' }, iconHtml: Icons.Check, titleCaption: "Replace this plan?", bodyHtml: '<p data-agent-plan-target="confirmationMessage"></p>', omitCancelButton: true, footerHtml: `${button("Cancel", "cancelConfirmation")}${button("Continue", "confirmReplacement", true)}` });
  return `<section class="work-view-pane" data-work-view-source="plan"><div id="${domId("agent_plan_pane", workspaceId)}" class="agent-plan-pane" data-turbo-permanent data-controller="agent-plan" data-agent-plan-workspace-id-value="${h(workspaceId)}" data-action="kintsugi:workspace-agent-selected@document->agent-plan#sync kintsugi:workspace-pane-visible@document->agent-plan#sync kintsugi:workspace-pane-hidden@document->agent-plan#sync visibilitychange@document->agent-plan#sync">
    <div id="${planContentId(workspaceId)}" class="agent-plan-content"></div>
    <div id="${statusId(workspaceId)}" class="agent-plan-status" role="status" data-agent-plan-target="status">Select an Agent to view its plan.</div>${confirm}</div></section>`;
}
const reference = Type.Object({ type: Type.Literal("plan") }, { additionalProperties: false });
export const planWorkViews: NonNullable<WorkspaceModule["workViews"]> = [{ type: "plan", parseReference(value) { if (!Value.Check(reference, value)) throw invalidArguments("Invalid Plan view"); return value; }, identity: () => "plan", render: ({ workspaceId }) => shell(workspaceId) }];
export const planCommands: NonNullable<WorkspaceModule["commands"]> = [{ id: "plan.open", execute: () => ({ createdWorkView: { type: "plan" } }) }];
export const planLauncher = { id: "plan.open", label: "Open Plan", description: "Open the editable plan for the selected Agent.", scope: "workspace" as const, surfaces: { ui: { placement: "work-launcher" as const, iconHtml: Icons.Check, label: "Plan" } } };
export const planChannel: NonNullable<WorkspaceModule["cableChannels"]>[number] = {
  name: "agent-plan",
  async subscribe(identifier, listener) {
    if (identifier.channel !== "module" || identifier.name !== "agent-plan") throw invalidArguments("Invalid Plan channel");
    const { agentId } = Value.Parse(Type.Object({ agentId: Type.String({ minLength: 1 }) }, { additionalProperties: false }), identifier.params);
    await requirePlanAgent(identifier.workspaceId, agentId);
    const store = agentPlanStore();
    const publish = () => listener(update(signalId(identifier.workspaceId, agentId), signal(store.read(identifier.workspaceId, agentId))));
    const unsubscribe = store.subscribe((workspace, agent) => { if (workspace === identifier.workspaceId && agent === agentId) publish(); });
    publish();
    return { unsubscribe };
  },
};
export const handlePlanRequest: NonNullable<WorkspaceModule["routes"]>[number]["handle"] = async (request, url) => {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/agent-plans\/([^/]+)$/);
  if (!match) return;
  const workspaceId = decodeURIComponent(match[1]!), agentId = decodeURIComponent(match[2]!);
  const json = requestAcceptsJson(request);
  try {
    const agent = await requirePlanAgent(workspaceId, agentId);
    let plan: AgentPlan;
    if (request.method === "GET") plan = agentPlanStore().read(workspaceId, agentId);
    else if (request.method === "POST") {
      if (agent.readOnly) return new Response("This Agent is read-only", { status: 403 });
      const input = await readJsonObject(request);
      if (!Value.Check(agentPlanInputSchema, input)) throw invalidArguments("Invalid plan action or fields");
      plan = agentPlanStore().change(workspaceId, agentId, input);
    } else return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
    const headers = { "x-kintsugi-plan-revision": String(plan.revision) };
    return json ? jsonResponse({ agent, plan }, { headers }) : stream(update(planContentId(workspaceId), planForm(workspaceId, agent, plan)), { headers });
  } catch (error) {
    if (!(error instanceof KintsugiCoreError) && !(error instanceof AgentPlanConflict)) throw error;
    const status = error instanceof AgentPlanConflict ? 409 : error.code === "agent_not_found" || error.code === "workspace_not_found" ? 404 : 400;
    return json ? jsonResponse({ error: { message: error.message } }, { status }) : stream(update(statusId(workspaceId), h(error.message)), { status });
  }
};
const planSchemaJson: JsonObject = JSON.parse(JSON.stringify(agentPlanInputSchema));
export const planOpenApiPaths = {
  "/workspaces/{id}/agent-plans/{agentId}": {
    get: { summary: "Read the selected Agent's persistent Markdown plan and revision", parameters: ["id", "agentId"].map(name => ({ name, in: "path", required: true, schema: { type: "string" } })), responses: { "200": { description: "Agent metadata and plan; HTML clients receive server-rendered Plan updates" } } },
    post: { summary: "Update an Agent plan without starting agent work", parameters: ["id", "agentId"].map(name => ({ name, in: "path", required: true, schema: { type: "string" } })), requestBody: { required: true, content: { "application/json": { schema: planSchemaJson } } }, responses: { "200": { description: "Saved plan" }, "409": { description: "Revision conflict; local draft must be preserved" } } },
  },
};
