import { Value } from "typebox/value";
import { readJsonObject, requestAcceptsJson } from "@kintsugi/core";
import { errorMessage, escapeHtml } from "@kintsugi/shared";
import { workspaceMemoryPolicyChangeSchema, type WorkspaceMemoryPolicyChange, type WorkspaceMemoryPolicySnapshot } from "@kintsugi/shared/workspace-resources";
import { workspaceMemoryPolicyAvailable, inspectWorkspaceMemoryPolicy, configureWorkspaceMemoryPolicy } from "@kintsugi/workspace";
import { buttonHtml } from "@kintsugi/design-system/button";
import { jsonResponse, response, stream, update, wantsStream } from "@kintsugi/shared/http";

const MiB = 1024 ** 2;
export interface WorkspaceMemoryPolicyBackend {
  available(): Promise<boolean>;
  inspect(): Promise<WorkspaceMemoryPolicySnapshot>;
  configure(changes: WorkspaceMemoryPolicyChange): Promise<WorkspaceMemoryPolicySnapshot>;
}
const backend: WorkspaceMemoryPolicyBackend = { available: workspaceMemoryPolicyAvailable, inspect: inspectWorkspaceMemoryPolicy, configure: configureWorkspaceMemoryPolicy };
export async function renderWorkspaceResourceSettings(error = "", saved = false, control = backend): Promise<string> {
  let policy: WorkspaceMemoryPolicySnapshot | undefined;
  let unavailable = "";
  try {
    if (await control.available()) policy = await control.inspect();
    else unavailable = "Update the installation to enable global workspace RAM limits (System compatibility version 4).";
  } catch (failure) { unavailable = errorMessage(failure); }
  const content = policy ? `<form method="post" action="/settings/workspace-resources" data-turbo="true">
    <p>This hard cap applies to every workspace, including new workspaces and individual RAM limit changes. It leaves the installation’s shared management and build budget intact.</p>
    <label class="settings-field"><span class="settings-field-label">Maximum RAM per workspace (MiB)</span><input class="text-field" name="maximumMemoryMiB" type="number" min="6" max="${Math.floor(policy.capacity / MiB)}" step="1" value="${Math.floor(policy.maximumMemory / MiB)}" required></label>
    <p>Current default: ${Math.floor(policy.defaultMemory / MiB)} MiB. Installation ceiling: ${Math.floor(policy.capacity / MiB)} MiB. Swap is controlled separately in Workspace Properties.</p>
    <p>To lower this cap, first lower any conflicting workspace limits in Workspace Properties. Saving will not restart workspaces or silently reduce running limits.</p>
    ${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Save RAM cap" } })}</form>` : `<p>${escapeHtml(unavailable)}</p>`;
  return `<section class="settings-sec" id="workspace_resource_settings">${error ? `<p class="settings-error" role="alert">${escapeHtml(error)}</p>` : saved ? '<p role="status">Workspace RAM cap saved.</p>' : ""}${content}</section>`;
}
export async function handleWorkspaceResourceSettings(request: Request, url: URL, control = backend): Promise<Response | undefined> {
  if (url.pathname !== "/settings/workspace-resources") return;
  if (!["GET", "POST"].includes(request.method)) return response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  if (request.method === "GET") {
    if (!requestAcceptsJson(request)) return response(await renderWorkspaceResourceSettings("", false, control));
    if (!await control.available()) return jsonResponse({ error: { code: "workspace_resource_policy_unavailable", message: "Update System to compatibility version 4." } }, { status: 503 });
    return jsonResponse({ workspaceMemoryPolicy: await control.inspect() });
  }
  let changes: WorkspaceMemoryPolicyChange;
  try {
    const input = request.headers.get("content-type")?.includes("application/json") ? await readJsonObject(request) : { maximumMemory: Number((await request.formData()).get("maximumMemoryMiB")) * MiB };
    if (!Value.Check(workspaceMemoryPolicyChangeSchema, input)) throw new Error("Enter a finite RAM cap of at least 6 MiB. Unknown settings are not accepted.");
    changes = input;
  } catch (error) {
    return jsonResponse({ error: { code: "invalid_workspace_resource_policy", message: errorMessage(error) } }, { status: 400 });
  }
  try {
    const policy = await control.configure(changes);
    if (requestAcceptsJson(request)) return jsonResponse({ workspaceMemoryPolicy: policy });
    return wantsStream(request) ? stream(update("workspace_resource_settings", await renderWorkspaceResourceSettings("", true, control))) : Response.redirect(new URL("/settings?section=workspace-resources", request.url), 303);
  } catch (error) {
    if (requestAcceptsJson(request)) return jsonResponse({ error: { code: "workspace_resource_policy_refused", message: errorMessage(error) } }, { status: 409 });
    const html = await renderWorkspaceResourceSettings(errorMessage(error), false, control);
    return wantsStream(request) ? stream(update("workspace_resource_settings", html), { status: 422 }) : response(html, { status: 422 });
  }
}
