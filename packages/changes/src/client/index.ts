import { createChangesEditController, syncFileEditButtons } from "./editing-controller.ts";
import { showButtonConfirmation } from "@kintsugi/design-system/button-confirmation/client";
import { createReviewSendController } from "./review-send-controller.ts";
import { createReviewCopyController } from "./review-copy-controller.ts";
import { exportReviewComments, type CommentAnnotation, type CommentPlacement } from "../comments.ts";
import type { ChangesAnnotation, MediaAnnotation, RevertAnnotation } from "../reverting.ts";
import { createDeletionReviewController } from "./deletion-controller.ts";
import type { CodeView, CodeViewItem, CodeViewOptions, CodeViewDiffItem, VirtualizedFileDiff, SelectedLineRange } from "@pierre/diffs";
import { copyTextToClipboard, type WorkspaceClientModule, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { createDiffEndpointsController } from "./diff-endpoints-controller.ts";
import { createCommitLinkController } from "./commit-link-controller.ts";
import { changesDiffOptions, wordDiffCSS } from "@kintsugi/syntax/diff-options";

const layoutStorageKey = "kintsugi:changes-layout";
const wrapStorageKey = "kintsugi:changes-wrap";
const unchangedStorageKey = "kintsugi:changes-unchanged";
const groupedStorageKey = "kintsugi:changes-grouped";
// Git paths never start with a slash, so these can't collide with a file.
const groupItemPrefix = "/changes-group/";

// Media previews sit on a file’s only, empty line; its number means nothing there.
const viewerCSS = `${wordDiffCSS} [data-diffs-header] { background: var(--bg); } :host([data-changes-media]) [data-line-number-content] { visibility: hidden; }`;

function createChangesController(Controller: WorkspaceClientControllerConstructor) {
  return class ChangesController extends Controller {
    declare readonly element: HTMLElement;
    static targets = ["unchangedHeader", "empty", "revertBlock", "viewHeader", "viewer", "model", "error", "errorMessage", "collapseToggle", "commentGutter", "commentEditor", "commentCard", "commentsModel", "listEditor", "orphanHost", "orphanDisclosure", "orphanContent"];
    static values = { workspaceId: String, snapshotId: String, collapsed: Boolean };
    declare readonly unchangedHeaderTarget: HTMLTemplateElement;
    declare readonly emptyTarget: HTMLElement;
    declare readonly hasEmptyTarget: boolean;
    declare readonly revertBlockTarget: HTMLTemplateElement;
    declare readonly viewHeaderTarget: HTMLElement;
    declare readonly viewerTarget: HTMLElement;
    declare readonly modelTarget: HTMLScriptElement;
    declare readonly errorTarget: HTMLElement;
    declare readonly errorMessageTarget: HTMLElement;
    declare readonly collapseToggleTarget: HTMLButtonElement;
    declare readonly commentGutterTarget: HTMLTemplateElement;
    declare readonly commentEditorTarget: HTMLTemplateElement;
    declare readonly commentCardTarget: HTMLTemplateElement;
    declare readonly listEditorTarget: HTMLElement;
    declare readonly orphanHostTarget: HTMLElement;
    declare readonly orphanDisclosureTarget: HTMLButtonElement;
    declare readonly orphanContentTarget: HTMLElement;
    declare readonly hasOrphanDisclosureTarget: boolean;
    declare readonly hasCollapseToggleTarget: boolean;
    declare readonly workspaceIdValue: string;
    declare readonly snapshotIdValue: string;
    declare readonly collapsedValue: boolean;
    private viewer?: CodeView<ChangesAnnotation, undefined>;
    private comments = new Map<string, CommentAnnotation>();
    private draft?: CommentAnnotation;
    private draftInList = false;
    private saving = false;
    private placements = new Map<string, CommentPlacement>();
    private renderedComments = new Map<string, string>();
    private revealedLines = new Set<string>();
    private orphansOpen?: boolean;
    private hasOrphans = false;
    private gutters = new WeakMap<HTMLElement, { path: string; hovered: () => { lineNumber: number; side?: "additions" | "deletions" } | undefined }>();
    private files = new Set<string>();
    private loaded = new Set<string>();
    private pending = new Set<string>();
    private abort?: AbortController;
    private options: CodeViewOptions<ChangesAnnotation, undefined> = {};
    private layout: "unified" | "split" = "unified";
    private wrap = true;
    private collapsed = false;
    private showUnchanged = false;
    private grouped = false;
    /** The group key of each changed file: "main" or its bucket's index. */
    private groups = new Map<string, string>();
    private groupHeadings = new Map<string, HTMLTemplateElement>();
    private unchanged?: string[];
    private headerTemplates = new Map<string, HTMLTemplateElement>();
    private media = new Map<string, HTMLTemplateElement>();
    private editable = new Set<string>();
    private readonly headerMedia = window.matchMedia("(max-width: 700px), (pointer: coarse)");
    private get headerHeight(): number { return this.headerMedia.matches ? 58 : 36; }
    private readonly resizeHeaders = (): void => {
      this.options = { ...this.options, itemMetrics: { diffHeaderHeight: this.headerHeight } };
      this.viewer?.setOptions(this.options);
    };

    connect(): void {
      this.headerMedia.addEventListener("change", this.resizeHeaders);
      void this.mount();
    }

    disconnect(): void {
      this.headerMedia.removeEventListener("change", this.resizeHeaders);
      this.abort?.abort();
      if (this.viewer) { this.viewerTarget.appendChild(this.viewHeaderTarget); this.viewerTarget.appendChild(this.orphanHostTarget); }
      this.viewer?.cleanUp();
      this.viewer = undefined;
      this.loaded.clear();
      this.pending.clear();
      this.renderedComments.clear();
      this.revealedLines.clear();
      this.headerTemplates.clear();
      this.media.clear();
      this.editable.clear();
    }

    /** Show changed files, plus unchanged ones when asked, in path order or grouped by bucket. Unchanged files load once opened. */
    private compose(): void {
      const item = (path: string): CodeViewItem<ChangesAnnotation> => this.viewer!.getItem(path)
        ?? { id: path, type: "file", file: { name: path, contents: "Loading file…", lang: "text", cacheKey: `${this.snapshotIdValue}:loading:${path}` }, collapsed: true, version: 0 };
      const unchanged = this.showUnchanged ? this.unchanged ?? [] : [];
      if (!this.grouped) {
        this.viewer!.setItems([...this.files, ...unchanged].sort((a, b) => a.localeCompare(b)).map(item));
        return;
      }
      // Headings are collapsed placeholder items: CodeView lays out only files, each with a same-height header.
      const heading = (key: string): CodeViewItem<ChangesAnnotation> => ({ id: `${groupItemPrefix}${key}`, type: "file", file: { name: "", contents: "", lang: "text", cacheKey: `${this.snapshotIdValue}:group:${key}` }, collapsed: true, version: 0 });
      const items: CodeViewItem<ChangesAnnotation>[] = [];
      for (const key of this.groupHeadings.keys()) {
        const paths = key === "unchanged" ? [...unchanged].sort((a, b) => a.localeCompare(b)) : [...this.files].filter(path => this.groups.get(path) === key);
        if (paths.length) items.push(heading(key), ...paths.map(item));
      }
      this.viewer!.setItems(items);
    }

    private async loadUnchanged(signal: AbortSignal): Promise<void> {
      if (this.unchanged) return;
      try {
        const query = new URLSearchParams({ snapshot: this.snapshotIdValue });
        const result = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/changes/unchanged?${query}`, { signal, headers: { Accept: "text/html" } });
        if (!result.ok) throw new Error(await result.text());
        const document = new DOMParser().parseFromString(await result.text(), "text/html");
        // SAFETY: The unchanged endpoint serializes this snapshot’s unchanged paths.
        this.unchanged = JSON.parse(document.querySelector("script[data-changes-unchanged]")!.textContent!) as string[];
      } catch (error) {
        if (signal.aborted) return;
        this.showError(`Couldn’t list unchanged files: ${error instanceof Error ? error.message : String(error)}`);
        console.error(error);
      }
    }

    private async mount(): Promise<void> {
      this.collapsed = this.collapsedValue;
      const shell = this.element.closest<HTMLElement>(".changes-body")!;
      this.layout = localStorage.getItem(layoutStorageKey) === "split" ? "split" : "unified";
      this.wrap = localStorage.getItem(wrapStorageKey) !== "false";
      this.showUnchanged = localStorage.getItem(unchangedStorageKey) === "true";
      for (const template of this.element.querySelectorAll<HTMLTemplateElement>("template[data-changes-group]")) this.groupHeadings.set(template.dataset.changesGroup!, template);
      const groupedToggle = this.element.querySelector('[data-action="changes#toggleGrouped"]');
      // The option only exists when the workspace has buckets.
      this.grouped = groupedToggle !== null && localStorage.getItem(groupedStorageKey) === "true";
      groupedToggle?.setAttribute("aria-checked", String(this.grouped));
      for (const radio of this.element.querySelectorAll<HTMLElement>("[data-layout]")) radio.setAttribute("aria-checked", String(radio.dataset.layout === this.layout));
      this.element.querySelector('[data-action="changes#toggleWrap"]')!.setAttribute("aria-checked", String(this.wrap));
      this.element.querySelector('[data-action="changes#toggleUnchanged"]')!.setAttribute("aria-checked", String(this.showUnchanged));
      for (const template of this.element.querySelectorAll<HTMLTemplateElement>("template[data-changes-header]")) this.headerTemplates.set(template.dataset.changesHeader!, template);
      // SAFETY: renderChanges emits this private model with type-matched loading items.
      const model = JSON.parse(this.modelTarget.textContent!) as { items: CodeViewItem<ChangesAnnotation>[]; files: { path: string; bucket?: number }[] };
      this.files = new Set(model.files.map(file => file.path));
      this.groups = new Map(model.files.map(file => [file.path, file.bucket === undefined ? "main" : String(file.bucket)]));
      for (const template of this.element.querySelectorAll<HTMLTemplateElement>("template[data-changes-media]")) this.media.set(template.dataset.changesMedia!, template);
      // SAFETY: The edit controller transfers only file disclosure booleans in this presentation model.
      const disclosure = new Map(Object.entries(JSON.parse(shell.dataset.changesFileCollapse ?? "{}") as Record<string, boolean>));
      for (const item of model.items) if (item.type === "file") this.loaded.add(item.id);
      if (!model.files.length && !this.showUnchanged) { this.syncCollapseControl(); return; }
      const abort = this.abort = new AbortController();
      const [[{ CodeView }]] = await Promise.all([
        Promise.all([import("@pierre/diffs"), import("@kintsugi/syntax/pierre")]),
        this.showUnchanged ? this.loadUnchanged(abort.signal) : undefined,
      ]);
      if (abort.signal.aborted) return;
      this.options = {
        ...changesDiffOptions,
        disableFileHeader: false,
        disableLineNumbers: false,
        enableLineSelection: true,
        enableGutterUtility: true,
        renderGutterUtility: (hovered, context) => {
          if (this.element.dataset.codeEditing || context.type !== "diff" || !this.loaded.has(context.item.id)) return null;
          // SAFETY: renderDiff emits a Button as the gutter template’s sole root.
          const button = this.commentGutterTarget.content.firstElementChild!.cloneNode(true) as HTMLElement;
          this.gutters.set(button, { path: context.item.id, hovered });
          return button;
        },
        renderAnnotation: ({ metadata }) => metadata.kind === "media" ? this.renderMedia(metadata) : metadata.kind === "revert" ? this.renderRevert(metadata) : this.renderComment(metadata),
        renderCodeViewHeader: () => this.viewHeaderTarget,
        renderCodeViewFooter: () => this.orphanHostTarget,
        diffStyle: this.layout,
        overflow: this.wrap ? "wrap" : "scroll",
        lineDiffType: "word-line",
        stickyHeaders: true,
        layout: { paddingTop: 0, paddingBottom: 8, gap: 0 },
        itemMetrics: { diffHeaderHeight: this.headerHeight },
        unsafeCSS: viewerCSS,
        onPostRender: (node, _instance, _phase, context) => {
          node.toggleAttribute("data-changes-media", context.item.annotations?.some(annotation => annotation.metadata.kind === "media") === true);
          // Unchanged files load on demand; there can be thousands of them.
          if (this.files.has(context.item.id) || !context.item.collapsed) void this.loadFile(context.item.id, abort.signal);
          if (context.type === "diff" && !this.element.dataset.codeEditing && this.loaded.has(context.item.id)) this.revealCommentLines(context.item, context.instance);
        },
        renderCustomHeader: (_file, context) => context.item.id.startsWith(groupItemPrefix)
          ? this.groupHeading(context.item.id.slice(groupItemPrefix.length))
          : this.header(context.item.id, context.item.collapsed === true),
      };
      this.viewer = new CodeView<ChangesAnnotation, undefined>(this.options);
      this.viewer.setup(this.viewerTarget);
      if (this.hasEmptyTarget) this.viewHeaderTarget.prepend(this.emptyTarget);
      this.viewer.setItems(model.items.map((item) => ({ ...item, collapsed: disclosure.get(item.id) ?? this.collapsed })));
      if (this.showUnchanged || this.grouped) this.compose();
      const scroll = Number(shell.dataset.changesScroll ?? 0);
      delete shell.dataset.changesFileCollapse;
      delete shell.dataset.changesScroll;
      requestAnimationFrame(() => { this.viewerTarget.scrollTop = scroll; });
      for (const path of this.loaded) this.updateComments(path);
      this.syncCollapseControl();
    }

    commentsModelTargetConnected(script: HTMLScriptElement): void {
      // SAFETY: This live model contains server-owned persisted comments and placements.
      const comments = JSON.parse(script.textContent!) as CommentPlacement[];
      const unavailable = comments.some(comment => comment.status !== "inline");
      if (unavailable && !this.hasOrphans) this.orphansOpen = true;
      this.hasOrphans = unavailable;
      this.placements = new Map(comments.map(comment => [comment.id, comment]));
      this.comments = new Map(comments.filter(comment => comment.status === "inline").map(comment => [comment.id, {
        id: comment.id, kind: "comment", path: comment.path, side: comment.side,
        start: comment.placedStart!, end: comment.placedEnd!, body: comment.body, revision: comment.revision,
      }]));
      if (this.viewer) for (const path of this.loaded) this.updateComments(path);
    }

    orphanDisclosureTargetConnected(button: HTMLButtonElement): void {
      this.orphansOpen ??= button.getAttribute("aria-expanded") === "true";
      this.syncOrphans();
    }
    toggleOrphans(): void {
      this.orphansOpen = !this.orphansOpen;
      this.syncOrphans();
      this.syncCollapseControl();
    }
    private syncOrphans(): void {
      if (!this.hasOrphanDisclosureTarget) return;
      this.orphanDisclosureTarget.setAttribute("aria-expanded", String(this.orphansOpen));
      this.orphanContentTarget.hidden = !this.orphansOpen;
      if (this.draftInList) this.listEditorTarget.hidden = !this.orphansOpen;
      if (this.viewer) this.syncCollapseControl();
    }

    shareViewer(event: CustomEvent<{ receive(viewer: CodeView<ChangesAnnotation, undefined>, configure: (options: CodeViewOptions<ChangesAnnotation, undefined>) => void): void }>): void {
      event.detail.receive(this.viewer!, options => {
        if (options.unsafeCSS !== undefined) options = { ...options, unsafeCSS: `${viewerCSS} ${options.unsafeCSS}` };
        this.options = { ...this.options, ...options };
        this.viewer!.setOptions(this.options);
      });
    }

    dismissError(): void { this.errorTarget.hidden = true; }

    private groupHeading(key: string): HTMLElement {
      // SAFETY: renderDiff emits each group heading template with one div root.
      return this.groupHeadings.get(key)!.content.firstElementChild!.cloneNode(true) as HTMLElement;
    }

    private header(path: string, collapsed: boolean): HTMLElement {
      const template = this.headerTemplates.get(path) ?? this.unchangedHeaderTarget;
      // SAFETY: Header templates contain one server-rendered div with an Content row button.
      const header = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
      const button = header.querySelector("button")!;
      if (template === this.unchangedHeaderTarget) {
        button.dataset.path = path;
        header.querySelector(".content-row__label-text")!.textContent = path;
        const edit = header.querySelector<HTMLButtonElement>('[data-action="changes-edit#begin"]')!;
        if (this.editable.has(path)) { edit.dataset.path = path; edit.setAttribute("aria-label", `Edit ${path}`); }
        else { edit.remove(); header.querySelector(".changes-file-edit-actions")!.remove(); }
      }
      button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${path}`);
      const edit = header.querySelector<HTMLButtonElement>('[data-action="changes-edit#begin"]');
      if (edit) edit.dataset.ready = String(this.loaded.has(path));
      syncFileEditButtons(header, this.element.dataset.codeEditing, false);
      return header;
    }

    toggleFile(event: Event): void {
      // SAFETY: File disclosure actions are attached to the server-rendered header buttons.
      const path = (event.currentTarget as HTMLButtonElement).dataset.path!;
      const item = this.viewer!.getItem(path)!;
      this.viewer!.updateItem({ ...item, collapsed: !item.collapsed, version: (item.version ?? 0) + 1 });
      this.syncCollapseControl();
    }

    private syncCollapseControl(): void {
      // Mixed states offer Collapse all; Expand all is only useful once everything is closed.
      this.collapsed = (this.files.size > 0 || this.hasOrphanDisclosureTarget)
        && (!this.hasOrphanDisclosureTarget || !this.orphansOpen)
        && [...this.files].every(path => this.viewer?.getItem(path)?.collapsed === true);
      if (!this.hasCollapseToggleTarget) return;
      this.collapseToggleTarget.disabled = false;
      this.collapseToggleTarget.dataset.collapsed = String(this.collapsed);
      const label = this.collapsed ? "Expand all" : "Collapse all";
      this.collapseToggleTarget.setAttribute("aria-label", label);
      this.collapseToggleTarget.title = label;
    }

    private async loadFile(path: string, signal: AbortSignal): Promise<void> {
      if (this.loaded.has(path) || this.pending.has(path)) return;
      this.pending.add(path);
      try {
        const query = new URLSearchParams({ snapshot: this.snapshotIdValue, path });
        const result = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/changes/file?${query}`, { signal, headers: { Accept: "text/html" } });
        if (!result.ok) throw new Error(await result.text());
        const document = new DOMParser().parseFromString(await result.text(), "text/html");
        const script = document.querySelector<HTMLScriptElement>("script[data-changes-file]")!;
        // SAFETY: The Changes file endpoint serializes a CodeViewItem captured by this snapshot.
        const item = JSON.parse(script.textContent!) as CodeViewItem<ChangesAnnotation>;
        // Hiding unchanged files removes them; they load again when shown and opened.
        const previous = this.viewer!.getItem(path);
        if (signal.aborted || !previous) return;
        const media = document.querySelector<HTMLTemplateElement>("template[data-changes-media]");
        if (media) this.media.set(path, media);
        if (script.dataset.editable === "true") this.editable.add(path);
        this.loaded.add(path);
        this.viewer!.updateItem({ ...item, collapsed: previous.collapsed, version: (previous.version ?? 0) + 1 });
        this.renderedComments.delete(path);
        this.updateComments(path);
      } catch (error) {
        if (signal.aborted) return;
        this.errorTarget.hidden = false;
        this.errorMessageTarget.textContent = `Couldn’t load ${path}: ${error instanceof Error ? error.message : String(error)}. Use Refresh to try again.`;
        console.error(error);
      } finally {
        this.pending.delete(path);
      }
    }

    addComment(event: Event): void {
      // SAFETY: This action is bound to the server-rendered gutter Button.
      const gutter = this.gutters.get(event.currentTarget as HTMLElement)!;
      const hovered = gutter.hovered()!;
      const selected = this.viewer!.getSelectedLines();
      const insideSelection = selected?.id === gutter.path && (selected.range.side ?? "additions") === (hovered.side ?? "additions")
        && hovered.lineNumber >= Math.min(selected.range.start, selected.range.end) && hovered.lineNumber <= Math.max(selected.range.start, selected.range.end);
      const range = insideSelection ? selected.range : { start: hovered.lineNumber, end: hovered.lineNumber, side: hovered.side };
      this.beginComment(gutter.path, range);
    }

    private beginComment(path: string, range: SelectedLineRange): void {
      if (this.element.dataset.codeEditing) { this.showError("Save or discard your code edit before writing a comment."); return; }
      if (this.draft) {
        if (this.draftInList) { this.orphansOpen = true; this.syncOrphans(); this.listEditorTarget.querySelector("textarea")!.focus(); return; }
        this.viewer!.scrollTo({ type: "line", id: this.draft.path, lineNumber: this.draft.end, side: this.draft.side, align: "center" });
        this.updateComments(this.draft.path);
        return;
      }
      if (range.endSide && range.endSide !== range.side) {
        this.errorMessageTarget.textContent = "Comment on one side of the diff at a time.";
        this.errorTarget.hidden = false;
        return;
      }
      this.draftInList = false;
      this.element.dataset.commentDraft = "true";
      this.draft = { revision: 0, id: crypto.randomUUID(), kind: "draft", path, side: range.side ?? "additions", start: Math.min(range.start, range.end), end: Math.max(range.start, range.end), body: "" };
      this.updateComments(path);
      this.viewer!.scrollTo({ type: "line", id: path, lineNumber: this.draft.end, side: this.draft.side, align: "center" });
    }

    private updateComments(path: string): void {
      const item = this.viewer!.getItem(path)!;
      if (this.element.dataset.codeEditing === path || item.type !== "diff" || !this.loaded.has(path)) return;
      const comments = [...this.comments.values()].filter(comment => comment.path === path && (this.draftInList || comment.id !== this.draft?.id));
      if (!this.draftInList && this.draft?.path === path) comments.push(this.draft);
      const signature = JSON.stringify(comments.map(comment => comment.kind === "draft" ? { ...comment, body: "" } : comment));
      if (this.renderedComments.get(path) === signature) return;
      this.renderedComments.set(path, signature);
      this.viewer!.updateItem({ ...item, annotations: comments.map(metadata => ({ lineNumber: metadata.end, side: metadata.side, metadata })), version: (item.version ?? 0) + 1 });
    }

    private revealCommentLines(item: CodeViewDiffItem<ChangesAnnotation>, instance: VirtualizedFileDiff<ChangesAnnotation, undefined>): void {
      // Pierre keeps annotations in collapsed context hidden. Reveal their exact line ranges.
      for (const annotation of item.annotations ?? []) if (annotation.metadata.kind === "comment" || annotation.metadata.kind === "draft") for (const line of [annotation.metadata.start, annotation.metadata.end]) {
        const key = `${item.id}:${annotation.side}:${line}`;
        if (this.revealedLines.has(key)) continue;
        this.revealedLines.add(key);
        const hunks = item.fileDiff.hunks;
        const start = (index: number) => annotation.side === "additions" ? hunks[index]!.additionStart : hunks[index]!.deletionStart;
        const end = (index: number) => start(index) + (annotation.side === "additions" ? hunks[index]!.additionCount : hunks[index]!.deletionCount) - 1;
        if (hunks.some((_hunk, index) => line >= start(index) && line <= end(index))) continue;
        const following = hunks.findIndex((_hunk, index) => start(index) > line);
        if (following !== -1) instance.expandHunk(following, "up", start(following) - line);
        else instance.expandHunk(hunks.length - 1, "down", line - end(hunks.length - 1));
      }
    }

    private renderMedia(annotation: MediaAnnotation): HTMLElement {
      // SAFETY: Media templates contain one server-rendered preview element.
      return this.media.get(annotation.path)!.content.firstElementChild!.cloneNode(true) as HTMLElement;
    }

    private renderRevert(annotation: RevertAnnotation): HTMLElement {
      // SAFETY: The revert template contains one server-rendered element wrapping its Button.
      const element = this.revertBlockTarget.content.firstElementChild!.cloneNode(true) as HTMLElement;
      element.dataset.block = String(annotation.block);
      return element;
    }

    private renderComment(comment: CommentAnnotation): HTMLElement {
      const template = comment.kind === "draft" ? this.commentEditorTarget : this.commentCardTarget;
      // SAFETY: The server emits a form/article root for these owned annotation templates.
      const element = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
      element.dataset.commentId = comment.id;
      if (comment.kind === "draft") {
        const textarea = element.querySelector<HTMLTextAreaElement>("textarea")!;
        textarea.value = comment.body;
        queueMicrotask(() => textarea.focus({ preventScroll: true }));
      } else element.querySelector<HTMLElement>("[data-comment-body]")!.textContent = comment.body;
      return element;
    }

    commentInput(event: Event): void {
      // SAFETY: This action is bound to the comment template’s textarea.
      const textarea = event.currentTarget as HTMLTextAreaElement;
      this.draft!.body = textarea.value;
      textarea.setCustomValidity("");
    }
    commentShortcut(event: KeyboardEvent): void {
      event.preventDefault();
      // SAFETY: The keyboard shortcut is bound to the comment template’s form.
      (event.currentTarget as HTMLFormElement).requestSubmit();
    }
    private showError(message: string): void {
      this.errorMessageTarget.textContent = message;
      this.errorTarget.hidden = false;
    }
    private async commentRequest(operation: "save" | "delete" | "delete-many" | "copied", data: FormData): Promise<string> {
      data.set("snapshot", this.snapshotIdValue);
      const result = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/changes/comments/${operation}`, { method: "POST", body: data, headers: { Accept: "text/vnd.turbo-stream.html" } });
      const html = await result.text();
      if (!result.ok) throw new Error(html);
      return html;
    }
    async saveComment(event: SubmitEvent): Promise<void> {
      event.preventDefault();
      if (this.saving) return;
      // SAFETY: Submit is bound to the comment template’s form.
      const form = event.currentTarget as HTMLFormElement;
      const textarea = form.querySelector<HTMLTextAreaElement>("textarea")!;
      const body = textarea.value.trim();
      if (!body) { textarea.setCustomValidity("Add a comment first."); textarea.reportValidity(); return; }
      const comment = this.draft!;
      const data = new FormData();
      data.set("id", comment.id);
      data.set("revision", String(comment.revision ?? 0));
      data.set("body", body);
      if (!comment.revision) {
        data.set("path", comment.path); data.set("side", comment.side);
        data.set("start", String(comment.start)); data.set("end", String(comment.end));
      }
      this.saving = true;
      for (const button of form.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
      textarea.readOnly = true;
      this.errorTarget.hidden = true;
      try {
        const html = await this.commentRequest("save", data);
        this.draft = undefined;
        delete this.element.dataset.commentDraft;
        this.listEditorTarget.replaceChildren();
        this.listEditorTarget.hidden = true;
        if (!this.draftInList && this.loaded.has(comment.path)) this.updateComments(comment.path);
        this.draftInList = false;
        window.Turbo!.renderStreamMessage(html);
      } catch (error) {
        this.showError(`Couldn’t save comment: ${error instanceof Error ? error.message : String(error)}`);
        console.error(error);
      } finally {
        this.saving = false;
        textarea.readOnly = false;
        for (const button of form.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false;
      }
    }
    cancelComment(event: Event): void {
      event.preventDefault();
      event.stopPropagation();
      if (this.saving) return;
      const path = this.draft!.path;
      this.draft = undefined;
      delete this.element.dataset.commentDraft;
      this.listEditorTarget.replaceChildren();
      this.listEditorTarget.hidden = true;
      if (!this.draftInList && this.loaded.has(path)) this.updateComments(path);
      this.draftInList = false;
    }
    editComment(event: Event): void {
      if (this.element.dataset.codeEditing) { this.showError("Save or discard your code edit before writing a comment."); return; }
      if (this.draft) return;
      // SAFETY: These actions are bound to buttons inside owned comment cards.
      const element = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-comment-id]")!;
      const comment = this.placements.get(element.dataset.commentId!)!;
      this.draftInList = element.classList.contains("changes-review-entry");
      this.element.dataset.commentDraft = "true";
      this.draft = { id: comment.id, revision: comment.revision, kind: "draft", path: comment.path, side: comment.side, start: comment.placedStart ?? comment.start, end: comment.placedEnd ?? comment.end, body: comment.body };
      if (this.draftInList) {
        this.orphansOpen = true;
        this.syncOrphans();
        this.listEditorTarget.hidden = false;
        this.listEditorTarget.replaceChildren(this.renderComment(this.draft));
      } else this.updateComments(comment.path);
    }
    async copyComment(event: Event): Promise<void> {
      // SAFETY: This action is bound to the server-rendered copy button in a saved comment card.
      const button = event.currentTarget as HTMLButtonElement;
      const comment = this.placements.get(button.closest<HTMLElement>("[data-comment-id]")!.dataset.commentId!)!;
      button.disabled = true;
      let copied = false;
      try {
        await copyTextToClipboard(exportReviewComments([comment]));
        copied = true;
        showButtonConfirmation(button);
        const data = new FormData();
        data.set("versions", JSON.stringify([{ id: comment.id, revision: comment.revision }]));
        window.Turbo!.renderStreamMessage(await this.commentRequest("copied", data));
      } catch (error) {
        this.showError(copied ? "Comment was copied, but we couldn’t record it. Copy again before deleting this workspace." : "Couldn’t copy the comment. Try again.");
        console.error(error);
      } finally { button.disabled = false; }
    }

    async deleteComment(event: Event): Promise<void> {
      // SAFETY: Delete actions are bound to server-rendered comment buttons.
      const button = event.currentTarget as HTMLButtonElement;
      const id = button.closest<HTMLElement>("[data-comment-id]")!.dataset.commentId!;
      const comment = this.placements.get(id)!;
      const data = new FormData();
      data.set("id", id); data.set("revision", String(comment.revision));
      button.disabled = true;
      try { window.Turbo!.renderStreamMessage(await this.commentRequest("delete", data)); }
      catch (error) { this.showError(`Couldn’t delete comment: ${error instanceof Error ? error.message : String(error)}`); console.error(error); }
      finally { button.disabled = false; }
    }
    async deleteComments(event: SubmitEvent): Promise<void> {
      event.preventDefault();
      // SAFETY: Bulk deletion is submitted by the server-rendered confirmation form.
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      // SAFETY: The server renders versions as a JSON array of comment IDs and revisions in this form.
      const versions = JSON.parse(String(data.get("versions"))) as { id: string; revision: number }[];
      const deletingDraft = this.draft && versions.some(version => version.id === this.draft!.id && version.revision === this.draft!.revision);
      form.querySelector<HTMLElement>("[popover]")!.hidePopover();
      for (const button of form.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
      try {
        const html = await this.commentRequest("delete-many", data);
        if (deletingDraft && this.draft) {
          const path = this.draft.path;
          this.draft = undefined;
          delete this.element.dataset.commentDraft;
          this.listEditorTarget.replaceChildren();
          this.listEditorTarget.hidden = true;
          if (!this.draftInList && this.loaded.has(path)) this.updateComments(path);
          this.draftInList = false;
        }
        window.Turbo!.renderStreamMessage(html);
      } catch (error) {
        this.showError(`Couldn’t delete comments: ${error instanceof Error ? error.message : String(error)}`);
        console.error(error);
      } finally { for (const button of form.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false; }
    }

    chooseLayout(event: Event): void {
      // SAFETY: Layout actions are attached to server-rendered menu buttons.
      const value = (event.currentTarget as HTMLButtonElement).dataset.layout;
      if (value !== "unified" && value !== "split") throw new Error("Unknown diff layout");
      this.layout = value;
      localStorage.setItem(layoutStorageKey, value);
      for (const radio of this.element.querySelectorAll<HTMLElement>("[data-layout]")) radio.setAttribute("aria-checked", String(radio.dataset.layout === value));
      this.options = { ...this.options, diffStyle: value };
      this.viewer?.setOptions(this.options);
    }

    async toggleUnchanged(event: Event): Promise<void> {
      this.showUnchanged = !this.showUnchanged;
      localStorage.setItem(unchangedStorageKey, String(this.showUnchanged));
      // SAFETY: The unchanged action is attached to the server-rendered checkbox menu item.
      (event.currentTarget as HTMLButtonElement).setAttribute("aria-checked", String(this.showUnchanged));
      if (!this.viewer) {
        // An empty comparison has no viewer until there is something to list.
        if (this.showUnchanged && !this.abort) void this.mount();
        return;
      }
      if (this.showUnchanged) await this.loadUnchanged(this.abort!.signal);
      else for (const path of this.unchanged ?? []) this.loaded.delete(path);
      if (this.viewer) this.compose();
    }

    toggleGrouped(event: Event): void {
      this.grouped = !this.grouped;
      localStorage.setItem(groupedStorageKey, String(this.grouped));
      // SAFETY: The grouping action is attached to the server-rendered checkbox menu item.
      (event.currentTarget as HTMLButtonElement).setAttribute("aria-checked", String(this.grouped));
      if (this.viewer) this.compose();
    }

    toggleWrap(event: Event): void {
      this.wrap = !this.wrap;
      localStorage.setItem(wrapStorageKey, String(this.wrap));
      // SAFETY: The wrap action is attached to the server-rendered checkbox menu item.
      (event.currentTarget as HTMLButtonElement).setAttribute("aria-checked", String(this.wrap));
      this.options = { ...this.options, overflow: this.wrap ? "wrap" : "scroll" };
      this.viewer?.setOptions(this.options);
    }

    toggleCollapse(): void {
      this.syncCollapseControl();
      this.collapsed = !this.collapsed;
      for (const path of this.files) {
        const item = this.viewer?.getItem(path);
        if (item) this.viewer!.updateItem({ ...item, collapsed: this.collapsed, version: (item.version ?? 0) + 1 });
      }
      // Unchanged files only ever collapse together; expanding them all would load the whole repository.
      if (this.collapsed) for (const path of this.unchanged ?? []) {
        const item = this.viewer?.getItem(path);
        if (item && !item.collapsed) this.viewer!.updateItem({ ...item, collapsed: true, version: (item.version ?? 0) + 1 });
      }
      if (this.hasOrphanDisclosureTarget) { this.orphansOpen = !this.collapsed; this.syncOrphans(); }
      this.syncCollapseControl();
    }
  };
}

export const kintsugiClientModule: WorkspaceClientModule = {
  id: "changes",
  install({ application, Controller, hooks }) {
    application.register("deletion-review", createDeletionReviewController(Controller));
    application.register("changes", createChangesController(Controller));
    application.register("changes-edit", createChangesEditController(Controller));
    application.register("review-copy", createReviewCopyController(Controller));
    application.register("review-send", createReviewSendController(Controller));
    application.register("changes-diff-endpoints", createDiffEndpointsController(Controller));
    application.register("commit-link", createCommitLinkController(Controller));
    hooks.onBecomeVisible(({ pane }) => {
      // Let Stimulus connect newly inserted views before requesting the refresh.
      requestAnimationFrame(() => {
        if (pane.dataset.workspaceSurfaceVisible !== "true") return;
        const element = pane.querySelector("[data-controller~='changes-diff-endpoints']");
        if (!element) return;
        // SAFETY: This element belongs to the controller registered above.
        const controller = application.getControllerForElementAndIdentifier(element, "changes-diff-endpoints") as InstanceType<ReturnType<typeof createDiffEndpointsController>>;
        controller.refreshWhenShown();
      });
    });
  },
};
