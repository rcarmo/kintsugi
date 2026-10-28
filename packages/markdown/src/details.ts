import type { MarkdownIt, StateBlock, StateCore, Token } from "markdown-it";
import { disclosureClosingHtml, disclosureOpeningHtml } from "@kintsugi/design-system/disclosure";

export const detailsOpeningPattern = /^<details(\s+open)?\s*>\s*(?:<summary>(.*?)<\/summary>)?\s*$/i;
const summaryPattern = /^<summary>(.*?)<\/summary>\s*$/i;
export const detailsClosingPattern = /^<\/details>\s*$/i;
const interrupts = { alt: ["paragraph", "reference", "blockquote", "list"] };

/**
 * GitHub-style `<details>` blocks become native disclosures, though other HTML stays escaped.
 * Opening and closing lines are parsed as separate blocks, so Markdown itself decides which
 * container, fence or list item each belongs to. Their tokens do not nest during parsing, so
 * an unclosed one cannot shift the levels of the tokens after it.
 */
export function installDetails(markdown: MarkdownIt): void {
  markdown.block.ruler.before("html_block", "details_open", (state, startLine, _endLine, silent) => {
    const opening = blockLine(state, startLine)?.match(detailsOpeningPattern);
    if (!opening) return false;
    if (silent) return true;

    let summary = opening[2];
    let nextLine = startLine + 1;
    if (summary === undefined) {
      let line = nextLine;
      while (line < state.lineMax && state.isEmpty(line)) line++;
      const match = line < state.lineMax && state.sCount[line]! >= state.blkIndent ? blockLine(state, line)?.match(summaryPattern) : undefined;
      if (match) {
        summary = match[1]!;
        nextLine = line + 1;
      }
    }

    const token = state.push("details_open", "details", 0);
    token.map = [startLine, nextLine];
    token.info = summary ?? "";
    if (opening[1] !== undefined) token.attrSet("open", "");
    state.line = nextLine;
    return true;
  }, interrupts);

  // A closing line with nothing to close stays ordinary text. One that closes an enclosing
  // container's disclosure still ends the paragraph before it, so that container can claim it.
  markdown.block.ruler.before("html_block", "details_close", (state, startLine, _endLine, silent) => {
    const text = blockLine(state, startLine);
    if (text === undefined || !detailsClosingPattern.test(text) || !hasOpenDetails(state, silent)) return false;
    if (silent) return true;
    state.push("details_close", "details", 0).map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }, interrupts);

  markdown.core.ruler.after("block", "details_implicit_close", closeAtContainerEnd);

  markdown.renderer.rules.details_open = (tokens, index) => {
    const token = tokens[index]!;
    return disclosureOpeningHtml({
      summary: { kind: "compact", tone: "muted", label: { kind: "text", text: plainText(markdown, token.info) } },
      open: token.attrGet("open") !== null,
    });
  };
  markdown.renderer.rules.details_close = () => `${disclosureClosingHtml}\n`;
}

/** A line's text without its container indentation, unless it is indented code. */
function blockLine(state: StateBlock, line: number): string | undefined {
  if (state.sCount[line]! - state.blkIndent >= 4) return undefined;
  return state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]);
}

/** Whether the current container, or optionally any enclosing one, has an open disclosure. */
function hasOpenDetails(state: StateBlock, includeEnclosing: boolean): boolean {
  let level = state.level;
  let closed = 0;
  for (let index = state.tokens.length - 1; index >= 0; index--) {
    const token = state.tokens[index]!;
    // Nested containers' tokens sit at deeper levels; a shallower token opens this container.
    if (token.level > level) continue;
    if (token.level < level) {
      if (!includeEnclosing) return false;
      level = token.level;
      closed = 0;
    }
    if (token.type === "details_close") closed++;
    else if (token.type === "details_open" && closed-- === 0) return true;
  }
  return false;
}

/** A disclosure still open when its container ends closes there, as one being streamed does. */
function closeAtContainerEnd(state: StateCore): void {
  const tokens: Token[] = [];
  const open: ("container" | "details")[] = [];
  const close = () => {
    open.pop();
    tokens.push(new state.Token("details_close", "details", 0));
  };
  for (const token of state.tokens) {
    if (token.type === "details_close") open.pop();
    else if (token.nesting === -1) {
      while (open.at(-1) === "details") close();
      open.pop();
    }
    tokens.push(token);
    if (token.type === "details_open") open.push("details");
    else if (token.nesting === 1) open.push("container");
  }
  while (open.length) close();
  state.tokens = tokens;
}

/** Disclosure summaries are plain-text labels, so inline Markdown contributes only its text. */
function plainText(markdown: MarkdownIt, source: string): string {
  const text = (tokens: Token[]): string => tokens.map(token => token.children ? text(token.children) : token.type === "text" || token.type === "code_inline" ? token.content : "").join("");
  return text(markdown.parseInline(source, {})).trim() || "Details";
}
