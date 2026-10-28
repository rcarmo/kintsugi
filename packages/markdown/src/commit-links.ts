import type { Env, MarkdownIt, Token } from "markdown-it";
import { rendererRule } from "./renderer-rule.ts";
import { changesCommitUrl, commitLinkPrefix, escapeHtml, isCommitHash, parseCommitLinkHref, shortCommit, type CommitLinkTarget } from "@kintsugi/shared";

const liveName = (endpoint: string) => endpoint === "working" ? "Uncommitted changes" : "Staged changes";
const hash = (endpoint: string) => `<code>${escapeHtml(shortCommit(endpoint))}</code>`;

/** What the link shows before (or instead of) its server-loaded label. */
function commitLinkContent({ base, target }: CommitLinkTarget): string {
  if (base === undefined) return isCommitHash(target) ? hash(target) : liveName(target);
  const hashes = [base, target].filter(isCommitHash);
  if (hashes.length === 2) return `${hash(base)}..${hash(target)}`;
  if (hashes.length === 0) return "Unstaged changes";
  // Ancestry puts the live snapshot last, whichever order the link names them in.
  return `${hash(hashes[0]!)}..${liveName(isCommitHash(base) ? target : base)}`;
}

function renderCommitLink(workspaceId: string, target: CommitLinkTarget): string {
  // Only commits have a subject or range size to look up; live snapshots are labelled by name.
  const loadsLabel = [target.base, target.target].every(endpoint => endpoint === undefined || isCommitHash(endpoint));
  const label = loadsLabel
    ? ` data-controller="commit-link" data-commit-link-url-value="${escapeHtml(changesCommitUrl(workspaceId, "commit-label", target))}" data-action="turbo:before-morph-element->commit-link#preserve"`
    : "";
  return `<a class="markdown-commit-link" href="${escapeHtml(changesCommitUrl(workspaceId, "open", target))}" data-turbo-stream="true"${label}>${commitLinkContent(target)}${loadsLabel ? '<span class="markdown-commit-link-label" data-commit-link-target="label"></span>' : ""}</a>`;
}

/**
 * `kintsugi://commit/…` links always show the commit itself; the
 * author's link text is dropped. Malformed commit links render as plain text.
 */
export function installCommitLinks(markdown: MarkdownIt): void {
  markdown.core.ruler.push("commit_links", state => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      const children: Token[] = [];
      for (let index = 0; index < block.children.length; index++) {
        const token = block.children[index]!;
        const href = token.type === "link_open" ? String(token.attrGet("href")!) : "";
        if (!href.startsWith(commitLinkPrefix)) { children.push(token); continue; }
        let close = index + 1;
        for (let depth = 1; ; close++) {
          const type = block.children[close]!.type;
          if (type === "link_open") depth++;
          if (type === "link_close" && --depth === 0) break;
        }
        if (parseCommitLinkHref(href)) {
          const link = new state.Token("commit_link", "", 0);
          link.content = href;
          children.push(link);
        } else children.push(...block.children.slice(index + 1, close));
        index = close;
      }
      block.children = children;
    }
  });
  markdown.renderer.rules.commit_link = rendererRule((tokens, index, _options, environment: Env & { workspaceId: string }) => renderCommitLink(environment.workspaceId, parseCommitLinkHref(tokens[index]!.content)!));
}
