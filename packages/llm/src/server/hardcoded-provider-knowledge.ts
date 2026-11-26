import { shippedProviderModelIds } from "./shipped-provider-models.ts";

const shippedModelIds = new Map(Object.entries(shippedProviderModelIds).map(([provider, ids]) => [provider, new Set(ids)]));
const maxDefaultModelsPerProvider = 5;

interface ProviderModelReference {
  id: string;
  label?: string;
}

interface ProviderKnowledge {
  apiKeyExample?: string;
}

interface ProviderKnowledgeRegistry {
  readonly [provider: string]: ProviderKnowledge;
}

const hardcodedPopularModels: readonly (ProviderModelReference & { provider: string })[] = [
  { provider: "openai", id: "gpt-6.1-sol" },
  { provider: "openai", id: "gpt-6-astra" },
  { provider: "openai", id: "gpt-6-luna" },
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "anthropic", id: "claude-fable-5-1" },
  { provider: "anthropic", id: "claude-sonnet-5-5" },
  { provider: "github-copilot", id: "gpt-6-astra" },
  { provider: "xai", id: "grok-4.6" },
  { provider: "openai-codex", id: "gpt-6.1-sol" },
  { provider: "openai-codex", id: "gpt-6-astra" },
  { provider: "openai-codex", id: "gpt-6-luna" },
];

const hardcodedProviderKnowledge: ProviderKnowledgeRegistry = {
  openai: {
    apiKeyExample: "sk-proj-abc123def456...",
  },
  "openai-codex": {
    apiKeyExample: "sk-proj-abc123def456...",
  },
  anthropic: {
    apiKeyExample: "sk-ant-api03-abc123def456...",
  },
};

export function getProviderApiKeyExample(provider: string): string | undefined {
  return hardcodedProviderKnowledge[provider]?.apiKeyExample;
}

const googleProbeModels = ["gemini-flash-latest", "gemini-4-neon", "gemini-3.5-flash", "gemini-2.5-flash"];
const credentialProbePreferences = new Map<string, readonly string[]>([
  ["google", googleProbeModels],
  ["google-vertex", googleProbeModels],
  ["openai", ["gpt-5-nano", "gpt-5.4-nano"]],
  ["anthropic", ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]],
]);

/** Prefer a known chat model; otherwise use the cheapest eligible model in stable order. */
export function credentialProbeModel<T extends { id: string; cost: { input: number } }>(provider: string, models: readonly T[]): T | undefined {
  const google = provider === "google" || provider === "google-vertex";
  // Deep Research uses Google's Interactions API, not the one-message chat probe.
  const chatModels = google ? models.filter(({ id }) => !id.startsWith("deep-research-")) : models;
  for (const id of credentialProbePreferences.get(provider) ?? []) {
    const model = chatModels.find(model => model.id === id);
    if (model) return model;
  }
  return chatModels.toSorted((a, b) => a.cost.input - b.cost.input || a.id.localeCompare(b.id))[0];
}

/** Drops the brand prefix from catalogue names ("Claude Opus 5.5" → "Opus 5.5"); the provider icon already shows it. */
export function modelDisplayName(name: string): string {
  return name.replace(/^Claude (?=[A-Z][a-z])/, "");
}

export function getPopularModelRank(provider: string, id: string): number | undefined {
  const rank = hardcodedPopularModels.findIndex((model) => model.provider === provider && model.id === id);
  if (rank >= 0) return rank;
  const known = shippedModelIds.get(provider);
  return known && !known.has(id) ? hardcodedPopularModels.length : undefined;
}

export const popularProviderIds: readonly string[] = [...new Set(hardcodedPopularModels.map(({ provider }) => provider))]
  .filter((provider) => getPopularProviderRank(provider) !== undefined)
  .sort((a, b) => getPopularProviderRank(a)! - getPopularProviderRank(b)!);

export function getPopularProviderRank(provider: string): number | undefined {
  // Prefer Codex sign-in; OpenAI keeps its model defaults in the other providers list.
  if (provider === "openai") return undefined;
  if (provider === "openai-codex") return 0;
  const rank = hardcodedPopularModels.findIndex((model) => model.provider === provider);
  return rank < 0 ? undefined : rank;
}

/** Up to five defaults: curated first, then post-release IDs in ID order. Otherwise use the highest known input price. */
export function defaultProviderModels<T extends { id: string; name?: string; cost?: { input?: number } }>(provider: string, models: readonly T[]): T[] {
  const popular = models.filter((model) => getPopularModelRank(provider, model.id) !== undefined)
    .sort((a, b) => getPopularModelRank(provider, a.id)! - getPopularModelRank(provider, b.id)! || a.id.localeCompare(b.id));
  if (popular.length) return popular.slice(0, maxDefaultModelsPerProvider);
  const priced = models.filter((model) => model.cost?.input !== undefined && Number.isFinite(model.cost.input))
    .sort((a, b) => b.cost!.input! - a.cost!.input! || (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id));
  return priced.slice(0, 1);
}
