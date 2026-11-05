import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep transport mocks and workspace metadata isolated from other packages.
async function scenario(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "claude-runtime-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      import { mkdirSync, writeFileSync } from "node:fs";
      const connections = [];
      let initializationGate;
      const launchSettings = { model: "anthropic::claude-opus-5-5", thinkingLevel: "medium" };
      const models = [
        { value: "default", displayName: "Default (recommended)", description: "" },
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportedEffortLevels: ["low", "medium", "high", "max"] },
        { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "", supportedEffortLevels: ["low", "medium"] },
      ];
      const sessions = agentId => process.env.KINTSUGI_DATA_DIR + "/workspaces/workspace/home-local/.local/share/kintsugi-agents/" + agentId + "/claude/projects/-work";
      const record = (agentId, id, rows) => { mkdirSync(sessions(agentId), { recursive: true }); writeFileSync(sessions(agentId) + "/" + id + ".jsonl", rows.map(row => JSON.stringify(row)).join("\\n")); };
      mock.module(${JSON.stringify(join(import.meta.dir, "../src/server/setup.ts"))}, () => ({
        agentTypeId: "claude", label: "Claude Code", requireSetup: async () => {},
        prepareClaude: async () => ({ instructions: "instructions" }),
        settings: { prepare: async () => ({ ...launchSettings }), renderFooter: async () => "" },
      }));
      mock.module(${JSON.stringify(join(import.meta.dir, "../src/server/transport.ts"))}, () => ({
        openClaudeTransport: async (workspaceId, agentId, start, message, failed) => {
          const connection = { start, message, failed, sent: [], calls: [], closed: false,
            send(value) { this.sent.push(value); },
            query: {
              initializationResult: async () => { await initializationGate?.promise; return { models, commands: [{ name: "compact", description: "Compact", argumentHint: "" }, { name: "model", description: "Model", argumentHint: "" }] }; },
              getContextUsage: async () => ({ percentage: 12 }),
              async interrupt() { connection.calls.push(["interrupt"]); },
              async stopTask(taskId) { connection.calls.push(["stopTask", taskId]); },
              async setModel(model) { connection.calls.push(["setModel", model]); },
              async applyFlagSettings(settings) { connection.calls.push(["applyFlagSettings", settings]); },
            },
            async close() { this.closed = true; } };
          connections.push(connection);
          return connection;
        },
      }));
      const rendering = await import(${JSON.stringify(join(import.meta.dir, "../src/server/render.ts"))});
      mock.module(${JSON.stringify(join(import.meta.dir, "../src/server/render.ts"))}, () => ({ ...rendering, liveRegions: () => [] }));
      mock.module("@kintsugi/agent/server/completion-catalog", () => ({ renderWorkspaceCompletionCatalog: async () => "" }));
      const busy = await import("@kintsugi/agent/server");
      const busyEvents = [];
      mock.module("@kintsugi/agent/server", () => ({ ...busy, publishWorkspaceAgentBusy(event) { busyEvents.push(event.busy); }, revokeAgentMcp: async () => {} }));
      const llm = await import("@kintsugi/llm/server");
      const preferences = [];
      mock.module("@kintsugi/llm/server", () => ({ ...llm, setAgentModelPreference: async (...args) => preferences.push(args) }));
      const finished = [];
      const events = { on() {}, async emit(name, payload) { if (name === "workspace_agent_turn_finished") finished.push(payload.agentId); } };
      const { createClaudeAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/runtime.ts"))});
      const agents = createClaudeAgents(() => events);
      const input = { text: "hello", images: [], attachmentNotes: [] };
      const result = (extra = {}) => ({ type: "result", subtype: "success", modelUsage: {}, queued_turn_count: 0, uuid: crypto.randomUUID(), session_id: "s", ...extra });
      ${script}
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, KINTSUGI_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("a launch prompt starts a new native session once, and retries of a send are not delivered twice", () => scenario(`
  const id = await agents.create("workspace", { input });
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  expect(connection.start).toMatchObject({ sessionId: runtime.record.sessionId, model: "claude-opus-5-5", effort: "medium", instructions: "instructions" });
  expect(connection.start.resume).toBeUndefined();
  expect(connection.sent).toHaveLength(1);
  expect(connection.sent[0]).toMatchObject({ type: "user", session_id: "", parent_tool_use_id: null, origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text: "hello" }] } });
  expect(connection.sent[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(runtime.isBusy).toBe(true);
  connection.message(result());
  expect(runtime.isBusy).toBe(false);
  expect(busyEvents).toEqual([true, false]);
  expect(finished).toEqual([id]);
  await runtime.send({ text: "again", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }], attachmentNotes: ["Attached notes.md"] }, "request");
  await runtime.send({ text: "again", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }], attachmentNotes: ["Attached notes.md"] }, "request");
  expect(connection.sent).toHaveLength(2);
  expect(connection.sent[1].message.content).toEqual([{ type: "text", text: "again\\n\\nAttached notes.md" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]);
  await expect(runtime.send({ ...input, text: "different" }, "request")).rejects.toMatchObject({ code: "invalid_arguments" });
  await agents.disposeAll();
`));

test("a restored Agent presents saved history without waiting for Claude to initialize", () => scenario(`
  const agentId = "restored-agent";
  const sessionId = crypto.randomUUID();
  const metadata = process.env.KINTSUGI_DATA_DIR + "/workspaces/workspace/metadata";
  mkdirSync(metadata, { recursive: true });
  writeFileSync(metadata + "/claude-code-agents.json", JSON.stringify({ agents: [{ id: agentId, title: "Claude Code", sessionId, model: "anthropic::claude-opus-5-5", thinkingLevel: "medium", submissions: [] }] }));
  record(agentId, sessionId, [{ type: "user", uuid: "saved-prompt", timestamp: "2026-10-16T07:00:00.000Z", message: { role: "user", content: "Saved history" } }]);
  initializationGate = Promise.withResolvers();
  const runtime = await agents.ready("workspace", agentId);
  expect(runtime.state.rows.map(row => row.uuid)).toEqual(["saved-prompt"]);
  expect(runtime.models).toEqual([]);
  initializationGate.resolve();
  await runtime.activate();
  expect(runtime.models).toHaveLength(3);
  await agents.disposeAll();
`));

test("prompts sent while Claude works steer its turn, and queued prompts keep it busy", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  await runtime.send(input, "first");
  await runtime.send({ ...input, text: "also this" }, "second");
  expect(runtime.state.rows.map(row => row.kind)).toEqual(["user", "steer"]);
  connection.message(result({ queued_turn_count: 1 }));
  expect(runtime.isBusy).toBe(true);
  connection.message(result());
  expect(runtime.isBusy).toBe(false);
  await agents.disposeAll();
`));

test("background work keeps Claude from settling until it has reported on it, though its turn has ended", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  const system = (subtype, extra) => ({ type: "system", subtype, uuid: crypto.randomUUID(), session_id: "s", ...extra });
  const tasks = list => system("background_tasks_changed", { tasks: list });
  await runtime.send(input, "first");
  connection.message(tasks([{ task_id: "suite", task_type: "local_bash", description: "Run the suite" }, { task_id: "watcher", task_type: "monitor", description: "Watch", ambient: true }]));
  connection.message(result());
  expect(runtime.isBusy).toBe(true);
  expect(runtime.isTurnRunning).toBe(false);
  expect(finished).toEqual([]);
  connection.message(system("task_notification", { task_id: "suite", run_id: "run-1", status: "completed", output_file: "", summary: "Suite passed" }));
  expect(runtime.isTurnRunning).toBe(true);
  expect(runtime.state.rows.at(-1)).toMatchObject({ kind: "task", runId: "run-1", summary: "Suite passed" });
  connection.message(tasks([{ task_id: "watcher", task_type: "monitor", description: "Watch", ambient: true }]));
  expect(runtime.isBusy).toBe(true);
  connection.message({ type: "stream_event", event: { type: "message_start", message: { id: "follow-up" } }, parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "s" });
  connection.message(result());
  expect(runtime.isBusy).toBe(false);
  expect(busyEvents).toEqual([true, false]);
  expect(finished).toEqual([id]);
  await runtime.send(input, "second");
  connection.message(tasks([{ task_id: "server", task_type: "local_bash", description: "Serve" }, { task_id: "lint", task_type: "local_bash", description: "Lint" }]));
  // Foreground commands notify as well; only background work is reported on.
  connection.message(system("task_notification", { task_id: "build", run_id: "run-2", status: "completed", output_file: "", summary: "Build" }));
  connection.message(system("task_notification", { task_id: "lint", run_id: "run-3", status: "completed", output_file: "", summary: "Lint passed" }));
  connection.message(tasks([{ task_id: "server", task_type: "local_bash", description: "Serve" }]));
  expect(runtime.state.rows.filter(row => row.kind === "task").map(row => row.runId)).toEqual(["run-1", "run-3"]);
  connection.message(result());
  await runtime.stop();
  expect(connection.calls).toEqual([["stopTask", "server"]]);
  connection.message(system("task_notification", { task_id: "server", status: "stopped", output_file: "", summary: "" }));
  connection.message(tasks([]));
  expect(runtime.isBusy).toBe(false);
  expect(finished).toEqual([id, id]);
  await agents.disposeAll();
`));

test("Claude reports background task kinds, progress and Stop capabilities", () => scenario(`
  const { claudeBackgroundActivities } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/background.ts"))});
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  const system = (subtype, extra) => ({ type: "system", subtype, uuid: crypto.randomUUID(), session_id: "s", ...extra });
  const tasks = list => system("background_tasks_changed", { tasks: list });
  await runtime.send(input, "first");
  // A task joins the live set before it reports starting.
  connection.message(tasks([{ task_id: "suite", task_type: "local_bash", description: "Run the suite" }]));
  connection.message(system("task_started", { task_id: "suite", tool_use_id: "toolu_suite", description: "Run the suite", task_type: "local_bash" }));
  connection.message(system("task_started", { task_id: "review", tool_use_id: "toolu_review", description: "Review auth", task_type: "local_agent", subagent_type: "general-purpose" }));
  connection.message(tasks([
    { task_id: "suite", task_type: "local_bash", description: "Run the suite" },
    { task_id: "review", task_type: "local_agent", subagent_type: "general-purpose", description: "Review auth" },
    { task_id: "ci", task_type: "monitor", description: "Watch CI", ambient: true },
    { task_id: "dream", task_type: "dream", description: "Housekeeping", ambient: true },
  ]));
  connection.message(system("task_progress", { task_id: "review", description: "Review auth", usage: { total_tokens: 31400, tool_uses: 12, duration_ms: 90000 }, last_tool_name: "Read" }));
  expect(claudeBackgroundActivities(runtime).map(({ key, kind, opens, title, progress, details, startedBy }) => ({ key, kind, opens, title, progress, details, startedBy: startedBy?.itemKey }))).toEqual([
    { key: "suite", kind: "command", opens: "inline", title: "Run the suite", progress: undefined, details: {}, startedBy: "toolu_suite" },
    { key: "review", kind: "subagent", opens: "drill-in", title: "Review auth", progress: "Using Read", details: { Type: "general-purpose", "Tool uses": "12", Tokens: "31.4k" }, startedBy: "toolu_review" },
    // Claude won't report on a monitor, but it is running work to look at; other ambient tasks are housekeeping.
    { key: "ci", kind: "monitor", opens: "inline", title: "Watch CI", progress: undefined, details: {}, startedBy: undefined },
  ]);
  connection.message(system("task_progress", { task_id: "review", description: "Review auth", usage: { total_tokens: 40000, tool_uses: 14, duration_ms: 95000 }, summary: "Reading the session store" }));
  expect(claudeBackgroundActivities(runtime)[1].progress).toBe("Reading the session store");
  await (await import(${JSON.stringify(join(import.meta.dir, "../src/server/render.ts"))})).rendering.background.stop(runtime, claudeBackgroundActivities(runtime)[0]);
  expect(connection.calls).toEqual([["stopTask", "suite"]]);
  // A finished task leaves the list; its report is in the conversation.
  connection.message(system("task_notification", { task_id: "suite", status: "completed", output_file: "", summary: "Suite passed" }));
  connection.message(tasks([{ task_id: "review", task_type: "local_agent", subagent_type: "general-purpose", description: "Review auth" }]));
  expect(claudeBackgroundActivities(runtime).map(activity => activity.key)).toEqual(["review"]);
  await agents.disposeAll();
`));

test("workflow progress retains phases and lists only agents that have started", () => scenario(`
  const { claudeBackgroundActivities } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/background.ts"))});
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  const system = (subtype, extra) => ({ type: "system", subtype, uuid: crypto.randomUUID(), session_id: "s", ...extra });
  await runtime.send(input, "first");
  connection.message(system("background_tasks_changed", { tasks: [{ task_id: "w1", task_type: "local_workflow", description: "review" }] }));
  connection.message(system("task_started", { task_id: "w1", tool_use_id: "toolu_w1", description: "review", task_type: "local_workflow", workflow_name: "review-changes", prompt: "export const meta = { name: 'review-changes', description: 'Review' }\\nreturn await agent('Find bugs', { label: 'bugs' })" }));
  const progress = workflow_progress => system("task_progress", { task_id: "w1", description: "Find: bugs", usage: { total_tokens: 900, tool_uses: 3, duration_ms: 5000 }, last_tool_name: "bugs", summary: "Review the diff", ...(workflow_progress && { workflow_progress }) });
  connection.message(progress([
    { type: "workflow_phase", index: 1, title: "Find" },
    { type: "workflow_phase", index: 2, title: "Verify" },
    { type: "workflow_agent", index: 1, label: "bugs", phaseIndex: 1, phaseTitle: "Find", agentId: "abugs", model: "claude-haiku-5-5", state: "progress", startedAt: 1000, lastToolName: "Bash", lastToolSummary: "git diff", tokens: 900, toolCalls: 3 },
    { type: "workflow_agent", index: 2, label: "perf", phaseIndex: 1, phaseTitle: "Find", agentId: "aperf", state: "done", startedAt: 1000, tokens: 400, toolCalls: 1, resultPreview: "No slow queries <found>" },
    // Queued: it has no transcript yet.
    { type: "workflow_agent", index: 3, label: "style", phaseIndex: 1, phaseTitle: "Find", state: "start", queuedAt: 1000 },
    // A kind of entry Claude Code may add later.
    { type: "workflow_log", text: "hello" },
  ]));
  // A frame without them changed nothing about the phases and agents.
  connection.message(progress(undefined));
  const activities = claudeBackgroundActivities(runtime);
  expect(activities.map(({ key, kind, opens, title, running, progress, details, parentKey }) => ({ key, kind, opens, title, running, progress, details, parentKey }))).toEqual([
    { key: "w1", kind: "workflow", opens: "drill-in", title: "review-changes", running: true, progress: undefined, details: { "Tool uses": "3", Tokens: "900" }, parentKey: undefined },
    { key: "abugs", kind: "workflow agent", opens: "drill-in", title: "bugs", running: true, progress: "Bash: git diff", details: { Phase: "Find", Model: "claude-haiku-5-5", "Tool uses": "3", Tokens: "900" }, parentKey: "w1" },
    { key: "aperf", kind: "workflow agent", opens: "drill-in", title: "perf", running: false, progress: undefined, details: { Phase: "Find", "Tool uses": "1", Tokens: "400" }, parentKey: "w1" },
  ]);
  expect(runtime.tasks[0].workflow.phases).toEqual(["Find", "Verify"]);
  expect(activities[2].result).toBe("No slow queries <found>");
  const run = sessions(id) + "/" + runtime.record.sessionId + "/subagents/workflows/wf_1";
  mkdirSync(run, { recursive: true });
  const row = (type, uuid, content) => JSON.stringify({ type, uuid, isSidechain: true, timestamp: "2026-10-20T12:00:00.000Z", message: { id: uuid, role: type, content, stop_reason: "end_turn" } });
  writeFileSync(run + "/agent-abugs.jsonl", [
    // Claude Code frames the request that started the workflow, and the agent's task, for the model.
    row("user", "u0", "[Workflow harness — user request] The harness relays the request:\\n  Review my branch\\n  \\n  Carefully"),
    row("user", "u1", "[Workflow harness — computed task] The computed task text follows:\\n  Find bugs in:\\n  \\n  - auth.ts"),
    row("assistant", "u2", [{ type: "text", text: "Reading the diff" }]),
  ].join("\\n"));
  const { readClaudeSubagentRows } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/rows.ts"))});
  const { workflowAgentRows } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/workflow.ts"))});
  const rows = workflowAgentRows(await readClaudeSubagentRows(sessions(id), runtime.record.sessionId, "abugs", true));
  expect(rows).toMatchObject([{ kind: "user", content: [{ type: "text", text: "Find bugs in:\\n\\n- auth.ts" }] }, { kind: "assistant", content: [{ type: "text", text: "Reading the diff" }] }]);
  await agents.disposeAll();
`));

test("stopping interrupts Claude without reporting its abort as a problem", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  await runtime.stop();
  expect(connection.calls).toEqual([]);
  await runtime.send(input, "first");
  await runtime.stop();
  expect(connection.calls).toEqual([["interrupt"]]);
  connection.message(result({ subtype: "error_during_execution", errors: ["Request was aborted"] }));
  connection.message({ type: "result", subtype: "error_during_execution", errors: ["[ede_diagnostic] result_type=user"], modelUsage: {}, uuid: crypto.randomUUID(), session_id: "s" });
  expect(runtime.state.notices).toEqual([]);
  await runtime.send(input, "second");
  connection.message(result({ subtype: "error_max_turns", errors: ["Reached the maximum number of turns"] }));
  expect(runtime.state.notices).toEqual(["Reached the maximum number of turns"]);
  await agents.disposeAll();
`));

test("model and effort changes use Claude's own catalog and apply to the running session", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  expect(runtime.selectedModel.value).toBe("opus");
  expect(runtime.selection.models.map(model => model.name)).toEqual(["Default (recommended)", "Claude Opus 5.5", "Claude Haiku 5.5"]);
  expect(runtime.selection.thinkingLevels).toEqual(["low", "medium", "high", "max"]);
  expect(runtime.contextPercent).toBe(12);
  await runtime.configure({ thinkingLevel: "max" });
  await runtime.configure({ model: "anthropic::haiku" });
  expect(connection.calls).toEqual([["applyFlagSettings", { effortLevel: "max" }], ["setModel", "haiku"], ["applyFlagSettings", { effortLevel: "medium" }]]);
  expect(runtime.record).toMatchObject({ model: "anthropic::claude-haiku-5-5", thinkingLevel: "medium" });
  expect(preferences.at(-1)).toEqual(["claude", { provider: "anthropic", id: "claude-haiku-5-5" }, "medium"]);
  await expect(runtime.configure({ thinkingLevel: "max" })).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(runtime.configure({ model: "openai-codex::gpt" })).rejects.toMatchObject({ code: "invalid_arguments" });
  expect(await runtime.command({ kind: "model", model: "opus" }, "model")).toEqual({ kind: "done", message: "Using Claude Opus 5.5." });
  await runtime.send(input, "busy");
  await expect(runtime.configure({ model: "anthropic::opus" })).rejects.toMatchObject({ code: "invalid_arguments" });
  await agents.disposeAll();
`));

test("new, fork and resume switch between the Agent's own native sessions", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const original = runtime.record.sessionId;
  await expect(runtime.command({ kind: "fork" }, "early-fork")).rejects.toMatchObject({ code: "invalid_arguments" });
  record(id, original, [{ type: "user", uuid: "prompt", timestamp: "2026-10-12T12:00:00.000Z", message: { role: "user", content: "Remember this" } }]);
  // A refused command leaves its request ID free for a retry.
  expect(await runtime.command({ kind: "fork" }, "early-fork")).toEqual({ kind: "done", message: "Conversation forked." });
  const forked = runtime.record.sessionId;
  expect(forked).not.toBe(original);
  expect(runtime.record.forkedFrom).toBe(original);
  expect(connections[0].closed).toBe(true);
  expect(connections[1].start).toMatchObject({ sessionId: forked, resume: original, forkSession: true });
  expect(runtime.state.rows.map(row => row.uuid)).toEqual(["prompt"]);
  // A fork keeps its parent's history until Claude records the fork itself.
  connections[1].failed(new Error("Disconnected"));
  await agents.ready("workspace", id);
  expect(connections[2].start).toMatchObject({ sessionId: forked, resume: original, forkSession: true });
  record(id, forked, [{ type: "user", uuid: "prompt", timestamp: "2026-10-12T12:00:00.000Z", message: { role: "user", content: "Remember this" } }]);
  connections[2].failed(new Error("Disconnected"));
  await agents.ready("workspace", id);
  expect(connections[3].start).toMatchObject({ sessionId: forked, resume: forked });
  expect(connections[3].start.forkSession).toBeUndefined();
  expect(runtime.record.forkedFrom).toBeUndefined();
  // The Claude Code CLI's conversations stay its own.
  mkdirSync(process.env.KINTSUGI_DATA_DIR + "/home/.claude/projects/-work", { recursive: true });
  writeFileSync(process.env.KINTSUGI_DATA_DIR + "/home/.claude/projects/-work/cli.jsonl", JSON.stringify({ type: "user", uuid: "cli", timestamp: "2026-10-12T12:00:00.000Z", message: { role: "user", content: "From the CLI" } }));
  const listed = await runtime.command({ kind: "resume" }, "list");
  expect(listed).toMatchObject({ kind: "resume", current: forked });
  expect(listed.sessions.map(session => session.title)).toEqual(["Remember this", "Remember this"]);
  await runtime.command({ kind: "resume", sessionId: original }, "resume");
  expect(connections[4].start).toMatchObject({ sessionId: original, resume: original });
  await runtime.command({ kind: "new" }, "new");
  const fresh = runtime.record.sessionId;
  expect(fresh).not.toBe(original);
  expect(connections[5].start.resume).toBeUndefined();
  // Retries replay the outcome instead of switching again.
  expect(await runtime.command({ kind: "new" }, "new")).toEqual({ kind: "done", message: "New Claude Code conversation started." });
  expect(await runtime.command({ kind: "fork" }, "early-fork")).toEqual({ kind: "done", message: "Conversation forked." });
  expect(runtime.record.sessionId).toBe(fresh);
  expect(connections).toHaveLength(6);
  await expect(runtime.command({ kind: "fork" }, "new")).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(runtime.send(input, "new")).rejects.toMatchObject({ code: "invalid_arguments" });
  expect(runtime.state.rows).toEqual([]);
  connections[5].message({ type: "conversation_reset", new_conversation_id: "cleared-session", uuid: crypto.randomUUID(), session_id: "s" });
  expect(runtime.record.sessionId).toBe("cleared-session");
  await agents.disposeAll();
`));
