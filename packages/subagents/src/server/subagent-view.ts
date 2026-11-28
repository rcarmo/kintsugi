import { buttonHtml } from "@kintsugi/design-system/button";
import { disclosureHtml, type DisclosureSummary } from "@kintsugi/design-system/disclosure";
import { listWorkspaceAgents, durableWorkspaceOwner, WorkspaceAgents, type AgentLivePresentationSubscription, type AgentRouteHandler } from "@kintsugi/builtin-agent/server";
import { ids } from "@kintsugi/agent/server/render-context";
import { requestAcceptsJson } from "@kintsugi/core";
import { createLivePresentation, escapeHtml as h, turboStream, turboStreamResponse, type WorkspaceAgentSettings, type WorkspaceAgentTab } from "@kintsugi/shared";
import { response } from "@kintsugi/shared/http";
import { clearFinishedSubagents, isActiveSubagent, nativeSnapshot, nativeSubagentViews, SubagentClearance, viewPath, withAncestors, type NativeSubagentView as SubagentRecord } from "./native-view-state.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Delegation } from "./native-state.ts";

export const subagentsWorkKey = "subagents:workspace";

/** The Work pane lists all Agent tabs; only Builtin Agents have native delegation trees. */
export async function renderSubagentsWorkView(
  workspaceId: string,
  roots: readonly WorkspaceAgentTab[],
  agentSettings: (agents: readonly WorkspaceAgentTab[]) => Promise<ReadonlyMap<string, WorkspaceAgentSettings>>,
): Promise<string> {
  const owner = roots.some(root => root.agentTypeId === "builtin") ? await durableWorkspaceOwner(workspaceId) : undefined;
  const grouped = byRoot(owner ? await owner.harness.commit(tx => nativeSubagentViews(tx), BACKGROUND_CONTEXT) : []);
  const settings = await agentSettings(roots);
  return `<section class="work-view-pane" data-work-view-source="${subagentsWorkKey}">
    <div id="subagents-work-${h(workspaceId)}" class="subagents-work-view" data-controller="subagents"
      data-subagents-workspace-id-value="${h(workspaceId)}"
      data-action="kintsugi:workspace-pane-visible@document->subagents#sync kintsugi:workspace-pane-hidden@document->subagents#sync visibilitychange@document->subagents#sync agent:turn-reveal->subagents#loaded:stop toggle->subagents#toggle:capture">
      ${roots.length ? roots.map(root => {
        const query = new URLSearchParams({ agent: root.id });
        const name = `<a href="/workspaces/${encodeURIComponent(workspaceId)}?${h(query.toString())}">${h(root.title)}</a>`;
        const configured = settingsText(settings.get(root.id));
        const children = root.agentTypeId === "builtin" ? `<div id="${h(contentId(workspaceId, root.id))}" data-turbo-permanent data-subagents-target="tree">${paneHtml(workspaceId, root.id, grouped.get(root.id) ?? [])}</div>` : "";
        return `<section class="subagents-root"><h3>${name}</h3>${configured ? `<p class="subagents-settings">${h(configured)}</p>` : ""}${children}</section>`;
      }).join("") : '<p class="subagents-empty">No Agents in this workspace yet.</p>'}
    </div>
  </section>`;
}

function byRoot(agents: readonly SubagentRecord[]): Map<string, SubagentRecord[]> {
  const grouped = new Map<string, SubagentRecord[]>();
  for (const agent of agents) {
    const children = grouped.get(agent.rootId);
    if (children) children.push(agent);
    else grouped.set(agent.rootId, [agent]);
  }
  return grouped;
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
      return new Response(null, { status: 303, headers: { location: `/workspaces/${encodeURIComponent(workspaceId)}?${new URLSearchParams({ agent: parent.agentId, workView: subagentsWorkKey })}` } });
    }
    const agents = await owner.harness.commit(tx => nativeSubagentViews(tx, parent.agentId), BACKGROUND_CONTEXT);
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
function settingsText(settings: WorkspaceAgentSettings | undefined): string | undefined {
  const parts: string[] = [];
  if (settings?.model) parts.push(settings.model);
  if (settings?.thinkingLevel) parts.push(`Thinking: ${settings.thinkingLevel}`);
  return parts.length ? parts.join(" · ") : undefined;
}
function branchSummary(agent: SubagentRecord, agents: SubagentRecord[]): DisclosureSummary {
  const tone = isActiveSubagent(agent) ? "running" : agent.status === "failed" ? "danger" : agent.status === "completed" ? "success" : "";
  const slots: Pick<DisclosureSummary, "width" | "attributesHtml" | "label" | "trailingHtml"> = {
    width: "fill", attributesHtml: `id="subagent-summary-${h(agent.id)}"`, label: { kind: "text", text: viewPath(agents, agent.id) },
    trailingHtml: `<span class="subagent-state"><span class="status-dot ${tone}"></span>${h(agent.status)}</span>`,
  };
  const settings: WorkspaceAgentSettings = {};
  if (agent.model) settings.model = `${agent.model.provider}/${agent.model.modelId}`;
  if (agent.thinkingLevel) settings.thinkingLevel = agent.thinkingLevel;
  const description = settingsText(settings);
  return description ? { ...slots, kind: "multiline", description } : { ...slots, kind: "compact" };
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
  if (!agents.length) return '<p class="subagents-empty">No subagents for this Agent yet.</p>';
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

/** Publish each Builtin Agent's subtree without replacing its open child transcripts. */
export async function subscribeSubagentTree(workspaceId: string, listener: (html: string) => void): Promise<AgentLivePresentationSubscription> {
  const owner = await durableWorkspaceOwner(workspaceId);
  let regions: { target: string; html: string }[] = [];
  const presentation = createLivePresentation(() => regions);
  const watches = await Promise.all([
    owner.harness.watchDoc(WorkspaceAgents, BACKGROUND_CONTEXT),
    owner.harness.watchDoc(Delegation, BACKGROUND_CONTEXT),
    owner.harness.watchDoc(SubagentClearance, BACKGROUND_CONTEXT),
    owner.harness.watchTaskGraph(BACKGROUND_CONTEXT),
  ]);
  let updates = Promise.resolve();
  const refresh = () => updates = updates.then(async () => {
    const roots = await listWorkspaceAgents(workspaceId);
    const grouped = byRoot(await owner.harness.commit(tx => nativeSubagentViews(tx), BACKGROUND_CONTEXT));
    regions = roots.map(({ agentId }) => ({ target: contentId(workspaceId, agentId), html: paneHtml(workspaceId, agentId, grouped.get(agentId) ?? []) }));
    presentation.invalidate();
  });
  for (const watch of watches) watch?.start(refresh);
  await refresh();

  const subscription = presentation.subscribe(listener);
  return { unsubscribe() { for (const watch of watches) void watch?.stop(); subscription.unsubscribe(); presentation.dispose(); } };
}
