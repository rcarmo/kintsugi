import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, normalizeContext, type Model } from "@earendil-works/pi-ai";
import { stream, closeOpenAICodexWebSocketSessions, getOpenAICodexWebSocketDebugStats } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { isJsonObject, type JsonObject } from "@kintsugi/core";
import { agentPlanStore } from "@kintsugi/agent/server/plan";
import { createNativePlanExtension } from "../../src/server/durable-plan.ts";
import { durablePromptCache } from "../../src/server/durable-prompt-cache.ts";
import { openDurableWorkspace } from "../../src/server/durable-workspace.ts";

// Real SDK transport and serializer, local offline provider; no production host or token.
test("Codex sends WebSocket deltas with unchanged and edited canonical plans", async () => {
  const bodies: JsonObject[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request, server) {
    if (server.upgrade(request)) return;
    return new Response("WebSocket only", { status: 400 });
  }, websocket: { message(socket, data) {
    const body: unknown = JSON.parse(String(data));
    if (!isJsonObject(body)) throw new Error("Expected request body");
    bodies.push(body);
    const id = `resp_${bodies.length}`, item = { id: `msg_${bodies.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Offline answer", annotations: [] }] };
    socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } }));
    socket.send(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }));
    socket.send(JSON.stringify({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    socket.send(JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Offline answer" }));
    socket.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
    socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 90 } } } }));
  } } });
  const dir = await mkdtemp(join(tmpdir(), "plan-codex-")), previous = process.env.KINTSUGI_DATA_DIR;
  process.env.KINTSUGI_DATA_DIR = dir;
  const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64url")}.x`;
  const model: Model<"openai-codex-responses"> = { id: "gpt-5.4", name: "Offline", provider: "offline", api: "openai-codex-responses", baseUrl: server.url.toString(), reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const models = createModels(), registry = createRegistry();
  let session: string | undefined;
  models.getModel = () => model;
  models.streamSimple = (_model, request, options) => {
    session = options?.sessionId;
    return stream(model, normalizeContext(request), { ...options, apiKey: token, transport: "websocket-cached", websocketConnectTimeoutMs: 2000, timeoutMs: 2000 });
  };
  registry.install(durablePromptCache);
  registry.install(createNativePlanExtension("w", () => workspace.harness));
  const workspace = await openDurableWorkspace(join(dir, "journal"), "w", { models, registry, settings: { retry: { enabled: false }, stream: { cacheRetention: "short" } } });
  try {
    const agent = await workspace.agent({ agentId: "a", title: "A", label: "A" }, { model: { provider: model.provider, modelId: model.id }, instructions: "Shared instructions" });
    agentPlanStore().change("w", "a", { action: "write", markdown: "- [ ] First" });
    for (let i = 0; i < 3; i++) {
      if (i === 2) agentPlanStore().change("w", "a", { action: "write", markdown: "- [ ] Changed" });
      await (await agent.submit({ type: "input", content: `Round ${i}`, requestId: String(i) }, ctx)).wait(ctx);
    }
    expect(bodies).toHaveLength(3);
    expect(bodies[0]!.previous_response_id).toBeUndefined();
    expect(bodies[1]!.previous_response_id).toBe("resp_1");
    expect(bodies[2]!.previous_response_id).toBe("resp_2");
    expect(JSON.stringify(bodies[1]!.input)).not.toContain("First");
    expect(JSON.stringify(bodies[2]!.input)).toContain("Changed");
    expect(getOpenAICodexWebSocketDebugStats(session!)?.deltaRequests).toBe(2);
  } finally {
    if (session) closeOpenAICodexWebSocketSessions(session);
    await workspace.close(); await server.stop(true);
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
