import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, normalizeContext, type Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { createRegistry } from "@earendil-works/pi-durable";
import { isJsonObject, type JsonObject, type JsonValue } from "@kintsugi/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { agentPlanStore } from "@kintsugi/agent/server/plan";
import { createNativePlanExtension } from "../../src/server/durable-plan.ts";
import { openDurableWorkspace } from "../../src/server/durable-workspace.ts";
import { planContextPrefix } from "../../src/server/plan-context.ts";

// Hash block boundaries incrementally: never retain quadratic copies of prefixes.
function boundaries(payload: JsonObject) {
  const hash = createHash("sha256"), all = new Set<string>(), conversation: string[] = [];
  let markers = 0, cachedPlan = false;
  const blocks = (value: JsonValue | undefined): JsonObject[] => Value.Check(Type.String(), value) ? [{ type: "text", text: value }] : Array.isArray(value) ? value.filter(isJsonObject) : [];
  const add = (kind: string, value: JsonObject, inConversation = false) => {
    const { cache_control, ...content } = value;
    hash.update(JSON.stringify([kind, content]));
    const key = hash.copy().digest("hex"); all.add(key);
    if (cache_control) {
      markers++;
      if (inConversation) conversation.push(key);
      if (Value.Check(Type.String(), content.text) && content.text.startsWith(planContextPrefix)) cachedPlan = true;
    }
  };
  for (const tool of blocks(payload.tools)) add("tool", tool);
  for (const block of blocks(payload.system)) add("system", block);
  for (const message of blocks(payload.messages)) {
    hash.update(JSON.stringify(["role", message.role]));
    for (const block of blocks(message.content)) add("content", block, true);
  }
  return { all, conversation, markers, cachedPlan };
}

test("real Anthropic serialization reuses canonical history ahead of the transient plan, with no added breakpoint or inference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-cache-wire-")), previous = process.env.ATELIER_DATA_DIR;
  process.env.ATELIER_DATA_DIR = dir;
  const model: Model<"anthropic-messages"> = { id: "claude-sonnet-4-20250514", name: "Offline", provider: "fixture", api: "anthropic-messages", baseUrl: "https://never-contact.invalid", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const models = createModels(), registry = createRegistry(), captured: JsonObject[] = [];
  let networkCalls = 0;
  models.getModel = () => model;
  models.streamSimple = (_selected, request, options) => stream(model, normalizeContext(request), {
    ...options, apiKey: "offline-only",
    async onPayload(payload, ref) {
      const rewritten = await options?.onPayload?.(payload, ref) ?? payload;
      if (!isJsonObject(rewritten)) throw new Error("Expected a request object");
      captured.push(rewritten);
      throw new Error("STOP_BEFORE_NETWORK");
    },
    fetch: Object.assign(async () => { networkCalls++; throw new Error("Network forbidden"); }, { preconnect() {} }),
  });
  registry.install(createNativePlanExtension("w", () => workspace.harness));
  const workspace = await openDurableWorkspace(join(dir, "journal"), "w", { models, registry, settings: { stream: { cacheRetention: "short" }, retry: { enabled: false } } });
  try {
    const agent = await workspace.agent({ agentId: "a", label: "Agent", title: "Offline" }, { model: { provider: "fixture", modelId: model.id }, instructions: "Shared instructions. ".repeat(100) });
    agentPlanStore().change("w", "a", { action: "write", markdown: "- [-] Inspect\n- [ ] Verify" });
    for (const text of ["First request", "Second request"]) await (await agent.submit({ type: "input", content: text }, ctx)).wait(ctx);
    expect(captured).toHaveLength(2); expect(networkCalls).toBe(0);
    const first = boundaries(captured[0]!), second = boundaries(captured[1]!);
    expect(first.cachedPlan).toBe(false);
    expect(first.conversation).toHaveLength(1);
    expect(second.all.has(first.conversation[0]!)).toBe(true);
    expect(first.markers).toBeLessThanOrEqual(3);
    const history = (await agent.entries({}, 100, undefined, ctx)).items;
    expect(JSON.stringify(history)).not.toContain(planContextPrefix);
  } finally {
    await workspace.close();
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR; else process.env.ATELIER_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
