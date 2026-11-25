import { expect, test } from "bun:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { availableProviderModels, cheapestAvailableProviderModel } from "../../src/server/known-model-provider-incorrectness.ts";
import { providerAvailability } from "../../src/server/provider-availability.ts";

async function fixture() {
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  return { credentials, runtime };
}

test("OpenAI API keys retain the full catalogue and its cheapest model", async () => {
  const { credentials, runtime } = await fixture();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-test" }));
  expect(await availableProviderModels(runtime, "openai")).toEqual(await runtime.getAvailable("openai"));
  expect((await availableProviderModels(runtime, "openai")).some((model) => model.id === "gpt-5.3-codex")).toBe(true);
  expect((await cheapestAvailableProviderModel(runtime, "openai"))!.id).toBe("gpt-5-nano");
});

test("ChatGPT sign-in excludes API-only models without switching providers", async () => {
  const { credentials, runtime } = await fixture();
  await credentials.modify("openai", async () => ({ type: "oauth", access: "test", refresh: "test", expires: Date.now() + 60_000 }));
  const available = await availableProviderModels(runtime, "openai");
  expect(available.some((model) => model.id === "gpt-5-nano")).toBe(false);
  expect(available.some((model) => model.id === "gpt-5.3-codex")).toBe(false);
  expect(available.some((model) => model.id === "gpt-5.6-luna")).toBe(true);
  expect(available.every((model) => model.provider === "openai")).toBe(true);
  const cheapest = await cheapestAvailableProviderModel(runtime, "openai");
  expect(cheapest!.id).toBe("gpt-6-luna");
  expect(cheapest!.api).toBe("openai-responses");
  const availability = (await providerAvailability(runtime, ["openai"])).get("openai")!;
  expect(availability.connection).toBe("connected");
  expect(availability.modelIds.has("gpt-5-nano")).toBe(false);

  // Read current authentication on every resolution, including after reconnect.
  await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-test" }));
  expect((await cheapestAvailableProviderModel(runtime, "openai"))!.id).toBe("gpt-5-nano");
});

test("other providers and disconnected providers are unchanged", async () => {
  const { credentials, runtime } = await fixture();
  expect(await availableProviderModels(runtime, "openai")).toEqual([]);
  expect(await cheapestAvailableProviderModel(runtime, "openai")).toBeUndefined();
  await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test" }));
  expect(await availableProviderModels(runtime)).toEqual(await runtime.getAvailable());
});

test("subscription disallowlist preserves unknown models and matches exact IDs only", async () => {
  const { runtime } = await fixture();
  const base = runtime.getModels("openai")[0]!;
  const models = [
    { ...base, id: "gpt-future-model" },
    { ...base, id: "gpt-5-nano-next" },
    { ...base, id: "gpt-5-nano" },
    { ...base, provider: "custom", id: "gpt-5-nano" },
  ];
  const subscription = {
    getAvailable: async () => models,
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  };
  expect(await availableProviderModels(subscription)).toEqual([models[0]!, models[1]!, models[3]!]);
  expect(await availableProviderModels({ ...subscription, checkAuth: async () => ({ type: "api_key" as const, source: "API key" }) })).toEqual(models);
});
