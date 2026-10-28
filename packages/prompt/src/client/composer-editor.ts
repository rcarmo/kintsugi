import { changeLayout, type ComposerQuote } from "@kintsugi/shared";

/** Height available above the arranged keyboard, or the full window when it is down. */
export function composerViewportHeight(): number {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return root.clientHeight - Number.parseFloat(style.getPropertyValue("--software-keyboard-inset") || "0")
    - Number.parseFloat(style.getPropertyValue("--software-keyboard-top") || "0");
}

/** Content-sized editing, bounded by the host's height budget and the controls' minimum. */
export function sizeComposer(composer: HTMLElement, maxComposer: number): void {
  const input = composer.querySelector<HTMLTextAreaElement>(".composer-input")!;
  if (!composer.checkVisibility()) return;
  const area = input.parentElement!;
  const buttons = area.querySelector<HTMLElement>(":scope > .composer-buttons")!;
  const promptTemplateButtons = area.querySelector<HTMLElement>(":scope > .composer-prompt-template-buttons");
  const height = (element: HTMLElement | null): number => element?.checkVisibility() ? element.getBoundingClientRect().height : 0;
  // Everything but the input area: thumbnails, status, footer.
  const chrome = composer.getBoundingClientRect().height - area.getBoundingClientRect().height;
  // Prompt template buttons make way as soon as there is something written.
  const hadText = composer.classList.contains("composer-has-text");
  const hasText = /\S/.test(input.value);
  const manuallySized = Number.parseFloat(composer.dataset.userHeight ?? "");
  const hadCompact = composer.classList.contains("composer-compact");
  const buttonStyle = getComputedStyle(buttons);
  const visibleButtons = [...buttons.children].filter((element) => element.checkVisibility());
  const columnHeight = visibleButtons.reduce((sum, element) => sum + element.getBoundingClientRect().height, 0)
    + Math.max(0, visibleButtons.length - 1) * Number.parseFloat(buttonStyle.gap)
    + Number.parseFloat(buttonStyle.paddingTop) + Number.parseFloat(buttonStyle.paddingBottom);
  const compact = Number.isFinite(manuallySized) && manuallySized < chrome + columnHeight;
  // Measure without letting the pane reflow: the input area keeps its size,
  // so the transcript above cannot clamp its scroll offset.
  const areaHeight = area.style.height;
  area.style.height = `${area.getBoundingClientRect().height}px`;
  const inline = input.style.height;
  composer.classList.toggle("composer-has-text", hasText);
  composer.classList.toggle("composer-compact", compact);
  input.style.height = "0px";
  const content = Math.ceil(input.scrollHeight);
  const floatingButtons = getComputedStyle(buttons).position === "absolute";
  const below = height(promptTemplateButtons) + (compact && !floatingButtons ? height(buttons) : 0);
  // Buttons beside the text set its minimum; compact controls take a row below it.
  const beside = compact || floatingButtons ? 0 : height(buttons);
  const minimum = Math.max(Number.parseFloat(getComputedStyle(input).minHeight) || 0, beside - below);
  const limit = Math.max(minimum, maxComposer - chrome - below);
  composer.classList.toggle("composer-has-text", hadText);
  composer.classList.toggle("composer-compact", hadCompact);
  input.style.height = inline;
  area.style.height = areaHeight;
  const desired = Number.isFinite(manuallySized) ? manuallySized - chrome - below : content;
  const next = Math.max(minimum, Math.min(desired, limit));
  const overflow = content > next ? "auto" : "hidden";
  const current = input.getBoundingClientRect().height;
  const inlineHeight = Number.parseFloat(input.style.height) || 0;
  if (hasText !== hadText || compact !== hadCompact || Math.abs(next - current) >= 0.5 || Math.abs(next - inlineHeight) >= 0.5 || input.style.overflowY !== overflow) {
    changeLayout(() => {
      composer.classList.toggle("composer-has-text", hasText);
      composer.classList.toggle("composer-compact", compact);
      input.style.height = `${next}px`;
      input.style.overflowY = overflow;
    });
  }
  const divider = composer.querySelector<HTMLElement>(".composer-divider");
  if (divider) {
    divider.setAttribute("aria-valuenow", String(Math.round(composer.getBoundingClientRect().height)));
    divider.setAttribute("aria-valuemin", String(Math.round(minimum + chrome + below)));
    divider.setAttribute("aria-valuemax", String(Math.round(limit + chrome + below)));
    divider.setAttribute("aria-valuetext", `${Math.round(composer.getBoundingClientRect().height)} pixels tall`);
  }
  revealComposerCaret(input);
}

/** Large pastes, history recall and dictation should leave the end caret visible. */
export function revealComposerCaret(input: HTMLTextAreaElement): void {
  if (document.activeElement === input && input.selectionEnd === input.value.length) input.scrollTop = input.scrollHeight;
}

/** Blank editor space is a typing target, but controls keep their native action. */
export function focusComposerText(composer: HTMLElement, event: MouseEvent): void {
  const input = composer.querySelector<HTMLTextAreaElement>(".composer-input")!;
  const target = event.target instanceof Element ? event.target : null;
  if (input.inert || !target || !composer.contains(target) || target === input) return;
  if (target.closest("button, a, input, select, textarea, label, summary, .composer-divider, .agent-chip, .composer-footer, .agent-completion-menu-host")) return;
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}

/** A selection as Markdown: a blockquote that says where it came from. Code keeps its fence. */
export function formatComposerQuote({ source, text, code }: ComposerQuote): string {
  // Code keeps the first line's indentation; prose loses stray surrounding whitespace.
  const body = code ? text.replace(/^(?:[ \t]*\n)+|\s+$/g, "") : text.trim();
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(run => run[0].length + 1)));
  const lines = code ? [fence, ...body.split("\n"), fence] : body.split("\n");
  return [`${source}:`, ...lines].map(line => line.trimEnd() ? `> ${line.trimEnd()}` : ">").join("\n");
}

/** Adds the quote and the start of its comment after the draft as one undoable edit, leaving the caret after them. */
export function appendComposerQuote(input: HTMLTextAreaElement, quote: ComposerQuote, comment: string): void {
  const draft = input.value;
  const separator = !draft || draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  input.focus({ preventScroll: true });
  input.setSelectionRange(draft.length, draft.length);
  // Native insertion keeps the undo stack and notifies input listeners, so drafts save as typed.
  if (!document.execCommand("insertText", false, `${separator}${formatComposerQuote(quote)}\n\n${comment}`)) throw new Error("Could not add the quote to the composer.");
}
