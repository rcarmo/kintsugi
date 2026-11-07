import { extensionOf, imageMimeByExtension, mediaMimeByExtension, workspaceImageUrl } from "@kintsugi/shared/file-metadata";
import { buttonHtml } from "@kintsugi/design-system/button";
import { escapeHtml } from "@kintsugi/shared";

/** Render standalone artifacts and URL previews referenced in Markdown. */

const imageExtensions = new Set(Object.keys(imageMimeByExtension));
const videoExtensions = new Set(Object.keys(mediaMimeByExtension).filter(extension => mediaMimeByExtension[extension]!.startsWith("video/")));
const audioExtensions = new Set(Object.keys(mediaMimeByExtension).filter(extension => mediaMimeByExtension[extension]!.startsWith("audio/")));

function workspaceProxyController(workspaceId: string, appKey: string, path: string): string {
  return [
    `data-controller="artifact-preview-proxy"`,
    `data-artifact-preview-proxy-workspace-id-value="${escapeHtml(workspaceId)}"`,
    `data-artifact-preview-proxy-app-key-value="${escapeHtml(appKey)}"`,
    `data-artifact-preview-proxy-path-value="${escapeHtml(path)}"`,
  ].join(" ");
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized === "0.0.0.0";
}

function renderFullscreenFrame(title: string, iframeHtml: string, newTabLinkHtml: string): string {
  return `<span class="agent-media-frame" data-controller="kintsugi-fullscreen" data-kintsugi-fullscreen-mode-value="media" data-kintsugi-fullscreen-title-value="${escapeHtml(title)}"><span class="agent-media-frame-bar"><span>${escapeHtml(title)}</span><span class="agent-media-frame-actions">${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Fullscreen" }, attributesHtml: 'data-action="kintsugi-fullscreen#open"' })}<span class="agent-media-frame-sep" aria-hidden="true">–</span>${newTabLinkHtml}</span></span>${iframeHtml}</span>`;
}

function embedLiteral(target: string): string {
  return escapeHtml(`![](artifact-preview:${target})`);
}

function renderFileEmbed(workspaceId: string, path: string): string {
  if (path.includes("\0")) return embedLiteral(path);

  const ext = extensionOf(path.split(/[?#]/)[0]!);
  const name = path.split("/").pop() || path;
  const proxy = workspaceProxyController(workspaceId, "file", path);

  if (ext === "svg") {
    const src = escapeHtml(workspaceImageUrl(workspaceId, path));
    const iframe = `<iframe class="agent-media-svg" src="${src}" sandbox="allow-scripts" title="${escapeHtml(name)}" loading="lazy"></iframe>`;
    return renderFullscreenFrame(path, iframe, `<a href="${src}" target="_blank" rel="noopener" data-turbo="false">in new tab ↗</a>`);
  }
  if (imageExtensions.has(ext)) {
    return `<img class="agent-media-img" data-controller="artifact-preview-proxy kintsugi-fullscreen" data-kintsugi-fullscreen-mode-value="media" data-kintsugi-fullscreen-title-value="${escapeHtml(name)}" data-artifact-preview-proxy-workspace-id-value="${escapeHtml(workspaceId)}" data-artifact-preview-proxy-app-key-value="file" data-artifact-preview-proxy-path-value="${escapeHtml(path)}" alt="${escapeHtml(name)}" loading="lazy">`;
  }
  if (videoExtensions.has(ext)) {
    return `<video class="agent-media-video" data-controller="artifact-preview-proxy kintsugi-fullscreen" data-kintsugi-fullscreen-mode-value="media" data-kintsugi-fullscreen-title-value="${escapeHtml(name)}" data-artifact-preview-proxy-workspace-id-value="${escapeHtml(workspaceId)}" data-artifact-preview-proxy-app-key-value="file" data-artifact-preview-proxy-path-value="${escapeHtml(path)}" controls preload="metadata"></video>`;
  }
  if (audioExtensions.has(ext)) {
    return `<audio class="agent-media-audio" ${proxy} controls preload="metadata"></audio>`;
  }
  if (ext === "html" || ext === "htm") {
    const iframe = `<iframe data-controller="artifact-preview-proxy artifact-preview-html" data-artifact-preview-proxy-workspace-id-value="${escapeHtml(workspaceId)}" data-artifact-preview-proxy-app-key-value="file" data-artifact-preview-proxy-path-value="${escapeHtml(path)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`;
    return renderFullscreenFrame(path, iframe, `<a ${proxy} target="_blank" rel="noopener">in new tab ↗</a>`);
  }
  return `<a class="agent-media-link" ${proxy} download="${escapeHtml(name)}" data-turbo="false">${escapeHtml(name)}</a>`;
}

function renderUrlEmbed(workspaceId: string, rawTarget: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawTarget);
  } catch {
    return embedLiteral(rawTarget);
  }

  if (isLoopbackHost(parsed.hostname)) {
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    const appKey = `port-${port}`;
    const path = `${parsed.pathname}${parsed.search}`;
    const proxy = workspaceProxyController(workspaceId, appKey, path);
    const iframe = `<iframe data-controller="artifact-preview-proxy artifact-preview-html" data-artifact-preview-proxy-workspace-id-value="${escapeHtml(workspaceId)}" data-artifact-preview-proxy-app-key-value="${escapeHtml(appKey)}" data-artifact-preview-proxy-path-value="${escapeHtml(path)}" loading="lazy"></iframe>`;
    return renderFullscreenFrame(rawTarget, iframe, `<a ${proxy} target="_blank" rel="noopener">in new tab ↗</a>`);
  }

  const src = parsed.toString();
  return renderFullscreenFrame(rawTarget, `<iframe src="${escapeHtml(src)}" loading="lazy"></iframe>`, `<a href="${escapeHtml(src)}" target="_blank" rel="noopener">in new tab ↗</a>`);
}

export function renderArtifactPreview(workspaceId: string, rawTarget: string): string {
  let target: string;
  try {
    target = decodeURI(rawTarget.trim());
  } catch {
    return embedLiteral(rawTarget);
  }
  if (target.startsWith("http://") || target.startsWith("https://")) return renderUrlEmbed(workspaceId, target);
  if (target.startsWith("/")) return renderFileEmbed(workspaceId, target);
  return embedLiteral(target);
}
