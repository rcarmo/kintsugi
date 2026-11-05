import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "@kintsugi/core";
import { terminalProcessSession, type TerminalProcesses } from "@kintsugi/observable-terminal/server";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, LiveDoc } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createDurableBashExtension } from "../../src/server/durable-bash.ts";
import { openDurableWorkspace, type DurableWorkspace } from "../../src/server/durable-workspace.ts";
import { clearLocalTerminalProcesses, runLocally, terminalProcessesIn } from "../../../observable-terminal/test/support/local-terminal-processes.ts";

// Terminal processes test the command lifecycle itself. These test what the
// Durable bash tool adds: starting at most once across recovery, Stop, and
// turning a finished process into a tool result.
const context = BACKGROUND_CONTEXT;
const fixtures: string[] = [];
const workspaces: DurableWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close()));
  for (const path of fixtures.splice(0)) {
    await clearLocalTerminalProcesses(path);
    await rm(path, { recursive: true, force: true });
  }
});

/** Terminal processes on this machine, on a tmux server of their own. */
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "kintsugi-bash-"));
  fixtures.push(path);
  return { path, tmuxDirectory: join(path, "tmux"), processes: terminalProcessesIn(path) };
}

/** The processes, reporting each start once it has happened. */
function observed(processes: TerminalProcesses) {
  const started = Promise.withResolvers<string>();
  return { started: started.promise, processes: { ...processes, async start(options) {
    await processes.start(options);
    started.resolve(options.id);
  } } satisfies TerminalProcesses };
}

async function harness(path: string, processes: TerminalProcesses, bash: string, timeout = 5) {
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: bash, timeout })], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  const registry = createRegistry();
  registry.install(createDurableBashExtension("workspace", processes));
  const options = { models, registry };
  const journal = join(path, "journal");
  const workspace = await openDurableWorkspace(journal, "workspace", options);
  workspaces.push(workspace);
  const conversation = await workspace.agent({ agentId: "tab", label: "Agent 1", title: "Bash" }, { model: { provider: "faux", modelId: "faux-1" } });
  return { workspace, conversation, journal, options };
}

async function toolResults(workspace: DurableWorkspace) {
  const conversation = await workspace.agent({ agentId: "tab", label: "Agent 1", title: "Bash" });
  const entries = (await conversation.entries({}, 100, undefined, context)).items;
  return entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");
}

const bashDetails = Type.Object({ displayAnsi: Type.String(), fullOutputPath: Type.String() });

async function run(bash: string, timeout = 5) {
  const f = await fixture();
  const { processes, started } = observed(f.processes);
  const h = await harness(f.path, processes, bash, timeout);
  const submission = await h.conversation.submit({ type: "input", content: "Run", requestId: "one" }, context);
  expect((await submission.wait(context)).status).toBe("done");
  const [result] = await toolResults(h.workspace);
  return { f, id: await started, result: result! };
}

test("a finished command becomes the tool result, and its terminal process is released", async () => {
  const { f, id, result } = await run("printf '\\033[32mgreen\\033[0m\\n'; echo plain; exit 3");
  expect(result.isError).toBe(false);
  expect(result.content).toEqual([{ type: "text", text: "green\nplain\n\nCommand exited with code 3" }]);
  expect(result.details).toMatchObject({ exitCode: 3, aborted: false, timedOut: false, fullOutputPath: f.processes.textFile(id) });
  expect(Value.Parse(bashDetails, result.details).displayAnsi).toContain("\u001b[32mgreen");
  expect(await f.processes.state(id)).toEqual({ state: "missing" });
});

test("output the model doesn't see stays readable at fullOutputPath", async () => {
  const { result } = await run("seq 1 3000; exit 1");
  const { fullOutputPath } = Value.Parse(bashDetails, result.details);
  // One text item: the Harness had nothing of its own to cut.
  expect(result.content).toHaveLength(1);
  const [content] = result.content;
  if (content?.type !== "text") throw new Error("expected a text result");
  expect(content.text).toStartWith("1005\n");
  expect(content.text).toEndWith(`3000\n\n[Output truncated: showing the last 9.7KB of output. Full output: ${fullOutputPath}]\n\nCommand exited with code 1`);
  const lines = (await readFile(fullOutputPath, "utf8")).trimEnd().split("\n");
  expect(lines).toHaveLength(3000);
  expect(lines[0]).toBe("1");
});

test("the tool's timeout is the command's deadline", async () => {
  const { result } = await run("echo started; sleep 10", 1);
  expect(result.content).toEqual([{ type: "text", text: "started\nTerminated\n\nCommand timed out after 1 seconds" }]);
  expect(result.details).toMatchObject({ exitCode: 143, timedOut: true, aborted: false });
});

test("a command whose terminal disappears is reported as uncertain, not run again", async () => {
  const f = await fixture();
  const count = join(f.path, "count");
  const tmux = (...args: string[]) => runLocally(f.tmuxDirectory)({ argv: ["tmux", ...args], user: "agent" }, {});
  const processes: TerminalProcesses = { ...f.processes, async start(options) {
    await f.processes.start(options);
    // The command says when it has counted itself; then its terminal goes.
    await tmux("wait-for", "counted");
    await tmux("kill-session", "-t", `=${terminalProcessSession(options.id)}`);
  } };
  const h = await harness(f.path, processes, `echo once >> ${shellQuote(count)}; tmux wait-for -S counted; sleep 10`);
  const submission = await h.conversation.submit({ type: "input", content: "Run", requestId: "one" }, context);
  expect((await submission.wait(context)).status).toBe("done");
  const [result] = await toolResults(h.workspace);
  expect(result!.isError).toBe(true);
  expect(result!.content[0]).toEqual({ type: "text", text: "The command's terminal disappeared before it recorded a result. The command was not run again." });
  expect(await readFile(count, "utf8")).toBe("once\n");
});

test.each(["shutdown", "stop"] as const)("native Durable %s preserves or cancels the workspace process deliberately", async (action) => {
  const f = await fixture();
  const { processes, started } = observed(f.processes);
  const count = join(f.path, "count");
  const h = await harness(f.path, processes, `echo once >> ${shellQuote(count)}; sleep 1; echo finished`);
  const submission = await h.conversation.submit({ type: "input", content: "Run", requestId: "one" }, context);
  await started;
  if (action === "stop") await h.conversation.abort(context);
  await h.workspace.close();
  const reopened = await openDurableWorkspace(h.journal, "workspace", h.options);
  workspaces.push(reopened);
  const restored = (await reopened.harness.submission(submission.id, context))!;
  expect((await restored.wait(context)).status).toBe(action === "stop" ? "unanswered" : "done");
  const countText = await Bun.file(count).exists() ? await readFile(count, "utf8") : "";
  if (action === "shutdown") expect(countText).toBe("once\n");
  else expect(["", "once\n"]).toContain(countText);
  const catalog = await reopened.harness.inspect(context);
  expect(catalog.tasks).toHaveLength(0);
});

test.each(["before-start", "after-start"] as const)("SIGKILL %s recovers without running the command twice", async (moment) => {
  const f = await fixture();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/durable-bash-crash.ts"), f.path, moment], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("crash now")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(await new Response(child.stderr).text());
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
    const expired = new Date(Date.now() - 60_000);
    await utimes(join(f.path, "journal.lock"), expired, expired);
    const models = createModels();
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Recovered")]);
    const registry = createRegistry();
    registry.install(createDurableBashExtension("workspace", f.processes));
    const workspace = await openDurableWorkspace(join(f.path, "journal"), "workspace", { models, registry });
    workspaces.push(workspace);
    const inspection = await workspace.harness.inspect(context);
    expect(inspection.submissions).toHaveLength(1);
    const submission = (await workspace.harness.submission(inspection.submissions[0]!.id, context))!;
    expect((await submission.wait(context)).status).toBe("done");
    const results = await toolResults(workspace);
    expect(results).toHaveLength(1);
    if (moment === "after-start") {
      expect(await readFile(join(f.path, "count"), "utf8")).toBe("once\n");
      expect(results[0]!.isError).toBe(false);
      expect(results[0]!.content).toContainEqual({ type: "text", text: expect.stringContaining("recovered") });
    } else {
      // A start that may or may not have happened is never guessed at.
      expect(await Bun.file(join(f.path, "count")).exists()).toBe(false);
      expect(results[0]!.isError).toBe(true);
      expect(results[0]!.content[0]).toEqual({ type: "text", text: "The command's terminal process is missing, so the command was not run again." });
    }
  } finally {
    child.kill();
    await child.exited;
  }
}, 20_000);

test("aborting a bash tool stops its command but lets the agent finish the turn", async () => {
  const f = await fixture();
  const { processes, started } = observed(f.processes);
  const h = await harness(f.path, processes, `sleep 3; touch ${shellQuote(join(f.path, "after-abort"))}`);
  const submission = await h.conversation.submit({ type: "input", content: "Run", requestId: "abort-tool" }, context);
  const id = await started;
  const inspection = await h.workspace.harness.inspect(context);
  const tool = inspection.tasks.find(({ record }) => record.kind === "pi.tool")!;
  await h.workspace.harness.abortTask(tool.record.id, context);
  expect((await submission.wait(context)).status).toBe("done");
  // Released, which kills whatever of the command was left, so it never gets to the touch.
  expect(await f.processes.state(id)).toEqual({ state: "missing" });
  expect(await Bun.file(join(f.path, "after-abort")).exists()).toBe(false);
});

// bun test fails on the unhandled rejection; in the app, Bun exits on one.
test("stopping while the command is starting stops it without an unhandled rejection", async () => {
  const f = await fixture();
  let stop!: () => Promise<void>;
  const processes: TerminalProcesses = { ...f.processes, async start(options) {
    await f.processes.start(options);
    // Stop lands after the command started but before the tool waits for it.
    const stopped = stop();
    await Bun.sleep(300);
    void stopped;
  } };
  const h = await harness(f.path, processes, "sleep 3");
  stop = () => h.conversation.abort(context);
  const submission = await h.conversation.submit({ type: "input", content: "Run", requestId: "one" }, context);
  expect((await submission.wait(context)).status).toBe("unanswered");
}, 20_000);

test.each([false, true])("cancelling only a real long-running bash tool kills its owned command (ignores TERM: %p)", async ignoresTerm => {
  const f = await fixture(), released = Promise.withResolvers<void>();
  const tracked = observed({ ...f.processes, async release(id) { await f.processes.release(id); released.resolve(); } });
  const pidFile = join(f.path, "command.pid");
  const command = `${ignoresTerm ? "trap '' TERM; " : ""}echo $$ > ${shellQuote(pidFile)}; echo running; while :; do sleep 0.1; done`;
  const h = await harness(f.path, tracked.processes, command, 60);
  const submission = await h.conversation.submit({ type: "input", content: "Disposable cancellation fixture", requestId: "stop-one-bash" }, context);
  const id = await tracked.started;
  while (!await Bun.file(pidFile).exists()) await Bun.sleep(10);
  const pid = Number(await readFile(pidFile, "utf8"));
  const live = await h.workspace.harness.snapshot(LiveDoc, h.conversation.id, context);
  const slot = live?.tools?.find(tool => tool.name === "bash");
  expect(slot?.taskId).toBeDefined();
  await h.workspace.harness.abortTask(slot!.taskId!, context);
  expect((await submission.wait(context)).status).toBe("done");
  await released.promise;
  expect(await f.processes.state(id)).toEqual({ state: "missing" });
  try { expect(await readFile(`/proc/${pid}/status`, "utf8")).toMatch(/^State:\s+Z/m); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const result = (await toolResults(h.workspace))[0]!;
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("was aborted");
}, 10000);
