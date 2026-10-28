import type { TerminalBufferRow } from "@gespenst/core";
import { fileReferencesIn, type WorkspaceFileTarget } from "@kintsugi/shared";

export type TerminalFileLink = WorkspaceFileTarget;
export interface TerminalWebLink { url: string }
export type TerminalLink = TerminalFileLink | TerminalWebLink;

function positive(value: string | null | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** OSC 8 destinations: local files, Kintsugi file links and web pages. Other schemes are never followed. */
export function terminalUri(uri: string): TerminalLink | undefined {
  let url: URL;
  try { url = new URL(uri); } catch { return undefined; }
  if (url.protocol === "http:" || url.protocol === "https:") return { url: url.href };
  const localFile = url.protocol === "file:" && (!url.hostname || url.hostname === "localhost");
  // Agents are told to write file links as kintsugi://file/<absolute path>.
  const kintsugiFile = url.protocol === "kintsugi:" && url.hostname === "file";
  if (!localFile && !kintsugiFile) return undefined;
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return undefined; }
  if (!path.startsWith("/") || path.includes("\0")) return undefined;
  // #L12C3 is a source position; any other anchor is a place in the page.
  const position = url.hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  const fragment = position ? undefined : url.hash.slice(1) || undefined;
  return { path, line: positive(url.searchParams.get("line")) ?? positive(position?.[1]), column: positive(url.searchParams.get("column")) ?? positive(position?.[2]), fragment };
}

// Trailing sentence punctuation and closing brackets belong to the prose, not the URL.
const webReference = /https?:\/\/[^\s<>"'`]+?(?=[.,;:!?)\]}'"`]*(?:$|[\s<>"'`]))/g;

export function terminalTextLinkAt(text: string, offset: number): TerminalLink | undefined {
  for (const match of text.matchAll(webReference)) {
    if (offset >= match.index && offset < match.index + match[0].length) return terminalUri(match[0]);
  }
  // OSC 8 is the unambiguous case; the open endpoint verifies that a plain-text reference names a file.
  for (const { start, end, ...link } of fileReferencesIn(text)) {
    if (offset >= start && offset < end) return link;
  }
  return undefined;
}

/** Resolve a screen cell to its OSC 8 destination, or a conservative visible URL or path. */
export function terminalLinkAt(row: TerminalBufferRow, column: number): TerminalLink | undefined {
  // Compute the string offset and inspect OSC 8 metadata in one pass. Cell
  // columns and JavaScript string offsets diverge for wide or Unicode text.
  let offset = 0;
  let nextColumn = 0;
  let uri: string | null | undefined;
  for (const cell of row.cells) {
    if (cell.x >= column) {
      if (cell.x === column) uri = cell.hyperlinkUri ?? uri;
      break;
    }
    offset += cell.x - nextColumn;
    if (cell.width !== "spacer-tail") offset += cell.text.length;
    nextColumn = cell.x + 1;
    if (cell.width === "wide" && cell.x + 1 === column) uri = cell.hyperlinkUri;
  }
  if (uri) return terminalUri(uri);
  return terminalTextLinkAt(row.text, offset + Math.max(0, column - nextColumn));
}
