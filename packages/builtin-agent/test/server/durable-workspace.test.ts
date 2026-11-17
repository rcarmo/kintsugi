import { persistedTimelineText } from "./fixtures/sqlite-timeline.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineDoc, Harness, defineExtension, defineTool, LiveDoc, type HarnessOptions } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { submitDurableInput } from "../../src/server/durable-input.ts";
import { durableWorkspaceTool } from "../../src/server/durable-tools.ts";
import { defineWorkspaceTool } from "@kintsugi/agent/server/workspace-tool";
import { openDurableWorkspace, WorkspaceAgents, type DurableWorkspace } from "../../src/server/durable-workspace.ts";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const workspaces: DurableWorkspace[] = [];
const record = { agentId: "kintsugi-tab-1", label: "Agent 1", title: "Find the durability regression" };
const agent = { model: { provider: "faux", modelId: "faux-1" } };

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "kintsugi-durable-"));
  directories.push(path);
  return path;
}

function provider() {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, registry: createRegistry() };
}

async function open(path: string, options: HarnessOptions, workspaceId = "workspace-1") {
  const workspace = await openDurableWorkspace(path, workspaceId, options);
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Durable workspace journal", () => {
  test("forwards distinct provider session IDs for new Builtin agents and preserves them after reopen", async () => {
    const path = await directory();
    const options = provider();
    const sessionIds: (string | undefined)[] = [];
    const streamSimple = options.models.streamSimple.bind(options.models);
    options.models.streamSimple = (model, request, settings) => {
      sessionIds.push(settings?.sessionId);
      return streamSimple(model, request, settings);
    };
    options.faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("answer")));
    const first = await open(path, options);
    const one = await first.agent(record, agent);
    await (await one.submit({ type: "input", content: "First request", requestId: "one" }, context)).wait(context);
    const two = await first.agent({ ...record, agentId: "second-agent" }, agent);
    await (await two.submit({ type: "input", content: "Independent request", requestId: "two" }, context)).wait(context);
    await first.close();

    const reopened = await open(path, options);
    await (await (await reopened.agent(record)).submit({ type: "input", content: "After reopen", requestId: "three" }, context)).wait(context);
    expect(sessionIds).toHaveLength(3);
    for (const sessionId of sessionIds) {
      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(sessionIds[1]).not.toBe(sessionIds[0]);
    expect(sessionIds[2]).toBe(sessionIds[0]);
  });

  test("creates independent roots atomically and finds their stable identities after reopen", async () => {
    const path = await directory();
    const options = provider();
    const first = await open(path, options);
    const [one, same] = await Promise.all([
      first.agent(record, agent),
      first.agent(record, agent),
    ]);
    expect(same.id).toBe(one.id);
    const two = await first.agent({ ...record, agentId: "kintsugi-tab-2", label: "Agent 2" }, agent);
    expect(two.id).not.toBe(one.id);
    expect((await first.harness.inspect(context)).scheduling).toBe("paused");
    const catalog = await first.harness.snapshot(WorkspaceAgents, context);
    expect(catalog?.agents).toHaveLength(2);
    expect(catalog?.workspaceId).toBe("workspace-1");
    await first.close();

    const reopened = await open(path, options);
    expect((await reopened.agent(record)).id).toBe(one.id);
    expect((await reopened.harness.inspect(context)).scheduling).toBe("paused");
    const journal = persistedTimelineText(path);
    expect(journal).toContain("kintsugi.workspace");
    expect(journal).toContain(record.title);
    expect(journal).toContain(record.agentId);
  });

  test("deduplicates admitted inputs across reopening and keeps their text searchable", async () => {
    const path = await directory();
    const options = provider();
    options.faux.setResponses([fauxAssistantMessage("The committed answer.")]);
    const first = await open(path, options);
    const conversation = await first.agent(record, agent);
    const input = { type: "input", content: "Searchable user request.", requestId: "browser-request-1" } as const;
    const submission = await conversation.submit(input, context);
    expect((await submission.wait(context)).status).toBe("done");
    await first.close();

    const reopened = await open(path, options);
    const same = await (await reopened.agent(record)).submit(input, context);
    expect(same.id).toBe(submission.id);
    expect((await same.wait(context)).status).toBe("done");
    expect(options.faux.state.callCount).toBe(1);
    const journal = persistedTimelineText(path);
    expect(journal).toContain(input.content);
    expect(journal).toContain("The committed answer.");
  });

  test("excludes a second writer and releases ownership on close", async () => {
    const path = await directory();
    const options = provider();
    const first = await open(path, options);
    await expect(openDurableWorkspace(path, "workspace-1", options)).rejects.toThrow("Lock file is already being held");
    await first.close();
    await open(path, options);
  }, 20_000);

  test("waits for a live writer to release its lease without opening storage early", async () => {
    const path = await directory();
    const options = provider();
    const first = await open(path, options);
    let acquired = false;
    const pending = open(path, options).then((workspace) => { acquired = true; return workspace; });
    await Bun.sleep(700);
    expect(acquired).toBe(false);
    await first.close();
    const second = await pending;
    expect((await second.harness.inspect(context)).scheduling).toBe("paused");
  });

  test("rejects workspace identity mismatches without leaking the writer lease", async () => {
    const path = await directory();
    const options = provider();
    const first = await open(path, options);
    await first.close();
    await expect(openDurableWorkspace(path, "another-workspace", options)).rejects.toThrow("Journal belongs to workspace workspace-1");
    await open(path, options);
  });

  test.each(["suspend", "stop"] as const)("%s distinguishes host shutdown from withdrawing queued steering", async (operation) => {
    const path = await directory();
    const options = provider();
    const started = Promise.withResolvers<void>();
    options.registry.install(defineExtension({ name: "blocking", tools: [defineTool({
      name: "block", description: "Hold a tool round open", parameters: Type.Object({}),
      async execute(_args, _api, invocation) {
        started.resolve();
        return await new Promise<never>((_resolve, reject) => {
          invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true });
        });
      },
    })] }));
    options.faux.setResponses([
      fauxAssistantMessage([{ type: "toolCall", id: "blocking-call", name: "block", arguments: {} }], { stopReason: "toolUse" }),
      (request) => {
        expect(request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Use the steered instruction"))).toBe(true);
        return fauxAssistantMessage("Steering survived shutdown.");
      },
    ]);
    const first = await open(path, options);
    const conversation = await first.agent(record, agent);
    const initial = await submitDurableInput(conversation, "workspace-1", options.models, { text: "Begin", requestId: "initial" }, context, async (_workspace, text) => text);
    await started.promise;
    const steer = await submitDurableInput(conversation, "workspace-1", options.models, { text: "Use the steered instruction", requestId: "steer" }, context, async (_workspace, text) => text);
    expect((await steer.status(context)).status).toBe("queued");
    if (operation === "stop") {
      await conversation.abort(context);
      expect((await initial.status(context)).status).toBe("unanswered");
      expect((await steer.status(context)).status).toBe("unanswered");
    }
    await first.close();
    const reopened = await open(path, options);
    const restoredSteer = (await reopened.harness.submission(steer.id, context))!;
    if (operation === "suspend") {
      expect((await restoredSteer.status(context)).status).toBe("queued");
      expect((await restoredSteer.wait(context)).status).toBe("done");
      expect((await (await reopened.harness.submission(initial.id, context))!.status(context)).status).toBe("done");
      expect(options.faux.state.callCount).toBe(2);
    } else {
      expect((await restoredSteer.status(context)).status).toBe("unanswered");
      expect((await reopened.harness.inspect(context)).tasks).toHaveLength(0);
      expect(options.faux.state.callCount).toBe(1);
    }
  });

  test.each(["unsafe", "safe"] as const)("recovers a SIGKILL during a %s tool without losing admission", async (replay) => {
    const path = await directory();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/durable-crash.ts"), path, replay], {
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      while (!output.includes("effect-started")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Crash fixture exited before tool execution: ${await new Response(child.stderr).text()}`);
        output += decoder.decode(chunk.value);
      }
      reader.releaseLock();
      child.kill("SIGKILL");
      await child.exited;
      const options = provider();
      options.faux.setResponses([fauxAssistantMessage("Recovered without submitting another user message.")]);
      options.registry.install(defineExtension({ name: "crash-test", tools: [durableWorkspaceTool(defineWorkspaceTool({
        name: "effect", label: "Effect", description: "Exercise recovery after execution started", parameters: Type.Object({}),
        async execute() {
          await appendFile(join(path, "executions.txt"), "executed\n");
          return { content: [{ type: "text", text: "Replayed safely" }], details: undefined };
        },
      }), replay)] }));
      const reopened = await open(path, options, "crash-workspace");
      const inspection = await reopened.harness.inspect(context);
      expect(inspection.scheduling).toBe("paused");
      expect(inspection.submissions).toHaveLength(1);
      const pending = (await reopened.harness.submission(inspection.submissions[0]!.id, context))!;
      expect((await pending.wait(context)).status).toBe("done");
      expect(await readFile(join(path, "executions.txt"), "utf8")).toBe(replay === "safe" ? "executed\nexecuted\n" : "executed\n");
      const conversation = await reopened.agent({ agentId: "crash-tab", label: "Agent 1", title: "Crash recovery" });
      const entries = (await conversation.entries({}, 100, undefined, context)).items;
      const results = entries.filter((entry) => entry.kind === "pi.tool-result").flatMap((entry) => entry.model ?? []);
      expect(results).toHaveLength(1);
      expect(results[0]?.role === "toolResult" && results[0].isError).toBe(replay === "unsafe");
      expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 20_000);

  test("SIGKILL retains committed generation partial as aborted and recovers without a synthetic input", async () => {
    const path = await directory();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/durable-crash.ts"), path, "generation"], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      let output = "";
      while (!output.includes("partial-committed")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Generation fixture exited early: ${await new Response(child.stderr).text()}`);
        output += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      child.kill("SIGKILL");
      await child.exited;
      const options = provider();
      options.faux.setResponses([request => {
        expect(request.messages.filter(message => message.role === "user")).toHaveLength(1);
        expect(JSON.stringify(request)).not.toContain("Kintsugi restarted");
        return fauxAssistantMessage("Recovered generation");
      }]);
      const reopened = await open(path, options, "crash-workspace");
      const conversation = await reopened.agent({ agentId: "crash-tab", label: "Agent 1", title: "Crash recovery" });
      const partial = (await reopened.harness.snapshot(LiveDoc, conversation.id, context))?.generation?.message;
      expect(JSON.stringify(partial?.content)).toContain("Committed");
      expect(options.faux.state.callCount).toBe(0);
      const inspection = await reopened.harness.inspect(context);
      expect(inspection.scheduling).toBe("paused");
      expect(inspection.submissions).toHaveLength(1);
      const pending = (await reopened.harness.submission(inspection.submissions[0]!.id, context))!;
      expect((await pending.wait(context)).status).toBe("done");
      const messages = (await conversation.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []);
      const aborted = messages.find(message => message.role === "assistant" && message.stopReason === "aborted");
      expect(aborted?.content).toEqual(partial!.content);
      expect(messages.filter(message => message.role === "user")).toHaveLength(1);
      expect(JSON.stringify(messages)).toContain("Recovered generation");
      expect(options.faux.state.callCount).toBe(1);
    } finally { child.kill(); await child.exited; }
  }, 25_000);

  test("uses Kintsugi's existing model runtime directly, without a second provider/auth adapter", async () => {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage("Existing model runtime works.")]);
    runtime.registerNativeProvider(faux.provider);
    const workspace = await open(await directory(), { models: runtime, registry: createRegistry() });
    const conversation = await workspace.agent(record, agent);
    const submission = await conversation.submit({ type: "input", content: "Hello" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    expect(faux.state.callCount).toBe(1);
  });
});


test("previous workspace journal catalog retains native history while renaming Agent identities", async () => {
  const path = await directory();
  const options = provider();
  const previousCatalog = defineDoc<{
    workspaceId: string;
    conversations: { conversationId: string; durableId: number; label: string; title: string; branches: number[] }[];
  }>({ kind: "kintsugi.workspace", version: 1, scope: "session", initial: () => ({ workspaceId: "workspace-1", conversations: [] }), checkpointWhen: () => false, });
  const harness = await Harness.open(await openNodeJsonlStorage(path, context), options, context);
  const id = await harness.commit(async tx => {
    const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
    (await tx.doc(previousCatalog)).conversations.push({ conversationId: record.agentId, durableId: created.id, label: record.label, title: record.title, branches: [created.id] });
    return created.id;
  }, context);
  await harness.close(context);
  const workspace = await open(path, options);
  expect((await workspace.agent(record)).id).toBe(id);
  expect((await workspace.harness.snapshot(WorkspaceAgents, context))!.agents).toEqual([{ ...record, durableId: id, branches: [id] }]);
  await workspace.close();
  const reopened = await open(path, options);
  expect((await reopened.agent(record)).id).toBe(id);
});
