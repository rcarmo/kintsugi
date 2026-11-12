import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { buttonHtml } from "@kintsugi/design-system/button";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import type { GitHostingProvider, GitHostingCredential } from "@kintsugi/core";
import { clearGitHostingCredential, gitHostingProvider, gitHostingProviders, saveGitHostingCredential } from "@kintsugi/git-hosting";
import { getStoredCommitIdentity, setCommitIdentity } from "@kintsugi/workspace-templates";
import { renderOnboardingDialog } from "../onboarding/routes.ts";
import { replace, stream, update } from "@kintsugi/shared/http";
import { renderCommitIdentityForm } from "./page.ts";
import { domId, escapeHtml, providerBadgeHtml } from "@kintsugi/shared";
import { registerSettingsContribution } from "./registry.ts";

type SettingsSurface = "settings" | "onboarding";

const sectionId = "settings-sec-git-hosting";

function disconnectConfirmation(provider: GitHostingProvider): string {
  return destructiveConfirmationHtml({
    id: `disconnect_${provider.id}`,
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Disconnect" } },
    confirmCaption: `Disconnect ${provider.label}`,
    cancelCaption: "Cancel",
  });
}

function connectFormId(surface: SettingsSurface, provider: GitHostingProvider): string {
  return domId(surface, provider.id, "connect-form");
}

function connectionId(surface: SettingsSurface, provider: GitHostingProvider): string {
  return domId(surface, "provider", provider.id);
}

function routePath(provider: GitHostingProvider, action: "connect" | "disconnect", surface: SettingsSurface): string {
  return `/settings/git-hosting/${provider.id}/${action}${surface === "onboarding" ? "?surface=onboarding" : ""}`;
}

export function renderGitHostingConnectButton(surface: SettingsSurface, provider: GitHostingProvider): string {
  return buttonHtml({
    type: "submit",
    variant: "primary",
    content: { kind: "caption", caption: "Connect" },
    attributesHtml: `form="${connectFormId(surface, provider)}"`,
  });
}

function connectionForm(surface: SettingsSurface, provider: GitHostingProvider, error: string): string {
  const { connectForm } = provider;
  const rowClass = surface === "settings" ? " git-hosting-connect-form--row" : "";
  const connectButton = surface === "onboarding" ? "" : renderGitHostingConnectButton(surface, provider);
  const account = connectForm.account
    ? `<input class="settings-input text-field" type="email" name="account" placeholder="${escapeHtml(connectForm.account.placeholder)}" aria-label="${escapeHtml(connectForm.account.label)}" autocomplete="email" required>`
    : "";
  const server = connectForm.serverUrl
    ? `<input class="settings-input text-field" type="url" name="serverUrl" placeholder="${escapeHtml(connectForm.serverUrl.placeholder)}" aria-label="${escapeHtml(connectForm.serverUrl.label)}" autocomplete="url" required>`
    : "";
  return `<form id="${connectFormId(surface, provider)}" class="git-hosting-connect-form${rowClass} form-stack" method="post" action="${routePath(provider, "connect", surface)}" data-turbo="true">
    ${connectForm.instructionsHtml}
    <p>Kintsugi keeps the token outside Agent sandboxes, so Agents can work with your ${escapeHtml(provider.label)} repositories without seeing it.</p>
    ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
    ${server}${account}
    ${connectForm.allowUntrustedCertificate ? `<label class="settings-field"><input type="checkbox" name="allowUntrustedCertificate" value="true"> ${escapeHtml(connectForm.allowUntrustedCertificate.label)}</label>` : ""}
    <div class="git-hosting-connect-controls"><input class="settings-input text-field" type="password" data-1p-ignore name="token" placeholder="${escapeHtml(connectForm.tokenPlaceholder)}" aria-label="${escapeHtml(provider.label)} token" autocomplete="off" required>${connectButton}</div>
  </form>`;
}

export function renderGitHostingConnection(surface: SettingsSurface, provider: GitHostingProvider, options: { expanded?: boolean; error?: string } = {}): string {
  const credential = provider.credential();
  const connected = Boolean(credential);
  const id = connectionId(surface, provider);
  if (surface === "onboarding" && !connected) return `<div class="git-hosting-connection" id="${id}">${connectionForm(surface, provider, options.error ?? "")}</div>`;
  const expanded = !connected && (options.expanded || Boolean(options.error));
  const actions = connected
    ? `<form method="post" action="${routePath(provider, "disconnect", surface)}" data-turbo="true">${disconnectConfirmation(provider)}</form>`
    : expanded ? "" : actionLinkHtml({ href: `/settings/git-hosting/${provider.id}/connect`, variant: "secondary", content: { kind: "caption", caption: "Connect" }, attributesHtml: 'data-turbo-stream="true"' });
  return `<div class="managed-list__item git-hosting-connection" id="${id}">
    ${providerBadgeHtml(provider.id, provider.label, "settings-provider-icon managed-list__visual")}
    <div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">${escapeHtml(provider.label)}</span></div>${credential?.serverUrl ? `<div class="git-hosting-server-url">${escapeHtml(credential.serverUrl)}</div>` : ""}${credential?.allowUntrustedCertificate && provider.connectForm.allowUntrustedCertificate ? `<small class="git-hosting-certificate-note">Certificate checks off</small>` : ""}${expanded ? connectionForm(surface, provider, options.error ?? "") : ""}</div>
    ${actions ? `<div class="managed-list__actions">${actions}</div>` : ""}
  </div>`;
}

async function renderGitHostingSettings(): Promise<string> {
  return `<section class="settings-sec settings-sec-git-hosting" id="${sectionId}"><div class="managed-list" data-controller="managed-list">${gitHostingProviders.map((provider) => renderGitHostingConnection("settings", provider)).join("")}</div></section>`;
}

registerSettingsContribution({ id: "git-hosting", label: "Git hosting", order: 30, render: renderGitHostingSettings });

export async function handleGitHostingSettingsRequest(request: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/settings\/git-hosting\/([^/]+)\/(connect|disconnect)$/);
  if (!match) return undefined;
  const provider = gitHostingProvider(match[1]!);
  const surface: SettingsSurface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
  if (match[2] === "connect" && request.method === "GET") return stream(replace(connectionId("settings", provider), renderGitHostingConnection("settings", provider, { expanded: true })));
  if (request.method !== "POST") return undefined;
  if (match[2] === "connect") {
    const form = await request.formData();
    const token = String(form.get("token") ?? "").trim();
    const account = form.has("account") ? String(form.get("account")).trim() : undefined;
    const serverUrl = form.has("serverUrl") ? String(form.get("serverUrl")).trim() : undefined;
    const credential: GitHostingCredential = { token, account, serverUrl };
    if (provider.connectForm.allowUntrustedCertificate && form.get("allowUntrustedCertificate") === "true") credential.allowUntrustedCertificate = true;
    const validation = await provider.validateCredential(credential);
    if (!validation.ok) return stream(replace(connectionId(surface, provider), renderGitHostingConnection(surface, provider, { error: validation.message })));
    saveGitHostingCredential(provider, validation.credential ?? credential);
    if (!await getStoredCommitIdentity()) await setCommitIdentity(validation.identity);
    return surface === "onboarding"
      ? stream(update("onboarding_modal_host", await renderOnboardingDialog({ resumeAfterConnect: true })))
      : stream(`${replace(sectionId, await renderGitHostingSettings())}${replace("settings_commit_identity", await renderCommitIdentityForm())}${update("onboarding_modal_host", await renderOnboardingDialog())}`);
  }
  clearGitHostingCredential(provider);
  return surface === "onboarding"
    ? stream(update("onboarding_modal_host", await renderOnboardingDialog({ includeCompleted: true, provider })))
    : stream(replace(sectionId, await renderGitHostingSettings()));
}
