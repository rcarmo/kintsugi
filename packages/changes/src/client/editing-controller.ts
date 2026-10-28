// @ts-expect-error Turbo ships no TypeScript declarations.
import { visit } from "@hotwired/turbo";
import type { CodeView, CodeViewOptions, DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import type { Editor, EditorChangeEvent } from "@pierre/diffs/edit";
import { copyTextToClipboard, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { changeBlocks, revertAnchor, revertBlockEdit, type ChangesAnnotation } from "../reverting.ts";
import { diskContents, editorContents, type EditModel, type EditedCommentRange } from "../editing.ts";
import { moveCommentRanges } from "../editing-ranges.ts";

type Viewer = CodeView<ChangesAnnotation, undefined>;
type Stream = HTMLElement & { targetElements: HTMLElement[]; templateElement: HTMLTemplateElement };

/** Both fresh Pierre headers and session updates use the same file-row state. */
export function syncFileEditButtons(header: HTMLElement, editingPath: string | undefined, pending: boolean): void {
  const edit = header.querySelector<HTMLButtonElement>('[data-action="changes-edit#begin"]');
  if (!edit) return;
  const active = editingPath === edit.dataset.path;
  edit.disabled = edit.dataset.ready !== "true" || Boolean(editingPath);
  edit.hidden = active || header.querySelector('[aria-expanded="false"]') !== null;
  const actions = header.querySelector<HTMLElement>(".changes-file-edit-actions")!;
  actions.hidden = !active;
  for (const button of actions.querySelectorAll<HTMLButtonElement>("button")) button.disabled = pending;
}

export function createChangesEditController(Controller: WorkspaceClientControllerConstructor) {
  return class ChangesEditController extends Controller {
    declare readonly element: HTMLElement;
    static targets = ["fileHeader", "status", "stale", "confirmation", "dialogError"];
    static values = { workspaceId: String, snapshotId: String };
    declare readonly workspaceIdValue: string;
    declare readonly snapshotIdValue: string;
    declare readonly fileHeaderTargets: HTMLElement[];
    declare readonly statusTarget: HTMLElement;
    declare readonly staleTarget: HTMLElement;
    declare readonly confirmationTarget: HTMLDialogElement;
    declare readonly dialogErrorTarget: HTMLElement;
    private connection!: AbortController;
    private viewer?: Viewer;
    private configure?: (options: CodeViewOptions<ChangesAnnotation, undefined>) => void;
    private model?: EditModel;
    private text = "";
    private ranges: EditedCommentRange[] = [];
    private history = new Map<number, EditedCommentRange[]>();
    private historyEntries = new WeakSet<object>();
    private busy = false;
    private starting = false;
    private accepted = false;
    private continuation?: () => void;
    private editor?: Editor<"file" | "file-diff", ChangesAnnotation, undefined>;
    /** Reverting rewrites the draft, so its hunks follow the base and the current draft. */
    private reverting?: { base: string; comments: DiffLineAnnotation<ChangesAnnotation>[]; diff: FileDiffMetadata; signature: string; parse: typeof import("@pierre/diffs").parseDiffFromFile };

    connect(): void {
      this.connection = new AbortController();
      const { signal } = this.connection;
      document.addEventListener("live:before-stream-render", this.preserve, { signal });
      document.addEventListener("turbo:before-stream-render", this.preserve, { signal });
      this.element.addEventListener("changes-edit:guard", this.guardRequested, { signal });
      document.addEventListener("submit", this.beforeSubmit, { capture: true, signal });
      document.addEventListener("turbo:before-visit", this.beforeVisit, { signal });
      document.addEventListener("workspace-selection:before-select", this.beforeWorkspaceSelection, { signal });
      this.element.addEventListener("keydown", this.shortcut, { capture: true, signal });
      window.addEventListener("beforeunload", this.beforeUnload, { signal });
    }
    disconnect(): void {
      this.connection.abort();
      this.confirmationTarget.close();
      // Component teardown is never a persistence action.
      if (this.model && !this.busy) void this.release(this.model.token).catch(error => console.error(error));
      this.model = undefined;
      this.history.clear();
    }
    fileHeaderTargetConnected(header: HTMLElement): void {
      syncFileEditButtons(header, this.element.dataset.codeEditing, this.busy || this.starting);
    }
    private get dirty(): boolean { return Boolean(this.model && diskContents(this.text, this.model.ending) !== this.model.contents); }
    private get shell(): HTMLElement { return this.element.closest<HTMLElement>(".changes-body")!; }
    private showError(message: string): void {
      const error = this.element.querySelector<HTMLElement>('[data-changes-target="error"]')!;
      error.hidden = false;
      error.querySelector<HTMLElement>('[data-changes-target="errorMessage"]')!.textContent = message;
      this.dialogErrorTarget.textContent = message;
      this.dialogErrorTarget.hidden = false;
    }
    private async request(operation: "begin" | "save" | "cancel", data: FormData): Promise<string> {
      const result = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/changes/edit/${operation}`, { method: "POST", body: data, headers: { Accept: operation === "save" ? "text/vnd.turbo-stream.html" : "text/html" } });
      const html = await result.text();
      if (!result.ok) throw new Error(html);
      return html;
    }
    async begin(event: Event): Promise<void> {
      if (this.model || this.starting) return;
      if (this.element.dataset.commentDraft) { this.showError("Save or cancel your comment before editing code."); return; }
      // SAFETY: Edit actions are bound to server-rendered header buttons with file paths.
      const path = (event.currentTarget as HTMLButtonElement).dataset.path!;
      this.starting = true;
      this.element.dataset.codeEditing = path;
      this.staleTarget.hidden = true;
      this.statusTarget.textContent = "Opening editor…";
      this.renderAvailability();
      try {
        const data = new FormData(); data.set("snapshot", this.snapshotIdValue); data.set("path", path);
        // Load first so a failed editor import cannot abandon an acquired lease.
        const [{ Editor }, { parseDiffFromFile }] = await Promise.all([import("@pierre/diffs/edit"), import("@pierre/diffs")]);
        const html = await this.request("begin", data);
        const document = new DOMParser().parseFromString(html, "text/html");
        // SAFETY: The begin endpoint emits our typed edit lease in an HTML data island.
        const model = JSON.parse(document.querySelector("script[data-changes-edit-model]")!.textContent!) as EditModel;
        if (this.connection.signal.aborted) { await this.release(model.token); return; }
        this.element.dispatchEvent(new CustomEvent("changes-edit:viewer", { detail: { receive: (viewer: Viewer, configure: (options: CodeViewOptions<ChangesAnnotation, undefined>) => void) => { this.viewer = viewer; this.configure = configure; } } }));
        this.model = model;
        const original = this.viewer!.getItem(path)!;
        this.text = editorContents(model.contents);
        this.accepted = false;
        this.ranges = (original.annotations ?? []).flatMap(({ metadata }) => metadata.kind === "comment" && metadata.side === "additions" ? [{ id: metadata.id, revision: metadata.revision!, start: metadata.start, end: metadata.end }] : []);
        this.history.set(0, structuredClone(this.ranges));
        let focused = false;
        this.configure!({
          createEditor: (type, options, key) => new Editor(type, { ...options, onAttach: editor => {
            this.editor = editor;
            if (!focused) { focused = true; requestAnimationFrame(() => editor.focus({ lineNumber: model.contents ? "first-visible" : 1, preventScroll: true })); }
          } }, key),
          onItemEditChange: event => this.changed(event),
          onItemEditComplete: () => this.accepted ? "accept" : "reject",
        });
        if (original.type === "diff" && this.revertible(path)) {
          const base = editorContents(original.fileDiff.deletionLines.join(""));
          this.reverting = { base, comments: original.annotations ?? [], diff: original.fileDiff, signature: "", parse: parseDiffFromFile };
          this.diffDraft(path);
          this.viewer!.updateItem({ ...original, annotations: this.annotations(path), edit: true, collapsed: false, version: (original.version ?? 0) + 1 });
        } else this.viewer!.updateItem({ ...original, edit: true, collapsed: false, version: (original.version ?? 0) + 1 });
        this.viewer!.scrollTo({ type: "item", id: path, align: "start" });

      } catch (error) {
        if (this.model) {
          await this.release(this.model.token);
          this.finish(false);
        }
        this.showError(error instanceof Error ? error.message : String(error));
        delete this.element.dataset.codeEditing;
      } finally {
        this.starting = false;
        this.renderAvailability();
      }
    }
    private changed(event: EditorChangeEvent<"file" | "file-diff", ChangesAnnotation, undefined>): void {
      if (!this.model) return;
      this.text = event.file.contents;
      const document = event.editor.getEditState()!.document;
      const { undoStack, redoStack } = document.history;
      const last = undoStack.at(-1), undone = redoStack.at(-1);
      const replay = (last && this.historyEntries.has(last)) || (undone && this.historyEntries.has(undone) && document.version === undone.versionBefore);
      const retained = replay ? this.history.get(document.version) : undefined;
      this.ranges = retained ? structuredClone(retained) : moveCommentRanges(this.ranges, event.changes);
      this.history.set(document.version, structuredClone(this.ranges));
      if (last) this.historyEntries.add(last);
      const versions = new Set([document.version, ...[...undoStack, ...redoStack].flatMap(entry => [entry.versionBefore, entry.versionAfter])]);
      for (const version of this.history.keys()) if (!versions.has(version)) this.history.delete(version);
      if (this.reverting && this.diffDraft(this.model.path)) {
        const path = this.model.path;
        // Pierre is still applying this change; replace the session's annotations once it has finished.
        queueMicrotask(() => {
          if (this.model?.path !== path) return;
          const item = this.viewer!.getItem(path)!;
          if (item.type === "diff") this.viewer!.updateItem({ ...item, annotations: this.annotations(path), version: (item.version ?? 0) + 1 });
        });
      }
      this.renderAvailability();
    }
    private renderAvailability(): void {
      this.element.querySelector<HTMLElement>(".changes-surface")!.inert = this.busy;
      for (const header of this.fileHeaderTargets) this.fileHeaderTargetConnected(header);
      for (const button of this.confirmationTarget.querySelectorAll<HTMLButtonElement>("button")) button.disabled = this.busy;
      if (!this.starting) this.statusTarget.textContent = this.busy ? "Saving…" : this.dirty ? "Unsaved edits" : "No unsaved edits";
      this.element.classList.toggle("changes-code-editing", Boolean(this.model || this.starting));
    }
    private finish(accept: boolean): void {
      this.accepted = accept;
      const item = this.viewer!.getItem(this.model!.path)!;
      if (item.type === "diff" && this.reverting) this.viewer!.updateItem({ ...item, annotations: this.reverting.comments, edit: false, version: (item.version ?? 0) + 1 });
      else this.viewer!.updateItem({ ...item, edit: false, version: (item.version ?? 0) + 1 });
      this.reverting = undefined;
      this.editor = undefined;
      delete this.element.dataset.codeEditing;
      this.model = undefined;
      this.history.clear();
      this.historyEntries = new WeakSet();
      this.renderAvailability();
    }
    private async release(token: string): Promise<void> {
      const data = new FormData(); data.set("token", token); await this.request("cancel", data);
    }
    async save(): Promise<boolean> {
      if (!this.model || this.busy || this.starting) return false;
      this.busy = true;
      this.renderAvailability();
      this.dialogErrorTarget.hidden = true;
      const shell = this.shell;
      const scroll = this.element.querySelector<HTMLElement>('[data-changes-target="viewer"]')!.scrollTop;
      // SAFETY: The viewer model is the server-rendered list of file IDs.
      const files = (JSON.parse(this.element.querySelector('script[data-changes-target="model"]')!.textContent!) as { files: { path: string }[] }).files;
      // The saved file stays open, including a previously unchanged file that now becomes a change.
      const collapsed = { ...Object.fromEntries(files.map(file => [file.path, this.viewer!.getItem(file.path)!.collapsed === true])), [this.model.path]: false };
      try {
        const data = new FormData();
        data.set("token", this.model.token); data.set("contents", this.text); data.set("ranges", JSON.stringify(this.ranges));
        data.set("history", shell.dataset.changesDiffEndpointsHistoryIdValue!);
        const html = await this.request("save", data);
        this.finish(true);
        this.confirmationTarget.close();
        // Transfer presentation only; all code, comments, counts and markup come from the server.
        shell.dataset.changesFileCollapse = JSON.stringify(collapsed);
        shell.dataset.changesScroll = String(scroll);
        window.Turbo!.renderStreamMessage(html);
        await new Promise(resolve => setTimeout(resolve, 0));
        return true;
      } catch (error) {
        this.showError(`Couldn’t save: ${error instanceof Error ? error.message : String(error)}`);
        console.error(error);
        return false;
      } finally { this.busy = false; if (this.element.isConnected) this.renderAvailability(); }
    }
    private revertible(path: string): boolean {
      // SAFETY: The viewer model is the server-rendered list of files and their revert availability.
      const files = (JSON.parse(this.element.querySelector('script[data-changes-target="model"]')!.textContent!) as { files: { path: string; revertible: boolean }[] }).files;
      return files.some(file => file.path === path && file.revertible);
    }
    /** Re-diffs the draft against the base; reports whether the revert buttons moved. */
    private diffDraft(path: string): boolean {
      const reverting = this.reverting!;
      reverting.diff = reverting.parse({ name: path, contents: reverting.base }, { name: path, contents: this.text }, { context: 3 });
      const signature = JSON.stringify(changeBlocks(reverting.diff).map(revertAnchor));
      if (signature === reverting.signature) return false;
      reverting.signature = signature;
      return true;
    }
    /** Comments keep their tracked positions; every hunk gets a revert button above it. */
    private annotations(path: string): DiffLineAnnotation<ChangesAnnotation>[] {
      const { comments, diff } = this.reverting!;
      const positions = new Map(this.ranges.map(range => [range.id, range]));
      const moved = comments.map(annotation => {
        const range = annotation.metadata.kind === "comment" && annotation.metadata.side === "additions" ? positions.get(annotation.metadata.id) : undefined;
        return range && annotation.metadata.kind === "comment" ? { ...annotation, lineNumber: range.end, metadata: { ...annotation.metadata, start: range.start, end: range.end } } : annotation;
      });
      return [...moved, ...changeBlocks(diff).map(block => ({ ...revertAnchor(block), metadata: { kind: "revert" as const, path, block: block.index } }))];
    }
    revertBlock(event: Event): void {
      if (!this.reverting || this.busy) return;
      // SAFETY: Revert buttons are cloned into annotations carrying their hunk index.
      const index = Number((event.currentTarget as HTMLElement).closest<HTMLElement>("[data-block]")!.dataset.block);
      const { diff } = this.reverting;
      this.editor!.applyEdits([revertBlockEdit(diff, changeBlocks(diff)[index]!)]);
      // The clicked button is replaced with the new hunks; keep typing and undo in the editor.
      this.editor!.focus({ preventScroll: true });
    }
    async copy(): Promise<void> {
      try { await copyTextToClipboard(this.text); this.statusTarget.textContent = "Copied edits"; }
      catch (error) { this.showError(`Couldn’t copy edits: ${error instanceof Error ? error.message : String(error)}`); }
    }
    discardFile(): void {
      if (this.starting || this.busy) return;
      this.continuation = () => this.refreshAfterDiscard();
      void this.discard();
    }
    private refreshAfterDiscard(): void {
      this.element.dispatchEvent(new CustomEvent("changes-edit:refresh", { bubbles: true }));
      window.KintsugiCable?.reconnect();
    }
    private guard(resume: () => void): void {
      if (this.starting || this.busy) return;
      if (!this.model) { resume(); return; }
      this.continuation = resume;
      if (!this.dirty) { void this.discard(); return; }
      this.dialogErrorTarget.hidden = true;
      this.confirmationTarget.showModal();
    }
    stay(event?: Event): void {
      event?.preventDefault();
      if (this.busy) return;
      this.continuation = undefined;
      this.confirmationTarget.close();
    }
    async discard(): Promise<void> {
      if (!this.model || this.busy) return;
      this.busy = true; this.renderAvailability();
      try {
        await this.release(this.model.token);
        this.finish(false);
        this.confirmationTarget.close();
        const resume = this.continuation; this.continuation = undefined;
        resume?.();
      } catch (error) { this.showError(error instanceof Error ? error.message : String(error)); }
      finally { this.busy = false; if (this.element.isConnected) this.renderAvailability(); }
    }
    async saveAndContinue(): Promise<void> {
      const resume = this.continuation;
      if (await this.save()) { this.continuation = undefined; resume?.(); }
    }
    private readonly guardRequested = (event: Event): void => {
      if (!this.model && !this.starting) return;
      event.preventDefault();
      // SAFETY: The endpoint controller owns this cancelable continuation event.
      const { resume } = (event as CustomEvent<{ resume(): void }>).detail;
      this.guard(resume);
    };
    private readonly shortcut = (event: KeyboardEvent): void => {
      const saveKey = event.key.toLowerCase() === "s" || event.key === "Enter";
      if (!this.model || !saveKey || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
      event.preventDefault(); event.stopImmediatePropagation(); void this.save();
    };
    private readonly beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!this.dirty && !this.busy) return;
      event.preventDefault(); event.returnValue = "";
    };
    private readonly beforeVisit = (event: Event): void => {
      if (!this.model) return;
      event.preventDefault();
      // SAFETY: Turbo before-visit events supply the browser destination in detail.url.
      const url = (event as CustomEvent<{ url: string }>).detail.url;
      this.guard(() => visit(url));
    };
    private readonly beforeWorkspaceSelection = (event: Event): void => {
      if (!this.model) return;
      event.preventDefault();
      // SAFETY: Workspace selection owns this continuation event.
      const resume = (event as CustomEvent<{ resume(): Promise<void> }>).detail.resume;
      this.guard(() => { void resume(); });
    };
    private readonly beforeSubmit = (event: Event): void => {
      if (!this.model || !(event.target instanceof HTMLFormElement)) return;
      const form = event.target;
      const url = new URL(form.action);
      const path = decodeURIComponent(url.pathname);
      const closesChanges = path.startsWith(`/workspaces/${this.workspaceIdValue}/work-views/`) && path.endsWith("/close") && path.includes('"type":"changes"');
      const leavesWorkspace = path.startsWith(`/workspaces/${this.workspaceIdValue}/`) && /\/(park|delete)$/.test(path);
      // Turbo submits commit links (`data-turbo-stream`) as forms; they replace this comparison.
      const opensCommitLink = path === `/workspaces/${this.workspaceIdValue}/changes/open`;
      if (!closesChanges && !leavesWorkspace && !opensCommitLink) return;
      event.preventDefault(); event.stopImmediatePropagation();
      // SAFETY: This listener handles native form submission events.
      const submitter = (event as SubmitEvent).submitter;
      this.guard(() => form.requestSubmit(submitter));
    };
    /** Whether rendering a stream into this target replaces the edit. Morphs keep permanent islands they still contain. */
    private replacedBy(stream: Stream, target: HTMLElement): boolean {
      if (target === this.element || this.element.contains(target)) return true;
      if (!target.contains(this.element)) return false;
      if (stream.getAttribute("method") !== "morph") return true;
      let island: HTMLElement | undefined;
      // The target contains the edit, so every ancestor up to it exists.
      for (let element = this.element.parentElement!; element !== target; element = element.parentElement!) if (element.id && element.hasAttribute("data-turbo-permanent")) island = element;
      return !island || !stream.templateElement.content.querySelector(`#${CSS.escape(island.id)}`);
    }
    private readonly preserve = (event: Event): void => {
      if (!this.model && !this.starting) return;
      // SAFETY: Both stream renderers expose the incoming Turbo stream and its targets.
      const stream = (event as CustomEvent<{ newStream: Stream }>).detail.newStream;
      if (!stream.targetElements.some(target => this.replacedBy(stream, target))) return;
      event.preventDefault();
      this.staleTarget.hidden = false;
    };
  };
}
