import type { MarkdownEmbedContext } from "@kintsugi/markdown";
import { escapeHtml } from "@kintsugi/shared";

export function renderInlineContentReference({ workspaceId, target, title, provisional }: MarkdownEmbedContext): string {
  let path: string;
  try {
    path = decodeURI(target);
  } catch {
    return escapeHtml(`inline-content:${target}`);
  }
  if (!path.startsWith("/") || path.includes("\0")) return escapeHtml(`inline-content:${target}`);
  if (provisional) return '<span role="status">Preparing visual explanation…</span>';

  const url = `/workspaces/${encodeURIComponent(workspaceId)}/inline-content?path=${encodeURIComponent(path)}`;
  const label = title || "Visual explanation";
  const source = `From the visual ${title ? `“${title}” ` : ""}(${path})`;
  return `<span role="group" aria-label="${escapeHtml(label)}" class="inline-content" data-controller="inline-content" data-inline-content-url-value="${escapeHtml(url)}" data-quote-source="${escapeHtml(source)}"><span data-inline-content-target="status" role="status">Loading visual explanation…</span><iframe title="${escapeHtml(label)}" sandbox="allow-scripts" referrerpolicy="no-referrer" data-inline-content-target="frame" data-action="load->inline-content#loaded" hidden></iframe></span>`;
}
