import { describe, expect, test } from "bun:test";
import { credentialProbeModel, defaultProviderModels, getPopularProviderRank, getPopularModelRank, modelDisplayName } from "../../src/server/hardcoded-provider-knowledge.ts";

import { shippedProviderModelIds } from "../../src/server/shipped-provider-models.ts";

const model = (id: string, input?: number, name = id) => ({ id, name, cost: input === undefined ? undefined : { input } });

describe("credential probe models", () => {
  test("Google prefers a chat model and never probes Deep Research through the chat API", () => {
    const research = { id: "deep-research-preview-04-2026", cost: { input: 0 } };
    const flash = { id: "gemini-flash-latest", cost: { input: 0.5 } };
    const neon = { id: "gemini-4-neon", cost: { input: 0.1 } };
    expect(credentialProbeModel("google", [research, neon, flash])).toBe(flash);
    expect(credentialProbeModel("google", [flash, neon, research])).toBe(flash);
    expect(credentialProbeModel("google", [research, neon])).toBe(neon);
    expect(credentialProbeModel("google-vertex", [research])).toBeUndefined();
  });
  test("unknown providers have a deterministic, non-mutating fallback", () => {
    const models = ["zeta", "beta", "alpha"].map(id => ({ id, cost: { input: id === "zeta" ? 2 : 1 } }));
    expect(credentialProbeModel("custom", models)?.id).toBe("alpha");
    expect(credentialProbeModel("custom", [...models].reverse())?.id).toBe("alpha");
    expect(models.map(({ id }) => id)).toEqual(["zeta", "beta", "alpha"]);
    expect(credentialProbeModel("classifier-only", [])).toBeUndefined();
  });
});

describe("provider setup defaults", () => {
  for (const provider of ["openai", "openai-codex"]) {
    test(`${provider} prioritizes Sol 6.1, then Astra and Luna 6, regardless of price`, () => {
      const models = [model("gpt-6-luna", 0.1), model("gpt-5.6-terra", 2), model("gpt-6-astra", 10), model("gpt-6.1-sol", 2), model("gpt-5.6-luna", 0.2)];
      expect(defaultProviderModels(provider, models).map((entry) => entry.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]);
      expect(models[0]!.id).toBe("gpt-6-luna");
      expect(defaultProviderModels(provider, models.filter((entry) => entry.id !== "gpt-6.1-sol")).map((entry) => entry.id)).toEqual(["gpt-6-astra", "gpt-6-luna"]);
    });
  }
  test("prioritizes Opus 5.5, then Fable 5.1 and Sonnet 5.5 for Anthropic", () => {
    const models = [model("claude-fable-5-1"), model("claude-opus-4-8"), model("claude-sonnet-5-5"), model("claude-opus-5-5"), model("claude-opus-5"), model("claude-fable-5")];
    expect(defaultProviderModels("anthropic", models).map((entry) => entry.id)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
    expect(defaultProviderModels("anthropic", models.filter((entry) => entry.id !== "claude-fable-5-1")).map((entry) => entry.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  });
  test("the release baseline only recommends the explicitly curated models", () => {
    const expected = {
      openai: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
      anthropic: ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"],
      "github-copilot": ["gpt-6-astra"],
      xai: ["grok-4.6"],
      "openai-codex": ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
    };
    const recommendations = new Map(Object.entries(expected));
    for (const [provider, ids] of Object.entries(shippedProviderModelIds)) {
      expect(recommendations.get(provider)).toEqual(defaultProviderModels(provider, ids.map((id) => model(id))).map((entry) => entry.id));
    }
  });
  test("adds post-release models after curated defaults, capped at five in stable ID order", () => {
    const models = [model("future-c"), model("gpt-6-luna"), model("gpt-6.1-sol"), model("future-b"), model("gpt-6-astra"), model("future-a"), model("gpt-5.6-sol", 100)];
    const expected = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "future-a", "future-b"];
    expect(defaultProviderModels("openai", models).map((entry) => entry.id)).toEqual(expected);
    expect(defaultProviderModels("openai", [...models].reverse()).map((entry) => entry.id)).toEqual(expected);
  });
  for (const provider of ["openai", "anthropic", "github-copilot", "xai", "openai-codex"]) {
    test(`${provider} promotes new IDs even without available curated models`, () => {
      const models = ["future-f", "future-c", "future-a", "future-e", "future-d", "future-b"].map((id) => model(id));
      expect(defaultProviderModels(provider, models).map((entry) => entry.id)).toEqual(["future-a", "future-b", "future-c", "future-d", "future-e"]);
      expect(getPopularModelRank(provider, "future-a")).toBeDefined();
    });
  }
  test("does not promote known non-curated models or unknown providers", () => {
    expect(getPopularModelRank("openai", "gpt-6-sol")).toBeUndefined();
    expect(getPopularModelRank("anthropic", "claude-opus-4-8")).toBeUndefined();
    expect(getPopularModelRank("github-copilot", "gpt-6.1-sol")).toBeUndefined();
    expect(getPopularModelRank("xai", "grok-4.7")).toBeUndefined();
    expect(getPopularModelRank("openai-codex", "gpt-5.5")).toBeUndefined();
    expect(getPopularModelRank("custom", "future-a")).toBeUndefined();
  });
  test("selects the highest known input price for uncurated providers", () => {
    expect(defaultProviderModels("custom", [model("cheap", 1), model("unknown"), model("expensive", 8)]).map((entry) => entry.id)).toEqual(["expensive"]);
  });
  test("breaks pricing ties by name, then ID", () => {
    expect(defaultProviderModels("custom", [model("z", 2, "Alpha"), model("b", 2, "Beta"), model("a", 2, "Alpha")])[0]!.id).toBe("a");
  });
  test("does not invent pricing when none is available", () => {
    expect(defaultProviderModels("custom", [model("unknown"), model("invalid", NaN)])).toEqual([]);
    expect(defaultProviderModels("custom", [])).toEqual([]);
    expect(defaultProviderModels("custom", [model("free", 0)])[0]!.id).toBe("free");
  });
  test("uses the price rule when curated IDs are absent from the account catalogue", () => {
    expect(defaultProviderModels("anthropic", [model("claude-opus-4-8", 10), model("claude-haiku-4-5", 1)])[0]!.id).toBe("claude-opus-4-8");
  });
  test("highlights Codex and leaves OpenAI in the other providers list", () => {
    expect(getPopularProviderRank("openai-codex")).toBe(0);
    expect(getPopularProviderRank("openai")).toBeUndefined();
    expect(getPopularProviderRank("google")).toBeUndefined();
  });
  test("drops the Claude brand prefix from model names", () => {
    expect(modelDisplayName("Claude Opus 5.5")).toBe("Opus 5.5");
    expect(modelDisplayName("Claude Haiku 4.5 (latest)")).toBe("Haiku 4.5 (latest)");
    expect(modelDisplayName("Claude 4 Sonnet (proxy)")).toBe("Claude 4 Sonnet (proxy)");
    expect(modelDisplayName("GPT-6 Astra")).toBe("GPT-6 Astra");
  });
});
