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
  checklist?: { completed: number; total: number };
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});
installMath(markdown);
installDetails(markdown);
installCommitLinks(markdown);

const taskStates = new Map([
  ["pending", { label: "Pending", icon: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/>' }],
  ["in_progress", { label: "In progress", icon: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.5v11a5.5 5.5 0 0 0 0-11Z" fill="currentColor"/>' }],
  ["completed", { label: "Completed", icon: '<path d="m3.5 8 3 3 6-6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' }],
]);
markdown.core.ruler.before("inline", "kintsugi_task_list", state => {
  const { checklist }: MarkdownEnvironment = state.env;
  if (!checklist) return;
  const lists: { token: Token; items: number; tasks: number }[] = [];
  for (const [index, token] of state.tokens.entries()) {
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") lists.push({ token, items: 0, tasks: 0 });
    if (token.type === "bullet_list_close" || token.type === "ordered_list_close") {
      const list = lists.pop();
      if (list?.tasks && list.tasks === list.items) {
        list.token.attrSet("data-markdown-task-list", "");
        list.token.attrSet("role", "list");
      }
    }
    if (token.type !== "list_item_open") continue;
    const list = lists.at(-1);
    if (list) list.items++;
    const paragraph = state.tokens[index + 1], inline = state.tokens[index + 2];
    if (paragraph?.type !== "paragraph_open" || inline?.type !== "inline") continue;
    const marker = /^\[([ xX-])\](?:[ \t\n]+|$)/.exec(inline.content);
    if (!marker) continue;
    const status = marker[1] === " " ? "pending" : marker[1] === "-" ? "in_progress" : "completed";
    token.attrSet("data-markdown-task", status);
    inline.content = inline.content.slice(marker[0].length);
    if (list) list.tasks++;
    checklist.total++;
    if (status === "completed") checklist.completed++;
  }
});
markdown.renderer.rules.list_item_open = (tokens, index, options, _environment, renderer) => {
  const opening = renderer.renderToken(tokens, index, options);
  const task = taskStates.get(tokens[index]!.attrGet("data-markdown-task") ?? "");
  return task ? `${opening}<span class="markdown-task-icon" role="img" aria-label="${task.label}"><svg viewBox="0 0 16 16" aria-hidden="true">${task.icon}</svg></span>` : opening;
};

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

/** Render the complete document and count only actual Markdown task items. */
export function renderMarkdownChecklist(workspaceId: string, text: string) {
  const checklist = { completed: 0, total: 0 };
  const html = markdown.render(text, { workspaceId, checklist } satisfies MarkdownEnvironment).trim();
  return { html, ...checklist };
}

export function renderProvisionalMarkdown(workspaceId: string, text: string): string {
  return markdown.render(text, { workspaceId, provisional: true } satisfies MarkdownEnvironment).trim();
}

/** The same rendering as `renderProvisionalMarkdown`, as one element per top-level block, so a live
 * update can resend only the blocks that changed. Parsed as one document: references, list
 * looseness and math resolve as they do in the whole. Undefined when a block isn't one element. */
export function renderProvisionalMarkdownBlocks(workspaceId: string, text: string): string[] | undefined {
  const environment = { workspaceId, provisional: true } satisfies MarkdownEnvironment;
  const tokens = markdown.parse(text, environment);
  const blocks: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= tokens.length; index++) {
    const token = tokens[index];
    // Disclosures don't nest during parsing (see details.ts), but their tokens enclose a block.
    if (token) depth += token.type === "details_open" ? 1 : token.type === "details_close" ? -1 : token.nesting;
    if (token && depth !== 0) continue;
    const html = markdown.renderer.render(tokens.slice(start, index + 1), markdown.options, environment).trim();
    start = index + 1;
    if (!html) continue;
    if (!isSingleElement(html)) return undefined;
    blocks.push(html);
  }
  return blocks;
}

function isSingleElement(html: string): boolean {
  let depth = 0;
  let elements = 0;
  let text = false;
  new HTMLRewriter()
    .on("*", { element(element) {
      if (depth === 0) elements++;
      if (element.selfClosing || !element.canHaveContent) return;
      depth++;
      element.onEndTag(() => { depth--; });
    } })
    .onDocument({ text(chunk) { if (depth === 0 && chunk.text.trim()) text = true; } })
    .transform(html);
  return elements === 1 && !text;
}
