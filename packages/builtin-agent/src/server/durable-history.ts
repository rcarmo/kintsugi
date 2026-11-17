import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { escapeHtml } from "@kintsugi/shared";
import { response } from "@kintsugi/shared/http";
import { KintsugiCoreError, getKintsugiRuntimeContext, isNotFoundError } from "@kintsugi/core";
import { sessionShareDir, workspaceSessionShareKey } from "@kintsugi/agent/server/session-share";
import { durableJournalDirectory, durableJournalExists } from "./durable-storage.ts";
import { projectDurableTranscript } from "./durable-transcript.ts";
import { findTranscriptItem } from "@kintsugi/agent/server/transcript";
import { renderTranscriptItem, renderTranscriptItemDetailFrame } from "@kintsugi/agent/server/render-transcript";
import { type AgentRouteHandler } from "./route-support.ts";
import { openDurableHistoryReader } from "./durable-history-reader.ts";

/** Enumerate the viewer's existing share, including journals whose workspace was deleted. */
export async function retainedDurableHistories(workspaceId: string) {
  // Validate the external workspace identifier before reading its share metadata.
  durableJournalDirectory("projectless", workspaceId);
  // A missing init is valid for an existing projectless workspace, but an
  // arbitrary/missing viewer must not turn into access to the projectless share.
  // Check retained host metadata only: history must work without Docker/readiness.
  const metadata = await stat(join(getKintsugiRuntimeContext().kintsugiDataDir, "workspaces", workspaceId, "metadata")).catch((error: NodeJS.ErrnoException) => {
    if (isNotFoundError(error)) return undefined;
    throw error;
  });
  if (!metadata?.isDirectory()) throw new KintsugiCoreError("workspace_not_found", `workspace not found: ${workspaceId}`);
  const share = await workspaceSessionShareKey(workspaceId);
  const directory = join(sessionShareDir(share), "builtin-durable");
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (isNotFoundError(error)) return [];
    throw error;
  });
  const histories: { workspaceId: string; owner: Awaited<ReturnType<typeof openDurableHistoryReader>>; dispose: () => Promise<void> }[] = [];
  try {
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = durableJournalDirectory(share, entry.name);
    if (!durableJournalExists(path)) continue;
    const reader = await openDurableHistoryReader(path,entry.name);
    histories.push({workspaceId:entry.name,owner:reader,dispose:reader.dispose});
  }
  return histories;
  } catch (error) {await Promise.all(histories.map(item => item.dispose()));throw error;}
}

/** Read-only HTTP surface: never mounts a live runtime, probes readiness, or resumes a scheduler. */
export const handleDurableHistoryRequest: AgentRouteHandler = async (request, url, options) => {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/agent-history(?:\/([^/]+)\/([^/]+)(?:\/(session-images|session-attachments|transcript-items)\/([^/]+)(?:\/(\d+))?)?)?$/);
  if (!match || request.method !== "GET") return undefined;
  function page(title: string, content: string) {
    if (!options.renderPage) throw new Error("Native history requires the host page renderer");
    const rendered = options.renderPage(`<div class="app no-sidebar"><div class="main"><header class="header"><h1>${escapeHtml(title)}</h1></header><main class="body">${content}</main></div></div>`);
    rendered.headers.set("Cache-Control", "no-store");
    return rendered;
  }
  const viewer = decodeURIComponent(match[1]!);
  const [source = "", agentId = "", operation = "", item = "", index = ""] = match.slice(2).map(value => value === undefined ? "" : decodeURIComponent(value));
  const base = `/workspaces/${encodeURIComponent(viewer)}/agent-history`;
  const histories = await retainedDurableHistories(viewer);
  try {
  if (!source) {
    const rows: string[] = [];
    for (const history of histories) {
      const gates = await history.owner.admission();
      for (const record of await history.owner.catalog()) {
        const state = gates?.deleted ? "Deleted workspace" : gates?.closed.includes(record.durableId) ? "Closed conversation" : "Conversation";
        rows.push(contentRowHtml({ width: "fill", kind: "multiline", label: { kind: "text", text: record.title }, description: `${history.workspaceId} · ${record.label} · ${state}`, element: { tag: "a", attributesHtml: `href="${base}/${encodeURIComponent(history.workspaceId)}/${encodeURIComponent(record.agentId)}"` } }));
      }
    }
    return page("Agent history", `<p>Read-only history from this template's session share.</p><div class="action-list">${rows.join("") || "No native history yet."}</div>`);
  }
  const history = histories.find(history => history.workspaceId === source);
  const record = history && (await history.owner.catalog()).find(record => record.agentId === agentId);
  if (!history || !record) return response("Not found", { status: 404 });
  const controller = await history.owner.agent(record);
  if (operation === "session-attachments") return await controller.attachment(item,Number(index));
  if (operation === "session-images") return await controller.image(item, Number(index));
  const branch = url.searchParams.get("branch") ?? String(record.durableId);
  if (!(record.branches ?? [record.durableId]).some(id => String(id) === branch)) return response("Not found", { status: 404 });
  const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) return response("Invalid history boundary",{status:400});
  const ctx = { workspaceId: source, agentId, readOnly: true, transcriptQuery: `branch=${encodeURIComponent(branch)}${before ? `&before=${before}` : ""}`, transcriptBasePath: `${base}/${encodeURIComponent(source)}/${encodeURIComponent(agentId)}` };
  const view = await controller.historyView(branch,before);
  const items = projectDurableTranscript(view);
  if (operation === "transcript-items") {
    const selected = findTranscriptItem(items, item);
    const count = Math.max(100, Math.min(100_000, Number(url.searchParams.get("count") ?? 100) || 100));
    return selected ? response(renderTranscriptItemDetailFrame(ctx, selected, { count })) : response("Not found", { status: 404 });
  }
  const branches = (record.branches ?? [record.durableId]).map(id => actionLinkHtml({ href: `${ctx.transcriptBasePath}?branch=${id}`, variant: "secondary", content: { kind: "caption", caption: `Branch ${id}${id === record.durableId ? " (current)" : ""}` } })).join(" ");
  const pager = `${view.before ? actionLinkHtml({href:`${ctx.transcriptBasePath}?branch=${encodeURIComponent(branch)}&before=${view.before}`,variant:"secondary",content:{kind:"caption",caption:"Earlier messages"}}) : ""} ${before ? actionLinkHtml({href:`${ctx.transcriptBasePath}?branch=${encodeURIComponent(branch)}`,variant:"secondary",content:{kind:"caption",caption:"Latest messages"}}) : ""}`;
  return page(record.title, `${actionLinkHtml({ href: base, variant: "secondary", content: { kind: "caption", caption: "All history" } })}<nav>${branches}</nav><p>Read-only branch history, including earlier sessions.</p>${pager}<div class="agent-transcript"><div class="agent-transcript-content">${items.map(item => renderTranscriptItem(ctx, item)).join("")}</div></div>`);
  } finally {await Promise.all(histories.map(item => item.dispose()));}
};
