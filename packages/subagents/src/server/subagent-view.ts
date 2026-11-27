import { buttonHtml } from "@kintsugi/design-system/button";
import { disclosureHtml, type DisclosureSummary } from "@kintsugi/design-system/disclosure";
import { listWorkspaceAgents, durableWorkspaceOwner, WorkspaceAgents, type AgentLivePresentationSubscription, type AgentRouteHandler } from "@kintsugi/builtin-agent/server";
import { ids } from "@kintsugi/agent/server/render-context";
import { requestAcceptsJson } from "@kintsugi/core";
import { createLivePresentation, escapeHtml as h, turboStream, turboStreamResponse } from "@kintsugi/shared";
import { response } from "@kintsugi/shared/http";
import { clearFinishedSubagents, isActiveSubagent, nativeSnapshot, SubagentClearance, viewPath, withAncestors, type NativeSubagentView as SubagentRecord } from "./native-view-state.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Delegation } from "./native-state.ts";

export async function renderSubagentsControl(workspaceId: string, agentId: string): Promise<string> {
  const agents = (await nativeSnapshot(workspaceId)).agents.filter(agent => agent.rootId === agentId);
  return `<div class="subagents-control" data-controller="subagents"
    data-subagents-workspace-id-value="${h(workspaceId)}" data-subagents-agent-id-value="${h(agentId)}"
    data-action="kintsugi:workspace-agent-selected@document->subagents#sync kintsugi:workspace-pane-visible@document->subagents#sync kintsugi:workspace-pane-hidden@document->subagents#sync visibilitychange@document->subagents#sync agent:turn-reveal->subagents#loaded:stop toggle->subagents#toggle:capture">${disclosureHtml({
    element: { attributesHtml: `data-subagents-target="panel"${agents.length ? "" : " hidden"}` },
    summary: { kind: "compact", width: "fill", label: { kind: "text", text: "Subagents" },
      trailingHtml: `<span id="subagents-status-${h(agentId)}">${statusHtml(agents)}</span>` },
    bodyHtml: `<div id="${h(contentId(workspaceId, agentId))}" data-turbo-permanent></div>`,
  })}</div>`;
}
function statusHtml(agents: SubagentRecord[]): string {
  const count = agents.filter(isActiveSubagent).length;
  return `<span data-subagents-target="status" data-subagent-count="${agents.length}">${count} active</span>`;
}

export const handleSubagentRequest: AgentRouteHandler = async (request, url) => {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/subagents(\/clear-finished)?$/);
  if (!match || request.method !== (match[2] ? "POST" : "GET")) return undefined;
  const workspaceId = decodeURIComponent(match[1]!);
  const roots = await listWorkspaceAgents(workspaceId);
  const parentId = url.searchParams.get("agent") ?? (match[2] ? undefined : roots[0]?.agentId);
  const parent = roots.find((agent) => agent.agentId === parentId);
  if (!parent) return new Response("Agent not found", { status: 404 });
  if (match[2]) {
    const owner = await durableWorkspaceOwner(workspaceId);
    const cleared = await clearFinishedSubagents(owner.harness, parent.agentId);
    if (cleared === null) return new Response("Agent not found", { status: 404 });
    if (requestAcceptsJson(request)) return Response.json({ cleared });
    if (!request.headers.get("accept")?.includes("text/vnd.turbo-stream.html")) {
      return new Response(null, { status: 303, headers: { location: `/workspaces/${encodeURIComponent(workspaceId)}?${new URLSearchParams({ agent: parent.agentId })}` } });
    }
    const agents = (await nativeSnapshot(workspaceId)).agents.filter(agent => agent.rootId === parent.agentId);
    return turboStreamResponse(turboStream("update", contentId(workspaceId, parent.agentId), paneHtml(workspaceId, parent.agentId, agents), { method: "morph" }));
  }
  const snapshot = await nativeSnapshot(workspaceId);
  const agents = snapshot.agents.filter(agent => agent.rootId === parent.agentId);
  if (requestAcceptsJson(request)) return Response.json({ parent: { id: parentId, title: parent.title }, agents, messages: snapshot.messages.filter((message) => message.to === parentId || message.from === parentId || agents.some((agent) => agent.id === message.to || agent.id === message.from)) });
  const open = new Set(url.searchParams.getAll("open"));
  const reveal = url.searchParams.get("reveal");
  let revealed = agents.find((agent) => agent.id === reveal);
  while (revealed) { open.add(revealed.id); revealed = agents.find((agent) => agent.id === revealed!.parentId); }
  return response(`<turbo-frame id="${h(contentId(workspaceId, parent.agentId))}" data-turbo-permanent refresh="morph">${paneHtml(workspaceId, parent.agentId, agents, open, reveal)}</turbo-frame>`);
};

function contentId(workspaceId: string, rootId: string): string { return `subagents-content-${workspaceId}-${rootId}`; }
function childrenId(workspaceId: string, parentId: string): string { return `subagent-children-${workspaceId}-${parentId}`; }
function branchSummary(agent: SubagentRecord, agents: SubagentRecord[]): DisclosureSummary {
  const tone = isActiveSubagent(agent) ? "running" : agent.status === "failed" ? "danger" : agent.status === "completed" ? "success" : "";
  const slots: Pick<DisclosureSummary, "width" | "attributesHtml" | "label" | "trailingHtml"> = {
    width: "fill", attributesHtml: `id="subagent-summary-${h(agent.id)}"`, label: { kind: "text", text: viewPath(agents, agent.id) },
    trailingHtml: `<span class="subagent-state"><span class="status-dot ${tone}"></span>${h(agent.status)}</span>`,
  };
  return agent.model ? { ...slots, kind: "multiline", description: `${agent.model.provider}/${agent.model.modelId}` } : { ...slots, kind: "compact" };
}
function branchHtml(workspaceId: string, agent: SubagentRecord, all: SubagentRecord[], group: SubagentRecord[], open: Set<string>): string {
  return `<div class="subagent-branch">${disclosureHtml({
    element: { id: `subagent-${agent.id}`, attributesHtml: `data-subagent-id="${h(agent.id)}" data-subagents-target="branch"` },
    summary: branchSummary(agent, all), open: open.has(agent.id),
    bodyHtml: `<div id="${ids.transcript({ workspaceId, agentId: agent.id })}" class="agent-transcript" data-turbo-permanent></div>${childrenHtml(workspaceId, agent.id, group.filter(child => child.parentId === agent.id), all, group, open)}`,
  })}</div>`;
}
function childrenHtml(workspaceId: string, parentId: string, children: SubagentRecord[], all: SubagentRecord[], group: SubagentRecord[], open: Set<string>): string {
  return `<div id="${h(childrenId(workspaceId, parentId))}" class="action-list">${children.map(agent => branchHtml(workspaceId, agent, all, group, open)).join("")}</div>`;
}
function paneHtml(workspaceId: string, rootId: string, agents: SubagentRecord[], open = new Set<string>(), reveal?: string | null): string {
  const shown = withAncestors(agents, agents.filter(agent => !agent.cleared));
  const active = withAncestors(agents, agents.filter(isActiveSubagent));
  const visible = agents.filter(agent => shown.has(agent.id));
  const cleared = agents.filter(agent => !shown.has(agent.id));
  const canClear = visible.some(agent => !agent.cleared && !active.has(agent.id));
  const url = `/workspaces/${encodeURIComponent(workspaceId)}/subagents/clear-finished?${new URLSearchParams({ agent: rootId })}`;
  const action = canClear ? `<form class="subagents-actions" method="post" action="${h(url)}">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Clear finished" } })}</form>` : "";
  const main = childrenHtml(workspaceId, rootId, visible.filter(agent => agent.parentId === rootId), agents, visible, open);
  const archive = cleared.length ? disclosureHtml({
    element: { id: `subagents-cleared-${workspaceId}-${rootId}`, attributesHtml: 'data-subagents-target="cleared" data-subagents-cleared' },
    summary: { kind: "compact", width: "fill", label: { kind: "text", text: `Cleared (${cleared.length})` } },
    open: cleared.some(agent => agent.id === reveal || open.has(agent.id)),
    bodyHtml: childrenHtml(workspaceId, `${rootId}-cleared`, cleared.filter(agent => !cleared.some(parent => parent.id === agent.parentId)), agents, cleared, open),
  }) : "";
  return `${action}${main}${archive}`;
}

/** Publish the tree while preserving independently subscribed child transcripts. */
export async function subscribeSubagentTree(workspaceId: string, rootId: string, listener: (html: string) => void): Promise<AgentLivePresentationSubscription> {
  const roots = await listWorkspaceAgents(workspaceId);
  if (!roots.some((root) => root.agentId === rootId)) throw new Error(`Agent not found: ${rootId}`);
  const owner = await durableWorkspaceOwner(workspaceId);
  let snapshot = await nativeSnapshot(workspaceId);
  const presentation = createLivePresentation(() => {
    const agents = snapshot.agents.filter(agent => agent.rootId === rootId);
    return [{
      target: contentId(workspaceId, rootId),
      html: paneHtml(workspaceId, rootId, agents),
    }, {
      target: `subagents-status-${rootId}`,
      html: statusHtml(agents),
      morph: false,
    }];
  });
  const watches = await Promise.all([
    owner.harness.watchDoc(WorkspaceAgents, BACKGROUND_CONTEXT),
    owner.harness.watchDoc(Delegation, BACKGROUND_CONTEXT),
    owner.harness.watchDoc(SubagentClearance, BACKGROUND_CONTEXT),
    owner.harness.watchTaskGraph(BACKGROUND_CONTEXT),
  ]);
  let updates = Promise.resolve();
  const refresh = () => updates = updates.then(async () => { snapshot = await nativeSnapshot(workspaceId); presentation.invalidate(); });
  for (const watch of watches) watch?.start(refresh);
  await refresh();

  const subscription = presentation.subscribe(listener);
  return { unsubscribe() { for (const watch of watches) void watch?.stop(); subscription.unsubscribe(); presentation.dispose(); } };
}
