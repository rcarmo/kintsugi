import { renderMarkdownEmbed } from "./embeds.ts";
import { copyButtonHtml } from "@kintsugi/design-system/copy-button";
import { buttonHtml } from "@kintsugi/design-system/button";
import MarkdownIt from "markdown-it";
import { installMath } from "./math.ts";
import { installDetails } from "./details.ts";
import { installCommitLinks } from "./commit-links.ts";
import type { Env, Token } from "markdown-it";
import { rendererRule } from "./renderer-rule.ts";
import { kintsugiFileHref, inlineCodeFileReference, workspaceFileImageSrc } from "./kintsugi-markdown.ts";
import { escapeHtml, isWorkspaceAppPort, isWorkspaceLoopbackHost, workspaceFileOpenUrl, workspacePortAppKey, workspaceProxyUrl } from "@kintsugi/shared";
import { renderMarkdownDiff } from "@kintsugi/syntax/markdown-diff";
import { highlightCodeHtml } from "@kintsugi/syntax";

export interface MarkdownRenderOptions {
  sourcePath?: string;
  frontmatter?: boolean;
  /** Opens linked files in this Files view instead of the workspace's preferred file viewer. */
  filesViewId?: string;
  /** Files that inline code file references (see `markdownFileReferenceCandidates`) may link to. */
  linkableFiles?: ReadonlySet<string>;
}

interface MarkdownEnvironment extends MarkdownRenderOptions, Env {
  workspaceId: string;
  provisional?: boolean;
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});
installMath(markdown);
installDetails(markdown);
installCommitLinks(markdown);
const defaultValidateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = (url) => /^file:\/\//i.test(url)
  ? kintsugiFileHref("", url) !== undefined
  : defaultValidateLink(url);

// Only explicit http(s) URLs: fuzzy matching would link file names like README.md.
markdown.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false, urlAuth: true });
markdown.linkify.add("ftp:", null).add("//", null).add("mailto:", null);

markdown.renderer.rules.table_open = () => '<div class="agent-table-scroll"><table>';
markdown.renderer.rules.table_close = () => "</table></div>";

markdown.renderer.rules.fence = rendererRule((tokens, index, _options, environment: MarkdownEnvironment) => {
  const token = tokens[index]!;
  const [language, ...filenameParts] = token.info.trim().split(/\s+/);
  const rawLang = language || undefined;
  const filenameInfo = filenameParts.join(" ") || undefined;
  const filenameMatch = filenameInfo?.match(/^filename=(?:"([^"]*)"|'([^']*)'|(\S+))$/);
  const filename = filenameMatch ? (filenameMatch[1] ?? filenameMatch[2] ?? filenameMatch[3]) : filenameInfo;
  const codeText = token.content.replace(/\n$/, "");
  if (rawLang?.toLowerCase() === "mermaid") return environment.provisional ? renderPendingMermaid(filename) : renderMermaid(codeText, filename);
  const isDiff = rawLang?.toLowerCase() === "diff";
  const code = isDiff ? renderMarkdownDiff(codeText, environment.provisional) : renderHighlightedFence(codeText, rawLang);
  const label = isDiff ? "Copy diff to clipboard" : rawLang ? `Copy ${rawLang} code to clipboard` : "Copy code to clipboard";
  const title = filename ?? (isDiff ? "Diff" : rawLang ? `${rawLang} code` : "Code");
  const headerClass = isDiff ? "markdown-diff-filename" : "agent-code-block-header";
  const header = filename ? `<div class="${headerClass}" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>` : "";
  const classes = `agent-code-block copy-region${isDiff ? " markdown-diff" : ""}`;
  const content = `${copyButtonHtml({ label, copyText: isDiff ? token.content : undefined })}${header}${code}`;
  return `<div class="${classes}" data-controller="kintsugi-fullscreen" data-kintsugi-fullscreen-mode-value="template" data-kintsugi-fullscreen-title-value="${escapeHtml(title)}">${content}<template data-kintsugi-fullscreen-target="content"><div class="${classes}">${content}</div></template></div>`;
});

function renderHighlightedFence(code: string, language?: string): string {
  const highlighted = highlightCodeHtml({ code, language });
  const attrs = [
    language ? `data-lang="${escapeHtml(language)}"` : "",
    highlighted.language ? `class="language-${escapeHtml(highlighted.language)}"` : "",
  ].filter(Boolean).join(" ");
  return `<pre${attrs ? ` ${attrs}` : ""}><code data-copy-source>${highlighted.html}</code></pre>`;
}

function mermaidDiagram(source: string, fullscreen = false): string {
  return `<div class="agent-mermaid-diagram${fullscreen ? " agent-mermaid-diagram-fullscreen" : ""}" data-controller="agent-mermaid" data-agent-mermaid-source-value="${escapeHtml(source)}"><div class="agent-mermaid-canvas" data-agent-mermaid-target="diagram" aria-busy="true"></div></div>`;
}

function renderMermaid(source: string, filename?: string): string {
  const title = filename ?? "Mermaid diagram";
  const header = filename ? `<div class="agent-media-frame-bar"><span>${escapeHtml(filename)}</span>${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Fullscreen" }, attributesHtml: 'data-action="kintsugi-fullscreen#open"' })}</div>` : "";
  return `<div class="agent-media-frame agent-mermaid" data-controller="kintsugi-fullscreen" data-kintsugi-fullscreen-mode-value="template" data-kintsugi-fullscreen-title-value="${escapeHtml(title)}">${header}${mermaidDiagram(source)}<template data-kintsugi-fullscreen-target="content">${mermaidDiagram(source, true)}</template></div>`;
}

function renderPendingMermaid(filename?: string): string {
  const header = filename ? `<div class="agent-media-frame-bar"><span>${escapeHtml(filename)}</span></div>` : "";
  return `<div class="agent-media-frame agent-mermaid">${header}<div class="agent-mermaid-diagram"><div class="agent-mermaid-canvas" aria-busy="true"></div></div></div>`;
}

const defaultLinkOpen = markdown.renderer.rules.link_open ?? ((tokens, index, options, _environment, renderer) => renderer.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = rendererRule((tokens, index, options, environment: MarkdownEnvironment, renderer) => {
  const token = tokens[index]!;
  const href = String(token.attrGet("href") ?? "");
  const fileHref = kintsugiFileHref(environment.workspaceId, href, environment.sourcePath, environment.filesViewId);
  if (fileHref) {
    token.attrSet("href", fileHref);
    token.attrSet("data-turbo-stream", "true");
    return defaultLinkOpen(tokens, index, options, environment, renderer);
  }

  const workspaceLocalHref = workspaceLocalPreviewHref(environment.workspaceId, href);
  if (workspaceLocalHref) token.attrSet("href", workspaceLocalHref);
  if (/^https?:\/\//i.test(href)) {
    token.attrSet("data-turbo", "false");
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, index, options, environment, renderer);
});

function insideLink(tokens: Token[], index: number): boolean {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor++) {
    if (tokens[cursor]!.type === "link_open") depth++;
    else if (tokens[cursor]!.type === "link_close") depth--;
  }
  return depth > 0;
}

const defaultCodeInline = markdown.renderer.rules.code_inline!;
markdown.renderer.rules.code_inline = rendererRule((tokens, index, options, environment: MarkdownEnvironment, renderer) => {
  const code = defaultCodeInline(tokens, index, options, environment, renderer);
  if (!environment.linkableFiles || insideLink(tokens, index)) return code;
  const reference = inlineCodeFileReference(tokens[index]!.content, environment.sourcePath);
  const path = reference?.candidates.find((candidate) => environment.linkableFiles!.has(candidate));
  if (!path) return code;
  const href = workspaceFileOpenUrl(environment.workspaceId, path, reference!, environment.filesViewId);
  return `<a class="markdown-file-reference" href="${escapeHtml(href)}" data-turbo-stream="true" title="${escapeHtml(path)}">${code}</a>`;
});

const defaultImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = rendererRule((tokens, index, options, environment: MarkdownEnvironment, renderer) => {
  const source = String(tokens[index]!.attrGet("src") ?? "");
  const embed = renderMarkdownEmbed(source, {
    workspaceId: environment.workspaceId,
    title: tokens[index]!.content,
    provisional: environment.provisional ?? false,
  });
  if (embed !== undefined) return embed;
  const src = workspaceFileImageSrc(environment.workspaceId, source, environment.sourcePath);
  if (src) {
    tokens[index]!.attrSet("src", src);
    tokens[index]!.attrJoin("class", "agent-media-img");
    tokens[index]!.attrSet("referrerpolicy", "no-referrer");
    tokens[index]!.attrSet("data-controller", "kintsugi-fullscreen");
    tokens[index]!.attrSet("data-kintsugi-fullscreen-mode-value", "media");
    tokens[index]!.attrSet("data-kintsugi-fullscreen-title-value", tokens[index]!.content || source.split(/[?#]/)[0]!.split("/").pop()!);
  }
  return defaultImage(tokens, index, options, environment, renderer);
});

function workspaceLocalPreviewHref(workspaceId: string, href: string): string | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  if (!isWorkspaceLoopbackHost(url.hostname)) return undefined;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!isWorkspaceAppPort(port) || url.protocol !== "http:") return undefined;
  return workspaceProxyUrl(workspaceId, workspacePortAppKey(port, url.hostname), `${url.pathname}${url.search}${url.hash}`);
}

function withoutFrontmatter(text: string): string {
  return text.replace(/^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");
}

/** Absolute paths that inline code in the document may refer to; check which exist before rendering. */
export function markdownFileReferenceCandidates(text: string, options: Pick<MarkdownRenderOptions, "sourcePath" | "frontmatter"> = {}): string[] {
  const source = options.frontmatter ? withoutFrontmatter(text) : text;
  const candidates = new Set<string>();
  for (const block of markdown.parse(source, { workspaceId: "" } satisfies MarkdownEnvironment)) {
    const children = block.children ?? [];
    children.forEach((token, index) => {
      if (token.type !== "code_inline" || insideLink(children, index)) return;
      for (const candidate of inlineCodeFileReference(token.content, options.sourcePath)?.candidates ?? []) candidates.add(candidate);
    });
  }
  return [...candidates];
}

export function renderMarkdown(workspaceId: string, text: string, options: MarkdownRenderOptions = {}): string {
  const source = options.frontmatter ? withoutFrontmatter(text) : text;
  return markdown.render(source, { workspaceId, ...options } satisfies MarkdownEnvironment).trim();
}

export function renderProvisionalMarkdown(workspaceId: string, text: string): string {
  return markdown.render(text, { workspaceId, provisional: true } satisfies MarkdownEnvironment).trim();
}
