import { contentText } from "@earendil-works/pi-ai";
import { escapeHtml } from "@kintsugi/shared";
import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { buttonHtml } from "@kintsugi/design-system/button";
import type { DurableAgentRuntime } from "./durable-runtime.ts";
import { treeFilterOptions, type TreeFilterMode } from "./session-tree.ts";

type Controller = Awaited<ReturnType<DurableAgentRuntime["agent"]>>;

/** Native history is a union of immutable fork prefixes, not a legacy SessionManager tree. */
export function renderDurableTree(history: Awaited<ReturnType<Controller["tree"]>>, options: { filter: TreeFilterMode; query: string; historyPath?: string }) {
  const parents = new Map<number, number | undefined>(history.nodes.map(node => [node.entry.id, node.parentId]));
  const active = new Set<number>();
  for (let id: number | undefined = history.active; id !== undefined; id = parents.get(id)) active.add(id);
  const tokens = history.filtered ? [] : options.query.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = history.nodes.filter(({ entry, parentId }) => {
    const role = entry.model?.[0]?.role;
    const labels = history.labels[String(entry.id)] ?? [];
    const text = entry.model?.map(message => contentText(message.content)).join("\n") || entry.kind;
    if (options.filter === "user-only" && role !== "user") return false;
    if (options.filter === "labeled-only" && !labels.length) return false;
    if ((options.filter === "default" || options.filter === "no-tools") && role === "system") return false;
    if (options.filter === "no-tools" && role === "toolResult") return false;
    if (!tokens.every(token => `${role} ${text} ${labels.join(" ")}`.toLowerCase().includes(token))) return false;
    return true;
  });
  const rows = matching.slice(-500).map(({entry,parentId})=>{
    const role = entry.model?.[0]?.role,labels = history.labels[String(entry.id)] ?? [];
    const text = entry.model?.map(message=>contentText(message.content)).join("\n") || entry.kind;
    const label = role === "user" ? "You" : role === "assistant" ? "Assistant" : role === "toolResult" ? "Tool result" : entry.kind;
    const item = contentRowHtml({ width: "fill", kind: "multiline", label: { kind: "text", text: label }, description: text.trim().replace(/\s+/g, " ").slice(0,240), element: { tag: "button", attributesHtml: `type="button" role="option" aria-selected="${entry.id === history.active}" data-completion-kind="tree-entry" data-tree-entry="${entry.id}"` } });
    const badges = labels.map(value => `<span class="agent-tree-label"><span>${escapeHtml(value)}</span>${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Remove" }, attributesHtml: `data-tree-action="label-remove" data-tree-label="${escapeHtml(value)}"` })}</span>`).join("");
    const editor = `<span class="agent-tree-label-editor" hidden><input class="text-field" type="text" placeholder="Add a label" aria-label="New node label">${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Cancel" }, attributesHtml: 'data-tree-action="label-cancel"' })}${buttonHtml({ type: "button", variant: "primary", content: { kind: "caption", caption: "Add" }, attributesHtml: 'data-tree-action="label-save"' })}</span>`;
    return `<div class="agent-tree-row" data-tree-entry="${entry.id}" style="--tree-lane:0">${item}<div class="agent-tree-labels">${badges}<span>#${entry.id}${parentId ? ` ← #${parentId}` : ""}${entry.id === history.active ? " · Current entry" : active.has(entry.id) ? " · Current branch" : " · Retained branch"}</span>${buttonHtml({type:"button",variant:"secondary",content:{kind:"caption",caption:"Label"},attributesHtml:'data-tree-action="label-edit"'})}</div>${editor}</div>`;
  });
  const limitNote = (history.filtered ? history.totalMatches : matching.length) > rows.length ? "Showing the latest 500 matches. Narrow the search for earlier entries." : "Continue on a new branch. Earlier branches stay in history.";
  return `<div class="agent-completion-menu action-list agent-tree-menu" role="listbox" aria-label="Session tree"><header class="agent-tree-header"><span class="agent-tree-heading"><b>Session tree</b>${options.historyPath ? `<a href="${escapeHtml(options.historyPath)}" target="_blank" rel="noopener" data-turbo="false">Browse retained history</a>` : ""}<span>${limitNote}</span></span><span class="agent-tree-controls"><input class="agent-tree-search text-field" type="search" value="${escapeHtml(options.query)}" placeholder="Search entries…" aria-label="Search session tree"><select class="agent-tree-filter" aria-label="Filter session tree">${treeFilterOptions.map(([value, label]) => `<option value="${value}"${value === options.filter ? " selected" : ""}>${label}</option>`).join("")}</select></span></header>${rows.join("") || '<div class="agent-completion-menu empty">No matching entries</div>'}</div>`;
}
