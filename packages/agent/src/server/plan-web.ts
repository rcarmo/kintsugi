import type { JsonObject } from "@kintsugi/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { KintsugiCoreError, invalidArguments, readJsonObject, requestAcceptsJson } from "@kintsugi/core";
import { buttonHtml } from "@kintsugi/design-system/button";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { Icons } from "@kintsugi/design-system/icons";
import { domId, escapeHtml as h, type WorkspaceModule, type WorkspaceWorkViewPresentation } from "@kintsugi/shared";
import { jsonResponse, stream, update } from "@kintsugi/shared/http";
import { AgentPlanConflict, agentPlanStore, agentPlanInputSchema, agentPlanSubmission, requirePlanAgent, type AgentPlan, type PlanAgent } from "./plan.ts";

export const planContentId = (workspaceId: string) => domId("agent_plan_content", workspaceId);
const signalId = (workspaceId: string, agentId: string) => domId("agent_plan_signal", workspaceId, agentId);
const statusId = (workspaceId: string) => domId("agent_plan_status", workspaceId);
function signal(plan: AgentPlan) { return `<span hidden data-agent-plan-target="version" data-agent-id="${h(plan.agentId)}" data-revision="${plan.revision}"></span>`; }
function button(caption: string, action: string, primary = false): string { return buttonHtml({ type: "button", variant: primary ? "primary" : "secondary", content: { kind: "caption", caption }, attributesHtml: `data-action="agent-plan#${action}"` }); }
export const planPresentation: WorkspaceWorkViewPresentation = { reference: { type: "plan" }, sourceKey: "plan", label: "Plan", kind: "contextual", iconHtml: Icons.Check, availability: { phase: "live" }, initiallyOpen: false };
function editor(workspaceId: string, agent: PlanAgent, plan: AgentPlan) {
  const completed = plan.plan.filter(item => item.status === "completed").length;
  const percent = plan.plan.length ? Math.round(100 * completed / plan.plan.length) : 0;
  return `<form class="agent-plan-editor" data-agent-plan-target="form" data-agent-id="${h(agent.id)}" data-action="submit->agent-plan#save" action="/workspaces/${encodeURIComponent(workspaceId)}/agent-plans/${encodeURIComponent(agent.id)}" method="post">
    <header class="work-view-toolbar agent-plan-toolbar"><strong>${h(agent.title)}</strong><span>${completed}/${plan.plan.length} complete</span><progress max="100" value="${percent}" aria-label="Plan completion">${percent}%</progress></header>
    <input type="hidden" name="expectedRevision" value="${plan.revision}" data-agent-plan-target="revision">
    <div id="${signalId(workspaceId, agent.id)}">${signal(plan)}</div>
    <div class="agent-plan-input">
      <pre class="agent-plan-highlight" data-agent-plan-target="highlight" aria-hidden="true"></pre>
      <textarea class="textarea agent-plan-text" name="markdown" aria-label="Agent plan Markdown" spellcheck="false" maxlength="65536" data-agent-plan-target="editor" data-action="input->agent-plan#edited scroll->agent-plan#scrollHighlight"${agent.readOnly ? " readonly" : ""}>${h(plan.markdown)}</textarea>
    </div>
    <textarea hidden data-agent-plan-target="prompt">${h(agentPlanSubmission(plan.markdown))}</textarea>
    <footer class="agent-plan-footer"><p>Markdown checklist: [ ] pending · [-] in progress · [x] complete. One item may be in progress.</p>
    <div class="agent-plan-actions">${button("Refresh", "refresh")}${agent.readOnly ? "" : `${button("Reset", "reset")}${button("Save", "save", true)}${button("Submit to model", "submitToModel")}`}</div></footer>
  </form>`;
}
function shell(workspaceId: string): string {
  const confirm = dialogHtml({ element: { id: domId("agent_plan_confirm", workspaceId), attributesHtml: 'data-agent-plan-target="confirmation"' }, iconHtml: Icons.Check, titleCaption: "Replace this plan?", bodyHtml: '<p data-agent-plan-target="confirmationMessage"></p>', omitCancelButton: true, footerHtml: `${button("Cancel", "cancelConfirmation")}${button("Continue", "confirmReplacement", true)}` });
  return `<section class="work-view-pane" data-work-view-source="plan"><div id="${domId("agent_plan_pane", workspaceId)}" class="agent-plan-pane" data-turbo-permanent data-controller="agent-plan" data-agent-plan-workspace-id-value="${h(workspaceId)}" data-action="kintsugi:workspace-agent-selected@document->agent-plan#sync kintsugi:workspace-pane-visible@document->agent-plan#sync kintsugi:workspace-pane-hidden@document->agent-plan#sync visibilitychange@document->agent-plan#sync">
    <div id="${statusId(workspaceId)}" class="agent-plan-status" role="status" data-agent-plan-target="status">Select an Agent to view its plan.</div>
    <div id="${planContentId(workspaceId)}" class="agent-plan-content"></div>${confirm}</div></section>`;
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
    return json ? jsonResponse({ agent, plan }, { headers }) : stream(update(planContentId(workspaceId), editor(workspaceId, agent, plan)), { headers });
  } catch (error) {
    if (!(error instanceof KintsugiCoreError) && !(error instanceof AgentPlanConflict)) throw error;
    const status = error instanceof AgentPlanConflict ? 409 : error.code === "agent_not_found" || error.code === "workspace_not_found" ? 404 : 400;
    return json ? jsonResponse({ error: { message: error.message } }, { status }) : stream(update(statusId(workspaceId), h(error.message)), { status });
  }
};
const planSchemaJson: JsonObject = JSON.parse(JSON.stringify(agentPlanInputSchema));
export const planOpenApiPaths = {
  "/workspaces/{id}/agent-plans/{agentId}": {
    get: { summary: "Read the selected Agent's persistent Markdown plan and revision", parameters: ["id", "agentId"].map(name => ({ name, in: "path", required: true, schema: { type: "string" } })), responses: { "200": { description: "Agent metadata and plan; HTML clients receive server-rendered editor updates" } } },
    post: { summary: "Update an Agent plan without starting agent work", parameters: ["id", "agentId"].map(name => ({ name, in: "path", required: true, schema: { type: "string" } })), requestBody: { required: true, content: { "application/json": { schema: planSchemaJson } } }, responses: { "200": { description: "Saved plan" }, "409": { description: "Revision conflict; local draft must be preserved" } } },
  },
};
