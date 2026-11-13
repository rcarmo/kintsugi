import { kintsugiName, escapeHtml, type WorkspaceModule } from "@kintsugi/shared";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { kintsugiThemes, readThemeSetting } from "@kintsugi/shared/theme";
import { pageBodyStimulusHtml } from "@kintsugi/design-system/page-body";
import { parseAssetManifest, type AssetManifest } from "./asset-manifest.ts";
import { themeRegionHtml, themeRegionId } from "./settings/theme.ts";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { Icons } from "@kintsugi/design-system/icons";

export function createPageLayout(options: { devReload?: boolean; workspaceModules: readonly WorkspaceModule[] }): (body: string, title?: string) => string {
  let cachedAssetManifest: AssetManifest | undefined;

  function loadAssetManifest(): AssetManifest {
    const manifestUrl = new URL("../../public/assets-manifest.json", import.meta.url);
    return existsSync(manifestUrl) ? parseAssetManifest(readFileSync(manifestUrl, "utf8")) : {};
  }

  function publicAssetExists(path: string): boolean {
    return existsSync(new URL(`../../public/${path.replace(/^\//, "")}`, import.meta.url));
  }

  function assetPath(logicalPath: string): string {
    cachedAssetManifest ??= loadAssetManifest();
    let resolved = cachedAssetManifest[logicalPath] ?? logicalPath;
    if (resolved.startsWith("/assets/") && !publicAssetExists(resolved)) {
      cachedAssetManifest = loadAssetManifest();
      resolved = cachedAssetManifest[logicalPath] ?? logicalPath;
    }
    return resolved;
  }

  function moduleStylesHtml(): string {
    const styles = new Set<string>();
    for (const module of options.workspaceModules) {
      for (const [path, entry] of Object.entries(module.staticFiles ?? {})) {
        if (path.endsWith(".css") && entry.contentType.toLowerCase().startsWith("text/css")) styles.add(path);
      }
    }
    return [...styles].map((path) => `<link rel="stylesheet" href="${assetPath(path)}">`).join("\n");
  }

  return (body, title = kintsugiName) => {
    if (options.devReload) cachedAssetManifest = loadAssetManifest();
    const pageId = randomUUID();
    const theme = readThemeSetting();
    const themeDefinition = kintsugiThemes.find(({ id }) => id === theme)!;
    const recoverySettings = actionLinkHtml({ href: "/settings?section=browser-transport", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Settings, label: "Connection settings" }, attributesHtml: 'data-turbo="false"' });
    return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}" data-kintsugi-page-id="${escapeHtml(pageId)}">
<head>
<meta charset="utf-8">
<style>
${kintsugiThemes.map(({ id, background, appearance }) => `html[data-theme="${id}"] { background: ${background}; color-scheme: ${appearance}; }`).join("\n")}
${options.devReload ? `
/* Keep the previous page painted while a rebuilt development page loads. */
@view-transition { navigation: auto; }
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 120ms; }
` : ""}</style>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<script src="${assetPath("/layout.js")}"></script>
<meta name="turbo-cache-control" content="no-cache">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="${themeDefinition.background}">
<link rel="stylesheet" href="${assetPath("/design-system.css")}">
<link rel="stylesheet" href="${assetPath("/style.css")}">
<link rel="stylesheet" href="${assetPath("/provisioning.css")}">
${moduleStylesHtml()}
<script type="module" src="${assetPath("/workspace.js")}"></script>
</head>
<body id="body"${pageBodyStimulusHtml(["navigation-origin", "browser-title", "cable-shell", options.devReload ? "dev-reload" : undefined])}${options.devReload ? ` data-dev-reload-url-value="/__kintsugi_dev_reload"` : ""}><div id="live-connection-status" role="status" class="live-connection-status"><span class="status-spinner" aria-hidden="true"></span><span>Reconnecting… Updates are paused.</span>${recoverySettings}</div><div id="${themeRegionId}" hidden>${themeRegionHtml(theme)}</div>${body}
</body>
</html>`;
  };
}
