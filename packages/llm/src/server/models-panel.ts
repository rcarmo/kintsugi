import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { connectCustomOpenAIEndpoint, customOpenAIProtocols, customOpenAIDefaults, CustomEndpointInputError, type CustomOpenAIProtocol, type CustomOpenAIEndpointInput } from "./custom-openai-endpoint.ts";
import { availableProviderModels } from "./known-model-provider-incorrectness.ts";
import { anthropicSubscriptionNotice } from "./subscription.ts";
import { listAccounts, providerLabel, sortByPopularity, type Account } from "./accounts.ts";
import { modelUnavailableReason, providerAvailability } from "./provider-availability.ts";
import { providerUsageFrameId, supportedUsageProviders } from "./provider-usage.ts";
import { getPopularModelRank, getPopularProviderRank, getProviderApiKeyExample, modelDisplayName } from "./hardcoded-provider-knowledge.ts";
import { modelRefValue as modelKey, parseModelRef, type ModelRef } from "./model-reference.ts";
import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { buttonHtml } from "@kintsugi/design-system/button";
import { copyButtonHtml } from "@kintsugi/design-system/copy-button";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { kintsugiBrandIconHtml, Icons } from "@kintsugi/design-system/icons";
import { warningBannerHtml } from "@kintsugi/design-system/warning-banner";
import {
  connectModelProviderApiKey,
  ProviderCatalogueRefreshError,
  createPiModelRuntime,
  refreshPiModelCatalogue,
  disconnectModelProvider,
  getEnabledModels,
  getCustomModelsJson,
  hasAvailableEnabledModel,
  seedProviderEnabledModels,
  loginPiOAuthProvider,
  setCustomModelsJson,
  setEnabledModels,
  type PiAuthPrompt,
} from "./pi-config-models.ts";
import { domId, errorMessage, escapeHtml, providerBadgeHtml, providerBrandIconHtml } from "@kintsugi/shared";
import { replace, response, stream, update } from "@kintsugi/shared/http";

/**
 * One Models panel, shown in three places: the Models dialog (from composers and the
 * usage ring), the Settings section, and onboarding. Only Settings offers Advanced, and
 * only onboarding has Continue.
 */
type ModelsHost = "dialog" | "settings" | "onboarding";
const modelsHosts: readonly ModelsHost[] = ["dialog", "settings", "onboarding"];

const ids = {
  panel: (host: ModelsHost) => domId("models_panel", host),
  connect: (host: ModelsHost) => domId("models_connect", host),
  reconnect: (host: ModelsHost, provider: string) => domId("models_reconnect", host, provider),
  connectionStep: (host: ModelsHost, provider: string, reconnect: boolean) => reconnect ? ids.reconnect(host, provider) : ids.connect(host),
  otherProviders: (host: ModelsHost) => domId("models_other_providers", host),
  enabledModels: (host: ModelsHost) => domId("models_enabled_models", host),
  enabledSection: (host: ModelsHost) => domId("models_enabled_section", host),
  catalogueRefresh: "models_catalogue_refresh",
  catalogue: (host: ModelsHost) => domId("models_catalogue", host),
  catalogueRow: (host: ModelsHost, model: ModelRef) => domId("models_catalogue_row", host, model.provider, model.id),
  continue: (host: ModelsHost) => domId("models_continue", host),
  dialog: (host: ModelsHost) => host === "onboarding" ? "onboarding_dialog" : "models_dialog",
};

type Runtime = Awaited<ReturnType<typeof createPiModelRuntime>>;
type AuthMethod = "oauth" | "api_key";
type ProviderChoice = { provider: string; label: string; methods: AuthMethod[] };

function providerChoices(runtime: Runtime): ProviderChoice[] {
  return sortByPopularity(runtime.getProviders().map((provider) => ({
    provider: provider.id,
    label: providerLabel(provider),
    methods: [provider.auth.oauth && "oauth", provider.auth.apiKey?.login && "api_key"].filter((method): method is AuthMethod => Boolean(method)),
  })));
}

type CatalogueEntry = ModelRef & { label: string; providerLabel: string; enabled: boolean };

/** Every model the connected accounts offer, popular providers and models first. */
async function catalogue(runtime: Runtime, accounts: Account[]): Promise<CatalogueEntry[]> {
  const enabledModels = new Set((await getEnabledModels()).map(modelKey));
  const perProvider = await Promise.all(accounts.filter((account) => account.connection === "connected").map(async (account) => {
    const rank = (id: string) => getPopularModelRank(account.provider, id) ?? Number.MAX_SAFE_INTEGER;
    return (await availableProviderModels(runtime, account.provider))
      .map((model): CatalogueEntry => ({ provider: account.provider, id: model.id, label: modelDisplayName(model.name ?? model.id), providerLabel: account.label, enabled: enabledModels.has(modelKey({ provider: account.provider, id: model.id })) }))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label));
  }));
  return perProvider.flat();
}

function hostQuery(host: ModelsHost): string { return `host=${host}`; }

function providerIcon(provider: string, label: string): string {
  return `<span aria-hidden="true">${providerBadgeHtml(provider, label, "settings-provider-icon")}</span>`;
}

/** What the card says in place of usage limits; undefined when it can show them. */
function usageNote(account: Account): string | undefined {
  const usage = supportedUsageProviders.find((supported) => supported.id === account.provider);
  if (account.connection === "needs_attention") return usage
    ? "Sign in again to use this provider and see its usage."
    : "Sign in again to use this provider.";
  if (account.method !== "subscription" && usage?.credential !== "api_key") return "API keys don’t have usage limits to show.";
  if (account.provider === "openai") return "Check your subscription usage on ChatGPT.";
  if (!usage) return `Kintsugi can’t read ${account.label} usage limits yet.`;
  return undefined;
}

/** The only place a connected provider shows up: rings while closed, limits and actions when open. */
function renderAccountCard(account: Account, host: ModelsHost, open: boolean): string {
  const usagePath = `/usage/providers/${encodeURIComponent(account.id)}`;
  const note = usageNote(account);
  const rings = note ? "" : `<turbo-frame class="usage-rings" id="${providerUsageFrameId("rings", account.id, host)}" src="${usagePath}/rings?scope=${host}"></turbo-frame>`;
  const usageLink = account.provider === "openai" && account.method === "subscription"
    ? actionLinkHtml({ href: "https://chatgpt.com/settings/usage", variant: "secondary", content: { kind: "caption", caption: "View usage on ChatGPT" }, attributesHtml: 'target="_blank" rel="noreferrer"' })
    : "";
  const usage = note
    ? `<p class="usage-caption">${escapeHtml(note)}</p>${usageLink ? `<div class="model-account__actions">${usageLink}</div>` : ""}`
    : `<turbo-frame class="model-provider-usage" id="${providerUsageFrameId("limits", account.id, host)}" src="${usagePath}/limits?scope=${host}" loading="lazy"><p class="usage-caption" role="status"><span class="status-spinner" aria-hidden="true"></span> Checking usage…</p></turbo-frame>`;
  const notice = account.provider === "anthropic" && account.method === "subscription" ? warningBannerHtml(anthropicSubscriptionNotice) : "";
  const reconnect = account.method === "subscription" && account.connection === "needs_attention"
    ? `<form method="post" action="/models/providers/${encodeURIComponent(account.provider)}/connect?${hostQuery(host)}&reconnect=1" data-turbo="true">${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Sign in again" } })}</form>`
    : "";
  const disconnect = `<form method="post" action="/models/providers/${encodeURIComponent(account.provider)}/forget?${hostQuery(host)}" data-turbo="true">${destructiveConfirmationHtml({
    id: domId("forget_provider", host, account.id),
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Disconnect" } },
    confirmCaption: "Disconnect",
    cancelCaption: "Cancel",
  })}</form>`;
  const summary = {
    kind: "multiline" as const,
    width: "fill" as const,
    label: { kind: "text" as const, text: account.label },
    description: account.connection === "needs_attention" ? "Sign-in needs attention" : account.description,
    leadingHtml: providerIcon(account.provider, account.label),
    trailingHtml: rings,
  };
  const actions = `<div class="model-account__actions">${reconnect}${disconnect}</div>`;
  // Signing in again happens right here in the card, in place of its actions.
  const actionsHtml = reconnect ? `<turbo-frame id="${ids.reconnect(host, account.provider)}" class="model-connect">${actions}</turbo-frame>` : actions;
  return `<div class="model-account">${disclosureHtml({ summary, open: open || account.connection === "needs_attention", bodyHtml: `<div class="form-section">${notice}${usage}${actionsHtml}</div>` })}</div>`;
}

function renderProviderChoice(provider: Pick<ProviderChoice, "provider" | "label">, host: ModelsHost, width: "fit" | "fill" = "fit", customApi?: CustomOpenAIProtocol): string {
  const attributes = customApi
    ? `method="get" action="/models/custom-endpoints/new" data-turbo-frame="${ids.connect(host)}"`
    : `method="post" action="/models/providers/${encodeURIComponent(provider.provider)}/connect?${hostQuery(host)}" data-turbo="true"`;
  const fields = customApi ? `<input type="hidden" name="host" value="${host}"><input type="hidden" name="api" value="${customApi}">` : "";
  return `<form class="model-provider-choice" ${attributes}>${fields}${contentRowHtml({
    kind: "multiline",
    width,
    element: { tag: "button", attributesHtml: 'type="submit"' },
    label: { kind: "text", text: provider.label },
    leadingHtml: providerIcon(provider.provider, provider.label),
  })}</form>`;
}

function renderOtherProviders(providers: ProviderChoice[], host: ModelsHost, query = ""): string {
  const normalized = query.trim().toLowerCase();
  const matching = providers.filter((provider) => `${provider.label} ${provider.provider}`.toLowerCase().includes(normalized));
  const customProtocols = customOpenAIProtocols.filter(protocol => `${protocol.name} ${protocol.id}`.toLowerCase().includes(normalized));
  const customChoices = customProtocols.map(protocol => renderProviderChoice({ provider: "openai", label: protocol.name }, host, "fill", protocol.id)).join("");
  const choices = matching.map((provider) => renderProviderChoice(provider, host, "fill")).join("") + customChoices;
  return `<turbo-frame id="${ids.otherProviders(host)}"><div class="model-providers" tabindex="0" role="region" aria-label="Other model providers">${choices || '<div class="managed-list__empty" role="status">No matching model providers.</div>'}</div></turbo-frame>`;
}

function connectFrame(host: ModelsHost, body: string, frameId = ids.connect(host)): string {
  return `<turbo-frame id="${frameId}" class="model-connect">${body}</turbo-frame>`;
}

/** Providers without an account yet, split into popular ones and the rest. */
function unconnectedProviders(runtime: Runtime, accounts: Account[]) {
  const connected = new Set(accounts.map((account) => account.provider));
  const choices = providerChoices(runtime).filter((provider) => !connected.has(provider.provider));
  const popular = choices.filter((provider) => getPopularProviderRank(provider.provider) !== undefined);
  return { popular, other: choices.filter((provider) => !popular.includes(provider)) };
}

/** Always offer popular providers up front, with the rest behind a search. */
function renderConnectChoices(host: ModelsHost, runtime: Runtime, accounts: Account[]): string {
  const { popular, other } = unconnectedProviders(runtime, accounts);
  return connectFrame(host, `<div class="model-provider-groups">
    <h3 class="models-panel__heading">Connect model providers</h3>
    <div class="model-popular-providers">${popular.map((provider) => renderProviderChoice(provider, host)).join("")}</div>
    ${disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Other model providers" } }, bodyHtml: `<div class="model-other-providers-body"><form method="get" action="/models/connect/providers" data-controller="server-filter" data-action="input->server-filter#submit" data-turbo-frame="${ids.otherProviders(host)}">
        <input type="hidden" name="host" value="${host}"><input class="text-field" type="search" name="q" placeholder="Find a provider…" aria-label="Find a provider" autocomplete="off"><button type="submit" hidden>Search</button>
      </form>${renderOtherProviders(other, host)}</div>` })}
  </div>`);
}

async function renderEnabledModelsList(runtime: Runtime, host: ModelsHost): Promise<string> {
  const enabledModels = await getEnabledModels();
  const availability = await providerAvailability(runtime, enabledModels.map((model) => model.provider));
  const labels = new Map(runtime.getProviders().map((provider) => [provider.id, providerLabel(provider)]));
  const rows = enabledModels.map((model) => {
    const reason = modelUnavailableReason(availability.get(model.provider)!, model, runtime);
    const providerName = labels.get(model.provider) ?? model.provider;
    return `<div class="managed-list__item">
      <span class="managed-list__visual" aria-hidden="true">${providerBrandIconHtml(model.provider, providerName)}</span>
      <div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text" title="${escapeHtml(model.id)}">${escapeHtml(model.label)}</span></div><div class="managed-list__description">${escapeHtml(reason ? `${providerName} · ${reason}` : providerName)}</div></div>
      <div class="managed-list__actions"><form method="post" action="/models/enabled-models/disable?${hostQuery(host)}" data-turbo="true"><input type="hidden" name="model" value="${escapeHtml(modelKey(model))}">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: `Disable ${model.label}` } })}</form></div>
    </div>`;
  }).join("");
  return `<div id="${ids.enabledModels(host)}" class="managed-list enabled-models" data-controller="managed-list"><div class="managed-list__items">${rows}</div>${rows ? "" : '<div class="managed-list__empty">No enabled models yet. Find a model below to enable it.</div>'}</div>`;
}

function catalogueRow(model: CatalogueEntry, host: ModelsHost): string {
  return `<form id="${ids.catalogueRow(host, model)}" method="post" action="/models/enabled-models/enable?${hostQuery(host)}" data-turbo="true">
    <input type="hidden" name="model" value="${escapeHtml(modelKey(model))}">
    ${contentRowHtml({
      width: "fill",
      kind: "multiline",
      element: { tag: "button", attributesHtml: `type="submit"${model.enabled ? " disabled" : ""} title="${escapeHtml(model.id)}"` },
      label: { kind: "text", text: model.label },
      description: model.providerLabel,
      leadingHtml: providerBrandIconHtml(model.provider, model.providerLabel),
      trailingHtml: model.enabled ? '<span class="usage-caption">Enabled</span>' : Icons.Plus,
    })}
  </form>`;
}

function renderCatalogue(entries: CatalogueEntry[], host: ModelsHost, query: string): string {
  const normalized = query.trim().toLowerCase();
  const matching = entries.filter((model) => `${model.label} ${model.id} ${model.providerLabel}`.toLowerCase().includes(normalized));
  return `<turbo-frame class="model-provider-results" id="${ids.catalogue(host)}"><div class="model-provider-models" tabindex="0" role="region" aria-label="All models">${matching.map((model) => catalogueRow(model, host)).join("") || '<div class="managed-list__empty">No matching models.</div>'}</div></turbo-frame>`;
}

async function renderEnabledModelsSection(runtime: Runtime, accounts: Account[], host: ModelsHost, focus: boolean): Promise<string> {
  return `<section class="models-panel__section" id="${ids.enabledSection(host)}" aria-labelledby="${domId("models_enabled_models_section", host)}">
    <header class="models-panel__header">
      <h3 class="models-panel__heading" id="${domId("models_enabled_models_section", host)}">Enabled models</h3>
      <p class="models-panel__hint">Choose which models appear in the composer.</p>
    </header>
    ${await renderEnabledModelsList(runtime, host)}
    <div class="managed-list" data-controller="managed-list" data-managed-list-server-filter="true"><form class="managed-list__filter" method="get" action="/models/catalogue" data-controller="server-filter" data-action="input->server-filter#submit" data-turbo-frame="${ids.catalogue(host)}">
      <input type="hidden" name="host" value="${host}">
      <input class="text-field" type="search" name="q" placeholder="Find a model to enable…" aria-label="Find a model to enable" autocomplete="off"${focus ? " autofocus" : ""}><button type="submit" hidden>Search</button>
    </form>${renderCatalogue(await catalogue(runtime, accounts), host, "")}</div>
  </section>`;
}

function continueButton(host: ModelsHost, ready: boolean): string {
  return `<span id="${ids.continue(host)}">${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Continue" }, disabled: !ready })}</span>`;
}

function onboardingActions(ready: boolean): string {
  return `<div class="model-setup-actions models-panel__actions">
    <form method="post" action="/onboarding/finish" data-turbo="true">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Set up later" } })}</form>
    <form method="post" action="/models/finish" data-turbo="true">${continueButton("onboarding", ready)}</form>
  </div>`;
}

const customModelsPlaceholder = `{
  "providers": {
    "openai-codex": {
      "models": [
        {
          "id": "gpt-6-astra",
          "name": "GPT-6 Astra",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000
        }
      ]
    }
  }
}`;

type CustomModelsView = { source: string; open?: boolean; error?: string; status?: string };

function renderCatalogueRefresh(feedback: Pick<CustomModelsView, "error" | "status"> = {}): string {
  const refreshButton = buttonHtml({
    type: "submit",
    variant: "secondary",
    content: { kind: "caption", caption: "Refresh model catalogue" },
    attributesHtml: 'data-turbo-submits-with="Refreshing…"',
  });
  return `<section class="models-panel__section" id="${ids.catalogueRefresh}" aria-labelledby="models_catalogue_refresh_heading">
    <header class="models-panel__header">
      <h3 class="models-panel__heading" id="models_catalogue_refresh_heading">Built-in model catalogue</h3>
      <p class="models-panel__hint">Fetch the latest model definitions without updating Kintsugi.</p>
    </header>
    <form method="post" action="/models/catalogue/refresh" data-turbo="true">${refreshButton}</form>
    ${feedback.error ? `<p class="settings-error" role="alert">${escapeHtml(feedback.error)}</p>` : ""}
    ${feedback.status ? `<p role="status">${escapeHtml(feedback.status)}</p>` : ""}
  </section>`;
}

function renderCustomModelsSettings(view: CustomModelsView): string {
  const saveButton = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Validate and save" } });
  return `<div class="custom-models-settings">${disclosureHtml({ element: { id: "custom_models_settings" }, open: view.open, summary: { kind: "compact", label: { kind: "text", text: "Advanced model settings" } }, bodyHtml: `
    <form class="custom-models-form form-stack" method="post" action="/models/custom" data-turbo="true">
      <div><label for="custom_models_json">Custom Pi model configuration</label><p>Paste a Pi <code>models.json</code> object containing <code>providers</code>. Custom models are merged with the official catalogue.</p></div>
      <textarea class="textarea custom-models-json" id="custom_models_json" name="models" placeholder="${escapeHtml(customModelsPlaceholder)}" spellcheck="false" autocomplete="off">${escapeHtml(view.source)}</textarea>
      ${view.error ? `<p class="settings-error" role="alert">${escapeHtml(view.error)}</p>` : ""}
      ${view.status ? `<p class="custom-models-status" role="status">${escapeHtml(view.status)}</p>` : ""}
      <div class="custom-models-actions">${saveButton}</div>
    </form>
  ` })}</div>`;
}

type PanelOptions = {
  /** An account id to open, or "models" to start in the model search. */
  focus?: string;
  /** Replaces the connect area, e.g. with a sign-in already under way. */
  connectHtml?: string;
  error?: string;
  customModels?: Omit<CustomModelsView, "source">;
};

async function renderModelsPanel(host: ModelsHost, options: PanelOptions = {}): Promise<string> {
  const runtime = await createPiModelRuntime();
  const accounts = await listAccounts(runtime);
  const connect = options.connectHtml ?? renderConnectChoices(host, runtime, accounts);
  const providers = `${accounts.length ? `<section class="models-panel__section" aria-labelledby="${domId("models_providers", host)}">
    <h3 class="models-panel__heading" id="${domId("models_providers", host)}">Enabled model providers</h3>
    <div class="model-accounts">${accounts.map((account) => renderAccountCard(account, host, options.focus === account.id)).join("")}</div>
  </section>` : ""}
  ${connect}`;
  const models = accounts.length ? await renderEnabledModelsSection(runtime, accounts, host, options.focus === "models") : "";
  const advanced = host === "settings" ? renderCustomModelsSettings({ source: await getCustomModelsJson(), ...options.customModels }) : "";
  const actions = host === "onboarding" ? onboardingActions(await hasAvailableEnabledModel()) : "";
  const error = options.error ? `<p class="settings-error" role="alert">${escapeHtml(options.error)}</p>` : "";
  return `<div id="${ids.panel(host)}" class="models-panel">${error}${host === "settings" ? renderCatalogueRefresh() : ""}${providers}${models}${advanced}${actions}</div>`;
}

type DialogHost = Exclude<ModelsHost, "settings">;

function modelsDialogHtml(host: DialogHost, bodyHtml: string): string {
  return dialogHtml({
    element: { id: ids.dialog(host), attributesHtml: "data-dialog-auto-show" },
    iconHtml: host === "onboarding" ? kintsugiBrandIconHtml : Icons.Settings,
    titleCaption: host === "onboarding" ? "Set up Kintsugi" : "Models",
    bodyHtml,
    omitCancelButton: host === "onboarding",
  });
}

/** The Models dialog; onboarding shows the same panel as its last step. */
export async function renderModelsDialog(options: { host?: DialogHost; focus?: string; connect?: string } = {}): Promise<string> {
  const host = options.host ?? "dialog";
  const connectHtml = options.connect ? await connectStep(options.connect, host) : undefined;
  return modelsDialogHtml(host, await renderModelsPanel(host, { focus: options.focus, connectHtml }));
}

async function renderModelsSettings(): Promise<string> {
  return `<section class="settings-sec settings-sec-models" id="settings-sec-models">${await renderModelsPanel("settings")}</section>`;
}
export const modelSettingsContribution = { id: "models", label: "Models", order: 40, render: renderModelsSettings };

function providerHeading(provider: Pick<ProviderChoice, "provider" | "label">): string {
  return `<div class="model-setup-heading">${providerBadgeHtml(provider.provider, provider.label, "settings-provider-icon")}<span>${escapeHtml(provider.label)}</span></div>`;
}
function backToChoices(host: ModelsHost): string {
  return actionLinkHtml({ href: `/models/connect?${hostQuery(host)}`, variant: "secondary", content: { kind: "caption", caption: "Back" } });
}
/** Every connection state supplies content; this shell alone owns its placement. */
function renderConnectionStep(provider: Pick<ProviderChoice, "provider" | "label">, host: ModelsHost, options: {
  bodyHtml: string;
  actionsHtml?: string;
  attributesHtml?: string;
  /** About the provider account itself, which its card shows once connected. */
  noticeHtml?: string;
  /** Signing in again inside the provider's card, which already names the provider and shows its notice. */
  reconnect?: boolean;
}): string {
  return connectFrame(host, `<div id="model_connection_step" class="model-provider-connection${options.reconnect ? " model-provider-connection--reconnect" : ""}"${options.attributesHtml ? ` ${options.attributesHtml}` : ""}>
    ${options.reconnect ? "" : providerHeading(provider)}
    <div class="model-connection-content">
      ${options.reconnect ? "" : options.noticeHtml ?? ""}
      ${options.bodyHtml}
    </div>
    <div class="model-setup-actions">${options.actionsHtml ?? backToChoices(host)}</div>
  </div>`, ids.connectionStep(host, provider.provider, options.reconnect ?? false));
}
function openAISignInNotice(provider: string): string {
  return provider === "openai" ? warningBannerHtml({
    title: "We recommend ChatGPT / Codex instead",
    message: "For a ChatGPT subscription, use the ChatGPT / Codex login flow. It works with both the builtin agent and Pi.",
  }) : "";
}

function renderConnectionMethods(provider: ProviderChoice, host: ModelsHost): string {
  return renderConnectionStep(provider, host, {
    bodyHtml: `${openAISignInNotice(provider.provider)}<div class="model-setup-choices">${provider.methods.map((method) => `<form method="post" action="/models/providers/${encodeURIComponent(provider.provider)}/connect?${hostQuery(host)}&method=${method}" data-turbo="true">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: method === "oauth" ? "Use subscription" : "Use API key" } })}</form>`).join("")}</div>`,
  });
}
function renderApiKeyConnectionStep(provider: ProviderChoice, host: ModelsHost, error = ""): string {
  const inputId = domId("provider_api_key", provider.provider);
  const formId = domId("provider_api_key_form", provider.provider);
  return renderConnectionStep(provider, host, {
    bodyHtml: `${error ? `<p class="settings-error" role="alert">${escapeHtml(error)}</p>` : ""}
      <form id="${formId}" class="form-stack" method="post" action="/models/providers/${encodeURIComponent(provider.provider)}/api-key?${hostQuery(host)}" data-turbo="true">
        <input id="${inputId}" class="text-field" type="password" aria-label="API key" data-1p-ignore name="secret" placeholder="${escapeHtml(getProviderApiKeyExample(provider.provider) ?? "API key")}" autocomplete="off" required autofocus>
      </form>`,
    actionsHtml: backToChoices(host) + buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Connect" }, attributesHtml: `form="${formId}"` }),
  });
}

function renderCustomEndpointStep(host: ModelsHost, protocol: typeof customOpenAIProtocols[number], values: Partial<Omit<CustomOpenAIEndpointInput, "api" | "apiKey">> = {}, error = ""): string {
  const formId = domId("custom_endpoint_form", host);
  const field = (name: string, label: string, value: string, attributes = "") => `<div><label for="${formId}_${name}">${label}</label><input class="text-field" id="${formId}_${name}" name="${name}" value="${escapeHtml(value)}" ${attributes}></div>`;
  const advanced = disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Advanced settings" } }, bodyHtml: `<div class="form-stack">
    <p>Model listings don't include reliable limits. These apply to every model added here; adjust them to match your server.</p>
    ${field("contextWindow", "Context window (tokens)", String(values.contextWindow ?? customOpenAIDefaults.contextWindow), 'type="number" min="1" step="1" required')}
    ${field("maxTokens", "Maximum output tokens", String(values.maxTokens ?? customOpenAIDefaults.maxTokens), 'type="number" min="1" step="1" required')}
  </div>` });
  return renderConnectionStep({ provider: "openai", label: protocol.name }, host, {
    bodyHtml: `${error ? `<p class="settings-error" role="alert">${escapeHtml(error)}</p>` : ""}
      <form id="${formId}" class="form-stack" method="post" action="/models/custom-endpoints?${hostQuery(host)}" data-turbo="true">
        <input type="hidden" name="api" value="${protocol.id}">
        ${field("name", "Name", values.name ?? "", 'required placeholder="DevBox Ollama" autofocus')}
        ${field("baseUrl", "Base URL", values.baseUrl ?? "", 'type="url" required placeholder="https://models.example.com/v1"')}
        <div><label for="${formId}_key">API key (optional)</label><input class="text-field" id="${formId}_key" type="password" name="secret" autocomplete="off" data-1p-ignore><p>Leave blank for servers without authentication.</p></div>
        <p>Fetch models, then enable the ones you want. Or connect by model ID.</p>
        ${field("modelId", "Model ID (for manual connection)", values.modelId ?? "", 'placeholder="local-coder"')}
        ${advanced}
        <p>Private endpoints must be reachable from the app. Workspace network restrictions still apply.</p>
      </form>`,
    actionsHtml: backToChoices(host)
      + buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Connect model ID" }, attributesHtml: `form="${formId}" name="action" value="manual" data-turbo-submits-with="Connecting…"` })
      + buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Fetch models and connect" }, attributesHtml: `form="${formId}" name="action" value="discover" data-turbo-submits-with="Fetching models…"` }),
  });
}

/** The next connection step for a provider: its sign-in methods, or the only one it has. */
async function connectStep(providerId: string, host: ModelsHost, requestedMethod?: string): Promise<string> {
  const runtime = await createPiModelRuntime();
  const provider = providerChoices(runtime).find((candidate) => candidate.provider === providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  const method = provider.methods.find((candidate) => candidate === requestedMethod) ?? (provider.methods.length === 1 ? provider.methods[0] : undefined);
  if (method === "oauth") return renderOAuthConnectionStep(await startOAuthFlow({ ...provider, host, reconnect: false }));
  if (method === "api_key") return renderApiKeyConnectionStep(provider, host);
  return renderConnectionMethods(provider, host);
}

type PendingPrompt = { input: Exclude<PiAuthPrompt, { type: "select" }>; resolve: (value: string) => void; reject: (error: Error) => void };
type PendingOAuthFlow = {
  id: string;
  provider: string;
  label: string;
  host: ModelsHost;
  reconnect: boolean;
  revision: number;
  loginMethod: "default" | "browser";
  status: "pending" | "complete" | "error";
  abort: AbortController;
  authUrl?: string;
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  prompt?: PendingPrompt;
  redirectSubmitted?: boolean;
  error?: string;
};

const pendingOAuthFlows = new Map<string, PendingOAuthFlow>();

async function startOAuthFlow(target: Pick<PendingOAuthFlow, "provider" | "label" | "host" | "reconnect">, loginMethod: PendingOAuthFlow["loginMethod"] = "default"): Promise<PendingOAuthFlow> {
  // The credential runtime serializes logins per provider. An abandoned dialog must
  // not leave the next attempt queued behind a device code nobody will approve.
  for (const previous of pendingOAuthFlows.values()) {
    if (previous.provider !== target.provider || previous.status !== "pending") continue;
    previous.status = "error";
    previous.error = "This sign-in was replaced by a newer attempt. Start again to connect.";
    previous.prompt = undefined;
    previous.abort.abort();
  }
  const flow: PendingOAuthFlow = { id: crypto.randomUUID(), provider: target.provider, label: target.label, host: target.host, reconnect: target.reconnect, loginMethod, revision: 0, status: "pending", abort: new AbortController() };
  pendingOAuthFlows.set(flow.id, flow);
  void loginPiOAuthProvider(target.provider, {
    signal: flow.abort.signal,
    notify: (event) => {
      if (event.type === "auth_url") { flow.revision++; flow.authUrl = event.url; }
      else if (event.type === "device_code") { flow.revision++; flow.userCode = event.userCode; flow.verificationUri = event.verificationUri; flow.intervalSeconds = event.intervalSeconds; }
    },
    prompt: (prompt) => handleOAuthPrompt(flow, prompt),
  }).then(async () => {
    await seedProviderEnabledModels(target.provider);
    flow.status = "complete";
    flow.prompt = undefined;
  }).catch((error) => {
    if (flow.abort.signal.aborted) return;
    flow.status = "error";
    flow.prompt = undefined;
    flow.error = errorMessage(error);
  });
  await waitForOAuthFlowReady(flow);
  return flow;
}

function handleOAuthPrompt(flow: PendingOAuthFlow, prompt: PiAuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    const selected = flow.loginMethod === "browser"
      ? prompt.options.find((option) => option.id === "browser")?.id
      : prompt.options.find((option) => /device|headless/i.test(`${option.id} ${option.label ?? ""}`))?.id
        ?? prompt.options.find((option) => /default/i.test(option.label ?? ""))?.id
        ?? prompt.options[0]?.id;
    if (!selected) return Promise.reject(new Error("No OAuth login option available"));
    return Promise.resolve(selected);
  }

  return new Promise<string>((resolve, reject) => {
    const abort = () => {
      if (flow.prompt?.reject === reject) flow.prompt = undefined;
      reject(new Error("OAuth prompt cancelled"));
    };
    if (prompt.signal?.aborted || flow.abort.signal.aborted) return abort();
    prompt.signal?.addEventListener("abort", abort, { once: true });
    flow.abort.signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      prompt.signal?.removeEventListener("abort", abort);
      flow.abort.signal.removeEventListener("abort", abort);
    };
    const finish = (value: string) => {
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    flow.revision++;
    flow.prompt = { input: prompt, resolve: finish, reject: fail };
  });
}

async function waitForOAuthFlowReady(flow: PendingOAuthFlow): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && flow.status === "pending" && !flow.authUrl && !flow.verificationUri && !flow.prompt) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function oauthStatus(kind: "pending" | "done", title: string, detail: string): string {
  return `<ul class="status-list"><li class="status-list__item" ${kind === "done" ? 'role="checkbox" aria-checked="true"' : 'aria-busy="true"'}><span class="status-list__marker">${kind === "done" ? Icons.Check : ""}</span><span>${escapeHtml(title)} — ${escapeHtml(detail)}</span></li></ul>`;
}

function oauthAuthenticationAction(flow: PendingOAuthFlow, url: string, hidden = false, caption?: string): string {
  const authenticationName = flow.provider === "openai-codex" || flow.provider === "openai" ? "OpenAI" : flow.label;
  const signInMethod = flow.provider === "openai-codex" ? `${flow.verificationUri ? "device-code" : "browser"} sign-in` : "sign-in";
  return actionLinkHtml({
    href: url,
    variant: "primary",
    content: { kind: "caption", caption: caption ?? `Open ${authenticationName} ${signInMethod} page` },
    attributesHtml: `target="_blank" rel="noreferrer"${hidden ? ' data-oauth-device-auth hidden data-action="oauth-flow#showWaitingStatus"' : ""}`,
  });
}

function oauthDeviceCodeBody(flow: PendingOAuthFlow, complete = false): string {
  const copyButton = copyButtonHtml({
    label: `Copy ${flow.userCode ?? ""} into clipboard`,
    caption: `Copy ${flow.userCode ?? ""}`,
    copyText: flow.userCode ?? "",
    action: "oauth-flow#showDeviceAuth",
  });
  const confirmationName = flow.provider === "openai-codex" ? "OpenAI-Codex" : flow.label;
  const status = complete
    ? `<p class="settings-oauth-waiting-status" role="status"><span class="settings-oauth-complete-marker" aria-hidden="true">✓</span><span>${escapeHtml(flow.label)} connected</span></p>`
    : `<p class="settings-oauth-waiting-status" data-oauth-waiting-status hidden><span class="status-spinner" aria-hidden="true"></span><span>Waiting for ${escapeHtml(confirmationName)}…</span></p>`;
  return `<div class="settings-oauth-card">
    ${copyButton}
    ${oauthAuthenticationAction(flow, flow.verificationUri ?? "#", !complete)}
    ${status}
  </div>`;
}

function oauthFlowPath(flow: PendingOAuthFlow, action: "status" | "prompt" | "finish" | "cancel" | "browser"): string {
  return `/models/providers/${encodeURIComponent(flow.provider)}/oauth/${encodeURIComponent(flow.id)}/${action}`;
}

function oauthRedirectFormId(flow: PendingOAuthFlow): string {
  return domId("oauth_redirect_form", flow.id);
}

/** `copyCodeHint` replaces the visible label: the field then only carries the hint as its placeholder. */
function oauthPromptForm(flow: PendingOAuthFlow, copyCodeHint?: string): string {
  if (!flow.prompt) return "";
  const prompt = flow.prompt.input;
  const inputId = domId("oauth_prompt", flow.id);
  const label = copyCodeHint ? "" : `<label for="${inputId}">${escapeHtml(prompt.message)}</label>`;
  const placeholder = copyCodeHint ?? prompt.placeholder ?? "";
  return `<form id="${oauthRedirectFormId(flow)}" class="settings-oauth-card" method="post" action="${oauthFlowPath(flow, "prompt")}" data-turbo="true">${label}<input id="${inputId}" class="settings-input text-field" type="${prompt.type === "secret" ? "password" : "text"}" name="value" data-1p-ignore placeholder="${escapeHtml(placeholder)}"${copyCodeHint ? ` aria-label="${escapeHtml(copyCodeHint)}"` : ""}${prompt.type === "manual_code" || prompt.type === "secret" ? " required" : ""}></form>`;
}

/** Providers either redirect to a localhost page that won't load here, or show a code to copy on their own page. */
function oauthRedirectsToLocalhost(flow: PendingOAuthFlow): boolean {
  const redirect = flow.authUrl ? new URL(flow.authUrl).searchParams.get("redirect_uri") : null;
  return !redirect || ["localhost", "127.0.0.1"].includes(new URL(redirect).hostname);
}

function oauthBrowserRedirectBody(flow: PendingOAuthFlow): string {
  const prompt = flow.prompt;
  const localhost = oauthRedirectsToLocalhost(flow);
  const promptForm = localhost ? oauthPromptForm(flow) : oauthPromptForm(flow, `Paste the code from the ${flow.label} page here`);
  return `<div class="settings-oauth-card">
    ${localhost ? "<p>After signing in, copy the localhost URL here—even if that page won’t load.</p>" : ""}
    ${oauthAuthenticationAction(flow, flow.authUrl ?? "#", false, flow.provider === "anthropic" ? "Open Anthropic auth page" : localhost ? undefined : `Open ${flow.label} page to get the code`)}
    ${promptForm}
    ${!prompt && flow.redirectSubmitted ? oauthStatus("pending", `Waiting for ${flow.label}`, localhost ? "Confirming the pasted redirect URL." : "Confirming the pasted code.") : ""}
  </div>`;
}

function oauthCompleteBody(flow: PendingOAuthFlow): string {
  if (flow.verificationUri) return oauthDeviceCodeBody(flow, true);
  return `<div class="settings-oauth-card">${oauthStatus("done", `${flow.label} connected`, "Pick the models you want below.")}</div>`;
}

function canSwitchToBrowserAuth(flow: PendingOAuthFlow): boolean {
  return flow.provider === "openai-codex" && flow.loginMethod === "default" && flow.status !== "complete";
}

function oauthAlternateLoginAction(flow: PendingOAuthFlow): string {
  if (!canSwitchToBrowserAuth(flow)) return "";
  return `<form method="post" action="${oauthFlowPath(flow, "browser")}" data-turbo="true">${buttonHtml({
    type: "submit",
    variant: flow.status === "error" ? "primary" : "secondary",
    content: { kind: "caption", caption: "Try browser auth flow instead" },
    attributesHtml: 'data-turbo-submits-with="Starting sign-in…"',
  })}</form>`;
}

function renderOAuthConnectionStep(flow: PendingOAuthFlow): string {
  const pollMs = Math.max(1500, Math.min(15000, (flow.intervalSeconds ?? 3) * 1000));
  const exitButton = buttonHtml({
    type: "submit",
    variant: flow.status === "complete" ? "primary" : "secondary",
    content: { kind: "caption", caption: flow.status === "complete" ? "Done" : "Back" },
  });
  const submitUrlButton = buttonHtml({
    type: "submit",
    variant: "primary",
    content: { kind: "caption", caption: flow.authUrl ? oauthRedirectsToLocalhost(flow) ? "Submit URL" : "Submit code" : "Continue" },
    attributesHtml: `form="${oauthRedirectFormId(flow)}"`,
  });
  const body = flow.status === "complete"
    ? oauthCompleteBody(flow)
    : flow.status === "error"
      ? `<p class="settings-error">${escapeHtml(flow.error ?? "OAuth login failed")}</p>`
      : flow.verificationUri
        ? oauthDeviceCodeBody(flow)
        : flow.authUrl
          ? oauthBrowserRedirectBody(flow)
          : flow.prompt
            ? oauthPromptForm(flow)
            : `<div class="settings-oauth-card">${oauthStatus("pending", "Starting OAuth flow", "Waiting for the provider to respond.")}</div>`;
  const action = `<form method="post" action="${oauthFlowPath(flow, flow.status === "pending" ? "cancel" : "finish")}" data-turbo="true">${exitButton}</form>`
    + (flow.status === "pending" && flow.prompt ? submitUrlButton : "");
  const alternateLogin = oauthAlternateLoginAction(flow);
  return renderConnectionStep(flow, flow.host, {
    bodyHtml: `${flow.status !== "complete" ? openAISignInNotice(flow.provider) : ""}${body}`,
    noticeHtml: flow.provider === "anthropic" && flow.status !== "complete" ? warningBannerHtml(anthropicSubscriptionNotice) : undefined,
    actionsHtml: alternateLogin ? `<div class="model-setup-choices">${action}${alternateLogin}</div>` : action,
    reconnect: flow.reconnect,
    attributesHtml: `data-controller="oauth-flow" data-oauth-flow-status-url-value="${oauthFlowPath(flow, "status")}?revision=${flow.revision}" data-oauth-flow-active-value="${flow.status === "pending" && !(flow.prompt && !flow.authUrl && !flow.verificationUri)}" data-oauth-flow-poll-ms-value="${pollMs}"`,
  });
}

/** Providers or models changed: re-render the panel, and the composers' pickers follow. */
async function panelResponse(host: ModelsHost, renderPickerUpdates: () => Promise<string>, options: PanelOptions = {}): Promise<Response> {
  return stream(replace(ids.panel(host), await renderModelsPanel(host, options)) + await renderPickerUpdates());
}

function hostFrom(url: URL): ModelsHost | undefined {
  return modelsHosts.find((candidate) => candidate === (url.searchParams.get("host") ?? "dialog"));
}

export async function handleModelsRequest(request: Request, url: URL, renderPickerUpdates: () => Promise<string>, finishOnboarding: () => Promise<Response>): Promise<Response | undefined> {
  if (url.pathname !== "/models" && !url.pathname.startsWith("/models/")) return undefined;
  const host = hostFrom(url);
  if (!host) return response("Unknown models host", { status: 400 });
  // Direct navigation to /models renders the app shell around the dialog; see app.ts.
  if (url.pathname === "/models" && request.method === "GET") {
    const dialogHost = host === "onboarding" ? "onboarding" : "dialog";
    const html = await renderModelsDialog({ host: dialogHost, focus: url.searchParams.get("focus") ?? undefined, connect: url.searchParams.get("connect") ?? undefined });
    return stream(update(dialogHost === "onboarding" ? "onboarding_modal_host" : "settings_modal_host", html));
  }
  if (url.pathname === "/models/connect" && request.method === "GET") {
    const runtime = await createPiModelRuntime();
    return response(renderConnectChoices(host, runtime, await listAccounts(runtime)));
  }
  if (url.pathname === "/models/connect/providers" && request.method === "GET") {
    const runtime = await createPiModelRuntime();
    return response(renderOtherProviders(unconnectedProviders(runtime, await listAccounts(runtime)).other, host, url.searchParams.get("q") ?? ""));
  }
  if (url.pathname === "/models/custom-endpoints/new" && request.method === "GET") {
    const protocol = customOpenAIProtocols.find(protocol => protocol.id === url.searchParams.get("api"));
    if (!protocol) return response("Unknown endpoint protocol", { status: 400 });
    return response(renderCustomEndpointStep(host, protocol));
  }
  if (url.pathname === "/models/custom-endpoints" && request.method === "POST") {
    const form = await request.formData();
    const protocol = customOpenAIProtocols.find(protocol => protocol.id === form.get("api"));
    if (!protocol) return response("Unknown endpoint protocol", { status: 400 });
    const action = form.get("action");
    if (action !== "discover" && action !== "manual") return response("Unknown endpoint action", { status: 400 });
    const values = {
      name: String(form.get("name") ?? ""), baseUrl: String(form.get("baseUrl") ?? ""),
      modelId: String(form.get("modelId") ?? ""),
      contextWindow: Number(form.get("contextWindow")), maxTokens: Number(form.get("maxTokens")),
    };
    try { await connectCustomOpenAIEndpoint({ ...values, api: protocol.id, apiKey: String(form.get("secret") ?? "") }, action === "discover"); }
    catch (error) {
      // Do not reflect keys or upstream diagnostics into HTML, even if the server echoes them.
      const message = error instanceof CustomEndpointInputError ? error.message : "Couldn't connect the endpoint. Check its settings and try again.";
      return stream(replace(ids.connect(host), renderCustomEndpointStep(host, protocol, values, message)));
    }
    return panelResponse(host, renderPickerUpdates, { focus: "models", connectHtml: connectFrame(host, `<p role="status">${escapeHtml(values.name.trim())} connected. Choose models to enable below.</p>${backToChoices(host)}`) });
  }
  if (url.pathname === "/models/catalogue" && request.method === "GET") {
    const runtime = await createPiModelRuntime();
    return response(renderCatalogue(await catalogue(runtime, await listAccounts(runtime)), host, url.searchParams.get("q") ?? ""));
  }
  if (url.pathname === "/models/finish" && request.method === "POST") {
    if (!await hasAvailableEnabledModel()) return response("Choose at least one available model", { status: 422 });
    return await finishOnboarding();
  }
  if (url.pathname === "/models/catalogue/refresh" && request.method === "POST") {
    let feedback: Pick<CustomModelsView, "error" | "status">;
    try {
      const result = await refreshPiModelCatalogue();
      const errors = [...result.errors].map(([provider, error]) => `${provider}: ${error.message}`);
      if (result.aborted) errors.push("Refresh timed out or was interrupted. Try again.");
      feedback = errors.length
        ? { error: `Model catalogue refresh was incomplete. ${errors.join(" ")}` }
        : { status: "Model catalogue refreshed." };
    } catch (error) {
      feedback = { error: `Model catalogue refresh failed. ${errorMessage(error)}` };
    }
    const runtime = await createPiModelRuntime();
    const accounts = await listAccounts(runtime);
    // Leave the custom editor and connection forms alone, including unsaved input.
    const models = accounts.length ? replace(ids.enabledSection("settings"), await renderEnabledModelsSection(runtime, accounts, "settings", false)) : "";
    return stream(replace(ids.catalogueRefresh, renderCatalogueRefresh(feedback)) + models + await renderPickerUpdates());
  }
  if (url.pathname === "/models/custom" && request.method === "POST") {
    const form = await request.formData();
    const source = String(form.get("models") ?? "");
    try {
      const result = await setCustomModelsJson(source);
      const skipped = result.skippedOfficialModels;
      const status = skipped.length
        ? `Saved. ${skipped.length} ${skipped.length === 1 ? "model is" : "models are"} already in the official catalogue and will use the official definition: ${skipped.map(modelKey).join(", ")}.`
        : "Custom model configuration saved.";
      return panelResponse("settings", renderPickerUpdates, { customModels: { open: true, status } });
    } catch (error) {
      return stream(replace("custom_models_settings", renderCustomModelsSettings({ source, open: true, error: errorMessage(error) })));
    }
  }
  if (["/models/enabled-models/enable", "/models/enabled-models/disable"].includes(url.pathname) && request.method === "POST") {
    return await handleEnabledModelsAction(request, url.pathname.endsWith("/enable"), renderPickerUpdates);
  }
  let match = url.pathname.match(/^\/models\/providers\/([^/]+)\/connect$/);
  if (match && request.method === "POST") {
    const provider = providerChoices(await createPiModelRuntime()).find((candidate) => candidate.provider === decodeURIComponent(match![1]!));
    if (!provider) return response("Unknown provider", { status: 400 });
    if (url.searchParams.get("reconnect") === "1") {
      const flow = await startOAuthFlow({ ...provider, host, reconnect: true });
      return stream(replace(ids.reconnect(host, flow.provider), renderOAuthConnectionStep(flow)));
    }
    return stream(replace(ids.connect(host), await connectStep(provider.provider, host, url.searchParams.get("method") ?? undefined)));
  }
  match = url.pathname.match(/^\/models\/providers\/([^/]+)\/api-key$/);
  if (match && request.method === "POST") {
    const provider = providerChoices(await createPiModelRuntime()).find((candidate) => candidate.provider === decodeURIComponent(match![1]!));
    if (!provider?.methods.includes("api_key")) return response("Unknown API key provider", { status: 400 });
    const form = await request.formData();
    try {
      await connectModelProviderApiKey(provider.provider, String(form.get("secret") ?? ""));
      await seedProviderEnabledModels(provider.provider);
    } catch (error) {
      if (error instanceof ProviderCatalogueRefreshError) return panelResponse(host, renderPickerUpdates, { focus: provider.provider, error: error.message });
      return stream(replace(ids.connect(host), renderApiKeyConnectionStep(provider, host, errorMessage(error))));
    }
    return panelResponse(host, renderPickerUpdates, { focus: provider.provider });
  }
  match = url.pathname.match(/^\/models\/providers\/([^/]+)\/oauth\/([^/]+)\/(status|prompt|finish|cancel|browser)$/);
  if (match && request.method === "POST") {
    const provider = decodeURIComponent(match[1]!);
    const flowId = decodeURIComponent(match[2]!);
    const action = match[3]!;
    const flow = pendingOAuthFlows.get(flowId);
    if (!flow || flow.provider !== provider) return response("Sign-in session expired", { status: 410 });
    if (action === "browser") {
      if (!canSwitchToBrowserAuth(flow)) return response("Browser sign-in cannot replace this attempt", { status: 409 });
      const next = await startOAuthFlow(flow, "browser");
      pendingOAuthFlows.delete(flowId);
      return stream(replace(ids.connectionStep(flow.host, flow.provider, flow.reconnect), renderOAuthConnectionStep(next)));
    }
    if (action === "prompt") {
      const form = await request.formData();
      flow.redirectSubmitted = true;
      flow.prompt?.resolve(String(form.get("value") ?? ""));
      flow.prompt = undefined;
      await waitForOAuthFlowReady(flow);
    }
    if (flow.status === "complete") {
      pendingOAuthFlows.delete(flowId);
      return panelResponse(flow.host, renderPickerUpdates, { focus: provider });
    }
    if (action === "cancel" || action === "finish") {
      flow.abort.abort();
      pendingOAuthFlows.delete(flowId);
      return panelResponse(flow.host, renderPickerUpdates);
    }
    if (action === "status" && flow.status === "pending" && url.searchParams.get("revision") === String(flow.revision)) return stream("");
    return stream(replace(ids.connectionStep(flow.host, flow.provider, flow.reconnect), renderOAuthConnectionStep(flow)));
  }
  match = url.pathname.match(/^\/models\/providers\/([^/]+)\/forget$/);
  if (match && request.method === "POST") {
    await disconnectModelProvider(decodeURIComponent(match[1]!));
    return panelResponse(host, renderPickerUpdates);
  }
  return undefined;
}

async function handleEnabledModelsAction(request: Request, enable: boolean, renderPickerUpdates: () => Promise<string>): Promise<Response> {
  const form = await request.formData();
  const model = parseModelRef(String(form.get("model") ?? ""));
  if (!model) return response("Invalid model", { status: 400 });
  const runtime = await createPiModelRuntime();
  const current = await getEnabledModels();
  const index = current.findIndex((candidate) => modelKey(candidate) === modelKey(model));
  const accounts = (await listAccounts(runtime)).filter((account) => account.provider === model.provider);
  const entry = (await catalogue(runtime, accounts)).find((candidate) => modelKey(candidate) === modelKey(model));
  if (enable) {
    if (!entry) return response("Model not offered by a connected provider", { status: 400 });
    if (index < 0) current.push({ provider: entry.provider, id: entry.id, label: entry.label });
  } else if (index >= 0) {
    current.splice(index, 1);
  }
  await setEnabledModels(current);
  const ready = await hasAvailableEnabledModel();
  // Every host on the page shows the same enabled models, so all of them follow along.
  const updates = await Promise.all(modelsHosts.map(async (host) => replace(ids.enabledModels(host), await renderEnabledModelsList(runtime, host))
    + (entry ? replace(ids.catalogueRow(host, entry), catalogueRow({ ...entry, enabled: enable }, host)) : "")
    + (host === "onboarding" ? replace(ids.continue(host), continueButton(host, ready)) : "")));
  return stream(updates.join("") + await renderPickerUpdates());
}

export const modelsDialogId = ids.dialog("dialog");
