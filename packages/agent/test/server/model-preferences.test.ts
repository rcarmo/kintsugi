import { updateJsonSettings } from "@kintsugi/core/json-settings";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentModelPreference, setAgentModelPreference, getAgentModelThinkingLevel, setAgentModelThinkingLevel, createPiModelRuntime, disconnectModelProvider, seedProviderEnabledModels, getCustomModelsJson, setCustomModelsJson, setEnabledModels } from "@kintsugi/llm/server";
import { reconcileAgentModelPreferences, getAgentEnabledModels } from "../../src/server/model-preferences.ts";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kintsugi-custom-models-"));
  process.env.KINTSUGI_DATA_DIR = dataDir;
  // Provider changes reach every running workspace; this instance has none.
  process.env.KINTSUGI_NAMESPACE = `model-preferences-${crypto.randomUUID()}`;
});

afterEach(async () => {
  delete process.env.KINTSUGI_DATA_DIR;
  delete process.env.KINTSUGI_NAMESPACE;
  await rm(dataDir, { recursive: true, force: true });
});

describe("Agent model settings transactions", () => {
  test("concurrent preference and enabled-model updates preserve each other", async () => {
    await Promise.all([
      setEnabledModels([{ provider: "openai-codex", id: "gpt-5.4", label: "My model" }]),
      setAgentModelPreference("builtin", { provider: "openai-codex", id: "gpt-5.4" }, "high"),
      setAgentModelThinkingLevel("builtin", { provider: "anthropic", id: "claude" }, "medium"),
    ]);

    expect(await getAgentEnabledModels()).toEqual([{ provider: "openai-codex", id: "gpt-5.4", label: "My model", active: true }]);
    // Selecting a model is a preference update, not a catalogue update.
    await setAgentModelPreference("builtin", { provider: "openai-codex", id: "not-enabled" });
    expect(await getAgentEnabledModels()).toEqual([{ provider: "openai-codex", id: "gpt-5.4", label: "My model", active: true }]);
    expect(await getAgentModelThinkingLevel("builtin", { provider: "openai-codex", id: "gpt-5.4" })).toBe("high");
    expect(await getAgentModelThinkingLevel("builtin", { provider: "anthropic", id: "claude" })).toBe("medium");
  });

  test("custom model materialization preserves concurrent preferences", async () => {
    await Promise.all([
      setCustomModelsJson(JSON.stringify({ providers: { "openai-codex": { models: [{ id: "future-model" }] } } })),
      ...Array.from({ length: 8 }, (_, index) => setAgentModelThinkingLevel("builtin", { provider: "openai-codex", id: `model-${index}` }, "high")),
    ]);

    for (let index = 0; index < 8; index++) expect(await getAgentModelThinkingLevel("builtin", { provider: "openai-codex", id: `model-${index}` })).toBe("high");
    expect(JSON.parse(await getCustomModelsJson()).providers["openai-codex"].models).toEqual([{ id: "future-model" }]);
  });
});


test("connecting seeds defaults once, preserves other selections, and disconnect removes only that provider", async () => {
  const runtime = await createPiModelRuntime();
  await runtime.login("openai", "api_key", { prompt: async () => "test-only-key", notify: () => {} });
  await seedProviderEnabledModels("openai");
  const first = await getAgentEnabledModels();
  expect(first.length).toBeGreaterThan(0);
  expect(first[0]!.active).toBe(true);

  const retained = { provider: "openai", id: "gpt-5.4", label: "My selection", active: true };
  await setEnabledModels([retained]);
  await seedProviderEnabledModels("openai");
  expect(await getAgentEnabledModels()).toEqual([retained]);

  await runtime.login("anthropic", "api_key", { prompt: async () => "test-only-key", notify: () => {} });
  await seedProviderEnabledModels("anthropic");
  const both = await getAgentEnabledModels();
  expect(both.find((model) => model.active)?.provider).toBe("openai");
  expect(both.some((model) => model.provider === "anthropic")).toBe(true);

  await disconnectModelProvider("openai");
  expect(runtime.getProviderAuthStatus("openai").configured).toBe(false);
  expect((await getAgentEnabledModels()).every((model) => model.provider === "anthropic")).toBe(true);
  expect((await getAgentEnabledModels())[0]!.active).toBe(true);

  await disconnectModelProvider("anthropic");
  expect(await getAgentEnabledModels()).toEqual([]);
});


test("catalogue changes forget a removed native default without losing thinking preferences", async () => {
  const first = { provider: "openai", id: "first", label: "First" };
  const second = { provider: "openai", id: "second", label: "Second" };
  await setEnabledModels([first, second]);
  await setAgentModelPreference("builtin", { provider: first.provider, id: first.id }, "high");
  await setEnabledModels([second]);
  await reconcileAgentModelPreferences();
  await setEnabledModels([first, second]);
  expect((await getAgentEnabledModels()).find((model) => model.active)?.id).toBe("second");
  expect(await getAgentModelThinkingLevel("builtin", { provider: first.provider, id: first.id })).toBe("high");
  await setEnabledModels([]);
  await reconcileAgentModelPreferences();
  expect(await getAgentModelPreference("builtin")).toBeUndefined();
});


test("reads individual legacy preferences and preserves unrelated persisted fields", async () => {
  const path = join(dataDir, "pi-config", "models.json");
  await updateJsonSettings(path, (stored) => {
    stored.modelPreferences = {
      "openai::valid": { thinkingLevel: "high", retained: true },
      "openai::invalid": { thinkingLevel: 42 },
    };
    stored.otherOwner = { retained: true };
  });
  expect(await getAgentModelThinkingLevel("builtin", { provider: "openai", id: "valid" })).toBe("high");
  expect(await getAgentModelThinkingLevel("builtin", { provider: "openai", id: "invalid" })).toBeUndefined();
  expect(await getAgentModelThinkingLevel("builtin", { provider: "openai", id: "missing" })).toBeUndefined();
  await setAgentModelThinkingLevel("builtin", { provider: "openai", id: "valid" }, "medium");
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.agentPreferences.builtin.modelPreferences["openai::valid"]).toEqual({ thinkingLevel: "medium", retained: true });
  expect(saved.otherOwner).toEqual({ retained: true });
  expect(saved.modelPreferences).toBeUndefined();
});

test("all agent types share storage but isolate selections and model thinking levels", async () => {
  const model = { provider: "openai", id: "shared" };
  const agents = ["builtin", "pi", "codex", "codex-cli", "claude"];
  await Promise.all(agents.map(async (agent, index) => {
    await setAgentModelPreference(agent, model, `level-${index}`);
  }));
  for (const [index, agent] of agents.entries()) {
    expect(await getAgentModelPreference(agent)).toEqual(model);
    expect(await getAgentModelThinkingLevel(agent, model)).toBe(`level-${index}`);
  }
  await setAgentModelPreference("pi", { provider: "anthropic", id: "different" });
  expect(await getAgentModelPreference("builtin")).toEqual(model);
  expect(await getAgentModelThinkingLevel("pi", model)).toBe("level-1");
});

test("legacy active model belongs only to Built-in and survives namespacing", async () => {
  const model = { provider: "openai", id: "legacy" };
  await updateJsonSettings(join(dataDir, "pi-config", "models.json"), stored => { stored.activeModel = model; });
  expect(await getAgentModelPreference("builtin")).toEqual(model);
  expect(await getAgentModelPreference("pi")).toBeUndefined();
  await setAgentModelThinkingLevel("builtin", { provider: model.provider, id: model.id }, "high");
  expect(await getAgentModelPreference("builtin")).toEqual(model);
});
