import { agentComposerQuoteEvent, frameSelectionEvent, type AgentComposerQuoteDetail, type ComposerQuote, type FrameSelectionDetail, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { quotableSelection } from "@kintsugi/shared/text-selection";

interface PendingQuote {
  quote: ComposerQuote;
  transcript: HTMLElement;
  /** Selected in a visual; the page cannot see or clear that selection itself. */
  frame?: HTMLIFrameElement;
  rect(): DOMRect;
}

/** Distance from the transcript's edges. */
const inset = 8;
/** Distance below the selection. */
const offset = 4;

/** Where quoted text came from: its transcript item or visual, or the transcript when it spans several. */
function quoteSource(start: Element | null, end: Element | null): string {
  const source = start?.closest<HTMLElement>("[data-quote-source]");
  return source && source === end?.closest("[data-quote-source]") ? source.dataset.quoteSource! : "From the transcript";
}

/** Text selected on the page in a visible Agent transcript, without surrounding blank space. Code keeps its first line's indentation. */
export function transcriptSelectionText(): string | undefined {
  const selection = quotableSelection(document);
  if (!selection?.container.closest(".agent-transcript")?.checkVisibility()) return undefined;
  return selection.code ? selection.text.replace(/^(?:[ \t]*\n)+|\s+$/g, "") : selection.text.trim();
}

/** A typed character that should start a comment, not a shortcut, a space or a key in a field. */
function commentStart(event: KeyboardEvent): string | undefined {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return undefined;
  if ([...event.key].length !== 1 || !event.key.trim()) return undefined;
  if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input, textarea, select"))) return undefined;
  return event.key;
}

/**
 * A Comment button at the transcript's right edge, level with text selected in
 * the transcript, including inside visuals. Clicking it, or typing over a page
 * selection while the pane has focus, hands the selection to this pane's
 * composer as a quote.
 */
export function createTranscriptQuoteController(Controller: WorkspaceClientControllerConstructor) {
  return class TranscriptQuoteController extends Controller {
    static targets = ["action"];
    declare readonly element: HTMLElement;
    declare readonly actionTarget: HTMLElement;
    private pending?: PendingQuote;
    private pressing = false;
    private selectionFrame = 0;
    private positionFrame = 0;

    connect(): void {
      document.addEventListener("selectionchange", this.selectionChanged);
      this.element.addEventListener(frameSelectionEvent, this.frameSelected);
      this.element.addEventListener("keydown", this.typed);
      document.addEventListener("scroll", this.reposition, { capture: true, passive: true });
      window.addEventListener("resize", this.reposition);
    }

    disconnect(): void {
      document.removeEventListener("selectionchange", this.selectionChanged);
      this.element.removeEventListener(frameSelectionEvent, this.frameSelected);
      this.element.removeEventListener("keydown", this.typed);
      document.removeEventListener("scroll", this.reposition, { capture: true });
      window.removeEventListener("resize", this.reposition);
      cancelAnimationFrame(this.selectionFrame);
      cancelAnimationFrame(this.positionFrame);
      this.hide();
    }

    /** A tap can clear the page selection before its click lands; the quote stays until the press ends. */
    press(): void {
      this.pressing = true;
    }

    /** Releasing on the button itself is a click, which takes the quote; WebKit may deliver it a frame later. */
    release(event: PointerEvent): void {
      if (event.type === "pointerup" && event.target instanceof Node && this.actionTarget.contains(event.target)) return;
      this.pressing = false;
      this.selectionChanged();
    }

    /** Pressing with a mouse would clear the page selection. */
    keepSelection(event: MouseEvent): void {
      event.preventDefault();
    }

    quote(): void {
      this.send("");
    }

    /**
     * Typing over a selection on the page starts a comment, while its button shows.
     * Not in visuals: their replayed keys come from an untrusted sandbox that can fake them.
     */
    private typed = (event: KeyboardEvent): void => {
      if (!this.pending || this.pending.frame || this.actionTarget.hidden || event.target instanceof HTMLIFrameElement) return;
      const comment = commentStart(event);
      if (!comment) return;
      event.preventDefault();
      this.send(comment);
    };

    private send(comment: string): void {
      const { quote, frame } = this.pending!;
      this.pressing = false;
      this.hide();
      if (!frame) document.getSelection()!.removeAllRanges();
      this.element.dispatchEvent(new CustomEvent<AgentComposerQuoteDetail>(agentComposerQuoteEvent, { detail: { quote, comment } }));
    }

    private selectionChanged = (): void => {
      cancelAnimationFrame(this.selectionFrame);
      this.selectionFrame = requestAnimationFrame(() => {
        const selection = quotableSelection(document);
        const transcript = selection?.container.closest<HTMLElement>(".agent-transcript");
        if (selection && transcript && this.element.contains(transcript)) {
          const { range, text, code } = selection;
          const element = (node: Node) => node instanceof Element ? node : node.parentElement;
          const source = quoteSource(element(range.startContainer), element(range.endContainer));
          this.show({ quote: { source, text, code }, transcript, rect: () => range.getBoundingClientRect() });
        } else if (this.pending && !this.pending.frame && !this.pressing) this.hide();
      });
    };

    private frameSelected = (event: Event): void => {
      // SAFETY: Inline content dispatches this event from its frame, with this detail.
      const { target: frame, detail } = event as CustomEvent<FrameSelectionDetail> & { target: HTMLIFrameElement };
      const transcript = frame.closest<HTMLElement>(".agent-transcript");
      if (!transcript) return;
      if (!detail) {
        if (this.pending?.frame === frame && !this.pressing) this.hide();
        return;
      }
      // A visual's script can report any selection, so the user's selection on the page wins,
      // unless the visual has focus. Pressing into it leaves that selection highlighted.
      if (quotableSelection(document)) {
        if (document.activeElement !== frame) return;
        document.getSelection()!.removeAllRanges();
      }
      const { text, code, rect } = detail;
      this.show({
        quote: { source: quoteSource(frame, frame), text, code }, transcript, frame,
        rect: () => {
          const bounds = frame.getBoundingClientRect();
          return new DOMRect(bounds.left + rect.left, bounds.top + rect.top, rect.right - rect.left, rect.bottom - rect.top);
        },
      });
    };

    private show(pending: PendingQuote): void {
      this.pending = pending;
      this.position();
    }

    private hide(): void {
      this.pending = undefined;
      this.actionTarget.hidden = true;
    }

    private reposition = (): void => {
      if (!this.pending) return;
      cancelAnimationFrame(this.positionFrame);
      this.positionFrame = requestAnimationFrame(() => { if (this.pending) this.position(); });
    };

    /** At the transcript's right edge, just below the selection, kept inside the transcript. */
    private position(): void {
      const { transcript, rect } = this.pending!;
      const action = this.actionTarget;
      const selection = rect();
      const bounds = transcript.getBoundingClientRect();
      action.hidden = !transcript.checkVisibility() || selection.bottom <= bounds.top || selection.top >= bounds.bottom;
      if (action.hidden) return;
      const { width, height } = action.getBoundingClientRect();
      action.style.top = `${Math.max(Math.min(selection.bottom + offset, bounds.bottom - inset - height), bounds.top + inset)}px`;
      action.style.left = `${bounds.right - inset - width}px`;
    }
  };
}
