import { Icons } from "@kintsugi/design-system/icons";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { buttonHtml } from "@kintsugi/design-system/button";
import { qrCodeButtonHtml, qrCodeDialogHtml } from "@kintsugi/design-system/qr-code";
import { domId, escapeHtml, isWorkspaceLoopbackHost, type WorkspaceWorkViewPresentation } from "@kintsugi/shared";
import { browserFrameId, browserNavigationCount, type WorkspaceBrowserView } from "./state.ts";

export function browserWorkViewPresentation(view: WorkspaceBrowserView): WorkspaceWorkViewPresentation {
  return {
    sourceKey: view.key,
    label: view.label,
    reference: { type: "browser", browserId: view.key },
    kind: "resource", iconHtml: Icons.Browser,
    availability: { phase: "live" },
  };
}

export function renderBrowserWorkViewBody(workspaceId: string, view: WorkspaceBrowserView, previewUrl: string): string {
  return `<section class="work-view-pane" data-work-view-source="${escapeHtml(view.key)}"><div class="browser-pane">${renderBrowserFrame(workspaceId, view, previewUrl)}</div></section>`;
}

const browserFramePermissions = [
  "clipboard-write",
  "camera",
  "microphone",
  "geolocation",
  "display-capture",
  "fullscreen",
  "autoplay",
  "picture-in-picture",
  "web-share",
  "payment",
  "usb",
  "serial",
  "hid",
  "bluetooth",
  "midi",
  "gamepad",
  "accelerometer",
  "gyroscope",
  "magnetometer",
  "xr-spatial-tracking",
].map((feature) => `${feature} *`).join("; ");

export function renderBrowserFrame(workspaceId: string, view: WorkspaceBrowserView, previewUrl: string): string {
  const navigationKey = domId("browser_navigation", workspaceId, view.key, Bun.hash(`${previewUrl}#${browserNavigationCount(workspaceId, view.key)}`).toString(16));
  const target = view.targetUrl ? new URL(view.targetUrl) : undefined;
  const browserId = view.key;
  const frameControllerAttributes = previewUrl
    ? ` src="${escapeHtml(previewUrl)}"${target && (target.protocol === "file:" || isWorkspaceLoopbackHost(target.hostname)) ? ` allow="${browserFramePermissions}" allowfullscreen` : ""}`
    : "";
  const externalLinkContent = {
    kind: "icon-only" as const,
    iconHtml: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M18 13v6H5V6h6"/></svg>',
    label: "Open page in a new tab",
  };
  const externalLink = target
    ? actionLinkHtml({
      href: previewUrl,
      variant: "secondary",
      content: externalLinkContent,
      attributesHtml: 'data-browser-address-target="external" target="_blank" rel="noreferrer"',
    })
    : buttonHtml({ type: "button", variant: "secondary", content: externalLinkContent, disabled: true });
  const qrDialogId = `${navigationKey}_qr`;
  const qrButton = qrCodeButtonHtml(qrDialogId, "Open page on your phone", !target);
  const qrDialog = target ? qrCodeDialogHtml(qrDialogId, previewUrl) : "";
  const reloadButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.5-2.6L20 9M4 15l2.4 2.6A7 7 0 0 0 17.9 15"/></svg>', label: "Reload" },
    attributesHtml: 'data-action="browser-address#reload"',
  });
  // Morphs never remove permanent elements, so the per-navigation identity lives on
  // their non-permanent parents: a navigation swaps those out, permanent children included.
  return `<turbo-frame id="${browserFrameId(workspaceId, browserId)}" class="browser-frame">
    <div class="browser-shell">
      <form id="${navigationKey}_toolbar" class="browser-toolbar work-view-toolbar" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/browser/${encodeURIComponent(browserId)}/navigate" data-turbo-frame="${browserFrameId(workspaceId, browserId)}" data-controller="browser-address" data-action="submit->browser-address#submit">
        ${reloadButton}
        <input id="${navigationKey}_address" data-turbo-permanent class="browser-address-input text-field" name="url" value="${escapeHtml(view.targetUrl)}" placeholder="http://localhost:3000" spellcheck="false" autocomplete="off" aria-label="Browser URL" data-action="click->browser-address#initializeAddress">
        ${externalLink}
        ${qrButton}
      </form>
      ${qrDialog}
      <div id="${navigationKey}_viewport_slot" class="browser-viewport">
        <iframe id="${navigationKey}_viewport" data-turbo-permanent${frameControllerAttributes} title="Browser view" loading="lazy" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>
  </turbo-frame>`;
}
