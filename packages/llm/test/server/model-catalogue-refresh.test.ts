import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { updateJsonSettings } from "@kintsugi/core/json-settings";
import { createPiModelRuntime, getEnabledModels, readPiModelCatalogue, refreshPiModelCatalogue, setCustomModelsJson, setEnabledModels } from "../../src/server/pi-config-models.ts";

type RefreshResult = Awaited<ReturnType<ModelRuntime["refresh"]>>;
let dataDir: string, runtime: ModelRuntime;
const previousDataDir = process.env.KINTSUGI_DATA_DIR;
const realFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
const noNetwork = async (): Promise<Response> => { throw new Error("Unexpected network outside explicit catalogue refresh"); };
let respond: (request: Request) => Promise<Response> = noNetwork;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kintsugi-catalogue-refresh-"));
  process.env.KINTSUGI_DATA_DIR = dataDir;
  globalThis.fetch = Object.assign(async (input: URL | RequestInfo, init?: RequestInit) => respond(new Request(input, init)), { preconnect: realFetch.preconnect });
  await setCustomModelsJson(JSON.stringify({ providers: { openai: { models: [{ id: "local-custom-model", name: "My custom model", contextWindow: 8192, maxTokens: 1024 }] } } }));
  await setEnabledModels([{ provider: "openai", id: "local-custom-model", label: "My custom model" }]);
  await updateJsonSettings(join(dataDir, "pi-config", "auth.json"), stored => { stored.openai = { type: "api_key", key: "catalogue-test-key" }; });
  runtime = await createPiModelRuntime();
});
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); respond = noNetwork; });
afterAll(async () => {
  globalThis.fetch = realFetch;
  if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

async function savedConfiguration() {
  return Promise.all(["models.json", "custom-models.json", "auth.json"].map(file => readFile(join(dataDir, "pi-config", file), "utf8")));
}

function catalogFixture() {
  const model = { ...runtime.getModels("openai").find(model => model.id !== "local-custom-model")!, id: `catalogue-fixture-${crypto.randomUUID()}`, name: "Refreshed built-in model" };
  const requests: Request[] = [];
  let fail = false;
  respond = async request => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.origin !== "https://pi.dev" || !url.pathname.startsWith("/api/models/providers/")) throw new Error("Catalogue refresh must not start inference");
    if (url.pathname !== "/api/models/providers/openai") return new Response(null, { status: 404 });
    if (fail) return new Response(null, { status: 400 });
    return Response.json({ models: [model] }, { headers: { "last-modified": "Sun, 01 Jan 2040 00:00:00 GMT", etag: '"fixture-catalogue"' } });
  };
  return { model, requests, fail() { fail = true; } };
}

test("explicit refresh forces SDK network catalogues and shares concurrent requests", async () => {
  const gate = Promise.withResolvers<RefreshResult>();
  const refresh = spyOn(runtime, "refresh").mockImplementation(options => {
    expect(options?.allowNetwork).toBe(true);
    expect(options?.force).toBe(true);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
    return gate.promise;
  });
  cleanups.push(() => refresh.mockRestore());
  const before = await savedConfiguration();
  const first = refreshPiModelCatalogue(), second = refreshPiModelCatalogue();
  expect(first).toBe(second);
  await Promise.resolve();
  expect(refresh).toHaveBeenCalledTimes(1);
  const result: RefreshResult = { aborted: false, errors: new Map() };
  gate.resolve(result);
  expect(await first).toBe(result);
  expect(await savedConfiguration()).toEqual(before);
});

test("a failed refresh is visible to the caller and can be retried", async () => {
  const refresh = spyOn(runtime, "refresh").mockRejectedValueOnce(new Error("Catalogue unavailable")).mockResolvedValue({ aborted: false, errors: new Map() });
  cleanups.push(() => refresh.mockRestore());
  await expect(refreshPiModelCatalogue()).rejects.toThrow("Catalogue unavailable");
  expect((await refreshPiModelCatalogue()).aborted).toBe(false);
  expect(refresh).toHaveBeenCalledTimes(2);
});

test("the SDK refresh receives the same 15-second cancellation deadline as pi update --models", async () => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(5));
  cleanups.push(() => timeout.mockRestore());
  const refresh = spyOn(runtime, "refresh").mockImplementation(options => new Promise(resolve => {
    const signal = options?.signal;
    if (!signal) throw new Error("Refresh has no cancellation signal");
    signal.addEventListener("abort", () => resolve({ aborted: true, errors: new Map() }), { once: true });
  }));
  cleanups.push(() => refresh.mockRestore());
  expect((await refreshPiModelCatalogue()).aborted).toBe(true);
  expect(timeout).toHaveBeenCalledWith(15_000);
});

test("new built-in definitions load into the live runtime and persist without changing custom or enabled models", async () => {
  const fixture = catalogFixture();
  const before = await savedConfiguration();
  expect(runtime.getModel("openai", fixture.model.id)).toBeUndefined();
  const result = await refreshPiModelCatalogue();
  expect(result.aborted).toBe(false);
  expect([...result.errors]).toEqual([]);
  expect(runtime.getModel("openai", fixture.model.id)?.name).toBe("Refreshed built-in model");
  expect(runtime.getModel("openai", "local-custom-model")?.contextWindow).toBe(8192);
  expect(await getEnabledModels()).toEqual([{ provider: "openai", id: "local-custom-model", label: "My custom model" }]);
  expect(await savedConfiguration()).toEqual(before);
  expect(fixture.requests.some(request => new URL(request.url).pathname === "/api/models/providers/openai")).toBe(true);
  for (const request of fixture.requests) {
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBeNull();
    expect(new URL(request.url).searchParams.get("types")).toBe("chat,image,classifier");
  }
  const requestsBeforeReload = fixture.requests.length;
  const catalogue = await readPiModelCatalogue();
  expect(catalogue.getModel("openai", fixture.model.id)?.name).toBe("Refreshed built-in model");
  expect(fixture.requests).toHaveLength(requestsBeforeReload);
  const reloaded = await ModelRuntime.create({ authPath: join(dataDir, "pi-config", "auth.json"), modelsPath: join(dataDir, "pi-config", "models.json"), allowModelNetwork: false });
  expect(reloaded.getModel("openai", fixture.model.id)?.name).toBe("Refreshed built-in model");
  expect(fixture.requests).toHaveLength(requestsBeforeReload);
});

test("provider errors remain explicit and a failed forced refresh retains the cached catalogue", async () => {
  const fixture = catalogFixture();
  expect((await refreshPiModelCatalogue()).errors.size).toBe(0);
  const before = await savedConfiguration();
  fixture.fail();
  const requestsBeforeRetry = fixture.requests.length;
  const result = await refreshPiModelCatalogue();
  expect(result.aborted).toBe(false);
  expect(result.errors.get("openai")?.message).toContain("400");
  expect(fixture.requests.length).toBeGreaterThan(requestsBeforeRetry);
  expect(runtime.getModel("openai", fixture.model.id)).toBeDefined();
  expect(await savedConfiguration()).toEqual(before);
});

test("the shared refresh publishes new definitions for key providers and applies OpenRouter's account catalogue", async () => {
  const keyProviders = ["openai", "openai-codex", "anthropic", "xai", "google", "opencode-go", "openrouter"];
  await updateJsonSettings(join(dataDir, "pi-config", "auth.json"), stored => {
    for (const provider of keyProviders) {
      stored[provider] = provider === "openai-codex"
        ? { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 }
        : { type: "api_key", key: `fixture-${provider}` };
    }
  });
  const definitions = new Map<string, Model<Api>>(keyProviders.map(provider => {
    const base = runtime.getModels(provider)[0];
    if (!base) throw new Error(`No bundled fixture model for ${provider}`);
    return [provider, { ...base, id: `${provider}-refreshed-fixture`, name: `New ${provider} model` }] as const;
  }));
  const requests: Request[] = [];
  const blockedModelId = "openrouter-not-on-this-account";
  let failedProvider: string | undefined;
  respond = async request => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.origin === "https://openrouter.ai" && url.pathname === "/api/v1/models/user") {
      return Response.json({ data: [{ id: definitions.get("openrouter")!.id, context_length: 32_000 }] });
    }
    if (url.origin !== "https://pi.dev" || !url.pathname.startsWith("/api/models/providers/")) throw new Error("Unexpected provider request");
    const provider = url.pathname.split("/").at(-1)!;
    const model = definitions.get(provider);
    if (!model) return new Response(null, { status: 404 });
    if (provider === failedProvider) return new Response(null, { status: 403 });
    const models = provider === "openrouter" ? [model, { ...model, id: blockedModelId }] : [model];
    return Response.json({ models }, { headers: { "last-modified": "Sun, 01 Jan 2040 00:00:00 GMT" } });
  };

  const before = await savedConfiguration();
  expect((await refreshPiModelCatalogue()).errors.size).toBe(0);
  const readOnly = await readPiModelCatalogue();
  for (const [provider, model] of definitions) {
    expect(runtime.getModel(provider, model.id)?.name).toBe(model.name);
    expect((await runtime.getAvailable(provider)).some(available => available.id === model.id)).toBe(true);
    expect(readOnly.getModel(provider, model.id)?.name).toBe(model.name);
    expect(requests.some(request => request.url.startsWith(`https://pi.dev/api/models/providers/${provider}?`))).toBe(true);
  }
  expect(runtime.getModel("openrouter", blockedModelId)).toBeUndefined();
  expect(runtime.getModel("openrouter", definitions.get("openrouter")!.id)?.contextWindow).toBe(32_000);
  expect(requests.find(request => request.url === "https://openrouter.ai/api/v1/models/user")?.headers.get("authorization")).toBe("Bearer fixture-openrouter");
  expect(requests.every(request => request.method === "GET")).toBe(true);
  expect(requests.filter(request => request.url.startsWith("https://pi.dev/")).every(request => !request.headers.has("authorization"))).toBe(true);

  requests.length = 0;
  failedProvider = "anthropic";
  const google = definitions.get("google")!;
  definitions.set("google", { ...google, name: "Updated Google definition" });
  const partial = await refreshPiModelCatalogue();
  expect([...partial.errors.keys()]).toEqual(["anthropic"]);
  expect(runtime.getModel("anthropic", definitions.get("anthropic")!.id)).toBeDefined();
  expect(runtime.getModel("google", google.id)?.name).toBe("Updated Google definition");
  expect(await savedConfiguration()).toEqual(before);
});
