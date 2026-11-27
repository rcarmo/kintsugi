import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { attributeModelToolUsage, ModelToolUsage } from "../../src/server/durable-model-tool-usage.ts";
import { openDurableWorkspace } from "../../src/server/durable-workspace.ts";

/** Exercise real nested ToolTasks and committed accounting; no UI or external provider requests. */
test("classifier and image calls preserve actual provider/model attribution without forcing cache settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kintsugi-model-tool-usage-")), context = BACKGROUND_CONTEXT;
  const models = createModels(), faux = fauxProvider({ tokensPerSecond: 100_000 }); models.setProvider(faux.provider);
  const cacheOptions: (string | undefined)[] = [], sessionIds: (string | undefined)[] = [], prefixes: string[] = [];
  const stream = models.streamSimple.bind(models);
  models.streamSimple = (model, request, options) => {
    cacheOptions.push(options?.cacheRetention); sessionIds.push(options?.sessionId);
    prefixes.push(JSON.stringify(request.messages[0]));
    return stream(model, request, options);
  };
  const registry = createRegistry();
  const rawUsage = { input: 3, output: 2, cacheRead: 7, cacheWrite: 1, totalTokens: 13, cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 } };
  const imageUsage = { ...rawUsage, imageOutput: 1 };
  let executed = 0;
  const internalTools = ["classify", "generateImages"].map(name => attributeModelToolUsage(defineTool({
    name: `pi.codemode.models.${name}`, description: "Native model usage fixture", parameters: Type.Object({ model: Type.Object({ provider: Type.String(), id: Type.String() }) }), callers: ["tools"],
    async execute() { executed++; return { output: [{ type: "text", text: "model result" }], usage: name === "generateImages" ? imageUsage : rawUsage }; },
  })));
  registry.install(defineExtension({ name: "model-usage-fixture", tools: [...internalTools, defineTool({
    name: "invoke_models", description: "Invoke native model tools", parameters: Type.Object({}),
    async execute(_args, api, ctx) {
      await api.executeTool("pi.codemode.models.classify", { model: { provider: "classifier-provider", id: "classifier-model" } }, ctx, { key: "classifier" });
      await api.executeTool("pi.codemode.models.classify", { model: { provider: "classifier-provider", id: "classifier-model" } }, ctx, { key: "classifier" });
      await api.executeTool("pi.codemode.models.classify", { model: { provider: "classifier-provider", id: "classifier-model" } }, ctx, { key: "classifier-two" });
      await api.executeTool("pi.codemode.models.generateImages", { model: { provider: "image-provider", id: "image-model" } }, ctx, { key: "image" });
      return { output: [{ type: "text", text: "Done" }] };
    },
  })] }));
  let workspace = await openDurableWorkspace(dir, "workspace", { models, registry });
  const record = { agentId: "agent", title: "Agent", label: "Agent" };
  try {
    const agent = await workspace.agent(record, { model: { provider: "faux", modelId: "faux-1" }, instructions: "Stable application instructions" });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("invoke_models", {})], { stopReason: "toolUse" }), fauxAssistantMessage("Finished")]);
    await (await agent.submit({ type: "input", content: "Use the models", requestId: "first" }, context)).wait(context);
    const usage = await workspace.harness.snapshot(ModelToolUsage, agent.id, context);
    expect(usage?.models["classifier-provider/classifier-model"]).toMatchObject({ input: 6, output: 4, cacheRead: 14, cacheWrite: 2, totalTokens: 26 });
    expect(usage?.models["classifier-provider/classifier-model"]?.cost.total).toBeCloseTo(0.066);
    expect(usage?.models["classifier-provider/classifier-model"]).not.toHaveProperty("imageOutput");
    expect(usage?.models["image-provider/image-model"]).toEqual(imageUsage);
    expect(Object.keys(usage!.calls)).toHaveLength(3); expect(executed).toBe(3);
    expect(prefixes[0]).toBe(prefixes[1]);
    const originalSession = sessionIds[0];
    expect(originalSession).toBeTruthy(); expect(sessionIds[1]).toBe(originalSession);
    await workspace.close();
    workspace = await openDurableWorkspace(dir, "workspace", { models, registry });
    const reopened = await workspace.agent(record);
    faux.setResponses([fauxAssistantMessage("After restart")]);
    await (await reopened.submit({ type: "input", content: "Continue", requestId: "second" }, context)).wait(context);
    expect(sessionIds.at(-1)).toBe(originalSession);
    expect(cacheOptions.every(option => option === undefined)).toBe(true);
    expect((await workspace.harness.snapshot(ModelToolUsage, reopened.id, context))?.models).toEqual(usage?.models);
  } finally { await workspace.close(); await rm(dir, { recursive: true, force: true }); }
});
