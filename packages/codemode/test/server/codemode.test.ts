import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { durableViewState, projectDurableTranscript } from "@kintsugi/builtin-agent/server";
import { openDurableAgentRuntime, type DurableAgentRuntime } from "@kintsugi/builtin-agent/server/durable-runtime";
import type { ToolView } from "@kintsugi/agent/server/transcript";
import { codemodeTool, localScriptFiles } from "./support.ts";
import { createWorkspaceCodemodeExtension } from "../../src/server/extension.ts";

const paths: string[] = [];
const runtimes: DurableAgentRuntime[] = [];
const record = { agentId: "tab", label: "Agent 1", title: "Code mode" };
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.suspend()));
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Code mode with an `echo` tool, and a `hold` tool that runs until it is cancelled or released, whose start `held`
 * reports. Reopening a suspended runtime's `path` picks up where it was.
 */
async function setup(reopen?: string) {
  const path = reopen ?? await mkdtemp(join(tmpdir(), "kintsugi-codemode-"));
  if (!reopen) paths.push(path);
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  const held = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const registry = createRegistry();
  registry.install(createWorkspaceCodemodeExtension("native-workspace", new CodemodeSandbox(), localScriptFiles));
  registry.install(defineExtension({ name: "codemode-test-tools", tools: [
    defineTool({
      name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }),
      async execute(args) { return { output: [{ type: "text", text: args.text }] }; },
    }),
    defineTool({
      name: "hold", description: "Hold until cancelled or released", parameters: Type.Object({}), replay: "safe",
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
  const runtime = await openDurableAgentRuntime(path, "native-workspace", {}, {
    harness: async () => ({ models, registry }),
    prepare: async () => ({ model: { provider: "faux", modelId: "faux-1" }, instructions: "Committed instructions", thinkingLevel: "off" }),
    expand: async (_workspace, text) => text, validateModel: async () => {}, ready: async () => {},
  });
  runtimes.push(runtime);
  return { runtime, faux, held, release: released.resolve, path, agent: await runtime.agent(record) };
}

type Agent = Awaited<ReturnType<DurableAgentRuntime["agent"]>>;

async function scriptTool(agent: Agent): Promise<ToolView | undefined> {
  const watch = await agent.watch(context);
  const tool = codemodeTool(projectDurableTranscript(watch.value));
  await watch.stop();
  return tool;
}

/** Wait until the running tool's committed output, which a stop keeps, contains `text`. */
async function committedOutput(agent: Agent, text: string) {
  for (;;) {
    const watch = await agent.watch(context);
    const output = durableViewState(watch.value).live.tools?.[0]?.output;
    await watch.stop();
    if (output?.includes(text)) return;
    await Bun.sleep(20);
  }
}

test("code mode records each call a script makes, with its arguments and result", async () => {
  const { faux, agent } = await setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: "return await tools.echo({ text: 'echoed' });" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  const startedAt = Date.now();
  expect((await (await agent.submit({ requestId: "script", text: "Run it" })).wait(context)).status).toBe("done");
  const [echo] = (await scriptTool(agent))!.nested!;
  expect(echo).toMatchObject({ name: "echo", args: { text: "echoed" }, status: "ok", resultText: "echoed" });
  expect(echo!.issuedAt).toBeGreaterThanOrEqual(startedAt);
  expect(echo!.issuedAt).toBeLessThanOrEqual(Date.now());
});

test("a stopped script keeps the calls it made, for the transcript and the model", async () => {
  const { faux, agent, held } = await setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: "await tools.echo({ text: 'before the stop' }); await tools.hold({});" })], { stopReason: "toolUse" }),
  ]);
  await agent.submit({ requestId: "script", text: "Run it" });
  await held.promise;
  await committedOutput(agent, "started c2");
  await agent.stop();
  const tool = (await scriptTool(agent))!;
  const [echo, hold] = tool.nested!;
  expect(echo).toMatchObject({ name: "echo", status: "ok", resultText: "before the stop" });
  expect(hold).toMatchObject({ name: "hold", status: "error", details: { aborted: true } });
  // What the model gets for the stopped script: which calls ran, and which one the stop cut off.
  expect(tool.resultText).toContain('started c1: echo {"text":"before the stop"}\nfinished c1: ok\nstarted c2: hold {}');
  expect(tool.resultText).not.toContain("finished c2");
});

test("a script can name a file to run, which a call runs as it was when the call started, also after a restart", async () => {
  const { faux, agent, held, runtime, path } = await setup();
  const file = join(path, "script.js");
  await writeFile(file, "await tools.hold({});\nreturn await tools.echo({ text: 'first version' });\n");
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: `// @options: {"timeout_ms": 60000}\n// @path: ${file}\n` })], { stopReason: "toolUse" }),
  ]);
  await agent.submit({ requestId: "script", text: "Run it" });
  await held.promise;
  const issuedAt = (await scriptTool(agent))!.nested![0]!.issuedAt;
  expect(issuedAt).toBeNumber();
  await runtime.suspend();
  await writeFile(file, "return await tools.echo({ text: 'second version' });\n");
  const reopened = await setup(path);
  reopened.faux.setResponses([fauxAssistantMessage("Done")]);
  reopened.release();
  await reopened.runtime.resume();
  let tool = (await scriptTool(reopened.agent))!;
  while (tool.status === "running") {
    await Bun.sleep(20);
    tool = (await scriptTool(reopened.agent))!;
  }
  expect(tool.nested!.map(call => call.resultText)).toEqual(["released", "first version"]);
  expect(tool.nested![0]!.issuedAt).toBe(issuedAt);
  expect(tool.scriptFile).toMatchObject({ path: file, code: expect.stringContaining("first version") });
  expect(tool.resultText).toContain("first version");
});

test("a script file call can give the script input as JSON, which it gets as `input`", async () => {
  const { faux, agent, path } = await setup();
  const file = join(path, "script.js");
  await writeFile(file, '// @options: {"timeout_ms": 60000}\nreturn await tools.echo({ text: `${input.scope} (${input.pushbacks.length})` });\n');
  const request = { scope: "x".repeat(600), pushbacks: ["one", "two"] };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: `// @path: ${file}\n${JSON.stringify(request, null, 2)}\n` })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  expect((await (await agent.submit({ requestId: "script", text: "Run it" })).wait(context)).status).toBe("done");
  const [echo] = (await scriptTool(agent))!.nested!;
  expect(echo).toMatchObject({ status: "ok", resultText: `${request.scope} (2)` });
});

test.each([
  ["a missing file", (file: string) => `// @path: ${file}.missing`, "Can't read script file"],
  ["code after the path", (file: string) => `// @path: ${file}\nreturn 1;`, "can only have its input, as JSON"],
  ["a path line after code", (file: string) => `return 1;\n// @path: ${file}`, "must start the script"],
  ["a path line without a path", () => "// @path:", "needs the path of a script file"],
  ["options in the call and the file", (file: string) => `// @options: {"timeout_ms": 1000}\n// @path: ${file}`, "Put options in the file or in the call, not both"],
])("a script file call fails for %s", async (_name, code, error) => {
  const { faux, agent, path } = await setup();
  const file = join(path, "script.js");
  await writeFile(file, '// @options: {"max_output_tokens": 100}\nreturn 1;\n');
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: code(file) })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  expect((await (await agent.submit({ requestId: "script", text: "Run it" })).wait(context)).status).toBe("done");
  const tool = (await scriptTool(agent))!;
  expect(tool.status).toBe("error");
  expect(tool.resultText).toContain(error);
});
