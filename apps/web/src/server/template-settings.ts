import { grantedInstanceCredentials } from "@kintsugi/workspace-templates";
import { getPrivateNetworkAccess } from "@kintsugi/workspace-templates/private-network";
import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { invalidArguments } from "@kintsugi/core";
import { buttonHtml } from "@kintsugi/design-system/button";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { Icons } from "@kintsugi/design-system/icons";
import { panelHtml } from "@kintsugi/design-system/panel";
import { toggleHtml } from "@kintsugi/design-system/toggle";
import { warningBannerHtml } from "@kintsugi/design-system/warning-banner";
import { buttonConfirmationHtml } from "@kintsugi/design-system/button-confirmation";
import { escapeHtml } from "@kintsugi/shared";
import { formatWorkspaceTemplateSpec, getChangeBuckets, getConfiguration, getWorkspaceTemplateConfiguration, globalWorkspaceConfiguration, isGlobalScope, workspaceTemplateSecretAllowsPath, type ConfigurationScope, type ScopeConfiguration, type WorkspaceTemplateEnvironmentVariable, type WorkspaceTemplateSecretSummary, type WorkspaceTemplateSshKeySummary } from "@kintsugi/workspace-templates";

import { workspaceTemplateSwatchColor } from "./workspace-template-presentation.ts";

export type ConfigurationSectionName = "secrets" | "ssh" | "environment" | "network" | "buckets";
export const templateSettingsHostId = "template_settings_host";
export const templateSettingsFrameId = "template_settings_detail";
export const templateSettingsErrorId = "template_settings_error";
export const globalWorkspaceSettingsFrameId = "global_workspace_settings_detail";
export const globalWorkspaceSettingsErrorId = "global_workspace_settings_error";
export const globalWorkspaceSettingsPath = "/global-workspace-settings";
export const globalWorkspaceSettingsSectionId = "global-workspace-settings";
export type TemplateSettingsSection = "index" | typeof sections[number];
export interface TemplateSettingsLocation { section?: string; editor?: string }
export interface TemplateSettingsReference { workspaceId: string; title: string }

function sectionFor(value?: string): TemplateSettingsSection | undefined {
  if (value === undefined) return undefined;
  if (value === "index") return value;
  const section = sections.find(section => section === value);
  if (section) return section;
  switch (value) {
    case "repository": return "general";
    case "danger": return "index";
    case "ssh-keys": return "ssh";
    case "dockerfile": case "preload-images": case "privileged": return "container";
    default: throw invalidArguments("Unknown template settings section");
  }
}
const sections = ["general", "global-secrets", "global-ssh", "global-environment", "global-network", "global-buckets", "secrets", "ssh", "environment", "network", "buckets", "container", "developer"] as const;
const recordSections: readonly TemplateSettingsSection[] = sections.filter(section => section !== "general" && section !== "developer");
const captionButton = (caption: string, attributesHtml: string, variant: "secondary" | "primary" = "secondary") => buttonHtml({ type: "button", variant, content: { kind: "caption", caption }, attributesHtml });
const paragraph = (text: string) => `<p class="template-settings-note">${escapeHtml(text)}</p>`;
const field = (caption: string, name: string, value: string, attributes = "") => `<label class="form-section"><span>${escapeHtml(caption)}</span><input class="text-field" name="${name}" value="${escapeHtml(value)}" ${attributes}></label>`;
const textarea = (caption: string, name: string, value: string, rows: number, attributes = "") => `<label class="form-section"><span>${caption}</span><textarea class="textarea" name="${name}" rows="${rows}" ${attributes}>${escapeHtml(value)}</textarea></label>`;
export function templateSettingsUrl(id: string, section: TemplateSettingsSection, editor?: string): string {
  return `/workspace-templates/${encodeURIComponent(id)}/settings?section=${section}${editor ? `&editor=${encodeURIComponent(editor)}` : ""}`;
}
export const globalWorkspaceSettingsUrl = `/settings?section=${globalWorkspaceSettingsSectionId}`;
interface EditorFormOptions {
  section: TemplateSettingsSection;
  editor?: string;
  caption?: string;
  attributesHtml?: string;
  autosave?: boolean;
  available?: boolean;
}
interface EditorLocation { section: TemplateSettingsSection; editor?: string }
const editorKey = (section: TemplateSettingsSection, editor?: string) => `${section}:${editor ?? ""}`;

/** Renders the editors for one scope's records: where their forms post and which editor is open or just saved. */
interface Editors {
  /** Global sections are prefixed so their editors stay distinct within a template's settings. */
  section(name: ConfigurationSectionName): TemplateSettingsSection;
  form(path: string, contents: string, options: EditorFormOptions): string;
  disclosure(section: TemplateSettingsSection, editor: string | undefined, label: string, contents: string, description?: string, attributesHtml?: string): string;
  removeForm(path: string, section: TemplateSettingsSection, label: string): string;
  actionUrl(path: string): string;
}

/** viewTemplateId is the template whose settings page shows global records, which re-renders after their changes. */
function editors(scope: ConfigurationScope, location: EditorLocation, saved: boolean, viewTemplateId?: string): Editors {
  const base = isGlobalScope(scope) ? globalWorkspaceSettingsPath : `/workspace-templates/${encodeURIComponent(scope)}`;
  const query = viewTemplateId ? `?workspaceTemplate=${encodeURIComponent(viewTemplateId)}` : "";
  const actionUrl = (path: string) => `${base}${path}${query}`;
  const opened = (section: TemplateSettingsSection, record?: string) => location.section === section && (record === undefined || location.editor === record);
  return {
    section: name => isGlobalScope(scope) ? `global-${name}` : name,
    actionUrl,
    form(path, contents, { section, editor, caption = "Save changes", attributesHtml = "", autosave = false, available = true }) {
      const justSaved = saved && location.section === section && location.editor === editor;
      return `<form class="form-stack" method="post" action="${escapeHtml(actionUrl(path))}" data-settings-editor-target="form" data-settings-editor-form-key="${escapeHtml(editorKey(section, editor))}"${autosave ? " data-settings-editor-autosave" : ""} data-settings-editor-available="${available}"${justSaved ? " data-settings-editor-saved-form" : ""} data-action="input->settings-editor#changed change->settings-editor#changed turbo:submit-start->settings-editor#submitting turbo:submit-end->settings-editor#submitted" ${attributesHtml}>
    ${contents}
    <div class="form-actions" tabindex="-1" data-settings-editor-save-actions${autosave ? " hidden" : ""}>${captionButton("Cancel", 'data-action="settings-editor#reset"')}${buttonConfirmationHtml({
      type: "submit", variant: "primary", disabled: true,
      content: { kind: "caption", caption }, confirmationLabel: "Changes saved", confirmed: justSaved,
      attributesHtml: "data-settings-editor-save",
    })}</div>
  </form>`;
    },
    disclosure(section, editor, label, contents, description, attributesHtml = "") {
      const summaryContent = description ? { kind: "multiline" as const, description } : { kind: "compact" as const };
      return disclosureHtml({ element: { attributesHtml: `data-settings-editor-disclosure="${escapeHtml(editorKey(section, editor))}"${attributesHtml ? ` ${attributesHtml}` : ""}` }, summary: { ...summaryContent, width: "fit", label: { kind: "text", text: label }, attributesHtml: `data-settings-editor-record="${escapeHtml(editorKey(section, editor))}"` }, bodyHtml: `<div class="template-settings-inline-body">${contents}</div>`, open: opened(section, editor) });
    },
    removeForm(path, section, label) {
      return `<div class="template-settings-remove"><form method="post" action="${escapeHtml(actionUrl(path))}" data-action="turbo:submit-start->settings-editor#submitting turbo:submit-end->settings-editor#submitted">${destructiveConfirmationHtml({ id: `template_remove_${section}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`, trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: label } }, confirmCaption: label, cancelCaption: "Cancel" })}</form></div>`;
    },
  };
}

function selection(label: string, name: string, value: string, options: { value: string; label: string }[]): string {
  return `<div class="form-section"><span>${label}</span><input type="hidden" name="${name}" value="${value}">${toggleHtml({ variant: "button", label, name, value, options, element: { dataAction: `change->settings-editor#toggleChanged` } })}</div>`;
}

/** The other list of records; a Secret or Environment variable named in both is labelled with describe. */
interface Counterpart { records: ScopeConfiguration; describe(name: string): string }

function secretEditor(e: Editors, secret?: WorkspaceTemplateSecretSummary): string {
  const section = e.section("secrets");
  const isNew = !secret;
  const record = secret?.id ?? "new";
  const permission = String(secret ? workspaceTemplateSecretAllowsPath(secret) : false);
  const nameAttributes = isNew ? 'data-workspace-template-new-secret-target="name" data-action="input->workspace-template-new-secret#suggestHost"' : "";
  const hostAttributes = isNew ? 'data-workspace-template-new-secret-target="host" data-action="input->workspace-template-new-secret#useDefault"' : "";
  const content = `${field("Environment variable", "envName", secret?.envName ?? "", `required autocomplete="off" ${nameAttributes}`)}
    ${field("Allowed hosts", "hostPattern", secret?.hostPattern ?? "", `required autocomplete="off" placeholder="api.anthropic.com" ${hostAttributes}`)}
    ${paragraph("Separate hosts with commas or semicolons. Use * as a wildcard, like *.github.com, or on its own to allow any host.")}
    ${field(secret?.configured ? "Replace secret value" : "Secret value", "secretValue", "", `type="password" autocomplete="new-password" data-1p-ignore`)}
    ${paragraph(secret?.configured ? "Leave the value blank to keep the stored secret. Stored values are never shown." : "Agents only see a placeholder. Add the real value here when it’s available.")}
    ${disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Advanced" } }, bodyHtml: `<div class="form-stack">
      ${field("Placeholder", "placeholder", secret?.placeholder ?? "", 'autocomplete="off"')}
      ${paragraph("Leave blank to use an automatically generated placeholder.")}
      ${textarea("Needed for", "annotation", secret?.annotation ?? "", 2)}
      <div class="form-section"><span>Allow substitution in URL paths</span><input type="hidden" name="allowInPath" value="${permission}"${isNew ? ' data-workspace-template-new-secret-target="permission"' : ""}>
      ${toggleHtml({ variant: "button", label: "Allow substitution in URL paths", name: "allowInPath", value: permission, options: [{ value: "false", label: "Disallow" }, { value: "true", label: "Allow" }], element: { dataAction: `${isNew ? "click->workspace-template-new-secret#choose change->workspace-template-new-secret#choose " : ""}change->settings-editor#toggleChanged`, data: isNew ? { "workspace-template-new-secret-target": "toggle" } : undefined } })}</div>
      ${paragraph("Allow only if the service needs this secret in its URL path, rather than headers or the request body.")}
    </div>` })}`;
  return `${secret ? paragraph(secret.configured ? "Secret stored" : "No value stored") : ""}${e.form(`/secrets${secret ? `/${encodeURIComponent(secret.id)}` : ""}`, content, { section, editor: record, caption: isNew ? "Add secret" : "Save changes", attributesHtml: isNew ? 'data-controller="workspace-template-new-secret"' : "" })}${secret ? e.removeForm(`/secrets/${encodeURIComponent(secret.id)}/delete`, section, "Delete secret") : ""}`;
}

function secretsSection(e: Editors, secrets: WorkspaceTemplateSecretSummary[], counterpart?: Counterpart): string {
  const section = e.section("secrets");
  return e.disclosure(section, undefined, "Secrets", `${paragraph("Agents only see placeholders. Real values are substituted in requests to allowed hosts. Changed values also reach existing workspaces; new secrets only reach new ones.")}<div class="template-settings-inline-records">${secrets.map(secret => e.disclosure(section, secret.id, secret.envName, secretEditor(e, secret), counterpart?.records.secrets.some(other => other.envName === secret.envName) ? counterpart.describe(secret.envName) : undefined)).join("")}${e.disclosure(section, "new", "Add secret", secretEditor(e))}</div>`);
}

function environmentSection(e: Editors, variables: WorkspaceTemplateEnvironmentVariable[], counterpart?: Counterpart): string {
  const section = e.section("environment");
  const editor = (variable?: WorkspaceTemplateEnvironmentVariable) => {
    const record = variable?.id ?? "new";
    return `${e.form(`/environment${variable ? `/${encodeURIComponent(variable.id)}` : ""}`, `<div class="template-settings-inline-fields">${field("Name", "name", variable?.name ?? "", 'required autocomplete="off"')}${field("Value", "value", variable?.value ?? "", 'autocomplete="off"')}</div>`, { section, editor: record, caption: variable ? "Save changes" : "Add variable" })}${variable ? e.removeForm(`/environment/${encodeURIComponent(variable.id)}/delete`, section, "Remove variable") : ""}`;
  };
  return e.disclosure(section, undefined, "Environment variables", `${paragraph("Added to new workspaces. Use Secrets for passwords and API keys.")}<div class="template-settings-inline-records">${variables.map(variable => e.disclosure(section, variable.id, variable.name, editor(variable), counterpart?.records.environment.some(other => other.name === variable.name) ? counterpart.describe(variable.name) : undefined)).join("")}${e.disclosure(section, "new", "Add variable", editor())}</div>`);
}

function sshSection(e: Editors, keys: WorkspaceTemplateSshKeySummary[], knownHosts: string): string {
  const section = e.section("ssh");
  const keyEditor = (key?: WorkspaceTemplateSshKeySummary) => {
    const record = key?.id ?? "new";
    const fields = e.form(`/ssh-keys${key ? `/${encodeURIComponent(key.id)}` : ""}`, `${field("Name", "name", key?.name ?? "", 'autocomplete="off"')}${key ? "" : textarea("Private key", "privateKey", "", 7, 'required autocomplete="off" spellcheck="false"')}`, { section, editor: record, caption: key ? "Save changes" : "Add key" });
    if (!key) return fields;
    const copy = buttonConfirmationHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Copy public key", iconHtml: Icons.Copy }, confirmationLabel: "Copied to clipboard", attributesHtml: 'data-action="ssh-public-key-copy#copy"' });
    return `${fields}<div class="template-settings-toolbar" data-controller="ssh-public-key-copy" data-ssh-public-key-copy-url-value="${escapeHtml(e.actionUrl(`/ssh-keys/${encodeURIComponent(key.id)}/public-key`))}"><span>${escapeHtml(key.keyType)}</span>${copy}<span data-ssh-public-key-copy-target="error" role="status" hidden>Could not copy key</span></div>${e.removeForm(`/ssh-keys/${encodeURIComponent(key.id)}/delete`, section, "Remove key")}`;
  };
  const trusted = e.form("/ssh-known-hosts", `${paragraph("GitHub, GitLab and Bitbucket are trusted by default. Only add identities you have verified with the server’s administrator.")}${textarea("Known hosts", "knownHosts", knownHosts, 7, 'spellcheck="false"')}`, { section, editor: "known-hosts" });
  return e.disclosure(section, undefined, "SSH keys", `${paragraph("Your agent may use these but can’t see them. Private keys are encrypted outside workspaces. Changes also apply to existing workspaces.")}<div class="template-settings-inline-records">${keys.map(key => e.disclosure(section, key.id, key.name || "Unnamed key", keyEditor(key))).join("")}${e.disclosure(section, "new", "Add key", keyEditor())}${e.disclosure(section, "known-hosts", "Trusted SSH servers", trusted)}</div>`);
}

function assertRecordExists(e: Editors, records: ScopeConfiguration, { section, editor }: EditorLocation): void {
  if (!editor || editor === "new") return;
  if (section === e.section("secrets") && !records.secrets.some(secret => secret.id === editor) || section === e.section("environment") && !records.environment.some(variable => variable.id === editor) || section === e.section("ssh") && editor !== "known-hosts" && !records.sshKeys.some(key => key.id === editor)) throw invalidArguments("Settings record not found");
}

function privateNetworkSection(e: Editors, entries: string[]): string {
  const section = e.section("network");
  const form = e.form("/private-network-access", `${textarea("Private TCP destinations, one per line", "privateNetworkAccess", entries.join("\n"), 5, 'spellcheck="false" placeholder="db.internal:5432"')}${paragraph("Global and template lists combine. Saving a list does not enable access. Choose Listed hosts only for a workspace, then park and unpark to apply it. Other modes keep their existing CIDR rules.")}${paragraph("Private addresses and exact host:port names only. Protected services and peer workspaces stay blocked. DNS addresses are pinned until the next restart.")}`, { section });
  return e.disclosure(section, undefined, "Listed private hosts", `<div class="private-network-editor">${form}</div>`);
}

function changeBucketsSection(e: Editors, text: string): string {
  const section = e.section("buckets");
  const form = e.form("/change-buckets", `${textarea("Buckets, one per line", "changeBuckets", text, 5, `spellcheck="false" autocomplete="off" placeholder="Tests: *Test.* *.test.* tests/"`)}${paragraph("Write a name, a colon, then patterns separated by spaces. A pattern without a slash matches file names anywhere, one ending in a slash matches a folder anywhere, and ! leaves files out. Files go in the first bucket they match.")}`, { section });
  const intro = "Changes counts lines in these buckets separately, so the main work stands out from tests and the like.";
  return e.disclosure(section, undefined, "Change buckets", `${paragraph(section === "buckets" ? `${intro} A bucket here replaces a shared one with the same name, and a name without patterns turns the shared one off.` : intro)}${form}`);
}


type ScopeSettings = ScopeConfiguration & {changeBuckets: string};
async function scopeSettings(scope: ConfigurationScope): Promise<ScopeSettings> {
 const [records,changeBuckets] = await Promise.all([getConfiguration(scope),getChangeBuckets(scope)]);
 return {...records,changeBuckets};
}

function configurationSections(e: Editors, records: ScopeSettings, counterpart?: Counterpart, destinations: string[] = []): string {
  return `<div class="template-settings-inline-records">${secretsSection(e, records.secrets, counterpart)}${sshSection(e, records.sshKeys, records.sshKnownHosts)}${environmentSection(e, records.environment, counterpart)}${privateNetworkSection(e, destinations)}${changeBucketsSection(e, records.changeBuckets)}</div>`;
}

export function templateSettingsErrorHtml(message: string): string {
  return warningBannerHtml({
    title: "Couldn’t save changes", message, role: "alert",
    dismiss: { buttonAttributesHtml: 'data-action="settings-editor#dismissError"', label: "Dismiss save error" },
  });
}

function editorErrorsHtml(errorId: string): string {
  return `<div id="${errorId}" class="settings-editor-error" data-settings-editor-target="error"></div><div data-settings-editor-target="requestError" hidden>${templateSettingsErrorHtml("Please try again. Your unsaved changes are still here.")}</div>`;
}

function editorContentAttributes(location: string, focus: string | undefined, submittedPath: string | undefined): string {
  return `data-settings-editor-target="content" data-settings-editor-location="${escapeHtml(location)}"${focus ? ` data-settings-editor-focus="${escapeHtml(focus)}"` : ""}${submittedPath ? ` data-settings-editor-submitted-path="${escapeHtml(submittedPath)}"` : ""}`;
}


export async function renderTemplateSettingsFrame(id: string, location: TemplateSettingsLocation, references: TemplateSettingsReference[], saved = false, submittedPath?: string): Promise<string> {
  const [t, own, global, ownHosts, globalHosts] = await Promise.all([getWorkspaceTemplateConfiguration(id), scopeSettings(id), scopeSettings(globalWorkspaceConfiguration), getPrivateNetworkAccess(id), getPrivateNetworkAccess(globalWorkspaceConfiguration)]);
  const section = sectionFor(location.section) ?? "index";
  const editor = location.editor ?? (location.section === "privileged" ? "docker" : location.section === "preload-images" ? "images" : location.section === "dockerfile" ? "dockerfile" : undefined);
  if (editor && !recordSections.includes(section)) throw invalidArguments("This settings section has no record editor");
  if (section === "container" && editor && !["docker", "images", "dockerfile"].includes(editor)) throw invalidArguments("Settings record not found");
  const current = { section, editor };
  const ownEditors = editors(id, current, saved);
  const globalEditors = editors(globalWorkspaceConfiguration, current, saved, id);
  assertRecordExists(ownEditors, own, current);
  assertRecordExists(globalEditors, global, current);
  const general = ownEditors.form("", `<div class="template-settings-inline-fields">${field("Display name", "name", t.name, 'required autocomplete="off" data-1p-ignore="true"')}${field("Repository", "gitUrl", formatWorkspaceTemplateSpec(t), "required")}</div><label class="template-settings-color"><span>Swatch color</span><input type="hidden" name="swatchColor" value="${escapeHtml(t.swatchColor ?? "")}"><span class="template-settings-color-control"><span class="workspace-template-icon" style="--workspace-template-swatch: ${escapeHtml(t.swatchColor ?? workspaceTemplateSwatchColor(t.id))}" aria-hidden="true"></span><input type="color" name="swatchColorPicker" aria-label="Swatch color" data-settings-editor-target="colorPicker" data-default-color="${workspaceTemplateSwatchColor(t.id)}" data-action="input->settings-editor#colorChanged change->settings-editor#colorChanged"></span></label>`, { section: "general", autosave: true });
  const catalogue = await grantedInstanceCredentials(id);
  const credentials = disclosureHtml({ summary: { kind: "compact", width: "fit", label: { kind: "text", text: "Instance credentials" } }, bodyHtml: `<p>Granted credentials apply to existing and future workspaces from this template.</p><ul>${catalogue.map(item => `<li>${escapeHtml(item.name)} · ${escapeHtml(item.envName)} · ${escapeHtml(item.hostPattern)}</li>`).join("") || "<li>No active grants</li>"}</ul><a href="/settings?section=credentials" data-turbo-frame="_top">Manage credentials and template grants</a>` });
  const shared = disclosureHtml({ summary: { kind: "compact", width: "fit", label: { kind: "text", text: "Shared with all templates" } }, bodyHtml: `<div class="template-settings-inline-body">${configurationSections(globalEditors, global, { records: own, describe: name => `Overridden by per-template ${name} with the same name` }, globalHosts)}</div>`, open: section.startsWith("global-") });
  const onlyHere = disclosureHtml({ summary: { kind: "compact", width: "fit", label: { kind: "text", text: "Only for this template" } }, bodyHtml: `<div class="template-settings-inline-body">${configurationSections(ownEditors, own, { records: global, describe: name => `Overrides global ${name} with the same name` }, ownHosts)}</div>`, open: ["secrets", "ssh", "environment", "network", "buckets"].includes(section) });
  const dockerSupport = ownEditors.form("/privileged", `${selection("Docker support", "privileged", String(t.privileged ?? false), [{ value: "false", label: "Off" }, { value: "true", label: "On" }])}${paragraph("Privileged workspaces can access host devices and data. Enable only for templates and agents you trust.")}`, { section: "container", editor: "docker", autosave: true });
  const images = ownEditors.disclosure("container", "images", "Preloaded images", ownEditors.form("/preload-images", `${t.privileged ? "" : paragraph("Turn on Docker support to edit preloaded images. Saved references are kept while Docker is off.")}${textarea("Image references, one per line", "preloadImages", (t.preloadImages ?? []).join("\n"), 6, `spellcheck="false"${t.privileged ? "" : " readonly"}`)}`, { section: "container", editor: "images", available: Boolean(t.privileged) }));
  const dockerfile = ownEditors.disclosure("container", "dockerfile", "Custom Dockerfile", ownEditors.form("/dockerfile", `${textarea("Dockerfile override", "dockerfile", t.dockerfile ?? "", 14, 'spellcheck="false" placeholder="FROM kintsugi-workspace"')}${paragraph("Leave blank to use the repository Dockerfile or default image. An override must start with FROM kintsugi-workspace.")}`, { section: "container", editor: "dockerfile" }));
  const docker = ownEditors.disclosure("container", undefined, "Docker", `${paragraph("Docker changes apply to new workspaces. Existing containers stay unchanged.")}${dockerSupport}<div class="template-settings-inline-records">${images}${dockerfile}</div>`);
  const developer = ownEditors.disclosure("developer", undefined, "Developer settings", ownEditors.form("/seed-config", `${selection("Kintsugi-in-Kintsugi seeding", "seedConfigEnabled", String(t.seedConfigEnabled ?? false), [{ value: "false", label: "Off" }, { value: "true", label: "On" }])}${paragraph("Allows the repository manifest to copy provider credentials and template configuration into new workspaces. Enable only for repositories and agents you trust.")}${paragraph("Disabling this does not remove credentials already copied into existing workspaces.")}`, { section: "developer" }), undefined, 'hidden data-template-settings-target="developer"');
  const deleteLabel = references.length ? `Delete template — delete ${references.length === 1 ? `workspace “${references[0]!.title}”` : `${references.length} workspaces`} first. This template is still in use.` : "Delete template";
  const deletion = `<form method="post" action="/workspace-templates/${encodeURIComponent(id)}/delete" data-action="turbo:submit-start->settings-editor#submitting turbo:submit-end->settings-editor#submitted">${destructiveConfirmationHtml({ id: "template_settings_delete", trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: Icons.Trash, label: deleteLabel }, disabled: references.length > 0, attributesHtml: 'data-settings-editor-record="index:delete"' }, confirmCaption: "Delete template", cancelCaption: "Cancel" })}</form>`;
  const header = `<h1 class="panel__title" id="template_settings_title">${Icons.Settings}<span>Template settings · ${escapeHtml(t.name)}</span></h1>${deletion}${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Close template settings" }, attributesHtml: 'data-action="template-settings#close"' })}`;
  const focus = section !== "index" || location.section === "danger" ? editorKey(section, location.section === "danger" ? "delete" : editor) : undefined;
  const body = `<div class="template-settings-content template-settings-inline" ${editorContentAttributes(templateSettingsUrl(id, section, editor), focus, submittedPath)}>
    ${editorErrorsHtml(templateSettingsErrorId)}
    ${general}<div class="template-settings-inline-disclosures">${credentials}${shared}${onlyHere}${docker}${developer}</div>
  </div>`;
  return `<turbo-frame id="${templateSettingsFrameId}" data-settings-editor-target="frame">${panelHtml({ element: { tag: "section", attributesHtml: 'aria-label="Template settings"' }, headerHtml: header, bodyHtml: body, bodyLayout: "full-bleed", bodyOverflow: "scroll" })}</turbo-frame>`;
}

export async function renderTemplateSettings(id: string, location: TemplateSettingsLocation, references: TemplateSettingsReference[]): Promise<string> {
  const frame = await renderTemplateSettingsFrame(id, location, references);
  const guard = dialogHtml({ element: { id: "template_settings_discard", actions: "cancel->template-settings#stay", attributesHtml: 'data-template-settings-target="discard"' }, iconHtml: Icons.Settings, titleCaption: "Discard unsaved changes?", bodyHtml: paragraph("Your changes haven’t been saved."), omitCancelButton: true, footerHtml: `${captionButton("Stay", 'data-action="template-settings#stay"')}${captionButton("Discard changes", 'data-action="template-settings#discard"', "primary")}` });
  return `<div id="${templateSettingsHostId}" class="template-settings-host" data-controller="template-settings settings-editor" data-template-settings-settings-editor-outlet="#${templateSettingsHostId}" data-action="settings-editor:loaded->template-settings#loaded turbo:frame-missing->settings-editor#frameMissing keydown->template-settings#keydown keydown@window->template-settings#developerKey keyup@window->template-settings#developerKey blur@window->template-settings#developerKey">
    ${frame}${guard}
  </div>`;
}

/** Global workspace settings as their own editor frame, shown in app Settings. */
export async function renderGlobalWorkspaceSettingsFrame(location: TemplateSettingsLocation = {}, saved = false, submittedPath?: string): Promise<string> {
  const records = await scopeSettings(globalWorkspaceConfiguration);
  const destinations = await getPrivateNetworkAccess(globalWorkspaceConfiguration);
  const section = sectionFor(location.section);
  const current = { section: section ?? "index", editor: location.editor };
  const e = editors(globalWorkspaceConfiguration, current, saved);
  assertRecordExists(e, records, current);
  return `<turbo-frame id="${globalWorkspaceSettingsFrameId}" data-settings-editor-target="frame"><div class="template-settings-inline-body" ${editorContentAttributes(globalWorkspaceSettingsUrl, section ? editorKey(section, location.editor) : undefined, submittedPath)}>
    ${editorErrorsHtml(globalWorkspaceSettingsErrorId)}
    ${configurationSections(e, records, undefined, destinations)}
  </div></turbo-frame>`;
}

export async function renderGlobalWorkspaceSettings(): Promise<string> {
  return `<section class="settings-sec" data-controller="settings-editor" data-action="turbo:frame-missing->settings-editor#frameMissing">${await renderGlobalWorkspaceSettingsFrame()}</section>`;
}
