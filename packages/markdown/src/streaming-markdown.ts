import { detailsClosingPattern, detailsOpeningPattern } from "./details.ts";
import { renderMarkdown, renderProvisionalMarkdown, renderProvisionalMarkdownBlocks } from "./markdown.ts";

interface Fence {
  marker: "`" | "~";
  size: number;
}

export interface StreamingMarkdownSnapshot {
  stableHtml: string;
  tailHtml: string;
}

export interface StreamingMarkdownUpdate {
  stableBoundary: number;
  stableHtmlAddition: string;
  tailHtml: string;
  /** The tail as one element per top-level block, when it renders that way; `tailHtml` joins them. */
  tailBlocks?: string[];
}

/**
 * Finds completed top-level blocks that can be rendered independently. This is
 * intentionally more conservative than a Markdown parser: lists, quotes,
 * indented blocks, tables, and potential reference links/definitions remain
 * mutable until the message is finalized. Boundaries index the original source.
 */
export function streamingMarkdownStableBoundary(source: string): number {
  let boundary = 0;
  let fence: Fence | undefined;
  let math: "$$" | "\\[" | undefined;
  let details = 0;
  const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
  let offset = 0;

  for (const lineWithEnding of lines) {
    const terminated = /[\r\n]$/.test(lineWithEnding);
    const line = lineWithEnding.replace(/(?:\r\n|\r|\n)$/, "");
    const lineStart = offset;
    offset += lineWithEnding.length;
    if (math) math = nextDisplayMath(math, line);
    else {
      const wasInFence = fence !== undefined;
      fence = nextFence(fence, line);
      if (!wasInFence && !fence) {
        // Container contents stay mutable until the message is finalized, and so does everything
        // after them. Stopping here also keeps nested `<details>` lines out of the count below.
        if (containerLinePattern.test(line)) return boundary;
        math = nextDisplayMath(undefined, line);
        details = nextDetailsDepth(details, line);
      }
    }

    // A trailing space may become an indented continuation, not a blank line.
    // Wait on a final CR as well: the next delta may complete a CRLF pair.
    if (!terminated || (lineWithEnding.endsWith("\r") && offset === source.length)) continue;
    if (!/^[ \t]*$/.test(line) || fence || math || details) continue;
    const candidate = source.slice(boundary, lineStart);
    if (isIndependentCompletedBlock(candidate)) boundary = offset;
  }
  return boundary;
}

/** List items, quotes and indented code. */
const containerLinePattern = /^(?: {4}|\t| {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)| {0,3}>)/;

/**
 * A disclosure's contents render inside it, so an open top-level `<details>` keeps its blocks
 * mutable. Like an unclosed fence, one that never closes stays mutable to the end.
 */
function nextDetailsDepth(depth: number, line: string): number {
  const text = line.match(/^ {0,3}(<.*)$/)?.[1];
  if (text === undefined) return depth;
  if (detailsOpeningPattern.test(text)) return depth + 1;
  if (depth && detailsClosingPattern.test(text)) return depth - 1;
  return depth;
}

function nextDisplayMath(open: "$$" | "\\[" | undefined, line: string): "$$" | "\\[" | undefined {
  if (open) return line.trimEnd().endsWith(open === "$$" ? "$$" : "\\]") ? undefined : open;
  const match = line.match(/^ {0,3}(\$\$|\\\[)(.*)$/);
  if (!match) return undefined;
  const marker = match[1] === "$$" ? "$$" : "\\[";
  return match[2]!.trimEnd().endsWith(marker === "$$" ? "$$" : "\\]") ? undefined : marker;
}

function hasOpenDisplayMath(source: string): boolean {
  let math: "$$" | "\\[" | undefined;
  let fence: Fence | undefined;
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (math) math = nextDisplayMath(math, line);
    else {
      const wasInFence = fence !== undefined;
      fence = nextFence(fence, line);
      if (!wasInFence && !fence) math = nextDisplayMath(undefined, line);
    }
  }
  return math !== undefined;
}

function nextFence(open: Fence | undefined, line: string): Fence | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})([\s\S]*)$/);
  if (!match) return open;
  const marker = match[1]![0];
  if (marker !== "`" && marker !== "~") throw new Error("fence pattern matched an unsupported marker");
  if (!open) {
    // Backticks are forbidden in backtick-fence info, but legal for tilde fences.
    if (marker === "`" && match[2]!.includes("`")) return undefined;
    return { marker, size: match[1]!.length };
  }
  const closes = marker === open.marker && match[1]!.length >= open.size && /^[ \t]*$/.test(match[2]!);
  return closes ? undefined : open;
}

function openFence(text: string): Fence | undefined {
  let open: Fence | undefined;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) open = nextFence(open, line);
  return open;
}

function isIndependentCompletedBlock(block: string): boolean {
  if (/^[ \t\r\n]*$/.test(block)) return false;
  let fence: Fence | undefined;
  let math: "$$" | "\\[" | undefined;
  const outsideFenceLines: string[] = [];
  for (const line of block.replace(/\r\n?/g, "\n").split("\n")) {
    if (math) { math = nextDisplayMath(math, line); continue; }
    const wasInFence = fence !== undefined;
    fence = nextFence(fence, line);
    if (!wasInFence && !fence) {
      math = nextDisplayMath(undefined, line);
      // Contents of math blocks have no Markdown reference/list semantics.
      if (!/^ {0,3}(\$\$|\\\[)/.test(line)) outsideFenceLines.push(line);
    }
  }
  if (fence || math) return false;
  // Reference links (including shortcut links) can depend on definitions anywhere
  // in the document. Keep the first bracket-bearing block and all subsequent
  // blocks together in the mutable tail, preserving one Markdown environment.
  // Deliberately conservative for literal brackets and inline links; fenced code
  // has no reference semantics and can still be committed independently.
  if (outsideFenceLines.some((line) => line.includes("["))) return false;
  return !outsideFenceLines.some((line, index) => index > 0 && /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line));
}

/** Make only a temporary parsing copy of an incomplete mutable tail. */
export function repairStreamingMarkdownTail(tail: string): string {
  // Markdown already closes fenced blocks at EOF, including inside containers.
  // A synthetic unindented closer can instead open a new root-level code block.
  // Leave open code untouched, including by the inline repairs below.
  if (openFence(tail) || hasOpenDisplayMath(tail)) return tail;

  // Do not invent Markdown closers inside a partially emitted equation. Keeping
  // math-bearing lines literal is safer than provisional emphasis/link repair.
  const lastLine = tail.slice(tail.lastIndexOf("\n") + 1);
  if (/(?:\$|\\[([])/.test(lastLine)) return tail;

  let repaired = tail;
  const dangling = repaired.match(/(!?)\[([^\]\n]*)\]\(([^)\s]*)$/);
  if (dangling?.[1]) {
    const start = dangling.index!;
    repaired = `${repaired.slice(0, start)}\\!${repaired.slice(start + 1)}`;
  } else if (dangling && /^(?:https?:\/\/|kintsugi:\/\/)/.test(dangling[3]!)) {
    repaired += ")";
  } else if (/!\[[^\]\n]*$/.test(repaired)) {
    const start = repaired.lastIndexOf("![");
    repaired = `${repaired.slice(0, start)}\\!${repaired.slice(start + 1)}`;
  }

  // An unmatched backtick is already rendered as text. Closing it could turn a
  // large suffix into inline code, so do not apply emphasis repairs either.
  if (hasUnmatchedInlineBacktick(repaired)) return repaired;
  const line = repaired.slice(repaired.lastIndexOf("\n") + 1);
  if (/(?:^|[^\\*])\*\*([^*\n\s][^*\n]*)$/.test(line)) return `${repaired}**`;
  if (/(?:^|[^\\*])\*([^*\n\s][^*\n]*)$/.test(line)) return `${repaired}*`;
  return repaired;
}

function hasUnmatchedInlineBacktick(text: string): boolean {
  let openingSize = 0;
  for (let index = 0; index < text.length;) {
    // Backslashes escape backticks in prose, but are literal inside code spans.
    if (!openingSize && text[index] === "\\") { index += 2; continue; }
    if (text[index] !== "`") { index++; continue; }
    const start = index;
    while (text[index] === "`") index++;
    const size = index - start;
    if (!openingSize) openingSize = size;
    else if (size === openingSize) openingSize = 0;
  }
  return openingSize !== 0;
}

export function renderStreamingMarkdownSnapshot(workspaceId: string, source: string): StreamingMarkdownSnapshot {
  const stableBoundary = streamingMarkdownStableBoundary(source);
  return {
    stableHtml: renderMarkdown(workspaceId, source.slice(0, stableBoundary)),
    tailHtml: renderProvisionalMarkdown(workspaceId, repairStreamingMarkdownTail(source.slice(stableBoundary))),
  };
}

/** Bounded state belonging to one append-only live transcript item. */
export class StreamingMarkdownRenderer {
  private stableBoundary = 0;

  constructor(private readonly workspaceId: string) {}

  render(source: string): StreamingMarkdownUpdate {
    const previousBoundary = this.stableBoundary;
    this.stableBoundary = Math.max(previousBoundary, streamingMarkdownStableBoundary(source));
    const tail = repairStreamingMarkdownTail(source.slice(this.stableBoundary));
    const tailBlocks = renderProvisionalMarkdownBlocks(this.workspaceId, tail);
    return {
      stableBoundary: this.stableBoundary,
      stableHtmlAddition: renderMarkdown(this.workspaceId, source.slice(previousBoundary, this.stableBoundary)),
      tailHtml: tailBlocks ? tailBlocks.join("") : renderProvisionalMarkdown(this.workspaceId, tail),
      tailBlocks,
    };
  }

}
