import { expect } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { customOpenAIDefaults, connectCustomOpenAIEndpoint, type CustomOpenAIEndpointInput } from "../../../src/server/custom-openai-endpoint.ts";
import { createPiModelRuntime, getCustomModelsJson } from "../../../src/server/pi-config-models.ts";

// Run in a fresh process: the production model runtime is intentionally an app-wide singleton.
const input: CustomOpenAIEndpointInput = { api: "openai-completions", name: "DevBox Ollama", baseUrl: "https://models.example.com/v1/", apiKey: "stub-only-key", ...customOpenAIDefaults };

const directory = await mkdtemp(join(tmpdir(), "endpoint-setup-"));
process.env.KINTSUGI_DATA_DIR = directory;
const paths: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  paths.push(new URL(request.url).pathname);
  expect(request.headers.get("authorization")).toBe(`Bearer ${input.apiKey}`);
  if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [{ id: "local-coder" }, { id: "local-coder" }, { id: "other" }] });
  if (new URL(request.url).pathname === "/v1/responses") {
    const body = await request.json();
    expect(body.model).toBe("local-coder");
    expect(body.stream).toBe(true);
    const item = { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp-1", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }
  if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("Unsupported", { status: 404 });
  const body = await request.json();
  if (body.model === "rejected") return Response.json({ error: { message: input.apiKey } }, { status: 401 });
  expect(body.model).toBe("manual-coder");
  expect(body.stream).toBe(true);
  const chunk = { id: "stub", object: "chat.completion.chunk", created: 1, model: "manual-coder", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] };
  const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
} });
try {
  const baseUrl = `http://127.0.0.1:${server.port}/v1`;
  const completions = await connectCustomOpenAIEndpoint({ ...input, baseUrl }, true);
  const responses = await connectCustomOpenAIEndpoint({ ...input, baseUrl, api: "openai-responses", name: "DevBox Responses", contextWindow: 65536, maxTokens: 2048 }, true);
  const manual = await connectCustomOpenAIEndpoint({ ...input, baseUrl, name: "Manual server", modelId: "manual-coder" }, false);
  expect(new Set([completions, responses, manual]).size).toBe(3);
  const runtime = await createPiModelRuntime();
  expect(runtime.getModel(completions, "local-coder")!.api).toBe("openai-completions");
  expect(runtime.getModels(completions).map(model => model.id)).toEqual(["local-coder", "other"]);
  expect(runtime.getModel(completions, "local-coder")).toMatchObject({ ...customOpenAIDefaults, reasoning: false, input: ["text"] });
  expect(runtime.getModel(responses, "local-coder")).toMatchObject({ api: "openai-responses", contextWindow: 65536, maxTokens: 2048 });
  expect(runtime.getProviders().find(provider => provider.id === responses)?.name).toBe("DevBox Responses");
  expect((await runtime.getAuth(runtime.getModel(completions, "local-coder")!))!.auth.apiKey).toBe(input.apiKey);
  const reply = await runtime.completeSimple(runtime.getModel(responses, "local-coder")!, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, { maxTokens: 16 });
  expect(reply.stopReason).toBe("stop");
  expect(reply.content[0]).toMatchObject({ type: "text", text: "ok" });
  expect(paths).toEqual(["/v1/models", "/v1/models", "/v1/chat/completions", "/v1/responses"]);
  const source = await getCustomModelsJson();
  expect(source).not.toContain(input.apiKey);
  const saved = JSON.parse(source);
  expect(saved.providers[completions].name).toBe("DevBox Ollama");
  const authPath = join(directory, "pi-config", "auth.json");
  expect(await readFile(authPath, "utf8")).toContain(input.apiKey);
  expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  expect(await readFile(join(directory, "pi-config", "models.json"), "utf8")).not.toContain(input.apiKey);
  // A bad manual ID never adds a provider or persists a credential.
  await expect(connectCustomOpenAIEndpoint({ ...input, baseUrl, modelId: "" }, false)).rejects.toThrow("model ID");
  const rejected = connectCustomOpenAIEndpoint({ ...input, baseUrl, modelId: "rejected" }, false);
  await expect(rejected).rejects.toThrow("model request failed");
  await expect(rejected).rejects.not.toThrow(input.apiKey);
  expect(await getCustomModelsJson()).toBe(source);
} finally {
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
