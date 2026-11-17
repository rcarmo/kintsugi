import { PopupPosition } from "@kintsugi/design-system/popup/position";
import { notifyInputListeners, setTextInputValue, type WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@kintsugi/shared";
import { agentTreeOwnsMenu, fitAgentTreeMenu, agentTreeMenuIsUpdating, clearAgentTreeMenu } from "./session-tree.ts";

type HtmlAutocompleteRequest = { query: string; params?: Record<string, string>; debounceMs?: number };

type HtmlAutocompleteOptions = {
  optionSelector: string;
  request(input: HTMLInputElement | HTMLTextAreaElement, force?: boolean): HtmlAutocompleteRequest | undefined;
  loadHtml?(request: HtmlAutocompleteRequest, host: HTMLElement): string | Promise<string> | undefined;
  /** Return false when selection starts an interaction that owns the open menu. */
  select(option: HTMLElement, input: HTMLInputElement | HTMLTextAreaElement, url: string): boolean | void;
  keydown?(event: KeyboardEvent, input: HTMLInputElement | HTMLTextAreaElement, url: string, actions: HtmlAutocompleteActions): boolean;
  loadingHtml?: string;
  triggerKeysWhenClosed?: string[];
  /** Search only on an explicit button action or Enter, never on typing/caret movement. */
  explicitSearch?: boolean;
  fullscreenShortcut?(option: HTMLElement): boolean;
  /** Return true when an event inside the menu has been handled. */
  menuEvent?(event: Event, input: HTMLInputElement | HTMLTextAreaElement): boolean | void;
};

type HtmlAutocompleteActions = {
  readonly open: boolean;
  readonly hasOptions: boolean;
  activeOption(): HTMLElement | undefined;
  select(option: HTMLElement): void;
  setInputValue(value: string): void;
  close(): void;
  refresh(force?: boolean): void;
};

export function createHtmlAutocompleteController(Controller: StimulusControllerConstructor, autocomplete: HtmlAutocompleteOptions) {
  return class HtmlAutocompleteController extends Controller {
    static values = { url: String };
    static targets = ["input", "menu", "catalog"];
    declare readonly element: HTMLElement;
    declare readonly urlValue: string;
    declare readonly inputTarget: HTMLInputElement | HTMLTextAreaElement;
    declare readonly menuTarget: HTMLElement;
    private position: PopupPosition | undefined;
    private requestId = 0;
    private optionId = 0;
    private debounceTimer: number | undefined;
    private form: HTMLFormElement | null = null;
    private readonly treeResize = new ResizeObserver(()=>fitAgentTreeMenu(this.menuTarget));

    connect(): void {
      this.treeResize.observe(this.inputTarget);
      const pane = this.inputTarget.closest(".agent-pane");if (pane) this.treeResize.observe(pane);
      this.form = this.inputTarget.closest("form");
      if (this.menuTarget.hasAttribute("popover")) this.position = new PopupPosition(this.inputTarget, this.menuTarget);
      this.menuTarget.addEventListener("click", this.click);
      this.menuTarget.addEventListener("pointerdown", this.pointerdown);
      this.menuTarget.addEventListener("pointerover", this.pointerover);
      for (const type of ["input", "change", "keydown"]) this.menuTarget.addEventListener(type, this.menuEvent);
      this.inputTarget.addEventListener("blur", this.blur);
      this.menuTarget.addEventListener("focusout", this.menuFocusout);
      this.form?.addEventListener("submit", this.submitted);
      document.addEventListener("selectionchange", this.selectionchange);
    }

    disconnect(): void {
      this.treeResize.disconnect();
      this.close();
      this.position?.disconnect();
      this.menuTarget.removeEventListener("click", this.click);
      this.menuTarget.removeEventListener("pointerdown", this.pointerdown);
      this.menuTarget.removeEventListener("pointerover", this.pointerover);
      for (const type of ["input", "change", "keydown"]) this.menuTarget.removeEventListener(type, this.menuEvent);
      this.inputTarget.removeEventListener("blur", this.blur);
      this.menuTarget.removeEventListener("focusout", this.menuFocusout);
      this.form?.removeEventListener("submit", this.submitted);
      document.removeEventListener("selectionchange", this.selectionchange);
    }

    search(): void {
      this.inputTarget.focus();
      this.scheduleRefresh(true);
    }

    input(): void {
      if (autocomplete.explicitSearch) this.close();
      else this.scheduleRefresh();
    }

    keydown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing) return;
      if (autocomplete.keydown?.(event, this.inputTarget, this.urlValue, {
        open: !this.menuTarget.hidden,
        hasOptions: this.options().length > 0,
        activeOption: () => this.activeOption(),
        select: (option) => this.insert(option),
        setInputValue: (value) => setTextInputValue(this.inputTarget, value),
        close: () => this.close(),
        refresh: (force = false) => this.scheduleRefresh(force),
      })) return;
      if (autocomplete.explicitSearch && event.key === "Enter" && !event.isComposing && this.options().length === 0 && autocomplete.request(this.inputTarget, true)) {
        event.preventDefault();
        this.search();
        return;
      }
      if (this.menuTarget.hidden) {
        if (autocomplete.triggerKeysWhenClosed?.includes(event.key)) requestAnimationFrame(() => this.scheduleRefresh());
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.moveTo(event.key === "Home" ? 0 : this.options().length - 1);
        return;
      }
      if (event.key.toLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const active = this.activeOption();
        const fullscreen = active && autocomplete.fullscreenShortcut?.(active);
        if (!fullscreen) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        active.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true }));
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        const active = this.activeOption();
        if (!active) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.insert(active);
      }
    }

    private scheduleRefresh(force = false): void {
      window.clearTimeout(this.debounceTimer);
      this.requestId++;
      const request = autocomplete.request(this.inputTarget, force);
      if (!request) {
        this.close();
        return;
      }
      if (autocomplete.loadingHtml && this.menuTarget.hidden) {
        this.menuTarget.innerHTML = autocomplete.loadingHtml;
        this.show();
      }
      const debounceMs = force ? 0 : request.debounceMs ?? 0;
      if (debounceMs === 0) {
        void this.refresh(request);
        return;
      }
      this.debounceTimer = window.setTimeout(() => void this.refresh(request), debounceMs);
    }

    private readonly click = (event: Event): void => {
      if (autocomplete.menuEvent?.(event, this.inputTarget)) {
        event.preventDefault();
        return;
      }
      const option = this.optionFromEvent(event);
      if (!option) return;
      event.preventDefault();
      this.insert(option);
    };

    private readonly pointerdown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      if (autocomplete.menuEvent?.(event, this.inputTarget)) {
        event.preventDefault();
        return;
      }
      const option = this.optionFromEvent(event);
      if (!option) return;
      event.preventDefault();
      // WebKit cancels click after a prevented touch pointerdown, so select immediately.
      if (event.pointerType === "touch") this.insert(option);
    };

    private readonly pointerover = (event: Event): void => {
      const option = this.optionFromEvent(event);
      if (option && this.options().includes(option)) this.activate(option, false);
    };

    private optionFromEvent(event: Event): HTMLElement | null {
      return event.target instanceof Element ? event.target.closest<HTMLElement>(autocomplete.optionSelector) : null;
    }

    private readonly menuEvent = (event: Event): void => {
      autocomplete.menuEvent?.(event, this.inputTarget);
    };

    private readonly blur = (event: Event): void => {
      if (!(event instanceof FocusEvent)) throw new Error("Autocomplete blur handler received a non-focus event");
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && this.menuTarget.contains(relatedTarget)) return;
      this.close();
    };

    // A focusable menu (tabindex="-1") keeps focus while its text is selected, so it stays open until focus leaves both.
    private readonly menuFocusout = (event: FocusEvent): void => {
      if (agentTreeMenuIsUpdating(this.menuTarget)) return;
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && (relatedTarget === this.inputTarget || this.menuTarget.contains(relatedTarget))) return;
      this.close();
    };

    private readonly submitted = (): void => this.close();

    private readonly selectionchange = (): void => {
      if (autocomplete.explicitSearch) return;
      if (this.menuTarget.hidden || document.activeElement !== this.inputTarget || agentTreeOwnsMenu(this.menuTarget)) return;
      this.scheduleRefresh();
    };

    private async refresh(request: HtmlAutocompleteRequest): Promise<void> {
      const id = ++this.requestId;
      const url = new URL(this.urlValue, window.location.href);
      url.searchParams.set("q", request.query);
      for (const [name, value] of Object.entries(request.params ?? {})) url.searchParams.set(name, value);
      const html = await (autocomplete.loadHtml?.(request, this.element)
        ?? fetch(url, { headers: { Accept: "text/html" } }).then((response) => response.text()));
      if (id !== this.requestId) return;
      if (!html.trim()) {
        this.close();
        return;
      }
      this.menuTarget.innerHTML = html;
      this.show();
      const active = this.activeOption();
      if (active) this.activate(active, false);
    }

    private show(): void {
      this.menuTarget.hidden = false;
      if (this.position) this.menuTarget.showPopover();
    }

    protected close(): void {
      this.requestId++;
      window.clearTimeout(this.debounceTimer);
      if (this.position) this.menuTarget.hidePopover();
      this.menuTarget.hidden = true;
      this.inputTarget.removeAttribute("aria-activedescendant");
      clearAgentTreeMenu(this.menuTarget);
    }

    private options(): HTMLElement[] {
      return [...this.menuTarget.querySelectorAll<HTMLElement>(autocomplete.optionSelector)].filter((option) => option.getAttribute("role") === "option");
    }

    private activeOption(): HTMLElement | undefined {
      return this.options().find((option) => option.getAttribute("aria-selected") === "true") ?? this.options()[0];
    }

    private activate(option: HTMLElement, scroll = true): void {
      for (const candidate of this.options()) {
        const active = candidate === option;
        candidate.setAttribute("aria-selected", active ? "true" : "false");
      }
      option.id ||= `${this.element.id || "html-autocomplete"}-option-${++this.optionId}`;
      this.inputTarget.setAttribute("aria-activedescendant", option.id);
      if (scroll) option.scrollIntoView({ block: "nearest" });
    }

    private move(delta: number): void {
      const options = this.options();
      if (options.length === 0) return;
      const current = this.activeOption();
      const index = current ? options.indexOf(current) : 0;
      this.activate(options[(index + delta + options.length) % options.length]);
    }

    private moveTo(index: number): void {
      const options = this.options();
      const option = options[index];
      if (option) this.activate(option);
    }

    private insert(option: HTMLElement): void {
      if (autocomplete.select(option, this.inputTarget, this.urlValue) === false) return;
      notifyInputListeners(this.inputTarget);
      this.close();
    }
  };
}
