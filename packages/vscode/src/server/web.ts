import { Icons } from "@kintsugi/design-system/icons";
import type { JsonValue } from "@kintsugi/core";
import { turboStreamResponse, type WorkspaceFileTarget, type WorkspaceModuleRouteContext, type WorkspaceCommandContribution, type WorkspaceModule, type WorkspaceWorkViewPresentation, type WorkspaceWorkViewReference } from "@kintsugi/shared";
import { renderVSCodeView, vscodeViewKey, renderVSCodeNavigationSignal, vscodeFileNavigationStream } from "./render.ts";
import { createWorkspaceVSCodeView, deleteWorkspaceVSCodeState, deleteWorkspaceVSCodeView, listWorkspaceVSCodeViews, openFileInConnectedVSCodeWindows, type WorkspaceVSCodeView } from "./workspace-vscode.ts";
import { patchVSCodeWorkspaceAppResponse, resolveVSCodeWorkspaceAppBackend, vscodeAppKey } from "./proxy.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { handleVSCodePublicResource } from "./public-resources.ts";
import { publicWorkspaceAppOrigin } from "@kintsugi/proxy-ingress/server";

function vscodeWorkViewPresentation(view: WorkspaceVSCodeView): WorkspaceWorkViewPresentation {
  return {
    sourceKey: vscodeViewKey(view.title),
    label: view.title,
    reference: { type: "vscode", title: view.title },
    kind: "resource", iconHtml: Icons.Code,
    availability: { phase: "live" },
  };
}

const vscodeWorkViewReferenceSchema = Type.Object({
  type: Type.Literal("vscode"),
  title: Type.String({ pattern: "\\S" }),
});

type VSCodeWorkViewReference = Static<typeof vscodeWorkViewReferenceSchema> & WorkspaceWorkViewReference;

function parseVSCodeReference(value: JsonValue): VSCodeWorkViewReference {
  if (!Value.Check(vscodeWorkViewReferenceSchema, value)) throw new Error("title is required");
  return { type: "vscode", title: value.title };
}

export const vscodeWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: "vscode.open",
    label: "Open VS Code",
    scope: "workspace",
    surfaces: {
      ui: { placement: "work-launcher", iconHtml: Icons.Code, label: "VS Code" },
      shortcut: { defaultBinding: "Meta+Alt+KeyV" },
    },
  },
];

export const vscodeWorkspaceModule: WorkspaceModule = {
  id: "vscode",
  workViews: [{
    type: "vscode",
    parseReference: parseVSCodeReference,
    identity: (reference: { type: "vscode"; title: string }) => reference.title,
    render: ({ workspaceId, reference }: { workspaceId: string; reference: VSCodeWorkViewReference }) => {
      const view = listWorkspaceVSCodeViews(workspaceId).find((candidate) => candidate.title === reference.title);
      if (!view) throw new Error(`VS Code view not found: ${reference.title}`);
      return renderVSCodeView(workspaceId, view.title);
    },
    close: ({ workspaceId, reference }: { workspaceId: string; reference: { type: "vscode"; title: string } }) => deleteWorkspaceVSCodeView(workspaceId, reference.title),
  }],
  staticFiles: { "/vscode.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  routes: [{ handle: (request, url) => handleVSCodePublicResource(request, url) }],
  initialize(context) {
    context.registerWorkspaceAppResolver(async (app, requestUrl) => app.appKey === vscodeAppKey
      ? {
          ...await resolveVSCodeWorkspaceAppBackend(app, requestUrl),
          adaptResponse: (response, request) => patchVSCodeWorkspaceAppResponse(app, response, request),
          adaptPreviewResponse: (response, request, basePath) => patchVSCodeWorkspaceAppResponse(app, response, request, new URL(publicWorkspaceAppOrigin(request)), basePath),
        }
      : undefined);
    context.onWorkspaceRemoved(deleteWorkspaceVSCodeState);
  },
  commands: [{
    id: "vscode.open",
    async execute({ workspaceId }) {
      const existing = listWorkspaceVSCodeViews(workspaceId)[0];
      return { createdWorkView: { type: "vscode", title: existing?.title ?? createWorkspaceVSCodeView(workspaceId).title } };
    },
  }],
  attachToWorkspace({ workspaceId }) {
    return {
      workViews: listWorkspaceVSCodeViews(workspaceId).map(vscodeWorkViewPresentation),
      overlayHtml: [renderVSCodeNavigationSignal(workspaceId)],
      commands: vscodeWorkspaceCommands,
    };
  },
};

export { createWorkspaceVSCodeView };

export async function openFileInVSCode(workspaceId: string, title: string, target: WorkspaceFileTarget, openWorkView: WorkspaceModuleRouteContext["openWorkView"]): Promise<Response> {
  const [presentation, delivered] = await Promise.all([
    openWorkView(workspaceId, { type: "vscode", title }).then((response) => response.text()),
    openFileInConnectedVSCodeWindows(workspaceId, target),
  ]);
  return turboStreamResponse(`${presentation}${vscodeFileNavigationStream(workspaceId, title, target, delivered)}`);
}
