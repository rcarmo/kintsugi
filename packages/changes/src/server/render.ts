import { canEditFile, type EditModel } from "../editing.ts";
import { canRevertFile } from "../reverting.ts";
import { renderEditFeedback, renderFileEditActions } from "./editing-render.ts";
import { workingTree } from "./snapshot.ts";
import { placeReviewComments, reviewComments } from "./comments.ts";
import { renderCommentsModel, renderCommentActions, renderOrphanComments, renderCopyCommentButton } from "./comment-render.ts";
import { renderHistoryGraph } from "./history-render.ts";
import { bucketTotals, type BucketTotals, type ChangeBucket, type ChangeTotals } from "./buckets.ts";
import { buttonHtml } from "@kintsugi/design-system/button";
import { Icons } from "@kintsugi/design-system/icons";
import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { popupHtml } from "@kintsugi/design-system/popup";
import { domId, escapeHtml } from "@kintsugi/shared";
import { parseDiffFromFile, type CodeViewItem } from "@pierre/diffs";
import type { ChangesFile, UnchangedFile } from "./diff.ts";
import type { MediaAnnotation } from "../reverting.ts";
import { type HistoryModel } from "../history.ts";
import type { ChangesHistory, ChangesSnapshot } from "./snapshot.ts";

export const changesBodyId = (workspaceId: string, historyId: string) => domId("changes", workspaceId, historyId, "body");
export const comparisonId = (workspaceId: string, historyId: string) => domId("changes", workspaceId, historyId, "comparison");
export const historyContentId = (history: ChangesHistory) => domId("changes", history.id, "history");
export const errorId = (workspaceId: string, historyId: string) => domId("changes", workspaceId, historyId, "error");
export const noticeId = (workspaceId: string, historyId: string) => domId("changes", workspaceId, historyId, "notice");
const json = <Value>(value: Value) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
const historyModel = (history: ChangesHistory, snapshot: ChangesSnapshot): HistoryModel => ({ commits: history.commits, topology: history.topology, references: history.references, endpoints: snapshot.endpoints, head: history.head, branch: history.branch, upstream: history.upstream, unpushed: history.unpushed });

export function renderChangesTitle(snapshot: ChangesSnapshot): string {
  const additions = snapshot.stats.reduce((sum, file) => sum + file.additions, 0);
  const deletions = snapshot.stats.reduce((sum, file) => sum + file.deletions, 0);
  return snapshot.index.phase === "ready" ? `Changes +${additions} −${deletions}` : "Changes";
}

export function renderHistory(snapshot: ChangesSnapshot): string {
  const history = snapshot.history;
  const more = history.hasMore ? `<div class="changes-history-more">${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Load more" }, attributesHtml: 'data-action="changes-diff-endpoints#loadMore" data-changes-diff-endpoints-target="more"' })}</div>` : "";
  const model = historyModel(history, snapshot);
  return renderHistoryGraph(model, history.id, `${more}<script type="application/json" data-changes-diff-endpoints-target="historyModel">${json(model)}</script>`);
}

export function renderError(workspaceId: string, historyId: string, message = ""): string {
  return `<div id="${errorId(workspaceId, historyId)}" class="changes-diff-endpoints-error" data-changes-diff-endpoints-target="error" role="alert" ${message ? "" : "hidden"}><span>${escapeHtml(message)}</span>${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Retry" }, attributesHtml: 'data-action="changes-diff-endpoints#retry"' })}${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss comparison error" }, attributesHtml: 'data-action="changes-diff-endpoints#dismissError"' })}</div>`;
}

/** Why a commit link's comparison couldn't be shown. Dismissing it clears it on the server, so it stays dismissed. */
export function renderNotice(workspaceId: string, historyId: string, message?: string): string {
  const dismiss = `<form class="changes-notice-dismiss" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/changes/notice/dismiss"><input type="hidden" name="history" value="${escapeHtml(historyId)}">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss" } })}</form>`;
  return `<div id="${noticeId(workspaceId, historyId)}">${message ? `<div class="changes-diff-endpoints-error" role="alert"><span>${escapeHtml(message)}</span>${dismiss}</div>` : ""}</div>`;
}

export function renderChanges(workspaceId: string, snapshot: ChangesSnapshot, buckets: readonly ChangeBucket[], pickerOpen = false): string {
  const history = snapshot.history;
  const pickerId = domId("changes", history.id, "picker");
  const header = history.phase === "ready" ? contentRowHtml({
    width: "fill",
    kind: "compact", label: { kind: "text", text: snapshot.label }, leadingHtml: Icons.Disclosure,
    element: { tag: "button", attributesHtml: `type="button" data-action="changes-diff-endpoints#togglePicker" data-changes-diff-endpoints-target="trigger" aria-expanded="${pickerOpen}" aria-controls="${pickerId}"` },
  }) : '<strong>Changes</strong>';
  const picker = history.phase === "ready" ? `<div id="${pickerId}" class="changes-picker-host" data-changes-diff-endpoints-target="picker" role="region" aria-label="Commit history" ${pickerOpen ? "" : "hidden"}><div class="changes-history-scroll" data-changes-diff-endpoints-target="historyScroll">${renderHistory(snapshot)}</div><div class="changes-picker-resizer" role="separator" aria-label="Resize commit history" aria-orientation="horizontal" tabindex="0" data-action="pointerdown->changes-diff-endpoints#beginResize pointermove->changes-diff-endpoints#dragResize keydown->changes-diff-endpoints#resizeWithKeyboard"></div></div>` : "";
  // History is the permanent shell; live comparisons replace only the Pierre island underneath it.
  return `<section id="${changesBodyId(workspaceId, history.id)}" data-turbo-permanent class="changes-body" data-controller="changes-diff-endpoints" data-changes-diff-endpoints-workspace-id-value="${escapeHtml(workspaceId)}" data-changes-diff-endpoints-history-id-value="${history.id}" data-changes-diff-endpoints-open-value="${pickerOpen}" data-action="changes-edit:refresh->changes-diff-endpoints#refresh live:before-stream-render@document->changes-diff-endpoints#preservePresentation turbo:before-stream-render@document->changes-diff-endpoints#preservePresentation keydown.esc->changes-diff-endpoints#escape">
    <header class="changes-diff-endpoints-header">${header}${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Refresh, label: "Refresh history and diff" }, attributesHtml: 'data-action="changes-diff-endpoints#refresh" data-changes-diff-endpoints-target="refresh"' })}</header>${picker}${renderComparison(workspaceId, snapshot, buckets)}
    <div class="changes-loading" data-changes-diff-endpoints-target="loading" role="status" hidden><span class="changes-spinner" aria-hidden="true"></span><span>Generating comparison…</span></div><div class="changes-alerts">${renderNotice(workspaceId, history.id, snapshot.notice)}${renderError(workspaceId, history.id)}</div>
  </section>`;
}

export function renderComparison(workspaceId: string, snapshot: ChangesSnapshot, buckets: readonly ChangeBucket[], collapsed = true): string {
  return `<div id="${comparisonId(workspaceId, snapshot.history.id)}" class="changes-diff-slot" data-changes-diff-endpoints-target="diff">${renderDiff(workspaceId, snapshot, buckets, collapsed)}</div>`;
}

export function renderEditModel(model: EditModel): string {
  return `<script type="application/json" data-changes-edit-model>${json(model)}</script>`;
}

function fileItem(file: ChangesFile, snapshotId: string, version: number, editable: boolean): CodeViewItem<MediaAnnotation> {
  return { id: file.path, type: "file", version, file: { name: file.path, lang: editable ? undefined : "text", contents: editable ? file.newContents! : file.detail ?? "No text changes to display.", cacheKey: `${snapshotId}:${file.path}` } };
}

export function renderChangesFile(file: ChangesFile, snapshotId: string, editable = false): string {
  const item: CodeViewItem<MediaAnnotation> = file.diff
    ? { id: file.path, type: "diff", fileDiff: file.diff, version: 1 }
    : fileItem(file, snapshotId, 1, editable && canEditFile(file));
  return `<script type="application/json" data-changes-file>${json(item)}</script>`;
}

const mediaAnnotation = (path: string) => [{ lineNumber: 1, metadata: { kind: "media" as const, path } }];
const mediaItem = (path: string, cacheKey: string, version: number): CodeViewItem<MediaAnnotation> => ({ id: path, type: "file", version, file: { name: path, lang: "text", contents: "", cacheKey }, annotations: mediaAnnotation(path) });
const mediaTemplate = (path: string, html: string) => `<template data-changes-media="${escapeHtml(path)}"><div class="changes-media">${html}</div></template>`;

/** An unchanged file as the Files view would show it: text, or an image, video or audio preview. */
export function renderUnchangedFile(workspaceId: string, snapshotId: string, path: string, file: UnchangedFile, editable: boolean): string {
  const cacheKey = `${snapshotId}:${path}`;
  if (file.kind === "image" || file.kind === "video" || file.kind === "audio") {
    const src = escapeHtml(`/workspaces/${encodeURIComponent(workspaceId)}/changes/unchanged-media?${new URLSearchParams({ snapshot: snapshotId, path })}`);
    const media = file.kind === "image" ? `<div class="changes-image-canvas"><img src="${src}" alt="${escapeHtml(path)}" loading="lazy" decoding="async"></div>`
      : file.kind === "video" ? `<video src="${src}" controls playsinline preload="metadata">Your browser can’t play this video.</video>`
      : `<audio src="${src}" controls preload="metadata">Your browser can’t play this audio.</audio>`;
    return `<script type="application/json" data-changes-file>${json(mediaItem(path, cacheKey, 1))}</script>${mediaTemplate(path, media)}`;
  }
  const contents = file.kind === "text" ? file.text : file.kind === "large" ? "This file is too large to show here." : "No preview available for this file.";
  const item: CodeViewItem<undefined> = { id: path, type: "file", version: 1, file: { name: path, lang: file.kind === "text" ? undefined : "text", contents, cacheKey } };
  return `<script type="application/json" data-changes-file data-editable="${editable}">${json(item)}</script>`;
}

export function renderUnchangedPaths(paths: string[]): string {
  return `<script type="application/json" data-changes-unchanged>${json(paths)}</script>`;
}

function renderRename(file: Pick<ChangesFile, "previousPath">): string {
  return file.previousPath ? `<span class="changes-rename" title="Previously ${escapeHtml(file.previousPath)}">Renamed</span>` : "";
}

const imageStatus = {
  added: { label: "Added", color: "changes-additions" },
  removed: { label: "Removed", color: "changes-deletions" },
  modified: { label: "Modified", color: "changes-rename" },
};

function renderImageComparison(workspaceId: string, snapshot: ChangesSnapshot, file: ChangesFile): string {
  const sides = (["before", "after"] as const).filter(side => !(file.change === "added" && side === "before") && !(file.change === "removed" && side === "after"));
  const figures = sides.map(side => {
    const image = file.images![side];
    const label = side === "before" ? "Before" : "After";
    const query = new URLSearchParams({ snapshot: snapshot.id, path: file.path, side });
    const src = `/workspaces/${encodeURIComponent(workspaceId)}/changes/image?${query}`;
    return `<figure><figcaption>${label}<span>${escapeHtml(side === "before" ? snapshot.baseLabel : snapshot.targetLabel)}</span></figcaption><div class="changes-image-canvas">${image ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(`${file.path} — ${label.toLowerCase()}`)}" loading="lazy" decoding="async">` : "<span>No image preview</span>"}</div></figure>`;
  }).join("");
  return mediaTemplate(file.path, `<div class="changes-image-comparison">${figures}</div>`);
}

const lineCounts = (totals: BucketTotals) => `<span class="changes-additions">+${totals.additions}</span><span class="changes-deletions">−${totals.deletions}</span>`;

/** All files, the main work's lines, then each bucket that has files. */
function renderSummary(fileCount: number, totals: ChangeTotals): string {
  const buckets = totals.buckets.filter(bucket => bucket.files).map(bucket => `<span class="changes-summary-bucket">${escapeHtml(bucket.name)} ${lineCounts(bucket)}</span>`).join("");
  return `<span class="changes-summary"><span>${fileCount} ${fileCount === 1 ? "file" : "files"}</span>${lineCounts(totals.main)}${buckets}</span>`;
}

/** Headings the viewer places above each group when files are grouped by bucket. */
function renderGroupHeadings(totals: ChangeTotals): string {
  const heading = (key: string, name: string, stats = "") => `<template data-changes-group="${key}"><div class="changes-file-header changes-group-header"><span class="changes-group-name" role="heading" aria-level="2">${escapeHtml(name)}</span>${stats ? `<span class="changes-file-stats">${stats}</span>` : ""}</div></template>`;
  return heading("main", totals.main.name, lineCounts(totals.main)) + totals.buckets.map((bucket, index) => heading(String(index), bucket.name, lineCounts(bucket))).join("") + heading("unchanged", "Unchanged files");
}

export function renderDiff(workspaceId: string, snapshot: ChangesSnapshot, buckets: readonly ChangeBucket[], collapsed: boolean): string {
  const comments = placeReviewComments(reviewComments.list(workspaceId), snapshot);
  const files = snapshot.stats.map(file => {
    const captured = snapshot.files.get(file.path)!, working = snapshot.endpoints.target === workingTree;
    return { ...file, image: !!captured.images, editable: working && canEditFile(captured), revertible: working && canRevertFile(captured) };
  });
  const totals = bucketTotals(buckets, files);
  const groupedFiles = files.map(file => ({ ...file, bucket: totals.bucketOf.get(file.path) }));
  const items: CodeViewItem<MediaAnnotation>[] = files.map((file) => {
    const captured = snapshot.files.get(file.path)!;
    if (file.image) return mediaItem(file.path, `${snapshot.id}:${file.path}`, 0);
    if (!captured.diff) return fileItem(captured, snapshot.id, 0, file.editable);
    const loadingDiff = parseDiffFromFile({ name: file.previousPath ?? file.path, contents: "" }, { name: file.path, contents: "Loading diff…", lang: "text" });
    loadingDiff.cacheKey = `${snapshot.id}:loading:${file.path}`;
    return { id: file.path, type: "diff", fileDiff: loadingDiff, version: 0 };
  });
  const mediaTemplates = files.filter(file => file.image).map(file => renderImageComparison(workspaceId, snapshot, snapshot.files.get(file.path)!)).join("");
  const iconButton = (label: string, action: string, icon: string, attributes = "") => buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: icon, label }, attributesHtml: `data-action="changes#${action}" ${attributes}` });
  const menuItem = (label: string, role: "menuitemradio" | "menuitemcheckbox", checked: boolean, attributes: string) => contentRowHtml({ width: "fill", kind: "compact", label: { kind: "text", text: label }, trailingHtml: `<span class="changes-menu-check">${Icons.Check}</span>`, element: { tag: "button", attributesHtml: `type="button" role="${role}" aria-checked="${checked}" ${attributes}` } });
  const layoutItem = (layout: "unified" | "split", label: string) => menuItem(label, "menuitemradio", layout === "unified", `data-layout="${layout}" data-action="changes#chooseLayout"`);
  const checkItem = (label: string, action: string, checked: boolean) => menuItem(label, "menuitemcheckbox", checked, `data-action="changes#${action}"`);
  const displayMenu = popupHtml({
    id: domId("changes", workspaceId, snapshot.id, "display"), label: "Display options",
    trigger: { variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Settings, label: "Display options" } },
    contentHtml: `${layoutItem("unified", "Unified diff")}${layoutItem("split", "Side-by-side diff")}<hr class="popup-menu__separator">${checkItem("Wrap long lines", "toggleWrap", true)}<hr class="popup-menu__separator">${checkItem("Show unchanged files", "toggleUnchanged", false)}${buckets.length ? checkItem("Group files by bucket", "toggleGrouped", false) : ""}`,
  });
  const collapseIcons = `<span class="changes-collapse-icon">${Icons.CollapseAll}</span><span class="changes-expand-icon">${Icons.ExpandAll}</span>`;
  const headers = files.map((file) => `<template data-changes-header="${escapeHtml(file.path)}"><div class="changes-file-header" data-changes-edit-target="fileHeader">${contentRowHtml({
    width: "fill",
    kind: "compact", label: { kind: "text", text: file.path }, leadingHtml: Icons.Disclosure,
    trailingHtml: `${renderRename(file)}<span class="changes-file-stats">${file.image ? `<span class="${imageStatus[file.change].color}">${imageStatus[file.change].label}</span>` : file.binarySizes ? "<span>Binary</span>" : `<span class="changes-additions">+${file.additions}</span><span class="changes-deletions">−${file.deletions}</span>`}</span>`,
    element: { tag: "button", attributesHtml: `type="button" data-path="${escapeHtml(file.path)}" data-action="changes#toggleFile" aria-expanded="${!collapsed}"` },
  })}${file.editable ? buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Edit" }, attributesHtml: `data-action="changes-edit#begin" data-path="${escapeHtml(file.path)}" aria-label="Edit ${escapeHtml(file.path)}"${collapsed ? " hidden" : ""}` }) + renderFileEditActions() : ""}</div></template>`).join("");
  const unchangedHeader = `<template data-changes-target="unchangedHeader"><div class="changes-file-header changes-unchanged-header" data-changes-edit-target="fileHeader">${contentRowHtml({
    width: "fill", kind: "compact", label: { kind: "text", text: "" }, leadingHtml: Icons.Disclosure,
    element: { tag: "button", attributesHtml: 'type="button" data-action="changes#toggleFile"' },
  })}${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Edit" }, attributesHtml: 'data-action="changes-edit#begin"' })}${renderFileEditActions()}</div></template>`;
  const commentTemplates = `<template data-changes-target="revertBlock"><div class="changes-revert-block">${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Revert hunk" }, attributesHtml: 'data-action="changes-edit#revertBlock"' })}</div></template>
    <template data-changes-target="commentGutter">${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: "Add a comment" }, attributesHtml: 'data-action="changes#addComment"' })}</template>
    <template data-changes-target="commentEditor"><form class="changes-comment changes-comment-editor" data-action="submit->changes#saveComment keydown.meta+enter->changes#commentShortcut keydown.ctrl+enter->changes#commentShortcut keydown.esc->changes#cancelComment"><textarea class="textarea" rows="3" required maxlength="10000" aria-label="Comment" placeholder="Leave a comment" data-action="input->changes#commentInput"></textarea><footer><span class="changes-comment-footer-space"></span>${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Discard" }, attributesHtml: 'data-action="changes#cancelComment"' })}${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Comment" } })}</footer></form></template>
    <template data-changes-target="commentCard"><article class="changes-comment changes-comment-card">${contentRowHtml({ width: "fill", kind: "multiline", label: { kind: "text", text: "Comment", textAttributesHtml: "data-comment-body" }, element: { tag: "button", attributesHtml: 'type="button" aria-label="Edit comment" data-action="changes#editComment"' } })}<div class="changes-comment-tools">${renderCopyCommentButton()}${iconButton("Delete comment", "deleteComment", Icons.Trash)}</div></article></template>`;
  const empty = snapshot.index.phase === "not-git" ? "This workspace isn’t a Git repository." : snapshot.endpoints.target === workingTree && snapshot.base === (snapshot.history.head ?? snapshot.history.emptyTree) ? "No uncommitted changes." : snapshot.label === "Unstaged changes" ? "No unstaged changes." : snapshot.label === "Staged changes" ? "No staged changes." : "No changed files in this comparison.";
  // The history-keyed parent protects Pierre’s managed DOM during live shell morphs.
  return `<section id="${domId("changes", snapshot.id, "diff")}" class="changes-diff" data-controller="changes changes-edit" data-action="changes-edit:viewer->changes#shareViewer" data-changes-edit-workspace-id-value="${escapeHtml(workspaceId)}" data-changes-edit-snapshot-id-value="${snapshot.id}" data-changes-workspace-id-value="${escapeHtml(workspaceId)}" data-changes-snapshot-id-value="${snapshot.id}" data-changes-collapsed-value="${collapsed}">
    <header class="changes-toolbar">
      <div class="changes-controls">${renderSummary(files.length, totals)}${files.length || comments.some(comment => comment.status !== "inline") ? buttonHtml({ type: "button", variant: "secondary", disabled: files.length > 0, content: { kind: "icon-only", iconHtml: collapseIcons, label: collapsed ? "Expand all" : "Collapse all" }, attributesHtml: `data-action="changes#toggleCollapse" data-changes-target="collapseToggle" data-collapsed="${collapsed}"` }) : ""}${displayMenu}</div>
    </header>
    ${renderEditFeedback()}
    <div data-controller="live-surface" data-live-surface-workspace-value="${escapeHtml(workspaceId)}" data-live-surface-kind-value="review-comments" data-live-surface-key-value="${snapshot.id}" data-live-surface-eager-value="true">${renderCommentsModel(snapshot.id, comments)}</div>
    ${renderCommentActions(workspaceId, snapshot.id, comments)}
    <div id="${changesBodyId(workspaceId, snapshot.id)}-error" class="changes-error" data-changes-target="error" role="alert" hidden><span data-changes-target="errorMessage"></span>${iconButton("Dismiss file error", "dismissError", Icons.Close)}</div>
    <div class="changes-surface"><div class="changes-viewer kintsugi-pierre-host" data-changes-target="viewer" aria-label="Changes diff">${files.length ? "" : `<div class="changes-empty" data-changes-target="empty">${escapeHtml(empty)}</div>`}<div data-changes-target="viewHeader"></div><div data-changes-target="orphanHost">${renderOrphanComments(snapshot.id, comments)}<div class="changes-orphan-editor" data-changes-target="listEditor" hidden></div></div></div></div>
    <script type="application/json" data-changes-target="model">${json({ files: groupedFiles, items })}</script>${buckets.length ? renderGroupHeadings(totals) : ""}<script type="application/json" data-changes-diff-endpoints-target="comparisonModel">${json({ endpoints: snapshot.endpoints, label: snapshot.label, baseLabel: snapshot.baseLabel, targetLabel: snapshot.targetLabel })}</script>${headers}${mediaTemplates}${unchangedHeader}${commentTemplates}
  </section>`;
}
