import { setContentRowLabel } from "@kintsugi/design-system/content-row/client";
import type { WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { resolveDiffEndpoints } from "../diff-endpoints.ts";
import { workingTree, historyGraph, diffEndpointsDescription, comparisonGraph, rowHeight, type DiffEndpoints, type HistoryGraph, type HistoryModel } from "../history.ts";

type ComparisonModel = { endpoints: DiffEndpoints; label: string; baseLabel: string; targetLabel: string };
const minimumHistoryHeight = 72;
const historyHeightStorageKey = "kintsugi:changes-history-height";

export function createDiffEndpointsController(Controller: WorkspaceClientControllerConstructor) {
  return class DiffEndpointsController extends Controller {
    declare readonly element: HTMLElement;
    static targets = ["diff", "trigger", "refresh", "picker", "loading", "error", "historyModel", "comparisonModel", "graph", "table", "row", "historyScroll", "more"];
    static values = { workspaceId: String, historyId: String, open: Boolean };
    declare readonly workspaceIdValue: string;
    declare readonly historyIdValue: string;
    declare readonly openValue: boolean;
    declare readonly diffTarget: HTMLElement;
    declare readonly triggerTarget: HTMLButtonElement;
    declare readonly refreshTarget: HTMLButtonElement;
    declare readonly pickerTarget: HTMLElement;
    declare readonly hasPickerTarget: boolean;
    declare readonly loadingTarget: HTMLElement;
    declare readonly errorTarget: HTMLElement;
    declare readonly graphTarget: SVGSVGElement;
    declare readonly tableTarget: HTMLTableElement;
    declare readonly rowTargets: HTMLTableRowElement[];
    declare readonly historyScrollTarget: HTMLElement;
    declare readonly moreTarget: HTMLButtonElement;
    declare readonly hasMoreTarget: boolean;
    private awaitingEnd = false;
    private secondCommitDeadline = 0;
    private secondCommitTimer?: ReturnType<typeof setTimeout>;
    private model?: HistoryModel;
    private graph?: HistoryGraph;
    private endpoints?: DiffEndpoints;
    private comparison?: ComparisonModel;
    private anchor?: string;
    private hoveredCommit?: string;
    private isOpen = false;
    private busy = false;
    private failed = false;
    private readonly client = crypto.randomUUID();
    private sequence = 0;
    private request?: AbortController;
    private paging?: AbortController;
    private resize?: ResizeObserver;
    private lastOperation: "compare" | "refresh" | "history" = "compare";

    connect(): void {
      const storedHeight = localStorage.getItem(historyHeightStorageKey);
      const parsedHeight = Number(storedHeight);
      if (storedHeight && Number.isFinite(parsedHeight)) this.setHistoryHeight(parsedHeight);
      this.resize = new ResizeObserver(() => this.measure());
      this.resize.observe(this.element);
      if (this.hasPickerTarget) {
        this.pickerTarget.hidden = !this.openValue;
        this.resize.observe(this.pickerTarget);
      }
      if (this.openValue) this.openPicker();
      this.measure();
    }
    disconnect(): void { this.request?.abort(); this.paging?.abort(); this.resize?.disconnect(); clearTimeout(this.secondCommitTimer); }

    historyModelTargetConnected(script: HTMLScriptElement): void {
      // SAFETY: This model is emitted by the Changes history renderer, not an external endpoint.
      this.model = JSON.parse(script.textContent!) as HistoryModel;
      this.graph = historyGraph(this.model.commits);
      this.endpoints ??= this.model.endpoints;
      this.anchor ??= this.endpoints.target;
      this.paint();
    }
    comparisonModelTargetConnected(script: HTMLScriptElement): void {
      // SAFETY: The comparison endpoint emits the applied endpoints alongside its server-rendered viewer.
      this.comparison = JSON.parse(script.textContent!) as ComparisonModel;
      this.endpoints ??= this.comparison.endpoints;
      if (this.model) this.paint();
      this.syncAvailability();
      queueMicrotask(() => { if (this.element.isConnected) this.measure(); });
    }
    preservePresentation(event: CustomEvent<{ newStream: { templateElement: HTMLTemplateElement } }>): void {
      for (const shell of event.detail.newStream.templateElement.content.querySelectorAll<HTMLElement>(".changes-body")) {
        if (shell.dataset.changesDiffEndpointsWorkspaceIdValue !== this.workspaceIdValue) continue;
        shell.dataset.changesDiffEndpointsOpenValue = String(this.isOpen);
        shell.dataset.changesLayout = this.element.dataset.changesLayout ?? "unified";
        shell.dataset.changesWrap = this.element.dataset.changesWrap ?? "false";
        // A saved code edit hands its file disclosure and scroll position to the refreshed Changes.
        if (this.element.dataset.changesFileCollapse !== undefined) shell.dataset.changesFileCollapse = this.element.dataset.changesFileCollapse;
        if (this.element.dataset.changesScroll !== undefined) shell.dataset.changesScroll = this.element.dataset.changesScroll;
      }
    }

    triggerTargetConnected(button: HTMLButtonElement): void { button.setAttribute("aria-expanded", String(this.isOpen || this.openValue)); }

    togglePicker(): void { if (this.isOpen) this.closePicker(); else this.openPicker(); }
    private openPicker(): void {
      if (!this.hasPickerTarget) return;
      this.isOpen = true;
      this.pickerTarget.hidden = false;
      this.triggerTarget.setAttribute("aria-expanded", "true");
      this.paint();
      this.syncAvailability();
      this.measure();
      const row = this.rowTargets.find(row => row.dataset.commit === this.endpoints!.target)!;
      row.focus({ preventScroll: true });
      if (this.endpoints!.target === workingTree) this.historyScrollTarget.scrollTop = 0;
      else row.scrollIntoView({ block: "nearest" });
    }
    closePicker(): void {
      if (!this.isOpen) return;
      this.clearHover();
      this.endSecondCommitSelection();
      this.isOpen = false;
      this.pickerTarget.hidden = true;
      this.triggerTarget.setAttribute("aria-expanded", "false");
      this.syncAvailability();
      this.measure();
      this.triggerTarget.focus();
    }
    escape(event: KeyboardEvent): void {
      if (!this.isOpen || this.element.querySelector(".popup-menu:popover-open")) return;
      event.preventDefault();
      event.stopPropagation();
      this.closePicker();
    }

    beginResize(event: PointerEvent): void {
      if (event.button !== 0) return;
      event.preventDefault();
      // SAFETY: Only the history resizer binds this action.
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }
    dragResize(event: PointerEvent): void {
      // SAFETY: Only the history resizer binds this action; capture ends with the drag.
      if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) this.setHistoryHeight(event.clientY - this.pickerTarget.getBoundingClientRect().top);
    }
    resizeWithKeyboard(event: KeyboardEvent): void {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? -1 : 1;
      this.setHistoryHeight(this.pickerTarget.getBoundingClientRect().height + direction * (event.shiftKey ? 80 : 24));
    }
    // The stylesheet keeps room for the comparison below.
    private setHistoryHeight(height: number): void {
      const clamped = Math.max(minimumHistoryHeight, Math.round(height));
      this.element.style.setProperty("--changes-history-height", `${clamped}px`);
      localStorage.setItem(historyHeightStorageKey, String(clamped));
    }

    private commitAt(element: Element, clientY: number): string | undefined {
      const dot = element.closest<SVGCircleElement>("[data-dot]");
      if (dot) return dot.dataset.dot;
      if (element.closest("[data-changes-diff-endpoints-target=graph]")) {
        return this.model!.commits[Math.floor((clientY - this.graphTarget.getBoundingClientRect().top) / rowHeight)]?.id;
      }
      return element.closest<HTMLElement>("[data-commit]")?.dataset.commit;
    }
    private choose(id: string, extend: boolean): void {
      if (!extend) this.anchor = id;
      const candidate: DiffEndpoints = !extend || id === this.anchor ? { target: id } : { target: id, base: this.anchor! };
      const selected = resolveDiffEndpoints(this.model!.topology, candidate, this.model!.commits.map(commit => commit.id));
      this.endpoints = candidate.base === undefined ? { target: selected.target } : { target: selected.target, base: selected.base };
      this.paint();
    }
    private endSecondCommitSelection(): void {
      clearTimeout(this.secondCommitTimer);
      this.secondCommitTimer = undefined;
      this.awaitingEnd = false;
      this.secondCommitDeadline = 0;
      if (this.model) this.paint();
    }
    private withEditGuard(resume: () => void): void {
      const editor = this.element.querySelector<HTMLElement>('[data-controller~="changes-edit"]');
      if (!editor || editor.dispatchEvent(new CustomEvent("changes-edit:guard", { cancelable: true, detail: { resume } }))) resume();
    }
    private selectCommit(id: string): void {
      this.withEditGuard(() => {
        const extend = this.awaitingEnd && performance.now() < this.secondCommitDeadline;
        this.endSecondCommitSelection();
        if (!extend) {
          this.awaitingEnd = true;
          this.secondCommitDeadline = performance.now() + 5000;
          this.secondCommitTimer = setTimeout(() => this.endSecondCommitSelection(), 5000);
        }
        this.choose(id, extend);
        void this.generate("compare");
      });

    }
    selectSnapshot(event: MouseEvent): void {
      if (event.button !== 0) return;
      // SAFETY: This action is attached to the native history table.
      const id = this.commitAt(event.target as Element, event.clientY);
      if (id) this.selectCommit(id);
    }

    navigate(event: KeyboardEvent): void {
      // SAFETY: Only history rows bind this action.
      const row = event.currentTarget as HTMLTableRowElement;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.selectCommit(row.dataset.commit!);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const index = this.rowTargets.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1);
        const next = this.rowTargets[index];
        if (!next) return;
        next.focus();
      }
    }
    hoverRow(event: PointerEvent): void {
      if (event.pointerType === "touch") { this.clearHover(); return; }
      const element = document.elementFromPoint(event.clientX, event.clientY);
      this.setHovered(element && this.tableTarget.contains(element) ? this.commitAt(element, event.clientY) : undefined);
    }
    clearHover(): void { this.setHovered(undefined); }
    private setHovered(id: string | undefined): void {
      if (id === this.hoveredCommit) return;
      this.hoveredCommit = id;
      for (const row of this.rowTargets) row.dataset.hovered = String(row.dataset.commit === id);
      for (const rect of this.graphTarget.querySelectorAll<SVGRectElement>(".changes-history-row-background")) rect.dataset.hovered = String(rect.dataset.commit === id);
    }

    private paint(): void {
      const model = this.model!, endpoints = this.endpoints!, graph = this.graph!;
      const selected = comparisonGraph(graph, endpoints, model.topology);
      for (const rect of this.graphTarget.querySelectorAll<SVGRectElement>(".changes-history-row-background")) {
        rect.dataset.path = String(selected.selectedRows.includes(rect.dataset.commit!));
        rect.dataset.hovered = String(rect.dataset.commit === this.hoveredCommit);
      }
      const focused = this.rowTargets.find(row => row === document.activeElement);
      for (const row of this.rowTargets) {
        row.tabIndex = focused ? row === focused ? 0 : -1 : row.dataset.commit === endpoints.target ? 0 : -1;
        const id = row.dataset.commit!;
        row.dataset.path = String(selected.selectedRows.includes(id));
        row.dataset.hovered = String(id === this.hoveredCommit);
        row.setAttribute("aria-selected", row.dataset.path);
      }
      for (const dot of this.graphTarget.querySelectorAll<SVGCircleElement>("[data-dot]")) {
        const id = dot.dataset.dot!, endpoint = id === selected.target;
        const color = selected.path.includes(id) || endpoint ? "var(--accent)" : `var(--changes-branch-${dot.dataset.color})`;
        dot.setAttribute("r", endpoint ? "6" : "3.5");
        dot.setAttribute("stroke", color);
        dot.setAttribute("stroke-width", endpoint ? "2" : "1.5");
        dot.setAttribute("fill", endpoint || dot.dataset.ahead === "true" ? color : "var(--panel)");
      }
      for (const path of this.graphTarget.querySelectorAll<SVGPathElement>("[data-selected-backbone],[data-selected-beads]")) path.setAttribute("d", selected.route);
      const applied = this.comparison?.endpoints.target === endpoints.target && this.comparison.endpoints.base === endpoints.base;
      const description = applied ? this.comparison!.label : diffEndpointsDescription(model, selected);
      setContentRowLabel(this.triggerTarget, this.awaitingEnd ? "Select a second commit for a custom range" : description);
      this.element.style.setProperty("--changes-history-rows", String(model.commits.length));
      this.element.style.setProperty("--changes-history-chrome", this.hasMoreTarget ? "var(--changes-history-more-height)" : "0px");
    }
    private measure(): void {
      const toolbar = this.diffTarget.querySelector<HTMLElement>(".changes-toolbar")!;
      const top = toolbar.getBoundingClientRect().bottom - this.element.getBoundingClientRect().top;
      this.element.style.setProperty("--changes-comparison-top", `${top}px`);
    }
    private syncAvailability(): void {
      this.element.classList.toggle("changes-busy", this.busy);
      this.element.classList.toggle("changes-failed", this.failed);
      this.loadingTarget.hidden = !this.busy;
      this.refreshTarget.disabled = this.busy;
      this.diffTarget.setAttribute("aria-busy", String(this.busy));
      if (this.hasPickerTarget) {
        const refreshing = this.busy && this.lastOperation === "refresh";
        this.historyScrollTarget.inert = refreshing;
      }
      for (const element of this.diffTarget.querySelectorAll<HTMLElement>(".changes-surface,.changes-empty")) element.inert = this.busy || this.failed;
      for (const element of this.diffTarget.querySelectorAll<HTMLElement>(".changes-controls")) element.inert = this.busy;
    }

    refresh(): void { this.withEditGuard(() => { void this.generate("refresh"); }); }
    /** Showing Changes refreshes it, but never asks to leave an open code edit; saving or discarding refreshes then. */
    refreshWhenShown(): void { if (!this.element.querySelector("[data-code-editing]")) void this.generate("refresh", true); }
    retry(): void {
      const operation = this.lastOperation;
      if (operation === "history") void this.loadMore();
      else this.withEditGuard(() => { void this.generate(operation); });
    }
    dismissError(): void { this.errorTarget.hidden = true; }
    /** `shown`: Changes refreshes because it was shown, not because you asked; see the refresh route. */
    private async generate(operation: "compare" | "refresh", shown = false): Promise<void> {
      this.request?.abort();
      if (operation === "refresh") {
        this.endSecondCommitSelection();
        this.paging?.abort();
      }
      const request = this.request = new AbortController();
      this.lastOperation = operation;
      this.busy = true;
      this.failed = false;
      this.errorTarget.hidden = true;
      this.syncAvailability();
      const data = new FormData();
      data.set("history", this.historyIdValue);
      data.set("client", this.client);
      data.set("sequence", String(++this.sequence));
      // Keep the existing comparison request fields at the HTTP boundary.
      data.set("end", this.endpoints!.target);
      if (this.endpoints!.base !== undefined) data.set("start", this.endpoints!.base ?? "");
      data.set("pickerOpen", String(this.isOpen));
      if (shown) data.set("shown", "true");
      try {
        const result = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/changes/${operation}`, { method: "POST", body: data, signal: request.signal, headers: { Accept: "text/vnd.turbo-stream.html" } });
        const html = await result.text();
        if (request.signal.aborted) return;
        // A later selection, maybe from another browser, superseded this one. Point the history back at the shown comparison.
        if (result.status === 204) {
          this.endpoints = this.comparison!.endpoints;
          this.anchor = this.endpoints.target;
          this.paint();
          return;
        }
        const contentType = result.headers.get("Content-Type") ?? "";
        // Only plain-text bodies are readable messages; an HTML error page would show up as markup.
        if (!contentType.includes("text/vnd.turbo-stream.html")) throw new Error(contentType.startsWith("text/plain") && html ? html : `The server responded with ${result.status}.`);
        this.failed = !result.ok;
        window.Turbo!.renderStreamMessage(html);
        // Turbo inserts the stream synchronously; rendering its targets occurs in the next task.
        await new Promise(resolve => setTimeout(resolve, 0));
      } catch (error) {
        if (request.signal.aborted) return;
        this.failed = true;
        this.errorTarget.hidden = false;
        this.errorTarget.querySelector("span")!.textContent = `Couldn’t generate this comparison: ${error instanceof Error ? error.message : String(error)}`;
        console.error(error);
      } finally {
        if (!request.signal.aborted) { this.busy = false; this.syncAvailability(); }
      }
    }
    async loadMore(): Promise<void> {
      this.lastOperation = "history";
      this.errorTarget.hidden = true;
      this.moreTarget.disabled = true;
      const request = this.paging = new AbortController();
      const skip = this.model!.commits.filter(commit => commit.kind === "commit").length;
      try {
        const query = new URLSearchParams({ history: this.historyIdValue, skip: String(skip) });
        const result = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/changes/history?${query}`, { signal: request.signal, headers: { Accept: "text/vnd.turbo-stream.html" } });
        const html = await result.text();
        if (request.signal.aborted) return;
        // This history is outdated: an open code edit kept a refresh out. Refresh; it shows the first page of the new history.
        if (result.status === 409) {
          this.moreTarget.disabled = false;
          this.refresh();
          return;
        }
        if (!result.ok) throw new Error(html);
        window.Turbo!.renderStreamMessage(html);
      } catch (error) {
        if (request.signal.aborted) return;
        this.errorTarget.hidden = false;
        this.errorTarget.querySelector("span")!.textContent = `Couldn’t load history: ${error instanceof Error ? error.message : String(error)}`;
        this.moreTarget.disabled = false;
        console.error(error);
      }
    }
  };
}
