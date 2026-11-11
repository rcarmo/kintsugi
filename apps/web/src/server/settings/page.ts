import { renderCredentialSettings, handleCredentialSettings } from "./credentials.ts";
import { imageSource } from "@kintsugi/shared/publishing";
import { renderNetworkSettings, handleNetworkSettings } from "./network.ts";
import { renderWorkspaceResourceSettings, handleWorkspaceResourceSettings } from "./workspace-resources.ts";
import { connectionModeManaged, renderConnectionModeSettings } from "./connection-mode.ts";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { panelHtml } from "@kintsugi/design-system/panel";
import { buttonHtml } from "@kintsugi/design-system/button";
import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { Icons } from "@kintsugi/design-system/icons";
import { createPiModelRuntime, modelsDialogId, popularProviderIds, setEnabledModels } from "@kintsugi/llm/server";
import { kintsugiEnv, invalidArguments } from "@kintsugi/core";
import { errorMessage, escapeHtml, providerBadgeHtml } from "@kintsugi/shared";
import { clearGitHostingCredential, gitHostingProviders } from "@kintsugi/git-hosting";
import { kintsugiUrl } from "@kintsugi/proxy-ingress";
import { clearCommitIdentity, getStoredCommitIdentity, setCommitIdentity } from "@kintsugi/workspace-templates";
import { kintsugiUrlHtml } from "../kintsugi-url.ts";
import { resetOnboarding } from "../onboarding/state.ts";
import { renderOnboardingDialog } from "../onboarding/routes.ts";
import { workspaceModules } from "../workspace-modules.generated.ts";
import { remove, replace, response, stream, update, wantsStream } from "@kintsugi/shared/http";
import { listSettingsContributions, registerSettingsContribution } from "./registry.ts";
import { renderThemeSettings } from "./theme.ts";
import { globalWorkspaceSettingsSectionId, renderGlobalWorkspaceSettings } from "../template-settings.ts";
import { kintsugiVersion } from "../../version.ts";
import { browserTransportSectionId, renderBrowserTransportSettings } from "./browser-transport.ts";

function forceDeleteWorkspacesEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

export async function renderCommitIdentityForm(error = ""): Promise<string> {
  const identity = await getStoredCommitIdentity();
  return `<form id="settings_commit_identity" class="settings-commit-identity" method="post" action="/settings/commit-identity" autocomplete="off" data-controller="commit-identity" data-action="input->commit-identity#queue change->commit-identity#save submit->commit-identity#submit">
    ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
    <label class="settings-field"><span class="settings-field-label">Commit author name</span><input class="settings-input text-field" name="commitAuthorName" value="${escapeHtml(identity?.name ?? "")}" placeholder="Ada Lovelace" autocomplete="off" data-1p-ignore required></label>
    <label class="settings-field"><span class="settings-field-label">Commit author email</span><input class="settings-input text-field" type="email" name="commitAuthorEmail" value="${escapeHtml(identity?.email ?? "")}" placeholder="ada@example.com" autocomplete="off" data-1p-ignore required></label>
  </form>`;
}

async function renderCommitIdentitySettings(): Promise<string> {
  return `<section class="settings-sec settings-sec-commit-identity" id="settings-sec-commit-identity">${await renderCommitIdentityForm()}</section>`;
}

function renderBuildIdentity(): string {
  const commit = kintsugiEnv("COMMIT_ID");
  if (!commit) return `<span class="settings-build-identity">Local development build</span>`;
  const commitUrl = `${imageSource}/commit/${encodeURIComponent(commit)}`;
  return `<a class="settings-build-identity" href="${commitUrl}" target="_blank" rel="noreferrer">${escapeHtml(commit.slice(0, 7))}</a>`;
}

export type WorkspaceCleanupResult = { deleted: number; errors: string[] };

function renderForceDeleteWorkspaces(result?: WorkspaceCleanupResult): string {
  const confirmation = destructiveConfirmationHtml({
    id: "delete_all_workspaces",
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Delete all workspaces" } },
    confirmCaption: "Delete all workspaces",
    cancelCaption: "Cancel",
  });
  const deleted = result === undefined ? "" : `<p class="developer-tools-status" role="status">Deleted ${escapeHtml(result.deleted)} workspace${result.deleted === 1 ? "" : "s"}.</p>`;
  const errors = result?.errors.length ? `<p class="settings-error">${escapeHtml(result.errors.join("\n"))}</p>` : "";
  return `<div id="settings_force_delete_workspaces" class="developer-tools-action">
    <div class="developer-tools-copy">
      <div>Workspaces</div>
      <p>Permanently delete every workspace and its files.</p>
      ${deleted}${errors}
    </div>
    <div class="developer-tools-control"><form method="post" action="/settings/workspaces/force-delete" data-turbo="true">${confirmation}</form></div>
  </div>`;
}

function renderResetSettings(): string {
  const confirmation = destructiveConfirmationHtml({
    id: "delete_all_settings",
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Delete all settings" } },
    confirmCaption: "Delete all settings",
    cancelCaption: "Cancel",
  });
  return `<div class="developer-tools-action">
    <div class="developer-tools-copy">
      <div>Stored settings</div>
      <p>Delete the Commit identity, git hosting tokens, and model provider credentials stored by Kintsugi.</p>
    </div>
    <div class="developer-tools-control"><form method="post" action="/settings/reset" data-turbo="true">${confirmation}</form></div>
  </div>`;
}

async function renderDeveloperTools(): Promise<string> {
  const destructiveActions = `${renderResetSettings()}${forceDeleteWorkspacesEnabled() ? renderForceDeleteWorkspaces() : ""}`;
  return `<section class="settings-sec settings-sec-developer-tools">${destructiveActions}</section>`;
}

registerSettingsContribution({ id: "credentials", label: "Credentials", order: 24, render: renderCredentialSettings, handleAction: ({ request, url }) => handleCredentialSettings(request, url) });
registerSettingsContribution({ id: "workspace-resources", label: "Workspace resources", order: 17, render: renderWorkspaceResourceSettings, handleAction: ({ request, url }) => handleWorkspaceResourceSettings(request, url) });
registerSettingsContribution({ id: "network", label: "Network", order: 16, render: renderNetworkSettings, handleAction: ({ request, url }) => handleNetworkSettings(request, url) });
registerSettingsContribution({ id: "access", label: "Connection mode", order: 15, render: renderConnectionModeSettings });
registerSettingsContribution({ id: "theme", label: "Theme", order: 10, render: renderThemeSettings });
registerSettingsContribution({ id: globalWorkspaceSettingsSectionId, label: "Global workspace settings", order: 25, render: renderGlobalWorkspaceSettings });
registerSettingsContribution({ id: "commit-identity", label: "Commit identity", order: 20, render: renderCommitIdentitySettings });
for (const module of workspaceModules) {
  for (const contribution of module.settingsContributions ?? []) registerSettingsContribution(contribution);
}

export const appSettingsFrameId = "app_settings_frame";

const disclosureSections = new Set(["credentials", "network", "workspace-resources", "models", "telemetry", "token-optimizer", globalWorkspaceSettingsSectionId, "host", "developer-tools"]);
const sectionFrameId = (id: string) => `app_settings_section_${id}`;

async function renderSettingsSectionFrame(id: string, request: Request): Promise<string> {
  if (id === browserTransportSectionId) return `<turbo-frame class="app-settings-section-frame" id="${sectionFrameId(id)}">${renderBrowserTransportSettings(request)}</turbo-frame>`;
  const section = listSettingsContributions().find(contribution => contribution.id === id);
  if (!section && id !== "developer-tools") throw invalidArguments(`settings section not found: ${id}`);
  const content = id === "developer-tools"
    ? `${await renderDeveloperTools()}${actionLinkHtml({ href: "/design-system-catalogue.html", variant: "secondary", content: { kind: "caption", caption: "Design system catalogue" }, attributesHtml: 'data-turbo="false"' })}${renderBuildIdentity()}`
    : await section!.render();
  return `<turbo-frame class="app-settings-section-frame" id="${sectionFrameId(id)}">${disclosureSections.has(id) ? `<div class="app-settings-expanded">${content}</div>` : content}</turbo-frame>`;
}

export async function renderSettingsFrame(request: Request, sectionId?: string): Promise<string> {
  if (sectionId === "git-identity") sectionId = "commit-identity";
  const contributions = listSettingsContributions();
  if (sectionId && !contributions.some(contribution => contribution.id === sectionId) && sectionId !== "developer-tools" && sectionId !== "url" && sectionId !== browserTransportSectionId) throw invalidArguments(`settings section not found: ${sectionId}`);
  // Opening the panel never waits for a contribution's I/O. Each section owns its request.
  const inline = new Map(contributions
    .filter(contribution => !disclosureSections.has(contribution.id))
    .map(({ id, label }) => [id, `<turbo-frame class="app-settings-section-frame" id="${sectionFrameId(id)}" src="/settings/sections/${id}"><section class="settings-sec" id="settings-sec-${id}"><span role="status">Loading ${escapeHtml(label)}…</span></section></turbo-frame>`]));
  const take = (...ids: string[]) => ids.map(id => { const html = inline.get(id) ?? ""; inline.delete(id); return html; }).join("");
  const disclosure = (id: string, label: string) => disclosureHtml({
    element: { id: `settings-sec-${id}`, attributesHtml: id === "developer-tools" ? 'hidden data-app-settings-target="developer"' : undefined }, open: sectionId === id,
    summary: {
      kind: id === "models" ? "multiline" : "compact",
      label: { kind: "text", text: label },
      trailingHtml: id === "models" ? popularProviderIds.map(provider => providerBadgeHtml(provider, provider, "settings-provider-icon")).join("") : undefined,
    },
    bodyHtml: `<turbo-frame class="app-settings-section-frame" id="${sectionFrameId(id)}" src="/settings/sections/${id}" loading="lazy"><span role="status">Loading…</span></turbo-frame>`,
  });
  const versionFooter = `<footer class="app-settings-version" aria-label="Kintsugi version">${escapeHtml(kintsugiVersion)}</footer>`;
  // The recovery destination loads no other sections: hung section requests
  // must not exhaust the browser's HTTP connections before a transport switch.
  const content = sectionId === browserTransportSectionId
    ? `<div class="app-settings-overview">${renderBrowserTransportSettings(request)}<p>${actionLinkHtml({ href: "/settings", variant: "secondary", content: { kind: "caption", caption: "All settings" }, attributesHtml: 'data-turbo="false"' })}</p></div>${versionFooter}`
    : `<div class="app-settings-overview">
    ${renderBrowserTransportSettings(request)}
    ${take("theme", "dictation", "commit-identity", "git-hosting", "update-channel", "update", "access")}
    ${connectionModeManaged() ? "" : `<section class="settings-sec settings-sec-url" id="settings-sec-url"><h2>Kintsugi URL</h2>${kintsugiUrlHtml(kintsugiUrl(request), "settings_kintsugi_url_qr")}</section>`}
    ${take(...inline.keys())}
    <div class="app-settings-disclosures">${disclosure("credentials", "Credentials")}${disclosure("network", "Network")}${disclosure("workspace-resources", "Workspace resources")}${disclosure("models", "Models")}${disclosure(globalWorkspaceSettingsSectionId, "Global workspace settings that apply to all new workspaces")}${disclosure("telemetry", "Token telemetry")}${disclosure("token-optimizer", "Token optimizer")}${disclosure("host", "Host")}${disclosure("developer-tools", "Developer tools")}</div>
  </div>${versionFooter}`;
  const header = `<h1 class="panel__title" tabindex="-1" data-app-settings-heading>${Icons.Settings}<span>Settings</span></h1>${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Close settings" }, attributesHtml: 'data-action="app-settings#close"' })}`;
  return `<turbo-frame id="${appSettingsFrameId}" data-app-settings-target="frame">${panelHtml({ element: { tag: "section", attributesHtml: 'aria-label="Settings"' }, headerHtml: header, bodyHtml: `<div class="template-settings-content app-settings-content"${sectionId ? ` data-app-settings-anchor="settings-sec-${escapeHtml(sectionId)}"` : ""} data-app-settings-location="/settings${sectionId ? `?section=${encodeURIComponent(sectionId)}` : ""}">${content}</div>`, bodyLayout: "full-bleed", bodyOverflow: "scroll" })}</turbo-frame>`;
}

export async function renderAppSettings(request: Request, sectionId?: string): Promise<string> {
  return `<div id="app_settings_panel" class="template-settings-host app-settings-host" data-controller="app-settings" data-action="keydown->app-settings#keydown keydown@window->app-settings#developerKey keyup@window->app-settings#developerKey blur@window->app-settings#developerKey">${await renderSettingsFrame(request, sectionId)}</div>`;
}

export async function renderDeveloperToolsSettings(request: Request): Promise<string> {
  return renderAppSettings(request, "developer-tools");
}

async function deleteAllStoredSettings(): Promise<void> {
  await resetOnboarding();
  for (const provider of gitHostingProviders) clearGitHostingCredential(provider);
  await clearCommitIdentity();
  await setEnabledModels([]);
  const runtime = await createPiModelRuntime();
  for (const credential of await runtime.listCredentials()) await runtime.logout(credential.providerId);
}

export async function handleSettingsPageRequest(request: Request, url: URL, options: { forceDeleteAllWorkspaces?: () => Promise<WorkspaceCleanupResult>; renderModelPickerUpdates: () => Promise<string> }): Promise<Response | undefined> {
  const sectionMatch = url.pathname.match(/^\/settings\/sections\/([^/]+)$/);
  if (sectionMatch && request.method === "GET") return response(await renderSettingsSectionFrame(sectionMatch[1]!, request));
  if (url.pathname === "/settings" && request.method === "GET") {
    const section = url.searchParams.get("section") ?? undefined;
    if (request.headers.get("turbo-frame") === appSettingsFrameId) return response(await renderSettingsFrame(request, section));
    const html = await renderAppSettings(request, section);
    return wantsStream(request) ? stream(update("app_settings_host", html)) : response(html);
  }
  if ((url.pathname === "/settings/developer-tools" || url.pathname === "/settings/development") && request.method === "GET") {
    const html = await renderDeveloperToolsSettings(request);
    return wantsStream(request) ? stream(update("app_settings_host", html)) : response(html);
  }
  if (url.pathname === "/settings/reset" && request.method === "POST") {
    await deleteAllStoredSettings();
    const pickerUpdates = await options.renderModelPickerUpdates();
    return stream(`${pickerUpdates}${replace(appSettingsFrameId, await renderSettingsFrame(request, "developer-tools"))}${update("onboarding_modal_host", await renderOnboardingDialog())}${remove(modelsDialogId)}`);
  }
  if (url.pathname === "/settings/workspaces/force-delete" && request.method === "POST" && forceDeleteWorkspacesEnabled()) {
    const result = options.forceDeleteAllWorkspaces
      ? await options.forceDeleteAllWorkspaces()
      : { deleted: 0, errors: ["Workspace deletion is not available."] };
    return stream(replace("settings_force_delete_workspaces", renderForceDeleteWorkspaces(result)));
  }
  // Retain the old POST URL as an external boundary for existing clients.
  if ((url.pathname === "/settings/commit-identity" || url.pathname === "/settings/git-identity") && request.method === "POST") {
    const form = await request.formData();
    try {
      await setCommitIdentity({ name: String(form.get("commitAuthorName") ?? ""), email: String(form.get("commitAuthorEmail") ?? "") });
    } catch (error) {
      const message = errorMessage(error);
      return stream(replace("settings_commit_identity", await renderCommitIdentityForm(message)));
    }
    return stream(update("onboarding_modal_host", await renderOnboardingDialog()));
  }
  return undefined;
}
