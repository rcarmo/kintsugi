import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enabledModelOptionViews, selectAvailableEnabledModel, type AgentModelOptionView } from "../../src/server/model-state.ts";
import { modelRefValue, parseModelRef, setEnabledModels, setAgentModelPreference } from "@kintsugi/llm/server";
import type { Api, Model } from "@earendil-works/pi-ai";

const model = (provider: string, id: string, options: { selected?: boolean; available?: boolean } = {}): AgentModelOptionView => ({
  provider,
  id,
  name: id,
  selected: options.selected ?? false,
  available: options.available ?? true,
});

describe("new workspace model selection", () => {
  test("falls back from a disconnected active model to an available model", () => {
    const models = [
      model("disconnected", "active", { selected: true, available: false }),
      model("connected", "fallback"),
    ];

    expect(selectAvailableEnabledModel(models)).toEqual({ provider: "connected", id: "fallback" });
    expect(selectAvailableEnabledModel(models, { provider: "disconnected", id: "active" })).toEqual({ provider: "connected", id: "fallback" });
  });

  test("keeps an available requested model and returns no model when all are disconnected", () => {
    const available = model("connected", "requested");

    expect(selectAvailableEnabledModel([model("connected", "active", { selected: true }), available], {
      provider: available.provider,
      id: available.id,
    })).toEqual({ provider: "connected", id: "requested" });
    expect(selectAvailableEnabledModel([model("disconnected", "only", { selected: true, available: false })])).toBeUndefined();
  });
});

describe("model references", () => {
  test("round-trips provider-qualified IDs, including IDs with separators", () => {
    const reference = { provider: "custom", id: "namespace::model" };
    expect(parseModelRef(modelRefValue(reference))).toEqual(reference);
  });

  test("rejects references missing a provider, model, or separator", () => {
    for (const value of ["", "model", "::model", "provider::"]) {
      expect(parseModelRef(value)).toBeUndefined();
    }
  });
});

describe("Anthropic subscription models", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kintsugi-model-state-"));
    process.env.KINTSUGI_DATA_DIR = dataDir;
    await setEnabledModels([{ provider: "anthropic", id: "claude", label: "Claude" }, { provider: "openai", id: "gpt", label: "GPT" }]);
    await setAgentModelPreference("builtin", { provider: "anthropic", id: "claude" });
  });
  afterEach(async () => {
    delete process.env.KINTSUGI_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });
  const catalogueModel = (provider: string, id: string): Model<Api> => ({ provider, id, name: id, api: "openai-completions", baseUrl: "https://example.test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 });
  const runtime = (anthropicCredential: "oauth" | "api_key") => ({
    getAvailable: async (provider?: string) => [provider === "anthropic" ? catalogueModel("anthropic", "claude") : catalogueModel("openai", "gpt")],
    checkAuth: async () => ({ type: "api_key" as const }),
    getModel: () => undefined,
    listCredentials: async () => [{ providerId: "anthropic", type: anthropicCredential }, { providerId: "openai", type: "api_key" as const }],
  });

  test("are hidden from the built-in agent, which falls back to another provider", async () => {
    const models = await enabledModelOptionViews(undefined, runtime("oauth"));
    expect(models.map((model) => model.provider)).toEqual(["openai"]);
    expect(selectAvailableEnabledModel(models, { provider: "anthropic", id: "claude" })).toEqual({ provider: "openai", id: "gpt" });
  });

  test("stay available when Anthropic is connected with an API key", async () => {
    const models = await enabledModelOptionViews(undefined, runtime("api_key"));
    expect(models.map((model) => [model.provider, model.available, model.selected])).toEqual([["anthropic", true, true], ["openai", true, false]]);
  });
});
