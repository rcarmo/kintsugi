import { isDelimitedPath } from "../delimited.ts";
import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { buttonHtml } from "@kintsugi/design-system/button";
import { buttonGroupHtml } from "@kintsugi/design-system/button-group";
import { copyButtonHtml } from "@kintsugi/design-system/copy-button";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { Icons } from "@kintsugi/design-system/icons";
import { popupHtml } from "@kintsugi/design-system/popup";
import { toggleHtml } from "@kintsugi/design-system/toggle";
import { domId, escapeHtml, formatBytes, workspaceFileOpenUrl, workspaceProxyUrl, type WorkspaceWorkViewPresentation } from "@kintsugi/shared";
import { workspaceImageUrl } from "@kintsugi/shared/file-metadata";
import { workspaceRoot } from "@kintsugi/workspace";
import { posix } from "node:path";
import type { FileEntry } from "./files.ts";
import { isImageFile } from "../image-file.ts";
import type { FilePreviewKind } from "./file-preview.ts";
import { defaultFilesViewId, filesDiskGeneration, filesNavigationRequest, type FilesHistoryDirection, type FilesView } from "./state.ts";

function filesTreeFrameId(workspaceId: string, viewId: string): string {
  return domId("workspace", workspaceId, "files", viewId, "tree");
}

function filesEditorFrameId(workspaceId: string, viewId: string): string {
  return domId("workspace", workspaceId, "files", viewId, "editor");
}

export function filesTreeResultsFrameId(workspaceId: string, viewId: string): string {
  return domId("workspace", workspaceId, "files", viewId, "tree", "results");
}

export function filesDirectoryFrameId(workspaceId: string, viewId: string, path: string): string {
  return `files_directory_${Buffer.from(`${workspaceId}\0${viewId}\0${path}`).toString("base64url")}`;
}

export function renderFilesRefreshSignal(workspaceId: string): string {
  return `<span id="${domId("files_refresh_signal", workspaceId)}" data-controller="files-refresh-signal" data-files-refresh-signal-generation-value="${filesDiskGeneration(workspaceId)}" data-files-refresh-signal-workspace-id-value="${escapeHtml(workspaceId)}" hidden></span>`;
}

function filesNavigatorToggle(action: "expand" | "collapse"): string {
  const label = `${action === "expand" ? "Expand" : "Collapse"} Files navigator`;
  return buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: Icons.Panel, label },
    attributesHtml: `${action === "expand" ? "data-files-navigator-expand " : ""}data-action="files-view#${action}"`,
  });
}

function refreshButton(): string {
  return buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: Icons.Refresh, label: "Refresh files" },
    attributesHtml: 'data-action="files-view#refresh"',
  });
}

function historyStep(workspaceId: string, view: FilesView, direction: FilesHistoryDirection): string {
  const target = view[direction]?.at(-1);
  const caption = direction === "back" ? "Back" : "Forward";
  const button = buttonHtml({
    type: "submit",
    variant: "secondary",
    disabled: !target,
    content: { kind: "icon-only", iconHtml: direction === "back" ? Icons.Back : Icons.Forward, label: target ? `${caption} to ${posix.basename(target)}` : caption },
  });
  return `<form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/files-view/history" data-turbo-stream="true">
    <input type="hidden" name="filesView" value="${escapeHtml(view.id)}"><input type="hidden" name="direction" value="${direction}">
    ${button}
  </form>`;
}

function editorToolbarLeading(workspaceId: string, view: FilesView): string {
  const history = buttonGroupHtml({ orientation: "horizontal", semantics: "group", label: "File history", itemsHtml: historyStep(workspaceId, view, "back") + historyStep(workspaceId, view, "forward") });
  const path = view.path ? `<span class="file-editor-path" title="${escapeHtml(view.path)}">${escapeHtml(view.path)}</span>` : '<span class="file-editor-path">Choose a file</span>';
  return `<span class="file-editor-toolbar-leading">${history}${path}</span>`;
}

function directoryToggleUrl(workspaceId: string, viewId: string, path: string, expand: boolean): string {
  const query = new URLSearchParams({ path, view: expand ? "inline" : "collapsed", filesView: viewId });
  return `/workspaces/${encodeURIComponent(workspaceId)}/files?${query}`;
}

function selectedFileActions(workspaceId: string, view: FilesView, readOnly = false): string {
  const path = view.path!;
  const name = posix.basename(path);
  const contentUrl = isImageFile(path) ? workspaceImageUrl(workspaceId, path) : workspaceProxyUrl(workspaceId, "file", path);
  const copyButton = copyButtonHtml({
    label: "Copy file contents",
    copyText: "",
    disabled: true,
    attributesHtml: 'data-file-editor-target="copyButton"',
  });
  const downloadButton = actionLinkHtml({
    href: `${contentUrl}?download=1`,
    variant: "secondary",
    content: {
      kind: "icon-only",
      iconHtml: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
      label: "Download file",
    },
    attributesHtml: `download="${escapeHtml(name)}" data-turbo="false"`,
  });
  const deleteButton = buttonHtml({
    type: "submit",
    variant: "danger",
    content: { kind: "icon-only", iconHtml: Icons.Trash, label: "Delete file" },
  });
  const deleteForm = `<form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/files-view/delete" data-turbo-stream="true" data-turbo-confirm="Delete ${escapeHtml(name)}? This cannot be undone.">
    <input type="hidden" name="path" value="${escapeHtml(path)}"><input type="hidden" name="filesView" value="${escapeHtml(view.id)}">
    ${deleteButton}
  </form>`;
  const diagramButton = /\.drawio(?:\.xml)?$/i.test(path) ? `<form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/drawio/open" data-turbo-stream="true">
    <input type="hidden" name="path" value="${escapeHtml(path)}">
    ${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Open in Draw.io" } })}
  </form>` : "";
  return buttonGroupHtml({
    orientation: "horizontal",
    semantics: "group",
    label: "Actions for selected file",
    itemsHtml: `${diagramButton}${readOnly ? "" : copyButton}${downloadButton}${deleteForm}`,
  });
}

function renderEntryRow(workspaceId: string, viewId: string, entry: FileEntry, expanded: boolean, selectedPath?: string): string {
  const icon = entry.kind === "directory"
    ? `${Icons.Disclosure}<span class="status-spinner sm files-directory-spinner"></span>`
    : entry.kind === "symlink" ? "↗" : "";
  const destination = entry.kind === "directory"
    ? `href="${escapeHtml(directoryToggleUrl(workspaceId, viewId, entry.path, !expanded))}" data-turbo-frame="${filesDirectoryFrameId(workspaceId, viewId, entry.path)}"`
    : entry.openable
      ? `href="${escapeHtml(workspaceFileOpenUrl(workspaceId, entry.path, {}, viewId))}" data-turbo-stream="true"`
      : "";
  const directoryAttributes = entry.kind === "directory"
    ? ` data-files-destination="${escapeHtml(entry.directoryPath ?? entry.path)}" data-action="dragenter->files#folderDragEnter dragover->files#folderDragOver dragleave->files#folderDragLeave drop->files#folderDrop" aria-expanded="${expanded}"`
    : entry.openable ? ' data-action="files-view#collapse"' : "";
  const selectedAttribute = entry.path === selectedPath ? ' aria-selected="true"' : "";
  const size = entry.kind === "directory" ? "" : `<span class="files-row-size">${formatBytes(entry.size)}</span>`;
  return contentRowHtml({
    width: "fill",
    kind: "compact",
    primary: Boolean(destination),
    leadingHtml: `<span class="files-row-icon" aria-hidden="true">${icon}</span>`,
    label: { kind: "text", text: entry.name },
    trailingHtml: size,
    element: {
      tag: destination ? "a" : "div",

      attributesHtml: `role="treeitem" tabindex="-1" data-kind="${entry.kind}" data-files-path="${escapeHtml(entry.path)}"${destination ? ` ${destination}` : ""}${directoryAttributes}${selectedAttribute}`,
    },
  });
}

function renderEntry(workspaceId: string, viewId: string, entry: FileEntry, selectedPath?: string): string {
  if (entry.kind === "directory") return renderFilesDirectoryFrame(workspaceId, viewId, entry, entry.children, selectedPath);
  return renderEntryRow(workspaceId, viewId, entry, false, selectedPath);
}

export function renderFilesDirectoryFrame(workspaceId: string, viewId: string, entry: FileEntry, entries?: FileEntry[], selectedPath?: string): string {
  const expanded = entries !== undefined;
  const children = expanded
    ? `<div class="files-directory-children action-list" role="group">${entries.map((child) => renderEntry(workspaceId, viewId, child, selectedPath)).join("") || '<p class="files-empty empty-state">This folder is empty. Create files in Terminal, then Refresh.</p>'}</div>`
    : "";
  return `<turbo-frame id="${filesDirectoryFrameId(workspaceId, viewId, entry.path)}" class="files-directory-frame action-list">${renderEntryRow(workspaceId, viewId, entry, expanded, selectedPath)}${children}</turbo-frame>`;
}

export function renderFilesTreeResultsFrame(workspaceId: string, viewId: string, entries: FileEntry[], selectedPath?: string, filtered = false): string {
  const empty = filtered ? "No matching files. Try a different filter." : "This folder is empty. Drop files here to upload, or create files in Terminal, then Refresh.";
  return `<turbo-frame id="${filesTreeResultsFrameId(workspaceId, viewId)}" class="files-tree-results">
    <div class="files-filter-loading" role="status"><span class="status-spinner sm" aria-hidden="true"></span>Filtering files…</div>
    <div class="files-tree action-list" role="tree" aria-label="${filtered ? "Matching files" : `Files in ${escapeHtml(workspaceRoot)}`}" tabindex="0">${entries.map((entry) => renderEntry(workspaceId, viewId, entry, selectedPath)).join("") || `<p class="files-empty empty-state">${empty}</p>`}</div>
  </turbo-frame>`;
}

export function renderFilesTreeFrame(workspaceId: string, viewId: string, entries: FileEntry[], selectedPath?: string): string {
  const resultsFrameId = filesTreeResultsFrameId(workspaceId, viewId);
  const cancelUploadButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "caption", caption: "Cancel" },
    attributesHtml: 'data-action="files#cancel"',
  });
  return `<turbo-frame id="${filesTreeFrameId(workspaceId, viewId)}" data-turbo-permanent class="files-frame">
    <div class="files-navigator-content" data-controller="files" data-files-workspace-id-value="${escapeHtml(workspaceId)}" data-files-path-value="${escapeHtml(workspaceRoot)}" data-files-upload-url-value="/workspaces/${encodeURIComponent(workspaceId)}/files-view/upload" data-action="kintsugi:files-refresh@window->files#diskChanged formdata->files#preserveExpandedDirectories dragenter->files#dragEnter dragover->files#dragOver dragleave->files#dragLeave drop->files#drop keydown->files#keydown">
      <form class="managed-list__filter files-filter" method="get" action="/workspaces/${encodeURIComponent(workspaceId)}/files" data-controller="server-filter" data-action="input->server-filter#submit" data-turbo-frame="${resultsFrameId}">
        <input type="hidden" name="filesView" value="${escapeHtml(viewId)}">
        <input class="text-field" type="search" name="q" placeholder="Filter files…" aria-label="Filter files by name" autocomplete="off">
      </form>
      ${renderFilesTreeResultsFrame(workspaceId, viewId, entries, selectedPath)}
      <div class="files-drop-overlay" aria-hidden="true"><strong>Drop files to upload</strong><span>${escapeHtml(workspaceRoot)}</span></div>
      <footer class="files-upload-status" hidden><div class="files-progress-track"><span data-files-target="progress"></span></div><span data-files-target="status">Uploading…</span>${cancelUploadButton}</footer>
    </div>
  </turbo-frame>`;
}

function renderLazyFilesTreeFrame(workspaceId: string, view: FilesView): string {
  const query = new URLSearchParams({ filesView: view.id });
  return `<turbo-frame id="${filesTreeFrameId(workspaceId, view.id)}" data-turbo-permanent class="files-frame" src="/workspaces/${encodeURIComponent(workspaceId)}/files?${query}" loading="lazy"><div class="files-loading"><span class="status-spinner"></span> Loading files…</div></turbo-frame>`;
}

function fileConflictDialog(): string {
  const useTheirsButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "caption", caption: "Keep saved file" },
    attributesHtml: 'data-action="file-editor#useTheirs"',
  });
  const useMineButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "caption", caption: "Keep my edits" },
    attributesHtml: 'data-action="file-editor#useMine"',
  });
  return dialogHtml({
    element: {

      attributesHtml: 'data-file-editor-target="conflict"',
    },
    iconHtml: Icons.Files,
    titleCaption: "File changed on disk",
    bodyHtml: `<div class="file-conflict-comparison">
      <p>The saved file changed while you were editing it.</p><p>Choose which version to keep. The other version’s changes will be lost.</p>
      <label>Saved file<textarea class="textarea" data-file-editor-target="conflictTheirs" readonly rows="10" spellcheck="false" wrap="off"></textarea></label>
      <label>Your unsaved edits<textarea class="textarea" data-file-editor-target="conflictMine" readonly rows="10" spellcheck="false" wrap="off"></textarea></label>
    </div>`,
    footerHtml: `${useTheirsButton}${useMineButton}`,
    closeLabel: "Dismiss file conflict",
  });
}

function markdownDisplayToggle(kind: "Markdown" | "Table"): string {
  return toggleHtml({
    variant: "text",
    label: `${kind} display mode`,
    name: "markdown-display-mode",
    value: "source",
    element: {
      tag: "span",
      dataAction: "change->file-editor#selectMarkdownDisplayMode",
      data: { "file-editor-target": "markdownDisplayOptions" },
    },
    options: [
      { label: "Source", value: "source" },
      { label: kind === "Table" ? "Table" : "Rendered", value: "rendered" },
    ],
  });
}

function displayMenu(workspaceId: string, viewId: string): string {
  return popupHtml({
    id: domId("files", workspaceId, viewId, "display"), label: "Display options",
    trigger: { variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Settings, label: "Display options" } },
    contentHtml: contentRowHtml({ width: "fill", kind: "compact", label: { kind: "text", text: "Wrap long lines" }, trailingHtml: `<span class="file-editor-menu-check">${Icons.Check}</span>`, element: { tag: "button", attributesHtml: 'type="button" role="menuitemcheckbox" aria-checked="true" data-file-editor-target="wrapToggle" data-action="file-editor#toggleWrap"' } }),
  });
}

export function renderFilesEditorFrame(workspaceId: string, view: FilesView, previewKind: FilePreviewKind = isImageFile(view.path ?? "") ? "image" : "text", previewError?: string): string {
  const frameId = filesEditorFrameId(workspaceId, view.id);
  if (!view.path) return `<turbo-frame id="${frameId}" class="files-editor-frame"><section class="file-editor-pane files-editor-empty"><header class="file-editor-toolbar work-view-toolbar">${editorToolbarLeading(workspaceId, view)}${filesNavigatorToggle("expand")}</header><p>Select a file to view or edit. Drop files into the Files navigator to upload, or create them in Terminal and choose Refresh.</p></section></turbo-frame>`;
  if (previewKind !== "text") {
    const name = posix.basename(view.path);
    const mediaUrl = escapeHtml(previewKind === "image" ? workspaceImageUrl(workspaceId, view.path) : workspaceProxyUrl(workspaceId, "file", view.path));
    const fullscreen = previewKind === "image" || previewKind === "video";
    const preview = previewError
      ? `<p class="empty-state">${escapeHtml(previewError)}</p>`
      : previewKind === "image"
      ? `<img src="${mediaUrl}" alt="${escapeHtml(name)}" decoding="async" loading="lazy">`
      : previewKind === "video"
        ? `<video src="${mediaUrl}" controls playsinline preload="metadata">Your browser can’t play this video. Download it to open it elsewhere.</video>`
        : previewKind === "audio"
          ? `<audio src="${mediaUrl}" controls preload="metadata">Your browser can’t play this audio. Download it to open it elsewhere.</audio>`
          : `<p class="empty-state">${previewKind === "large-text" ? "This text file is too large to edit here." : "No preview available for this file."} Download it to open it elsewhere.</p>`;
    const fullscreenButton = buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Fullscreen" }, attributesHtml: 'data-action="kintsugi-fullscreen#open"' });
    return `<turbo-frame id="${frameId}" class="files-editor-frame"><section class="file-editor-pane" data-controller="kintsugi-fullscreen" data-kintsugi-fullscreen-mode-value="media" data-kintsugi-fullscreen-title-value="${escapeHtml(name)}">
      <header class="file-editor-toolbar work-view-toolbar">${editorToolbarLeading(workspaceId, view)}<span class="file-editor-toolbar-actions">${fullscreen ? fullscreenButton : ""}${selectedFileActions(workspaceId, view, true)}${filesNavigatorToggle("expand")}</span></header>
      <div class="file-media-preview">${preview}</div>
    </section></turbo-frame>`;
  }
  const contentUrl = `/workspaces/${encodeURIComponent(workspaceId)}/files-view/content?${new URLSearchParams({ path: view.path })}`;
  if (/\.drawio(?:\.xml)?$/i.test(view.path)) {
    const previewId = `${frameId}_diagram_${Bun.hash(view.path).toString(16)}`;
    return `<turbo-frame id="${frameId}" class="files-editor-frame"><section class="file-editor-pane file-editor-diagram-pane" id="${previewId}" data-turbo-permanent data-controller="files-diagram" data-files-diagram-workspace-id-value="${escapeHtml(workspaceId)}" data-files-diagram-content-url-value="${escapeHtml(contentUrl)}" data-files-diagram-preview-url-value="/workspaces/${encodeURIComponent(workspaceId)}/drawio/preview">
      <header class="file-editor-toolbar work-view-toolbar"><span class="file-editor-status is-error" data-files-diagram-target="status"></span><span class="file-editor-toolbar-actions">${selectedFileActions(workspaceId, view, true)}${filesNavigatorToggle("expand")}</span></header>
      <div class="file-editor-diagram-preview" data-files-diagram-target="preview"><p class="empty-state">Loading diagram…</p></div>
    </section></turbo-frame>`;
  }
  const delimited = isDelimitedPath(view.path);
  const rendered = delimited || /\.(?:md|markdown)$/i.test(view.path);
  const editorId = `${frameId}_${Bun.hash(view.path).toString(16)}`;
  return `<turbo-frame id="${frameId}" class="files-editor-frame" data-controller="file-editor-navigation" data-file-editor-navigation-editor-value="${escapeHtml(editorId)}" data-file-editor-navigation-request-value="${filesNavigationRequest(workspaceId, view.id)}" data-file-editor-navigation-line-value="${view.line ?? 0}" data-file-editor-navigation-column-value="${view.column ?? 0}"><section class="file-editor-pane" id="${escapeHtml(editorId)}" data-turbo-permanent data-controller="file-editor" data-file-editor-workspace-id-value="${escapeHtml(workspaceId)}" data-file-editor-files-view-value="${escapeHtml(view.id)}" data-file-editor-path-value="${escapeHtml(view.path)}" data-file-editor-content-url-value="${escapeHtml(contentUrl)}" data-file-editor-line-value="${view.line ?? 0}" data-file-editor-column-value="${view.column ?? 0}">
    <header class="file-editor-toolbar work-view-toolbar">${editorToolbarLeading(workspaceId, view)}<span class="file-editor-toolbar-actions">${rendered ? markdownDisplayToggle(delimited ? "Table" : "Markdown") : ""}<span class="file-editor-status" data-file-editor-target="status">Loading…</span>${refreshButton()}${displayMenu(workspaceId, view.id)}${selectedFileActions(workspaceId, view)}${filesNavigatorToggle("expand")}</span></header>
    <div class="file-editor-host kintsugi-pierre-host" data-file-editor-target="host"><div class="file-editor-loading" data-file-editor-target="loading" role="status"><i class="status-spinner sm" aria-hidden="true"></i><span>Loading file…</span></div></div>
    ${rendered ? `<div class="file-editor-rendered-markdown${delimited ? " file-editor-rendered-table" : " markdown"}" data-file-editor-target="renderedMarkdown" hidden></div>` : ""}
    ${fileConflictDialog()}
  </section></turbo-frame>`;
}

export function filesWorkViewPresentation(view: FilesView): WorkspaceWorkViewPresentation {
  return {
    sourceKey: `files:${view.id}`,
    label: view.path ? posix.basename(view.path) : view.viewer === "office" ? "Office" : "Files",
    reference: { type: "files", id: view.id },
    kind: view.viewer === "office" ? "resource" : "contextual", iconHtml: Icons.Files,
    initiallyOpen: view.id !== defaultFilesViewId,
    availability: { phase: "live" },
  };
}

export function renderFilesWorkViewBody(workspaceId: string, view: FilesView, previewKind?: FilePreviewKind, previewError?: string): string {
  return `<section class="work-view-pane files-work-view"><div class="files-workbench${view.path ? "" : " is-files-navigator-open"}" data-controller="files-view" data-files-view-selected-path-value="${escapeHtml(view.path ?? "")}" data-action="turbo:frame-load->files-view#updateSelection turbo:before-morph-attribute->files-view#preservePaneState">
    <div class="files-editor-canvas">${renderFilesEditorFrame(workspaceId, view, previewKind, previewError)}</div>
    <aside class="files-navigator" aria-label="Files navigator"><header class="files-navigator-header work-view-toolbar"><span class="files-navigator-path">${escapeHtml(workspaceRoot)}</span>${refreshButton()}${filesNavigatorToggle("collapse")}</header>${renderLazyFilesTreeFrame(workspaceId, view)}</aside>
  </div></section>`;
}
