import { appendComposerQuote, composerViewportHeight, focusComposerText, sizeComposer } from "./composer-editor.ts";
import { changeLayout, focusLikelyOpensSoftwareKeyboard, isWorkspacePaneVisible, mobileComposerMediaQuery, type AgentComposerQuoteDetail, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";

/** The composer may grow to this share of the space above the keyboard (or of the window). */
const composerMaxShare = 0.4;
const longPressMs = 500;

/**
 * Composer visibility, height and draft indicator. Every change is applied in
 * one layout transaction so whatever sits above is pushed up in a single step.
 */
export function createAgentComposerController(Controller: WorkspaceClientControllerConstructor) {
  return class AgentComposerController extends Controller {
    static targets = ["opener"];
    static values = { openOnSelect: { type: Boolean, default: true }, openOnCreate: Boolean };
    declare readonly openOnSelectValue: boolean;
    declare readonly openOnCreateValue: boolean;
    declare readonly element: HTMLElement;
    declare readonly openerTarget: HTMLButtonElement;
    declare readonly hasOpenerTarget: boolean;
    private activeSelection = false;
    private pane!: HTMLElement;
    private longPress?: ReturnType<typeof setTimeout>;
    private suppressNextClick = false;
    private resizing?: { pointerId: number; y: number; height: number };

    connect(): void {
      this.pane = this.element.closest<HTMLElement>('[data-workspace-pane-role="agent"]')!;
      this.updateDraftIndicator();
      this.selected();
      this.autosize();
    }

    disconnect(): void {
      this.activeSelection = false;
      clearTimeout(this.longPress);
      this.resizing = undefined;
      this.blurInput();
    }

    private get composer(): HTMLElement | null {
      return this.element.querySelector<HTMLElement>(":scope > .composer");
    }

    private get input(): HTMLTextAreaElement | null {
      return this.element.querySelector<HTMLTextAreaElement>(":scope > .composer .composer-input");
    }

    private get isOpen(): boolean {
      return this.element.classList.contains("agent-composer-open");
    }

    private get mobile(): boolean {
      return window.matchMedia(mobileComposerMediaQuery).matches;
    }

    /** Programmatic focus cannot raise a soft keyboard, so touch devices wait for a tap. */
    private get focusesOnOpen(): boolean {
      return !this.mobile && !focusLikelyOpensSoftwareKeyboard();
    }

    private blurInput(): void {
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.composer?.contains(active)) active.blur();
    }

    private setOpen(open: boolean): void {
      if (open === this.isOpen) return;
      changeLayout(() => {
        if (!open) this.blurInput();
        this.element.classList.toggle("agent-composer-open", open);
        this.autosize();
      });
    }

    selected(event?: Event): void {
      if (event && event.target !== this.pane) return;
      if (!isWorkspacePaneVisible(this.element)) return;
      const created = this.pane.dataset.workspaceAgentCreated === "true";
      if (this.activeSelection && !created) return;
      this.activeSelection = true;
      const input = this.input;
      if (!input) return; // Ended CLI sessions are read-only.
      // Some agent types start ready to write, including on mobile.
      delete this.pane.dataset.workspaceAgentCreated;
      // Otherwise, reading comes first on mobile and in CLI views.
      this.setOpen((created && this.openOnCreateValue) || (this.openOnSelectValue && !this.mobile));
      if (focusLikelyOpensSoftwareKeyboard()) this.blurInput();
      else if (document.hasFocus()) {
        if (this.isOpen) input.focus({ preventScroll: true });
        else this.element.dispatchEvent(new Event("kintsugi:workspace-agent-focus"));
      }
    }

    hidden(event: Event): void {
      if (event.target !== this.pane) return;
      // Live-surface replacement briefly hides and re-shows the same pane.
      setTimeout(() => {
        if (this.element.isConnected && isWorkspacePaneVisible(this.element)) return;
        this.activeSelection = false;
        this.blurInput();
      }, 0);
    }

    reveal(): void {
      this.open();
    }

    open(): void {
      if (this.suppressNextClick) return;
      this.setOpen(true);
      if (this.focusesOnOpen) this.input!.focus({ preventScroll: true });
    }

    close(): void {
      this.setOpen(false);
    }

    /** Selected transcript text, to comment on: the composer opens with it and grows in one step. */
    quote(event: CustomEvent<AgentComposerQuoteDetail>): void {
      const input = this.input!;
      changeLayout(() => {
        this.setOpen(true);
        appendComposerQuote(input, event.detail.quote, event.detail.comment);
      });
    }

    /** A prompt was accepted for sending. On mobile the composer and keyboard go away at once. */
    sending(): void {
      if (this.mobile) this.close();
    }

    sent(): void {
      this.updateDraftIndicator();
      if (this.mobile) this.close();
    }

    /** Sending failed after the mobile composer closed: bring the draft and its error back. */
    failed(): void {
      if (this.mobile) this.setOpen(true);
    }

    focusText(event: MouseEvent): void {
      if (this.composer && this.input) focusComposerText(this.composer, event);
    }

    /** A focused terminal takes the space; the composer collapses and keeps its draft. */
    focused(event: FocusEvent): void {
      if (event.target instanceof Element && event.target.closest(".observable-terminal-host") && this.isOpen) this.close();
    }

    draftChanged(event: Event): void {
      if (event.target !== this.input) return;
      this.autosize();
      this.updateDraftIndicator();
    }

    /** The keyboard arrangement changed: the maximum height depends on the space above it. */
    layout(): void {
      this.autosize();
    }

    autosize(): void {
      const composer = this.composer;
      if (!composer || !this.input || !this.isOpen) return;
      sizeComposer(composer, Math.floor(composerViewportHeight() * (composer.dataset.userHeight ? 0.8 : composerMaxShare)));
    }

    resizeStart(event: PointerEvent): void {
      if (event.button !== 0) return;
      event.preventDefault();
      const divider = this.composer!.querySelector<HTMLElement>(".composer-divider")!;
      divider.focus({ preventScroll: true });
      divider.setPointerCapture(event.pointerId);
      this.resizing = { pointerId: event.pointerId, y: event.clientY, height: this.composer!.getBoundingClientRect().height };
    }

    resizeMove(event: PointerEvent): void {
      if (!this.resizing || event.pointerId !== this.resizing.pointerId) return;
      event.preventDefault();
      this.composer!.dataset.userHeight = String(this.resizing.height + this.resizing.y - event.clientY);
      this.autosize();
    }

    resizeEnd(): void {
      this.resizing = undefined;
    }

    resizeKey(event: KeyboardEvent): void {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const composer = this.composer!;
      composer.dataset.userHeight = String(composer.getBoundingClientRect().height + (event.key === "ArrowUp" ? 20 : -20));
      this.autosize();
    }

    private updateDraftIndicator(): void {
      if (!this.hasOpenerTarget) return;
      const input = this.input;
      const draft = Boolean(input?.value.trim() || this.composer?.querySelector(".agent-chip"));
      this.openerTarget.parentElement!.toggleAttribute("data-draft", draft);
    }

    // Holding open-composer opens it and starts dictation while the finger is still down.
    pressOpener(event: PointerEvent): void {
      if (event.button !== 0) return;
      clearTimeout(this.longPress);
      this.longPress = setTimeout(() => {
        this.longPress = undefined;
        this.suppressNextClick = true;
        this.setOpen(true);
        this.element.querySelector<HTMLButtonElement>(':scope > .composer [data-dictation-composer-target="button"]')!.click();
        // The release lands wherever the finger is now, possibly on a composer button.
        const swallow = (click: MouseEvent): void => { click.preventDefault(); click.stopImmediatePropagation(); };
        const release = (): void => {
          document.removeEventListener("pointerup", release, true);
          document.removeEventListener("pointercancel", release, true);
          document.addEventListener("click", swallow, true);
          setTimeout(() => {
            document.removeEventListener("click", swallow, true);
            this.suppressNextClick = false;
          }, 400);
        };
        document.addEventListener("pointerup", release, true);
        document.addEventListener("pointercancel", release, true);
      }, longPressMs);
    }

    releaseOpener(): void {
      clearTimeout(this.longPress);
      this.longPress = undefined;
    }

    suppressContextMenu(event: Event): void {
      event.preventDefault();
    }
  };
}
