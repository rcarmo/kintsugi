import { codeToTokens, isSupportedLanguage, type Lang } from "@pierre/highlights";
import { escapeHtml } from "@kintsugi/shared";
import { languageFromPath } from "./language.ts";
import { kintsugiTheme } from "./theme.ts";

export { languageFromPath } from "./language.ts";

// Canonical names for language classes; Highlights accepts these aliases but doesn't name them.
const aliases = new Map(Object.entries({
  ts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript", htm: "html", yml: "yaml",
  dockerfile: "docker", shell: "bash", sh: "bash", zsh: "bash", cs: "csharp", csx: "csharp", md: "markdown",
  py: "python", rb: "ruby", rs: "rust", tf: "terraform", protobuf: "proto",
  // Highlights has no ERB lexer; the surrounding HTML is the bulk of a template.
  erb: "html",
}));

const colorRole = /^var\(--syntax-([\w-]+)/;

export interface HighlightRequest { code: string; path?: string; language?: string }
export interface HighlightedCode { readonly html: string; readonly language?: string }

function resolveLanguage(language: string | undefined): Lang | undefined {
  const raw = language?.trim().toLowerCase();
  if (!raw) return undefined;
  const resolved = aliases.get(raw) ?? raw;
  return isSupportedLanguage(resolved) ? resolved : undefined;
}

/** Map Highlights tokens to stable syntax roles; colors are supplied by CSS. */
export function highlightCodeHtml(request: HighlightRequest): HighlightedCode {
  const language = resolveLanguage(request.language ?? languageFromPath(request.path));
  if (!language) return { html: escapeHtml(request.code) };
  const lines = codeToTokens(request.code, { lang: language, theme: kintsugiTheme }).tokens;
  const html = lines.map((tokens) => tokens.map((token, index) => {
    let escaped = escapeHtml(token.content);
    // The Markdown lexer emits task boxes as plain text after its list marker.
    const previous = tokens[index - 1];
    if (language === "markdown" && previous?.color === "var(--syntax-attribute)" && /^\s*(?:[-+*]|\d+[.)])\s+$/.test(previous.content)) {
      escaped = escaped.replace(/^\[([ xX-])\](?=\s|$)/, (box: string, state: string) => `<span class="syntax-${state === "-" ? "keyword" : state.toLowerCase() === "x" ? "string" : "attribute"}">${box}</span>`);
    }
    const role = token.color?.match(colorRole)?.[1];
    return role && role !== "foreground" ? `<span class="syntax-${role}">${escaped}</span>` : escaped;
  }).join("")).join("\n");
  return { html, language };
}

export function highlightCodeHtmlForPath(code: string, filePath?: string): HighlightedCode {
  return highlightCodeHtml({ code, path: filePath });
}
