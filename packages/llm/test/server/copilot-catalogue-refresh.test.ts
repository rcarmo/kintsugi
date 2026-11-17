import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { refreshGitHubCopilotModelAvailability } from "../../src/server/copilot-model-catalogue.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readJsonSettings, updateJsonSettings } from "@kintsugi/core/json-settings";
import { createPiModelRuntime, getEnabledModels, readPiModelCatalogue, refreshPiModelCatalogue, setEnabledModels } from "../../src/server/pi-config-models.ts";

let directory: string, runtime: ModelRuntime;
const previous = process.env.KINTSUGI_DATA_DIR, realFetch = globalThis.fetch;
const provider = "github-copilot", modelId = "copilot-newly-approved-fixture";
let accountStatus = 200, malformed = false, logoutDuringFetch = false, picker = true;
let holdCredentialLock: (() => Promise<void>) | undefined;
let accountHost = "api.individual.githubcopilot.com", oldId = "initial-placeholder";
let requests: Request[] = [];
const credential = () => ({ type: "oauth", refresh: "fixture-github-token", access: `fixture;proxy-ep=proxy.${accountHost.replace(/^api\./, "")};`, expires: Date.now() + 3_600_000, availableModelIds: [oldId] });
const authPath = () => join(directory, "pi-config", "auth.json");

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "kintsugi-copilot-catalogue-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  globalThis.fetch = Object.assign(async (input: URL | RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    requests.push(request);
    if (url.origin === "https://pi.dev" && url.pathname.startsWith("/api/models/providers/")) {
      if (url.pathname !== `/api/models/providers/${provider}`) return new Response(null, { status: 404 });
      const base = runtime.getModels(provider).find(model => model.id === oldId);
      if (!base) throw new Error("Missing bundled Copilot fixture model");
      return Response.json({ models: [modelId, "copilot-hidden", "copilot-no-tools"].map(id => ({ ...base, id, name: id })) }, { headers: { "last-modified": "Sun, 01 Jan 2040 00:00:00 GMT" } });
    }
    if (url.origin === `https://${accountHost}` && url.pathname === "/models") {
      if (logoutDuringFetch) await runtime.logout(provider);
      await holdCredentialLock?.();
      if (accountStatus !== 200) return new Response(null, { status: accountStatus });
      if (malformed) return Response.json({ wrong: "shape" });
      return Response.json({ data: [
        { id: modelId, model_picker_enabled: picker, policy: { state: "enabled" }, capabilities: { supports: { tool_calls: true } } },
        { id: oldId, model_picker_enabled: true, policy: { state: "disabled" } },
        { id: "copilot-hidden", model_picker_enabled: false, policy: { state: "enabled" } },
        { id: "copilot-no-tools", model_picker_enabled: true, policy: { state: "enabled" }, capabilities: { supports: { tool_calls: false } } },
      ] });
    }
    throw new Error("Unexpected request; no inference, token exchange or policy changes are allowed");
  }, { preconnect: realFetch.preconnect });
  await updateJsonSettings(authPath(), stored => { stored[provider] = credential(); });
  runtime = await createPiModelRuntime();
  oldId = runtime.getModels(provider)[0]!.id;
  await setEnabledModels([{ provider, id: oldId, label: "Existing choice" }]);
});
beforeEach(async () => {
  requests = []; accountStatus = 200; malformed = false; logoutDuringFetch = false; picker = true; holdCredentialLock = undefined; accountHost = "api.individual.githubcopilot.com";
  await updateJsonSettings(authPath(), stored => { stored[provider] = credential(); stored.unrelated = { type: "api_key", key: "untouched" }; });
  await runtime.refresh({ allowNetwork: false, providers: [provider] });
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = previous;
  await rm(directory, { recursive: true, force: true });
});

test("explicit refresh renews Copilot account availability even while its OAuth token remains valid", async () => {
  const before = await readJsonSettings(authPath());
  const enabled = await getEnabledModels();
  const result = await refreshPiModelCatalogue();
  expect([...result.errors]).toEqual([]);
  expect((await runtime.getAvailable(provider)).map(model => model.id)).toEqual([modelId]);
  const account = requests.find(request => new URL(request.url).pathname === "/models");
  expect(account?.url).toBe(`https://${accountHost}/models`);
  expect(account?.headers.get("authorization")).toBe(`Bearer ${credential().access}`);
  expect(account?.redirect).toBe("error");
  const saved = await readJsonSettings(authPath());
  expect(saved[provider]).toEqual(Object.assign({}, before[provider], { availableModelIds: [modelId] }));
  expect(saved.unrelated).toEqual(before.unrelated);
  expect(await getEnabledModels()).toEqual(enabled);
  expect((await readPiModelCatalogue()).getModel(provider, modelId)).toBeDefined();
  expect(requests.every(request => request.method === "GET")).toBe(true);
  expect(requests.some(request => request.url.includes("/policy") || request.url.includes("/token"))).toBe(false);
});

test("Copilot refresh uses the account's business endpoint and keeps strict picker filtering", async () => {
  accountHost = "api.business.githubcopilot.com"; picker = false;
  await updateJsonSettings(authPath(), stored => { stored[provider] = credential(); });
  expect((await refreshPiModelCatalogue()).errors.size).toBe(0);
  expect(requests.some(request => request.url === `https://${accountHost}/models`)).toBe(true);
  expect(await runtime.getAvailable(provider)).toEqual([]);
});

test("Copilot refresh keeps the Enterprise endpoint supplied by the stored sign-in", async () => {
  accountHost = "copilot-api.corp.example";
  await updateJsonSettings(authPath(), stored => { stored[provider] = { ...credential(), access: "fixture-enterprise-access", enterpriseUrl: "corp.example" }; });
  expect((await refreshPiModelCatalogue()).errors.size).toBe(0);
  expect(requests.some(request => request.url === `https://${accountHost}/models`)).toBe(true);
  expect((await runtime.getAvailable(provider)).map(model => model.id)).toEqual([modelId]);
});

test("Individual Copilot accounts retain Pi's enabled-policy fallback when all picker flags are false", async () => {
  picker = false;
  expect((await refreshPiModelCatalogue()).errors.size).toBe(0);
  expect((await runtime.getAvailable(provider)).map(model => model.id).sort()).toEqual([modelId, "copilot-hidden"].sort());
});

test("Copilot account errors are explicit and preserve the prior approved list", async () => {
  const before = await readJsonSettings(authPath()); accountStatus = 403;
  const result = await refreshPiModelCatalogue();
  expect(result.errors.get(provider)?.message).toContain("403");
  expect(await readJsonSettings(authPath())).toEqual(before);
  expect((await runtime.getAvailable(provider)).map(model => model.id)).toEqual([oldId]);
});

test("malformed Copilot account metadata does not replace a good availability list", async () => {
  const before = await readJsonSettings(authPath()); malformed = true;
  const result = await refreshPiModelCatalogue();
  expect(result.errors.has(provider)).toBe(true);
  expect(await readJsonSettings(authPath())).toEqual(before);
});

test("waiting for the SDK credential lock honours cancellation without writing", async () => {
  const before = await readJsonSettings(authPath());
  let release: (() => Promise<void>) | undefined;
  holdCredentialLock = async () => { release = await lock(authPath()); };
  try {
    await expect(refreshGitHubCopilotModelAvailability(runtime, authPath(), AbortSignal.timeout(50))).rejects.toThrow();
    expect(await readJsonSettings(authPath())).toEqual(before);
  } finally { await release?.(); }
});

test("a logout during the Copilot model request cannot be undone by its late result", async () => {
  logoutDuringFetch = true;
  const result = await refreshPiModelCatalogue();
  expect(result.errors.has(provider)).toBe(true);
  expect((await readJsonSettings(authPath()))[provider]).toBeUndefined();
});
