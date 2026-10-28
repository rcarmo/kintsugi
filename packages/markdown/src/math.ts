import type { MarkdownIt } from "markdown-it";
import { tex } from "@mdit/plugin-tex";
import { ParseError, renderToString } from "katex";
import { escapeHtml } from "@kintsugi/shared";

function renderMath(source: string, displayMode: boolean, raw: string): string {
  try {
    const html = renderToString(source, {
      displayMode,
      output: "htmlAndMathml",
      trust: false,
      throwOnError: true,
      strict: "ignore",
      maxExpand: 1000,
      maxSize: 20,
      macros: {},
    });
    return displayMode ? `<div class="markdown-math-display">${html}</div>\n` : html;
  } catch (error) {
    // Math is external input. Unsupported commands must not break a message.
    if (!(error instanceof ParseError)) throw error;
    return renderMathSource(raw);
  }
}

function renderMathSource(raw: string): string {
  return `<span class="markdown-math-source">${escapeHtml(raw)}</span>`;
}

/** Parse Markdown math on the server, regardless of which agent wrote it. */
export function installMath(markdown: MarkdownIt): void {
  markdown.use(tex, {
    delimiters: "all",
    allowInlineWithSpace: false,
    mathFence: false,
    render: (source: string, displayMode: boolean) => renderMath(source, displayMode, source),
  });

  // Pi also accepts display delimiters within prose. The upstream plugin only
  // handles those at block starts; keep this small adapter at the parsing seam.
  markdown.inline.ruler.before("math_inline_bracket", "math_inline_pi", (state, silent) => {
    const rest = state.src.slice(state.pos, state.posMax);
    const opening = rest.startsWith("$$") ? "$$" : rest.startsWith("\\[") ? "\\["
      : rest.startsWith("\\(") ? "\\(" : rest.startsWith("$") ? "$" : undefined;
    if (!opening) return false;
    const closing = opening === "\\[" ? "\\]" : opening === "\\(" ? "\\)" : opening;
    let end = rest.indexOf(closing, opening.length);
    while (end >= 0) {
      let backslashes = 0;
      for (let index = end - 1; index >= 0 && rest[index] === "\\"; index--) backslashes++;
      if (backslashes % 2 === 0) break;
      end = rest.indexOf(closing, end + closing.length);
    }
    if (end >= 0) {
      if (opening === "$" || opening === "\\(" || rest.slice(0, end).includes("\n")) return false;
      if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.markup = opening;
        token.content = rest.slice(opening.length, end);
      }
      state.pos += end + closing.length;
      return true;
    }
    const raw = rest.split("\n", 1)[0]!;
    // An unclosed dollar is ambiguous. Only a leading TeX command or script
    // identifies pending math; operators elsewhere may belong to Markdown or URLs.
    if (opening === "$" && (raw.includes("`")
      || /^\$[A-Za-z_][A-Za-z0-9_]*\//.test(raw)
      || !/^\$(?:\\[A-Za-z]+|[A-Za-z][A-Za-z0-9]*[_^])/.test(raw))) return false;
    if (!silent) {
      const token = state.push("math_pending", "span", 0);
      token.content = raw;
    }
    state.pos += raw.length;
    return true;
  });

  // The upstream dollar-block parser accepts EOF as a closer. Keep those
  // unfinished blocks literal, both during streaming and in saved messages.
  markdown.core.ruler.after("block", "math_source", (state) => {
    const lines = state.src.split("\n");
    for (const token of state.tokens) {
      if (token.type !== "math_block") continue;
      const [start, end] = token.map!;
      const raw = lines.slice(start, end).join("\n");
      token.meta = { raw };
      if (token.markup === "$$" && !(raw.trimEnd().endsWith("$$") && raw.lastIndexOf("$$") > raw.indexOf("$$"))) {
        token.type = "math_pending";
        token.content = raw;
      }
    }
  });
  markdown.renderer.rules.math_pending = (tokens, index) => renderMathSource(tokens[index]!.content);
  markdown.renderer.rules.math_block = (tokens, index) => {
    const token = tokens[index]!;
    return renderMath(token.content, true, String(token.meta!.raw));
  };
  markdown.renderer.rules.math_inline = (tokens, index) => {
    const token = tokens[index]!;
    const closing = token.markup === "\\(" ? "\\)" : token.markup === "\\[" ? "\\]" : token.markup;
    return renderMath(token.content, false, `${token.markup}${token.content}${closing}`);
  };
}
