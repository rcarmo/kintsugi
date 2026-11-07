import { registerWorkspacePresenter } from "@kintsugi/agent/server/tools";
import { buttonHtml } from "@kintsugi/design-system/button";
import { copyButtonHtml } from "@kintsugi/design-system/copy-button";
import { Icons } from "@kintsugi/design-system/icons";
import { domId, escapeHtml, type WorkspaceModule, type WorkspaceWorkViewPresentation } from "@kintsugi/shared";
import { createWorkspaceMetadataState, workspacePortBackend, resolveWorkspace } from "@kintsugi/workspace";
import { createWorkspaceSocketSession } from "@kintsugi/proxy-ingress/server";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createDesktopPresenter } from "./agent-tool.ts";
import { desktopRuntime } from "./runtime.ts";
import { desktopViewerResponse } from "./viewer.ts";

const reference = { type: "desktop" };
const referenceSchema = Type.Object({ type: Type.Literal("desktop") }, { additionalProperties: false });
const stateSchema = Type.Object({ open: Type.Boolean() });
const views = createWorkspaceMetadataState("desktop-view.json", (value) => Value.Parse(stateSchema, value), () => ({ open: false }));
const presentation: WorkspaceWorkViewPresentation = {
  sourceKey: "desktop", label: "Desktop", reference, kind: "resource", iconHtml: Icons.Desktop,
  availability: { phase: "live" },
};

export const kintsugiServerModule: WorkspaceModule = {
  id: "desktop",
  staticFiles: { "/desktop.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  workViews: [{
    type: "desktop",
    parseReference: (value) => Value.Parse(referenceSchema, value),
    identity: () => "desktop",
    render: ({ workspaceId }) => {
      const clipboardCopy = copyButtonHtml({ label: "Copy remote text to local clipboard", attributesHtml: 'data-desktop-pane-target="clipboardCopy" hidden' });
      const fullscreen = buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Fullscreen" }, attributesHtml: 'data-desktop-pane-target="fullscreen" data-action="desktop-pane#toggleFullscreen" aria-pressed="false"' });
      const statuses = [["connecting", "Connecting", "running"], ["connected", "Connected", "success"], ["disconnected", "Disconnected · reconnecting", "warning"], ["starting", "Starting Desktop", "running"], ["stopped", "Desktop stopped", ""], ["failed", "Desktop failed", "danger"]]
        .map(([phase, label, tone]) => `<span data-desktop-pane-target="status" aria-label="${label}" title="${label}" data-phase="${phase}"${phase === "connecting" ? "" : " hidden"}><i class="status-dot ${tone}" aria-hidden="true"></i><span class="desktop-status-caption">${label}</span></span>`).join("");
      return `<section id="${domId("desktop_view", workspaceId)}" data-turbo-permanent class="work-view-pane" data-work-view-source="desktop">
        <div class="desktop-pane" data-controller="desktop-pane" data-action="message@window->desktop-pane#receive fullscreenchange@document->desktop-pane#fullscreenChanged">
          <div class="desktop-toolbar">
            <div class="desktop-connection" role="status" aria-live="polite">${statuses}<span class="desktop-status-detail" data-desktop-pane-target="detail"></span></div>
            <div class="desktop-clipboard" role="group" aria-label="Remote clipboard">
              <textarea class="textarea desktop-clipboard-input" rows="1" wrap="off" aria-label="Remote clipboard text" title="Sends automatically after a short pause. Enter sends now; Shift+Enter adds a newline." placeholder="If you type here, it ends up in the remote clipboard" data-desktop-pane-target="clipboardInput" data-action="input->desktop-pane#queueClipboard compositionend->desktop-pane#queueClipboard keydown->desktop-pane#clipboardKeydown" disabled></textarea>
              <div class="desktop-clipboard-action">
                <span class="desktop-clipboard-feedback" data-desktop-pane-target="clipboardFeedback" role="status" aria-live="polite" hidden>
                  <span data-clipboard-state="pending">${Icons.More}</span>
                  <span data-clipboard-state="sending">${Icons.Refresh}</span>
                  <span data-clipboard-state="sent">${Icons.Check}</span>
                  <span class="desktop-clipboard-feedback-label" data-desktop-pane-target="clipboardFeedbackLabel"></span>
                </span>
                ${clipboardCopy}
              </div>
            </div>
            ${fullscreen}
          </div>
          <iframe class="desktop-frame" data-desktop-pane-target="frame" data-controller="workspace-app-frame" data-workspace-app-frame-workspace-id-value="${escapeHtml(workspaceId)}" data-workspace-app-frame-app-key-value="desktop" data-action="load->desktop-pane#loaded desktop:navigating->desktop-pane#reset" title="Desktop view"></iframe>
        </div>
      </section>`;
    },
    close: ({ workspaceId }) => views.write(workspaceId, { open: false }),
  }],
  commands: [{
    id: "desktop.start",
    async execute({ workspaceId }) {
      await desktopRuntime.start(workspaceId);
      views.write(workspaceId, { open: true });
      return { createdWorkView: reference };
    },
  }],
  routes: [{ async handle(request, url) {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/apps\/desktop(\/.*)?$/);
    if (!match) return;
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    const workspaceId = decodeURIComponent(match[1]!);
    await resolveWorkspace(workspaceId);
    if (!match[2]) return new Response(null, { status: 308, headers: { location: `${url.pathname}/${url.search}`, "cache-control": "no-store" } });
    const local = new URL(url); local.pathname = match[2];
    const result = await desktopViewerResponse(local, () => desktopRuntime.status(workspaceId));
    result.headers.set("cache-control", "no-store");
    result.headers.set("x-content-type-options", "nosniff");
    if (result.headers.get("content-type")?.includes("text/html")) result.headers.set("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    return result;
  } }],
  initialize(context) {
    context.registerSocketHandler(url => {
      const match = url.pathname.match(/^\/workspaces\/([^/]+)\/apps\/desktop\/websockify$/);
      if (!match) return;
      const workspaceId = decodeURIComponent(match[1]!);
      return createWorkspaceSocketSession(async () => { await resolveWorkspace(workspaceId); return workspacePortBackend(workspaceId, 6080, "/"); });
    });
    context.registerWorkspaceAppResolver(async (app, url) => {
      if (app.appKey !== "desktop") return undefined;
      // Only the remote-display transport is exposed. Never proxy CDP or VNC.
      if (url.pathname === "/websockify") return workspacePortBackend(app.workspaceId, 6080, "/");
      return { kind: "fetch", fetch: (request) => request.method === "GET"
        ? desktopViewerResponse(new URL(request.url), () => desktopRuntime.status(app.workspaceId))
        : new Response("Method not allowed", { status: 405, headers: { allow: "GET" } }) };
    });
    context.onWorkspaceRemoved((workspaceId) => views.delete(workspaceId));
    registerWorkspacePresenter("desktop", (workspaceId) => createDesktopPresenter({
      startDesktop: () => desktopRuntime.start(workspaceId),
      async presentDesktop() {
        views.write(workspaceId, { open: true });
        await context.presentWorkView(workspaceId, reference);
      },
    }));
  },
  attachToWorkspace({ workspaceId }) {
    return {
      workViews: views.read(workspaceId).open ? [presentation] : [],
      commands: [{ id: "desktop.start", label: "Open Desktop", description: "Start or reuse the workspace's Xvfb display and Chromium, and open its Desktop view.", scope: "workspace", surfaces: { ui: { placement: "work-launcher", iconHtml: Icons.Desktop, label: "Desktop" } } }],
    };
  },
};
