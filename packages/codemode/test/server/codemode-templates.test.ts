import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type AgentChange } from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import type { PromptTemplate } from "@kintsugi/agent/server/prompt-templates";
import type { ToolView, TranscriptItem } from "@kintsugi/agent/server/transcript";
import { openDurableAgentRuntime, type DurableAgentRuntime } from "@kintsugi/builtin-agent/server/durable-runtime";
import { assertNoTemplateAttachments, codemodeTemplateResponse, createCodemodeTemplates } from "@kintsugi/builtin-agent/server/durable-codemode-templates";
import { durableViewState, projectDurableTranscript } from "@kintsugi/builtin-agent/server";
import { createWorkspaceCodemodeExtension } from "../../src/server/extension.ts";
// Importing support also makes transcripts show each script's calls as code mode records them.
import { localScriptFiles } from "./support.ts";

const context = BACKGROUND_CONTEXT;
const paths: string[] = [];
const runtimes: DurableAgentRuntime[] = [];
const record = { agentId: "tab", label: "Agent 1", title: "Code mode templates" };
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.suspend()));
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const templates: PromptTemplate[] = [
  { name: "echo", trigger: "/echo", description: "Echo the arguments", prompt: "return await tools.echo({ text: argumentsText });", codemode: true },
  { name: "wait", trigger: "/wait", description: "Echo, then wait", prompt: "await tools.echo({ text: 'before the wait' });\nawait tools.hold({});", codemode: true },
  { name: "review", trigger: "/review", description: "A prompt", prompt: "Review this" },
];

async function setup() {
  const path = await mkdtemp(join(tmpdir(), "kintsugi-codemode-templates-"));
  paths.push(path);
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "small", input: ["text"] }] });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const echoed: string[] = [];
  const held = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  registry.install(createWorkspaceCodemodeExtension("native-workspace", new CodemodeSandbox(), localScriptFiles));
  registry.install(defineExtension({ name: "codemode-template-test-tools", tools: [
    defineTool({
      name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }),
      async execute(args) { echoed.push(args.text); return { output: [{ type: "text", text: args.text }] }; },
    }),
    defineTool({
      name: "hold", description: "Hold until released or cancelled", parameters: Type.Object({}),
      async execute(_args, _api, invocation) {
        held.resolve();
        await new Promise<void>((resolve, reject) => {
          void released.promise.then(resolve);
          invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true });
        });
        return { output: [{ type: "text", text: "released" }] };
      },
    }),
  ] }));
  let current: DurableAgentRuntime | undefined;
  const codemodeTemplates = createCodemodeTemplates(async () => templates, () => current!.harness);
  registry.install(codemodeTemplates.extension);
  const load = {
    harness: async () => ({ models: codemodeTemplates.models(models), registry }),
    prepare: async (): Promise<AgentChange> => ({ model: { provider: "faux", modelId: "small" }, instructions: "Committed instructions", thinkingLevel: "off" }),
    expand: async (_workspace: string, text: string) => text,
    validateModel: async () => {},
    ready: async () => {},
  };
  const open = async () => {
    const runtime = await openDurableAgentRuntime(path, "native-workspace", {}, load);
    runtimes.push(runtime);
    current = runtime;
    return runtime;
  };
  return { faux, echoed, held: () => held.promise, release: () => released.resolve(), open, runtime: await open() };
}

type Agent = Awaited<ReturnType<DurableAgentRuntime["agent"]>>;

async function transcript(agent: Agent): Promise<TranscriptItem[]> {
  const watch = await agent.watch(context);
  const items = projectDurableTranscript(watch.value);
  await watch.stop();
  return items;
}

function codemodeTools(items: TranscriptItem[]): ToolView[] {
  return items.flatMap(item => item.type === "tool" && item.tool.name === "codemode" ? [item.tool] : item.type === "working" ? codemodeTools(item.items) : []);
}

async function modelMessages(agent: Agent): Promise<Message[]> {
  return [...(await agent.context(context)).messages];
}

test("a template's message gets its script as the agent's call, and only a prompt template's text is left for the model", () => {
  const response = codemodeTemplateResponse([{ role: "user", content: "/echo hello there", timestamp: 1 }], templates, 2)!;
  expect(response).toMatchObject({ role: "assistant", stopReason: "toolUse", timestamp: 2, usage: { totalTokens: 0, cost: { total: 0 } } });
  expect(response.content).toEqual([{ type: "toolCall", id: expect.stringMatching(/^codemode_template_[0-9a-f]{32}$/), name: "codemode", arguments: { code: 'const args = ["hello","there"];\nconst argumentsText = "hello there";\nreturn await tools.echo({ text: argumentsText });' } }]);
  expect(codemodeTemplateResponse([{ role: "user", content: "/review", timestamp: 1 }], templates)).toBeUndefined();
  // Messages placed together each get their call; the others are left for the model.
  const together = codemodeTemplateResponse([{ role: "user", content: "/echo one", timestamp: 1 }, { role: "user", content: "And this", timestamp: 1 }, { role: "user", content: "/echo two", timestamp: 1 }], templates)!;
  expect(together.content.map(call => call.type === "toolCall" && call.arguments.code)).toEqual([expect.stringContaining('"one"'), expect.stringContaining('"two"')]);
  expect(codemodeTemplateResponse([{ role: "user", content: "/echo", timestamp: 1 }, { role: "toolResult", toolCallId: "x", toolName: "echo", content: [], isError: false, timestamp: 2 }], templates)).toBeUndefined();
});

test("a code mode template runs its script without asking the model, and the next message sees what it did", async () => {
  const { runtime, faux, echoed } = await setup();
  const agent = await runtime.agent(record);
  expect((await (await agent.submit({ requestId: "template", text: "/echo hello there" })).wait(context)).status).toBe("done");
  expect(faux.state.callCount).toBe(0);
  expect(echoed).toEqual(["hello there"]);

  const items = await transcript(agent);
  expect(items.find(item => item.type === "user")).toMatchObject({ text: "/echo hello there" });
  // The template finished its turn; it wasn't stopped.
  expect(items.find(item => item.type === "working")).toMatchObject({ completedAt: expect.any(Number), stoppedAt: undefined });
  const [tool] = codemodeTools(items);
  expect(tool).toMatchObject({ status: "ok" });
  expect(tool!.nested).toEqual([expect.objectContaining({ name: "echo", args: { text: "hello there" }, status: "ok", resultText: "hello there" })]);
  expect((await modelMessages(agent)).map(message => message.role)).toEqual(["system", "user", "assistant", "toolResult"]);

  faux.setResponses([(request) => {
    const roles = request.messages.map(message => message.role);
    expect(roles.slice(-4)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(JSON.stringify(request.messages)).toContain("hello there");
    return fauxAssistantMessage("I saw it");
  }]);
  expect((await (await agent.submit({ requestId: "after", text: "What happened?" })).wait(context)).status).toBe("done");
  expect(faux.state.callCount).toBe(1);
});

test("Stop ends a template's script like any other call", async () => {
  const { runtime, faux, held } = await setup();
  const agent = await runtime.agent(record);
  const submission = await agent.submit({ requestId: "template", text: "/wait" });
  await held();
  await agent.stop();
  expect((await submission.wait(context)).status).toBe("unanswered");
  const [tool] = codemodeTools(await transcript(agent));
  expect(tool!.nested).toEqual([
    expect.objectContaining({ name: "echo", status: "ok" }),
    expect.objectContaining({ name: "hold", status: "error", details: { aborted: true } }),
  ]);
  expect(faux.state.callCount).toBe(0);
});

test("a template's script picks up where it was after a restart, still without the model", async () => {
  const { runtime, faux, echoed, held, open } = await setup();
  const agent = await runtime.agent(record);
  await agent.submit({ requestId: "template", text: "/wait" });
  await held();
  await runtime.suspend();
  const reopened = await open();
  const restored = await reopened.agent(record);
  // The same request finds the saved submission.
  const submission = await restored.submit({ requestId: "template", text: "/wait" });
  await reopened.resume();
  // The interrupted hold isn't rerun; the script gets its interruption and ends.
  expect((await submission.wait(context)).status).toBe("done");
  expect(echoed).toEqual(["before the wait"]);
  expect(faux.state.callCount).toBe(0);
  const [tool] = codemodeTools(await transcript(restored));
  expect(tool!.nested!.map(call => [call.name, call.status])).toEqual([["echo", "ok"], ["hold", "error"]]);
});

test("a template sent while the agent works joins that work, and the agent carries on with its result", async () => {
  const { runtime, faux, held } = await setup();
  const agent = await runtime.agent(record);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: "await tools.hold({});" })], { stopReason: "toolUse" }),
    (request) => {
      expect(request.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "codemode" });
      expect(JSON.stringify(request.messages.at(-1))).toContain("steered in");
      return fauxAssistantMessage("Carried on");
    },
  ]);
  const first = await agent.submit({ requestId: "work", text: "Work" });
  await held();
  const steer = await agent.submit({ requestId: "template", text: "/echo steered in" });
  const watch = await agent.watch(context);
  const [slot] = durableViewState(watch.value).live.tools!;
  await watch.stop();
  await agent.abortTool(slot!.callId);
  expect((await first.wait(context)).status).toBe("done");
  expect((await steer.status(context)).status).not.toBe("queued");
  expect(faux.state.callCount).toBe(2);
  // Steering starts a new display block within the same execution run.
  const items = await transcript(agent);
  expect(items.map(item => item.type)).toEqual(["user", "working", "user", "working", "text"]);
  expect(items[2]).toMatchObject({ text: "/echo steered in" });
  expect([items[1], items[3]].map(item => item?.type === "working" && item.items.map(child => child.type))).toEqual([["tool"], ["tool"]]);
  expect(items[4]).toMatchObject({ text: "Carried on" });
});

test("a template only takes its typed arguments, so attachments are turned away", () => {
  expect(() => assertNoTemplateAttachments("/echo hi", templates)).toThrow("Code mode templates can't take attachments");
  expect(() => assertNoTemplateAttachments("/review", templates)).not.toThrow();
});

test("a template placed together with another message leaves that message for the model", async () => {
  const { runtime, faux, echoed } = await setup();
  const agent = await runtime.agent(record);
  const answering = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  faux.setResponses([
    async () => { answering.resolve(); await release.promise; return fauxAssistantMessage("First answer"); },
    (request) => {
      expect(request.messages.slice(-4).map(message => message.role)).toEqual(["user", "user", "assistant", "toolResult"]);
      return fauxAssistantMessage("Answered the rest");
    },
  ]);
  const first = await agent.submit({ requestId: "first", text: "First" });
  await answering.promise;
  // Placed together when the first answer ends: one steer and one follow-up.
  const template = await agent.submit({ requestId: "template", text: "/echo together", whenBusy: "steer" });
  const other = await agent.submit({ requestId: "other", text: "And the rest", whenBusy: "followUp" });
  release.resolve();
  expect((await first.wait(context)).status).toBe("done");
  expect((await template.wait(context)).status).toBe("done");
  expect((await other.wait(context)).status).toBe("done");
  expect(echoed).toEqual(["together"]);
  expect(faux.state.callCount).toBe(2);
  const turns = (await transcript(agent)).filter(item => item.type === "working");
  expect(turns).toHaveLength(2);
});

test("a message sent while a template runs gets its own turn, as it gets its own run", async () => {
  const { runtime, faux, held, release } = await setup();
  const agent = await runtime.agent(record);
  faux.setResponses([fauxAssistantMessage("Answered the message")]);
  const template = await agent.submit({ requestId: "template", text: "/wait" });
  await held();
  const message = await agent.submit({ requestId: "message", text: "Meanwhile" });
  release();
  expect((await template.wait(context)).status).toBe("done");
  expect((await message.wait(context)).status).toBe("done");
  expect(faux.state.callCount).toBe(1);
  const items = await transcript(agent);
  expect(items.map(item => item.type)).toEqual(["user", "working", "user", "working", "text"]);
  expect(items[1]).toMatchObject({ completedAt: expect.any(Number), stoppedAt: undefined });
});
