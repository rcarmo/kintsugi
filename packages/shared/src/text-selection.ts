/// <reference lib="dom" />

export interface QuotableSelection {
  range: Range;
  text: string;
  code: boolean;
  /** The closest element holding the whole selection. */
  container: Element;
}

/** A document's selection, when it is worth quoting: not blank and not inside a form field. */
export function quotableSelection(document: Document): QuotableSelection | undefined {
  const selection = document.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const container = common instanceof Element ? common : common.parentElement;
  const text = selection.toString();
  if (!text.trim() || !container || container.closest("input, textarea, select")) return undefined;
  return { range, text, code: Boolean(container.closest("pre")), container };
}
