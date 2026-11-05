import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, normalizeContext, type Api, type Message, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { agentPlanStore } from "@kintsugi/agent/server/plan";
import { createNativePlanExtension, durablePlanContextEntry } from "../../src/server/durable-plan.ts";
import { durablePromptCache, sharedInstructionsFirst } from "../../src/server/durable-prompt-cache.ts";
import { openDurableWorkspace } from "../../src/server/durable-workspace.ts";

const apis = ["anthropic-messages", "openai-responses", "openai-codex-responses", "openai-completions", "azure-openai-responses", "bedrock-converse-stream", "google-generative-ai", "google-vertex", "mistral-conversations", "pi-messages"] as const;
const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64url")}.x`;

// Use actual canonical requests produced through the journal, not hand-assembled
// suffixes. Capture before network for every SDK text-generation API.
test("append-only plans survive every provider serializer without transient marker rewrites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cache-providers-")), previous = process.env.ATELIER_DATA_DIR;
  process.env.ATELIER_DATA_DIR = dir;
  const models = createModels(), faux = fauxProvider({ tokensPerSecond: 100_000 }); models.setProvider(faux.provider);
  const registry = createRegistry(), requests: (readonly Message[])[] = [];
  const originalStream = models.streamSimple.bind(models);
  models.streamSimple = (model, request, options) => { requests.push(request.messages); return originalStream(model, request, options); };
  registry.install(durablePromptCache);
  registry.install(defineExtension({ name: "test-agent-identity", sections: [section("identity", () => "Agent-specific identity")] }));
  registry.install(createNativePlanExtension("w", () => workspace.harness));
  const workspace = await openDurableWorkspace(join(dir, "journal"), "w", { models, registry });
  try {
    const agent = await workspace.agent({ agentId: "a", title: "A", label: "A" }, { model: { provider: "faux", modelId: "faux-1" }, instructions: "Shared project guidance" });
    agentPlanStore().change("w", "a", { action: "write", markdown: "- [ ] First plan" });
    faux.setResponses([fauxAssistantMessage("First answer"), fauxAssistantMessage("Second answer"), fauxAssistantMessage("Third answer")]);
    await (await agent.submit({ type: "input", content: "First", requestId: "first" }, ctx)).wait(ctx);
    await (await agent.submit({ type: "input", content: "Second", requestId: "second" }, ctx)).wait(ctx);
    agentPlanStore().change("w", "a", { action: "write", markdown: "- [ ] Updated plan" });
    await (await agent.submit({ type: "input", content: "Third", requestId: "third" }, ctx)).wait(ctx);
    expect(requests).toHaveLength(3);
    expect(requests[1]!.slice(0, requests[0]!.length)).toEqual([...requests[0]!]);
    expect(requests[2]!.slice(0, requests[1]!.length)).toEqual([...requests[1]!]);
    expect(Object.keys(requests[0]![0]!.role === "system" ? requests[0]![0]!.sections ?? {} : {})).toEqual(["instructions", "identity"]);
    expect((await agent.entries({}, 100, undefined, ctx)).items.filter(durablePlanContextEntry.is)).toHaveLength(2);
    for (const api of apis) {
      const serializer: ProviderStreams = await import(`@earendil-works/pi-ai/api/${api}`);
      const model: Model<Api> = { id: api === "bedrock-converse-stream" ? "anthropic.claude-sonnet-4-20250514-v1:0" : api === "anthropic-messages" ? "claude-sonnet-4-20250514" : "gpt-5.4", name: "Offline", provider: "offline", api, baseUrl: "https://never-contact.invalid", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      for (const retention of ["short", "none"] as const) {
        const captured: unknown[] = [];
        let networkCalls = 0;
        for (const messages of requests) {
          const result = await serializer.stream(model, normalizeContext({ messages: [...messages] }), {
            apiKey: api === "openai-codex-responses" ? token : "offline-only", cacheRetention: retention, sessionId: "stable-session",
            async onPayload(payload) { captured.push(JSON.parse(JSON.stringify(payload))); throw new Error("STOP_BEFORE_NETWORK"); },
            // Google rejects custom fetch outright; its onPayload also runs before send.
            fetch: api.startsWith("google-") ? undefined : Object.assign(async () => { networkCalls++; throw new Error("Network forbidden"); }, { preconnect() {} }),
          }).result();
          if (!captured.length) throw new Error(`${api}: ${result.errorMessage}`);
        }
        expect(captured.length, `${api}/${retention}: reached serializer`).toBe(3);
        expect(networkCalls, api).toBe(0);
        const wire = captured.map(value => JSON.stringify(value));
        expect(wire.every(value => value.includes("First plan")), api).toBe(true);
        expect(wire[0], api).not.toContain("Updated plan");
        expect(wire[1], api).not.toContain("Updated plan");
        expect(wire[2], api).toContain("Updated plan");
        // Earlier plan remains in history, not replaced by the latest snapshot.
        expect(wire[2]!.indexOf("First plan"), api).toBeLessThan(wire[2]!.indexOf("Updated plan"));
        expect(wire[0]!.indexOf("Shared project guidance"), api).toBeLessThan(wire[0]!.indexOf("Agent-specific identity"));
      }
    }
  } finally {
    await workspace.close();
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR; else process.env.ATELIER_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("shared-first projection retains system patches, tools and signed assistant messages", () => {
  const messages: Message[] = [
    { role: "system", content: "", sections: { identity: "own", instructions: "shared" }, timestamp: 0 },
    fauxAssistantMessage([{ type: "thinking", thinking: "signed", thinkingSignature: "signature" }]),
    { role: "system", content: "", sections: { identity: "changed" }, toolsRemoved: [{ name: "old" }], timestamp: 1 },
  ];
  const before = JSON.stringify(messages), projected = sharedInstructionsFirst(messages);
  expect(Object.keys(projected[0]!.role === "system" ? projected[0]!.sections! : {})).toEqual(["instructions", "identity"]);
  expect(projected[1]).toBe(messages[1]); expect(projected[2]).toBe(messages[2]);
  expect(JSON.stringify(messages)).toBe(before);
});

for (const api of ["anthropic-messages", "openai-responses", "openai-codex-responses", "openai-completions"] as const) {
  for (const nativeChanges of [false, true]) {
    test(`${api}: ${nativeChanges ? "native" : "fallback"} instruction/tool changes preserve current semantics`, async () => {
      const serializer: ProviderStreams = await import(`@earendil-works/pi-ai/api/${api}`);
      const model: Model<typeof api> = { id: api === "anthropic-messages" ? "claude-sonnet-4-20250514" : "gpt-5.4", name: "Offline", provider: "offline", api, baseUrl: "https://never-contact.invalid", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsMidConvoSystemMessages: nativeChanges, supportsMidConvoToolChanges: nativeChanges, supportsAdditionalTools: nativeChanges } };
      const messages: Message[] = [
        { role: "system", content: "", sections: { identity: "Root identity", instructions: "Shared project instructions" }, toolsAdded: [{ name: "old_tool", description: "Old tool", parameters: { type: "object", properties: {} } }], timestamp: 0 },
        { role: "user", content: "First", timestamp: 0 },
        fauxAssistantMessage("Prior answer"),
        { role: "system", content: "", sections: { identity: "Updated role instructions" }, toolsRemoved: [{ name: "old_tool" }], toolsAdded: [{ name: "new_tool", description: "New tool", parameters: { type: "object", properties: {} } }], timestamp: 1 },
        { role: "user", content: "Next", timestamp: 1 },
      ];
      const captured: unknown[] = [];
      const result = await serializer.stream(model, normalizeContext({ messages: sharedInstructionsFirst(messages) }), {
        apiKey: api === "openai-codex-responses" ? token : "offline-only", cacheRetention: "short", sessionId: "stable",
        onPayload(payload) { captured.push(payload); throw new Error("STOP_BEFORE_NETWORK"); },
        fetch: Object.assign(async () => { throw new Error("Network forbidden"); }, { preconnect() {} }),
      }).result();
      expect(captured.length, result.errorMessage).toBe(1);
      const wire = JSON.stringify(captured[0]);
      expect(wire).toContain("Shared project instructions");
      expect(wire).toContain("Updated role instructions");
      expect(wire).toContain("new_tool");
      expect(wire.indexOf("Shared project instructions")).toBeLessThan(wire.indexOf(nativeChanges ? "Root identity" : "Updated role instructions"));
      // No capability is forced to true in production to hide required invalidation.
      expect(model.compat?.supportsMidConvoSystemMessages).toBe(nativeChanges);
    });
  }
}
