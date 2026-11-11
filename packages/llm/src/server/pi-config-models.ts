import { availableProviderModels } from "./known-model-provider-incorrectness.ts";
import { providerAvailability } from "./provider-availability.ts";
import type { ModelRef } from "./model-reference.ts";
import { readJsonSettings, updateJsonSettings } from "@kintsugi/core/json-settings";
import { syncSubscriptionClis } from "./subscription-cli.ts";
import { SubscriptionUsageError } from "./subscription-usage.ts";
import { anthropicUsageSource } from "./anthropic-subscription-usage.ts";
import { forgetSubscriptionInference } from "./recent-subscription-activity.ts";
import { defaultProviderModels, modelDisplayName } from "./hardcoded-provider-knowledge.ts";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { kintsugiDataPath, getKintsugiRuntimeContext, isJsonObject, readTextIfExists, writeJsonAtomic, type JsonObject, type JsonValue } from "@kintsugi/core";
import { errorMessage } from "@kintsugi/shared";
import type { Api, AuthInteraction, AuthPrompt, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface EnabledModel extends ModelRef { label: string }
const stringSchema = Type.String();
interface ModelSettings { providers?: JsonObject; enabledModels?: EnabledModel[] }

export interface CustomModelsSaveResult {
  skippedOfficialModels: ModelRef[];
}

function piConfigDir(): string { return kintsugiDataPath(getKintsugiRuntimeContext(), "pi-config"); }
function piModelsJsonPath(): string { return join(piConfigDir(), "models.json"); }
function piCustomModelsJsonPath(): string { return join(piConfigDir(), "custom-models.json"); }
function piAuthJsonPath(): string { return join(piConfigDir(), "auth.json"); }
function piDeviceIdPath(): string { return join(piConfigDir(), "device-id"); }

/** Sign in with ChatGPT identifies each installation by a stable UUID. */
async function piDeviceId(): Promise<string> {
  const path = piDeviceIdPath();
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, crypto.randomUUID(), { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  return (await readFile(path, "utf8")).trim();
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return Value.Check(stringSchema, value) ? value : undefined;
}

function modelReferenceFromJsonObject(value: JsonObject): ModelRef | undefined {
  const provider = jsonString(value.provider);
  const id = jsonString(value.id);
  return provider && id ? { provider, id } : undefined;
}

function enabledModelFromJson(value: JsonValue | undefined): EnabledModel | undefined {
  if (!isJsonObject(value)) return undefined;
  const reference = modelReferenceFromJsonObject(value);
  if (!reference) return undefined;
  return { ...reference, label: modelDisplayName(jsonString(value.label)?.trim() || reference.id) };
}

function parseModelSettings(stored: JsonObject): ModelSettings {
  const enabledModels = stored.enabledModels ?? stored.picker; // Read the previously saved app-owned list.
  return {
    providers: isJsonObject(stored.providers) ? stored.providers : undefined,
    enabledModels: Array.isArray(enabledModels) ? enabledModels.flatMap((entry) => {
      const model = enabledModelFromJson(entry);
      return model ? [model] : [];
    }) : undefined,
  };
}

async function getModelSettings(): Promise<ModelSettings> {
  return parseModelSettings(await readJsonSettings(piModelsJsonPath()));
}

async function updateModelSettings(update: (settings: ModelSettings) => void): Promise<void> {
  await updateJsonSettings(piModelsJsonPath(), (stored) => {
    const settings = parseModelSettings(stored);
    update(settings);
    stored.providers = settings.providers ?? {};
    if (settings.enabledModels) stored.enabledModels = settings.enabledModels.map((model) => ({ ...model }));
    delete stored.picker;
  });
}

function parseCustomModelsJson(source: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON: ${errorMessage(error)}`);
  }
  if (!isJsonObject(parsed)) throw new Error("Custom model configuration must be a JSON object.");
  const unexpected = Object.keys(parsed).filter((key) => key !== "providers");
  if (unexpected.length) throw new Error(`Only the providers property is accepted here. Remove: ${unexpected.join(", ")}.`);
  if (!isJsonObject(parsed.providers)) throw new Error('Custom model configuration must contain a "providers" object.');
  return parsed.providers;
}

async function validateCustomModelProviders(providers: JsonObject): Promise<void> {
  const path = join(piConfigDir(), `.custom-models-validation-${crypto.randomUUID()}.json`);
  await writeJsonAtomic(path, { providers });
  try {
    const validationRuntime = await ModelRuntime.create({ modelsPath: path, allowModelNetwork: false, refreshOnCreate: false });
    const error = validationRuntime.getError();
    if (error) throw new Error(error.replace(`\n\nFile: ${path}`, ""));
  } finally {
    await unlink(path);
  }
}

async function readStoredCustomModelProviders(): Promise<JsonObject | undefined> {
  const source = await readTextIfExists(piCustomModelsJsonPath());
  if (source === undefined) return undefined;
  const parsed: unknown = JSON.parse(source);
  if (!isJsonObject(parsed) || !isJsonObject(parsed.providers)) throw new Error(`${piCustomModelsJsonPath()} must contain a providers object`);
  return parsed.providers;
}

function withoutOfficialModelDuplicates(providers: JsonObject, officialRuntime: ModelRuntime): CustomModelsSaveResult & { providers: JsonObject } {
  const skippedOfficialModels: ModelRef[] = [];
  const filtered = structuredClone(providers);
  for (const [providerId, value] of Object.entries(filtered)) {
    if (!isJsonObject(value) || !Array.isArray(value.models)) continue;
    const officialIds = new Set(officialRuntime.getModels(providerId).map((model) => model.id));
    value.models = value.models.filter((model) => {
      if (!isJsonObject(model)) return true;
      const id = jsonString(model.id);
      if (!id || !officialIds.has(id)) return true;
      skippedOfficialModels.push({ provider: providerId, id });
      return false;
    });
  }
  return { providers: filtered, skippedOfficialModels };
}

async function materializeCustomModelProviders(providers: JsonObject): Promise<CustomModelsSaveResult> {
  const filtered = withoutOfficialModelDuplicates(providers, await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false }));
  await updateModelSettings((settings) => { settings.providers = filtered.providers; });
  return { skippedOfficialModels: filtered.skippedOfficialModels };
}

async function preparePiModelsJson(): Promise<void> {
  const settings = await getModelSettings();
  const stored = await readStoredCustomModelProviders();
  const providers = stored ?? settings.providers ?? {};
  if (!stored) await writeJsonAtomic(piCustomModelsJsonPath(), { providers });
  await materializeCustomModelProviders(providers);
}

export async function getCustomModelsJson(): Promise<string> {
  const providers = await readStoredCustomModelProviders() ?? (await getModelSettings()).providers ?? {};
  return Object.keys(providers).length ? JSON.stringify({ providers }, null, 2) : "";
}

export async function setCustomModelsJson(source: string): Promise<CustomModelsSaveResult> {
  const providers = source.trim() ? parseCustomModelsJson(source) : {};
  await validateCustomModelProviders(providers);
  await writeJsonAtomic(piCustomModelsJsonPath(), { providers });
  const result = await materializeCustomModelProviders(providers);
  if (modelRuntime) await (await modelRuntime).refresh();
  return result;
}

export async function getEnabledModels(): Promise<EnabledModel[]> { return (await getModelSettings()).enabledModels ?? []; }
export function hasConnectedModelProvider(runtime: Pick<ModelRuntime, "getProviders" | "getProviderAuthStatus">): boolean {
  return runtime.getProviders().some((provider) => runtime.getProviderAuthStatus(provider.id).configured);
}

export async function hasAvailableEnabledModel(): Promise<boolean> {
  const runtime = await createPiModelRuntime();
  const models = await getEnabledModels();
  const availability = await providerAvailability(runtime, models.map((model) => model.provider));
  return models.some((model) => availability.get(model.provider)!.modelIds.has(model.id));
}

export async function setEnabledModels(models: EnabledModel[]): Promise<void> {
  await updateModelSettings((settings) => { settings.enabledModels = models.map(({ provider, id, label }) => ({ provider, id, label })); });
}

let modelRuntime: Promise<ModelRuntime> | undefined;
/** The provider's model with the lowest input price, for small housekeeping requests. */
export function cheapestProviderModel(runtime: Pick<ModelRuntime, "getModels">, provider: string) {
  return runtime.getModels(provider).toSorted((a, b) => a.cost.input - b.cost.input)[0];
}

const kintsugiUserAgent = `Kintsugi (${platform()} ${release()}; ${arch()})`;

/** Introduces Kintsugi to providers instead of pi. Caller headers still win. */
function identifyAsKintsugi(runtime: ModelRuntime): ModelRuntime {
  const withIdentity = (model: Model<Api>, headers: ProviderHeaders | undefined): ProviderHeaders | undefined => {
    // Anthropic subscriptions only accept requests that identify as Claude Code.
    if (model.provider === "anthropic" && runtime.isUsingOAuth(model.provider)) return headers;
    const identity: ProviderHeaders = model.api === "openai-codex-responses" ? { "User-Agent": kintsugiUserAgent, originator: "Kintsugi" } : { "User-Agent": kintsugiUserAgent };
    return { ...identity, ...headers };
  };
  // Instance overrides also catch completeSimple, fetchDeferred, and the runtime's own re-entry when it routes virtual models.
  const streamSimple = runtime.streamSimple.bind(runtime);
  const streamDeferred = runtime.streamDeferred.bind(runtime);
  runtime.streamSimple = (model, context, options) => streamSimple(model, context, { ...options, headers: withIdentity(model, options?.headers) });
  runtime.streamDeferred = (model, handle, options) => streamDeferred(model, handle, { ...options, headers: withIdentity(model, options?.headers) });
  return runtime;
}

/** Housekeeping requests to Anthropic pose as Claude Code, the version pi already claims for Claude subscriptions. */
export function claudeCodeHeaders(model: Model<Api>): ProviderHeaders | undefined {
  return model.provider === "anthropic" ? { "User-Agent": "claude-cli/2.1.280", "x-app": "cli" } : undefined;
}

/** Settings catalogues must not refresh providers, resolve OAuth or start inference. */
export async function readPiModelCatalogue():Promise<ModelRuntime> {
  await preparePiModelsJson();
  return identifyAsKintsugi(await ModelRuntime.create({authPath:piAuthJsonPath(),modelsPath:piModelsJsonPath(),allowModelNetwork:false,refreshOnCreate:false}));
}
export function createPiModelRuntime(): Promise<ModelRuntime> {
  return modelRuntime ??= (async () => {
    await preparePiModelsJson();
    return identifyAsKintsugi(await ModelRuntime.create({ authPath: piAuthJsonPath(), modelsPath: piModelsJsonPath() }));
  })();
}

export interface GitHubCopilotUsageCredentials { token: string; enterpriseUrl?: string }

/** Read the GitHub sign-in token and its issuer together; an inference-token refresh is unnecessary. */
export async function readGitHubCopilotUsageCredentials(): Promise<GitHubCopilotUsageCredentials | undefined> {
  const credential = (await readJsonSettings(piAuthJsonPath()))["github-copilot"];
  if (!isJsonObject(credential) || credential.type !== "oauth") return undefined;
  const token = jsonString(credential.refresh);
  if (!token?.trim()) return undefined;
  const result: GitHubCopilotUsageCredentials = { token };
  if (credential.enterpriseUrl != null) {
    if (!Value.Check(stringSchema, credential.enterpriseUrl)) throw new SubscriptionUsageError("GitHub Copilot enterprise sign-in metadata is invalid. Reconnect GitHub Copilot.");
    result.enterpriseUrl = credential.enterpriseUrl;
  }
  return result;
}

export async function readGitHubCopilotUsageToken(): Promise<string | undefined> {
  return (await readGitHubCopilotUsageCredentials())?.token;
}

export type PiAuthPrompt = AuthPrompt;

export class ProviderCatalogueRefreshError extends Error {
  constructor(cause: unknown) {
    super(`Provider connected, but the online model catalogue refresh failed: ${errorMessage(cause)}`, { cause });
    this.name = "ProviderCatalogueRefreshError";
  }
}

async function refreshConnectedProviderCatalogue(runtime: ModelRuntime, provider: string, signal?: AbortSignal): Promise<void> {
  try {
    const result = await runtime.refresh({ providers: [provider], allowNetwork: true, force: true, signal });
    if (result.aborted) throw new Error("Catalogue refresh was interrupted.");
    const errors = [...result.errors.values()];
    if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  } catch (error) {
    throw new ProviderCatalogueRefreshError(error);
  }
}

function forgetSubscriptionState(provider: string): void {
  if (provider === "anthropic") anthropicUsageSource.forget();
  if (provider === "anthropic" || provider === "openai-codex" || provider === "github-copilot" || provider === "opencode-go") forgetSubscriptionInference(provider);
}

export async function loginPiOAuthProvider(providerId: string, interaction: AuthInteraction): Promise<void> {
  const runtime = await createPiModelRuntime();
  const deviceId = await piDeviceId();
  await runtime.login(providerId, "oauth", interaction, { getDeviceId: () => deviceId, agentName: "Kintsugi" });
  forgetSubscriptionState(providerId);
  if (providerId === "openai" || providerId === "anthropic") await syncSubscriptionClis(runtime);
  await refreshConnectedProviderCatalogue(runtime, providerId, interaction.signal);
}

/** Probe stored catalogue models or a not-yet-saved custom model using an in-memory credential. */
export async function validateModelProviderApiKey(provider: string, key: string, customModel?: Model<Api>): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is required");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider, async () => ({ type: "api_key", key: trimmed }));
  const runtime = identifyAsKintsugi(await ModelRuntime.create({ credentials, modelsPath: customModel ? null : piModelsJsonPath(), allowModelNetwork: false }));
  if (customModel) runtime.registerProvider(provider, { api: customModel.api, baseUrl: customModel.baseUrl, models: [customModel] });
  const models = runtime.getModels(provider);
  const model = models[Math.floor(Math.random() * models.length)];
  if (!model) {
    const classifier = runtime.getModelsOfType("classifier", provider)[0];
    if (!classifier) throw new Error(`No models found for provider "${provider}"`);
    const response = await runtime.classify(classifier, {
      state: { text: "ok" },
      questions: { valid: { type: "bool", instructions: "Does the text say ok?", criteria: { true: "The text says ok", false: "The text does not say ok" } } },
    }, { signal: AbortSignal.timeout(15_000) });
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? "Provider rejected the API key");
    return;
  }
  // A probe is its own one-request conversation. OpenCode Go rejects requests without a session ID.
  const response = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: Date.now() }] }, { maxTokens: 1, headers: claudeCodeHeaders(model), sessionId: crypto.randomUUID(), signal: customModel ? AbortSignal.timeout(15_000) : undefined });
  if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? "Provider rejected the API key");
}

export async function connectModelProviderApiKey(provider: string, key: string, options: { validate?: boolean } = {}): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is required");
  if (options.validate !== false) await validateModelProviderApiKey(provider, trimmed);
  const runtime = await createPiModelRuntime();
  await runtime.login(provider, "api_key", {
    prompt: async (prompt) => prompt.type === "select" ? prompt.options[0]?.id ?? "" : trimmed,
    notify: () => {},
  });
  forgetSubscriptionState(provider);
  if (provider === "openai" || provider === "anthropic") await syncSubscriptionClis(runtime);
  await refreshConnectedProviderCatalogue(runtime, provider);
}
export async function disconnectModelProvider(provider: string): Promise<void> {
  const runtime = await createPiModelRuntime();
  await runtime.logout(provider);
  forgetSubscriptionState(provider);
  if (provider === "openai" || provider === "anthropic") await syncSubscriptionClis(runtime);
  await updateModelSettings((settings) => {
    settings.enabledModels = (settings.enabledModels ?? []).filter((model) => model.provider !== provider);
  });
}

export async function seedProviderEnabledModels(provider: string): Promise<void> {
  const runtime = await createPiModelRuntime();
  const available = await availableProviderModels(runtime, provider);
  const defaults = defaultProviderModels(provider, available);
  await updateModelSettings((settings) => {
    const enabledModels = settings.enabledModels ?? [];
    if (!enabledModels.some((model) => model.provider === provider)) {
      settings.enabledModels = [...enabledModels, ...defaults.map((model) => ({ provider, id: model.id, label: modelDisplayName(model.name ?? model.id) }))];
    }
  });
}
