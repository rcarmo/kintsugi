// Native execution/protocol regression: an already-running code-mode tool sees newly approved models.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { updateJsonSettings } from "@kintsugi/core/json-settings";
import { createPiModelRuntime, getEnabledModels, refreshPiModelCatalogue, setEnabledModels } from "@kintsugi/llm/server";
import { withStreamSimple } from "../../src/server/durable-models.ts";
import { openDurableAgentRuntime, type DurableAgentRuntime } from "../../src/server/durable-runtime.ts";

test("an in-flight Agent sees a newly approved Copilot account model without reopening its runtime or changing its selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-live-catalogue-"));
  const previous = process.env.KINTSUGI_DATA_DIR, realFetch = globalThis.fetch;
  const entered = Promise.withResolvers<void>(), approved = Promise.withResolvers<void>();
  let owner: DurableAgentRuntime | undefined;
  process.env.KINTSUGI_DATA_DIR = directory;
  globalThis.fetch = Object.assign(async () => { throw new Error("No network before explicit catalogue refresh"); }, { preconnect: realFetch.preconnect });
  try {
    await updateJsonSettings(join(directory, "pi-config", "auth.json"), stored => { stored["github-copilot"] = { type: "oauth", refresh: "fixture-github-token", access: "fixture;proxy-ep=proxy.individual.githubcopilot.com;", expires: Date.now() + 3_600_000, availableModelIds: [] }; });
    const models = await createPiModelRuntime();
    const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "current" }] });
    models.registerNativeProvider(faux.provider);
    await setEnabledModels([{ provider: "faux", id: "current", label: "Current model" }]);
    const model = { ...models.getModels("github-copilot")[0]!, id: "newly-approved-fixture", name: "Newly approved model" };
    const registry = createRegistry();
    registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }) }));
    registry.install(defineExtension({ name: "catalogue-approval-gate", tools: [defineTool({
      name: "waitForApproval", description: "Hold this synthetic run while model approval is saved", parameters: Type.Object({}),
      async execute() { entered.resolve(); await approved.promise; return { output: [{ type: "text", text: "approved" }] }; },
    })] }));
    const heldModels = withStreamSimple(models, models.streamSimple.bind(models));
    owner = await openDurableAgentRuntime(join(directory, "journal"), "catalogue-fixture", {}, {
      harness: async () => ({ models: heldModels, registry }),
      prepare: async () => ({ model: { provider: "faux", modelId: "current" }, thinkingLevel: "off", instructions: "Catalogue approval regression" }),
      expand: async (_workspace, text) => text, validateModel: async () => {}, ready: async () => {},
    });
    const agent = await owner.agent({ agentId: "existing", label: "Existing Agent", title: "Already running" });
    const selectedBefore = (await agent.settings()).model;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code: `await tools.waitForApproval({}); return (await models.getAvailableOfType("chat", "github-copilot")).find(model => model.id === "${model.id}");` })], { stopReason: "toolUse" }),
      fauxAssistantMessage("The newly approved model is visible."),
    ]);
    const submission = await agent.submit({ requestId: "existing-run", text: "Wait for approval, then inspect the model catalogue." });
    await entered.promise;
    expect(models.getModel("github-copilot", model.id)).toBeUndefined();
    const requests: string[] = [];
    globalThis.fetch = Object.assign(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init), url = new URL(request.url);
      requests.push(url.href);
      if (url.origin === "https://api.individual.githubcopilot.com" && url.pathname === "/models") return Response.json({ data: [{ id: model.id, model_picker_enabled: true, policy: { state: "enabled" } }] });
      if (url.origin !== "https://pi.dev" || !url.pathname.startsWith("/api/models/providers/")) throw new Error("No provider inference is allowed");
      return url.pathname === "/api/models/providers/github-copilot"
        ? Response.json({ models: [model] }, { headers: { "last-modified": "Sun, 01 Jan 2040 00:00:00 GMT" } })
        : new Response(null, { status: 404 });
    }, { preconnect: realFetch.preconnect });
    expect((await refreshPiModelCatalogue()).errors.size).toBe(0);
    await setEnabledModels([...(await getEnabledModels()), { provider: "github-copilot", id: model.id, label: model.name }]);
    expect(await createPiModelRuntime()).toBe(models);
    approved.resolve();
    expect((await submission.wait(context)).status).toBe("done");
    const results = (await agent.context(context)).messages.filter(message => message.role === "toolResult" && message.toolName === "codemode");
    expect(JSON.stringify(results)).toContain(model.id);
    expect(JSON.stringify(results)).toContain(model.name);
    expect((await agent.settings()).model).toEqual(selectedBefore);
    expect(requests.some(url => new URL(url).pathname === "/api/models/providers/github-copilot")).toBe(true);
    expect(faux.state.callCount).toBe(2);
  } finally {
    approved.resolve();
    await owner?.suspend();
    globalThis.fetch = realFetch;
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
