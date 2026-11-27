import { buttonHtml } from "@kintsugi/design-system/button";
import { contentRowHtml, type ContentRowContent } from "@kintsugi/design-system/content-row";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { Icons } from "@kintsugi/design-system/icons";
import { invalidArguments } from "@kintsugi/core";
import { escapeHtml } from "@kintsugi/shared";
import { response } from "@kintsugi/shared/http";
import { renderTranscript, renderTranscriptItemDetailFrame } from "./render-transcript.ts";
import { scriptSourceRegion } from "./render-tool.ts";
import { formatWorkflowScriptForDisplay } from "./embedded-code.ts";
import { formatDuration, findTranscriptItem, type TranscriptItem } from "./transcript.ts";
import { backgroundActivityPath, ids, type AgentRenderContext } from "./render-context.ts";
import { transcriptTargetLink } from "./render-markup.ts";

/** Work an Agent started that goes on beside its conversation, such as a background command or a subagent. */
export interface BackgroundActivity {
  /** Stable while it exists; its detail loads from `<agent path>/background/:key`. */
  key: string;
  /** What sort of work it is, in the Agent's own words, such as "command" or "subagent". */
  kind: string;
  /** What it is: the command, or the subagent's description. */
  title: string;
  /** Secondary text under the title, such as a subagent’s model. */
  subtitle?: string;
  /** Still working. An idle subagent may stay listed while it can be given more work. */
  running: boolean;
  startedAt?: number;
  /** Its latest one-line progress. */
  progress?: string;
  /** The start of its answer once it has finished, shown beside its name where another activity's page lists it. */
  result?: string;
  /** Further facts, in order, such as Type, Tool uses and Tokens. */
  details: Record<string, string>;
  /** What in the Agent's transcript started it, such as a tool call, and what to call it. */
  startedBy?: { itemKey: string; label: string };
  /** The activity that started this one. */
  parentKey?: string;
  stoppable: boolean;
  /** How its detail opens: in place under its row, or as its own page the pane slides to. */
  opens: "inline" | "drill-in";
}

/** Running work first, then idle work; each activity is followed by the work it started. */
function ordered(activities: readonly BackgroundActivity[]): Array<{ activity: BackgroundActivity; depth: number }> {
  const keys = new Set(activities.map(activity => activity.key));
  const children = (parent: BackgroundActivity, depth: number): Array<{ activity: BackgroundActivity; depth: number }> => [{ activity: parent, depth }, ...activities.filter(child => child.parentKey === parent.key).flatMap(child => children(child, depth + 1))];
  const roots = activities.filter(activity => !activity.parentKey || !keys.has(activity.parentKey));
  return [...roots.filter(activity => activity.running), ...roots.filter(activity => !activity.running)].flatMap(root => children(root, 0));
}

/** The workspace list's busy spinner. */
const spinnerHtml = '<span class="status-indicator" role="img" aria-label="Running"><i class="status-spinner sm" aria-hidden="true"></i></span>';

/** Background rows show the title, optional subtitle and a spinner while running. */
function rowHtml(ctx: AgentRenderContext, activity: BackgroundActivity, depth: number, withResult = false): string {
  const path = backgroundActivityPath(ctx, activity.key);
  const label = { kind: "text" as const, text: activity.title };
  const content: ContentRowContent = activity.subtitle
    ? { kind: "multiline", width: "fill", label, description: activity.subtitle }
    : { kind: "compact", width: "fill", label };
  const spinner = activity.running ? spinnerHtml : "";
  const result = withResult && activity.result ? `<span class="agent-background-result" title="${escapeHtml(activity.result)}">${escapeHtml(activity.result)}</span>` : "";
  const row = activity.opens === "drill-in"
    ? contentRowHtml({ ...content, trailingHtml: `${result}${spinner}<span class="agent-background-chevron">${Icons.Next}</span>`, element: { tag: "a", attributesHtml: `href="${escapeHtml(path)}" data-action="agent-background#open"` } })
    // The frame loads once the row is opened, and keeps its contents while the list updates.
    : disclosureHtml({ summary: { ...content, trailingHtml: spinner }, bodyHtml: `<turbo-frame id="${ids.backgroundDetail(ctx, activity.key)}" src="${escapeHtml(path)}" loading="lazy" refresh="morph" data-turbo-permanent></turbo-frame>` });
  return `<div class="agent-background-activity${result ? " agent-background-activity--result" : ""}" style="--agent-background-depth: ${depth}" data-background-key="${escapeHtml(activity.key)}">${row}</div>`;
}

/** Rows for drill-in activities on another activity's page, such as a workflow's agents, with the start of each one's answer once it has finished; each opens its own page, as from the bar. */
export function backgroundActivityLinksHtml(ctx: AgentRenderContext, activities: readonly BackgroundActivity[]): string {
  return activities.map(activity => {
    if (activity.opens !== "drill-in") throw new Error("Only drill-in activities link from a page");
    return rowHtml(ctx, activity, 0, true);
  }).join("");
}

/** The pane's fixed bar: how much is going on, opening to a row for each activity. Empty when there is none. */
export function renderBackgroundActivities(ctx: AgentRenderContext, activities: readonly BackgroundActivity[]): string {
  if (!activities.length) return "";
  const running = activities.filter(activity => activity.running).length;
  const inactive = activities.length - running;
  const count = [running ? `${running} running ${spinnerHtml}` : "", inactive ? `${inactive} inactive` : ""].filter(Boolean).join(" · ");
  const html = ordered(activities).map(({ activity, depth }) => rowHtml(ctx, activity, depth)).join("");
  return disclosureHtml({
    element: { id: ids.backgroundList(ctx) },
    summary: { kind: "compact", width: "fill", label: { kind: "text", text: "Background" }, trailingHtml: `<span class="agent-background-meta">${count}</span>` },
    bodyHtml: html,
  });
}

/** Stopping ends work that can't be resumed, so it asks first. */
function stopHtml(ctx: AgentRenderContext, activity: BackgroundActivity): string {
  if (!activity.stoppable || !activity.running) return "";
  return `<form method="post" action="${escapeHtml(backgroundActivityPath(ctx, activity.key, "/stop"))}" class="agent-background-stop">${destructiveConfirmationHtml({
    id: `${ids.backgroundDetail(ctx, activity.key)}_stop`,
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Stop" } },
    confirmCaption: `Stop ${activity.kind}`,
    cancelCaption: "Keep running",
  })}</form>`;
}

/** Wraps detail that only changes when reloaded, such as output read on request, so it stays current while the activity runs. */
export function refreshingBackgroundDetail(activity: BackgroundActivity, html: string): string {
  // The wrapper stays once it stops, so the last reload doesn't move what it holds.
  return `<div${activity.running ? ' data-controller="agent-background-refresh"' : ""}>${html}</div>`;
}

/** An activity's facts, quieter than the detail beneath them: what it is, how long it has run, what started it, then the Agent's own. */
function factsHtml(ctx: AgentRenderContext, activity: BackgroundActivity): string {
  const facts: Array<[string, string]> = [["Kind", escapeHtml(activity.kind)]];
  if (activity.running && activity.startedAt !== undefined) facts.push(["Running for", `<span data-controller="agent-elapsed" data-agent-elapsed-since-value="${activity.startedAt}" data-agent-elapsed-format-value="duration"><span data-agent-elapsed-target="time">${formatDuration(Math.max(0, Date.now() - activity.startedAt))}</span></span>`]);
  if (activity.startedBy) facts.push(["Started by", transcriptTargetLink(ctx, activity.startedBy.itemKey, activity.startedBy.label)]);
  if (activity.progress) facts.push(["Progress", escapeHtml(activity.progress)]);
  for (const [label, text] of Object.entries(activity.details)) facts.push([escapeHtml(label), escapeHtml(text)]);
  return `<dl class="agent-background-facts">${facts.map(([label, html]) => `<dt>${label}</dt><dd>${html}</dd>`).join("")}</dl>`;
}

/** What an inline row shows once opened: its facts, Stop, then the Agent's own detail such as command output. */
export function renderBackgroundInlineDetail(ctx: AgentRenderContext, activity: BackgroundActivity, detailHtml: string): string {
  return `<turbo-frame id="${ids.backgroundDetail(ctx, activity.key)}" refresh="morph"><div class="agent-background-detail">${factsHtml(ctx, activity)}${stopHtml(ctx, activity)}${detailHtml}</div></turbo-frame>`;
}

const backHtml = buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Back, label: "Back" }, attributesHtml: 'data-action="agent-background#back"' });

/** A drill-in activity's own page: Back, its name, Stop and its facts, then the Agent's own detail such as a subagent's transcript. */
export function renderBackgroundPage(ctx: AgentRenderContext, activity: BackgroundActivity, detailHtml: string): string {
  return `<turbo-frame id="${ids.backgroundPage(ctx)}" refresh="morph"><div class="agent-background-page-content">
    <header class="agent-background-page-header">
      <div class="agent-background-page-heading">${backHtml}<h2 class="agent-background-page-title">${escapeHtml(activity.title)}${activity.running ? spinnerHtml : ""}</h2>${stopHtml(ctx, activity)}</div>
      ${factsHtml(ctx, activity)}
    </header>
    <div class="agent-background-page-body">${detailHtml}</div>
  </div></turbo-frame>`;
}

/** A transcript shown as an activity's detail, such as a subagent's, loads its lazy details from beneath the activity's path. */
function backgroundTranscriptContext(ctx: AgentRenderContext, activity: BackgroundActivity): AgentRenderContext {
  return { ...ctx, transcriptBasePath: backgroundActivityPath(ctx, activity.key) };
}

export function backgroundTranscriptHtml(ctx: AgentRenderContext, activity: BackgroundActivity, items: TranscriptItem[]): string {
  return `<div class="agent-transcript-content">${renderTranscript(backgroundTranscriptContext(ctx, activity), items, { systemPrompt: "", tools: [] })}</div>`;
}

/** Serves `transcript-items/:key` beneath the activity's path for a transcript shown with `backgroundTranscriptHtml`; it reads the transcript only for that. */
export async function backgroundTranscriptItemResponse(ctx: AgentRenderContext, activity: BackgroundActivity, path: string, url: URL, items: () => Promise<TranscriptItem[]>): Promise<Response | undefined> {
  if (!path.startsWith("transcript-items/")) return undefined;
  const item = findTranscriptItem(await items(), decodeURIComponent(path.slice("transcript-items/".length)));
  if (!item) return new Response("Transcript item not found", { status: 404 });
  const count = Number(url.searchParams.get("count") ?? 100);
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw invalidArguments("Invalid transcript detail size");
  return response(renderTranscriptItemDetailFrame(backgroundTranscriptContext(ctx, activity), item, { count }));
}

/** Closes a subagent's transcript once its result went back: a link to where it reached the Agent's conversation. */
export function backgroundReportHtml(ctx: AgentRenderContext, itemKey: string): string {
  return `<div class="agent-row agent-background-report">${transcriptTargetLink(ctx, itemKey, "The above final message was sent back into the parent conversation here")}</div>`;
}

/** A command's or monitor's output, for Agents that show one. */
export function backgroundOutputHtml(text: string, header = "Output"): string {
  return `<div class="agent-tool-detail"><section class="agent-tool-region"><div class="agent-region-header">${escapeHtml(header)}</div><pre class="agent-tool-result agent-tool-region-body">${escapeHtml(text || "(no output yet)")}</pre></section></div>`;
}

const scriptFrameId = (ctx: AgentRenderContext, activity: BackgroundActivity) => `${ids.backgroundDetail(ctx, activity.key)}_script`;

/** Where a workflow's script loads into its detail, from `script` beneath the activity's path. It loads once, so reloading the detail keeps it, whether it is open and whether it shows readable or original. */
export function backgroundScriptFrameHtml(ctx: AgentRenderContext, activity: BackgroundActivity): string {
  return `<turbo-frame class="agent-background-script-frame" id="${scriptFrameId(ctx, activity)}" src="${escapeHtml(backgroundActivityPath(ctx, activity.key, "/script"))}" loading="lazy" data-turbo-permanent></turbo-frame>`;
}

/** A workflow's script, highlighted and readably formatted, for `backgroundScriptFrameHtml`; with a `collapsedLabel`, folded under it. */
export function backgroundScriptResponse(ctx: AgentRenderContext, activity: BackgroundActivity, script: string, collapsedLabel?: string): Response {
  const region = `<div class="agent-tool-detail">${scriptSourceRegion(script, formatWorkflowScriptForDisplay(script))}</div>`;
  const html = collapsedLabel ? disclosureHtml({ summary: { kind: "compact", width: "fill", label: { kind: "text", text: collapsedLabel } }, bodyHtml: region }) : region;
  return response(`<turbo-frame id="${scriptFrameId(ctx, activity)}">${html}</turbo-frame>`);
}

/** Shown when an activity has finished since its row was opened. */
export function renderBackgroundGone(ctx: AgentRenderContext, key: string, page: boolean): string {
  const message = '<p class="agent-background-gone">This has finished. Its report is in the conversation.</p>';
  if (!page) return `<turbo-frame id="${ids.backgroundDetail(ctx, key)}">${message}</turbo-frame>`;
  return `<turbo-frame id="${ids.backgroundPage(ctx)}" refresh="morph"><div class="agent-background-page-content"><header class="agent-background-page-header"><div class="agent-background-page-heading">${backHtml}</div></header><div class="agent-background-page-body">${message}</div></div></turbo-frame>`;
}
