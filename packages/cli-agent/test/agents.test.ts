import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate dependency mocks and metadata caches; exercise the public module interface.
async function scenario(script: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cli-agent-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const workspace = await import("@kintsugi/workspace");
      const calls = [];
      const launches = [];
      const preparations = [];
      // Each Workspace's terminal processes: what was started and released, and each one's state.
      const started = [];
      const released = [];
      const processStates = new Map();
      let startError, releaseError;
      const terminalProcesses = (workspaceId) => ({
        async start(options) {
          if (startError) throw startError;
          started.push({ workspaceId, options });
          processStates.set(workspaceId + ":" + options.id, { state: "running", interactive: true });
        },
        async state(id) { return processStates.get(workspaceId + ":" + id) ?? { state: "missing" }; },
        async release(id) {
          if (releaseError) throw releaseError;
          released.push(id);
          processStates.delete(workspaceId + ":" + id);
        },
      });
      const setProcessState = (workspaceId, id, state) => processStates.set(workspaceId + ":" + id, state);
      let launchScript = "printf 'CLI started'";
      let setupError;
      let turnSettled = async () => true;
      let preparationError;
      let preparationDelay;
      let result = { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
      const workspaceTitles = new Map();
      const agentsFiles = new Map();
      mock.module("@kintsugi/workspace", () => ({ ...workspace, execWorkspaceCommand: async (_id, command) => ({ stdout: [...agentsFiles].find(([path]) => command[2].includes(path))?.[1] ?? "", stderr: "", exitCode: 0, durationMs: 0 }), getWorkspaceTitle: async (id) => workspaceTitles.get(id) ?? null, setWorkspaceTitle: async (id, title) => { workspaceTitles.set(id, title); return null; }, execWorkspaceShell: async (...args) => { calls.push(args); return result; }, workspaceTerminalProcesses: terminalProcesses }));
      const slugSuggestion = await import("@kintsugi/agent/server/slug-suggestion");
      const slugRequests = [];
      let suggestedSlug;
      let slugDelay;
      mock.module("@kintsugi/agent/server/slug-suggestion", () => ({ ...slugSuggestion, suggestAgentSlug: async (...args) => { slugRequests.push(args); await slugDelay?.promise; return suggestedSlug; } }));
      const { createCliAgentModule } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/index.ts"))});
      const adapter = {
        id: "example", label: "Example CLI", iconHtml: "",
        requireSetup: async () => { if (setupError) throw setupError; },
        settings: {
          renderFooter: async () => "",
          prepare: async (settings = {}) => settings,
        },
        prepareWorkspace: async (workspaceId) => { preparations.push(workspaceId); await preparationDelay?.promise; if (preparationError) throw preparationError; },
        prepareSession: async () => ({}),
        launchScript: (input, images, settings) => { launches.push({ input, images, settings }); return launchScript; },
        turnSettled: (...args) => turnSettled(...args),
      };
      const module = createCliAgentModule(adapter);
      const titleEvents = [];
      module.initialize({ events: { on() {}, emit: async (name, payload) => { titleEvents.push({ name, payload }); } }, registerSocketHandler() {} });
      const agentType = module.agentType;
      const saved = (workspaceId, agentTypeId = "example") => Bun.file(process.env.KINTSUGI_DATA_DIR + "/workspaces/" + workspaceId + "/metadata/" + agentTypeId + "-agents.json").json();
      const list = (workspaceId) => agentType.tabs.list({ workspaceId });
      // Creates a session in a fresh workspace and reports its turn boundaries the way its CLI does.
      async function turnSignals(workspaceId) {
        const { configureAgentMcp, handleAgentMcpRequest } = await import("@kintsugi/agent/server");
        configureAgentMcp({ on() {}, emit: async () => {} });
        const id = await agentType.create({ workspaceId });
        const token = calls.findLast((call) => call[2]?.stdin?.includes("Authorization: Bearer"))[2].stdin.match(/Authorization: Bearer ([\\w.-]+)/)[1];
        return { id, signal: (boundary) => handleAgentMcpRequest(new Request("http://localhost/agent-turn-" + boundary, { method: "POST", headers: { authorization: "Bearer " + token } }), workspaceId) };
      }
      ${script}
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, KINTSUGI_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("creation materializes images and passes input and settings to the adapter once", () => scenario(`
  const input = { text: "Inspect this image", images: [{ mimeType: "image/png", data: "aW1hZ2U=" }], attachmentNotes: ["File: /work/notes.txt"] };
  const settings = { input, model: "any-provider::model", thinkingLevel: "custom" };
  await agentType.launch.prepareWorkspace("initial", { agent: settings });
  const [tab] = await list("initial");
  const image = "/tmp/kintsugi-attachments/example-" + tab.id + "/0.png";
  expect(calls[0][1]).toContain(image);
  expect(calls[0][2]).toEqual({ stdin: "aW1hZ2U=" });
  const shellCalls = calls.length;
  expect(started).toEqual([{ workspaceId: "initial", options: expect.objectContaining({ id: tab.id, cwd: "/work", interactive: true }) }]);
  // A launch with a prompt runs the script in an outer shell whose trap finishes the pending turn.
  expect(started[0].options.command).toStartWith("trap ");
  expect(started[0].options.command).toContain("CLI started");
  expect(launches).toEqual([{ input, images: [image], settings }]);
  expect(preparations).toEqual(["initial"]);
  const [session] = (await saved("initial")).agents;
  expect(session).toMatchObject({ id: tab.id, title: "Example CLI", input, kind: "example", model: settings.model, thinkingLevel: "custom" });
  expect(session.tmuxSession).toBeUndefined();
  await list("initial");
  expect(calls).toHaveLength(shellCalls);
  expect(started).toHaveLength(1);
`));

test("a launch prompt names the tab with a suggested slug", () => scenario(`
  suggestedSlug = "inspect-attached-image";
  const input = { text: "Inspect this image", images: [], attachmentNotes: [] };
  await agentType.launch.prepareWorkspace("named", { agent: { input, model: "any-provider::model" } });
  const [tab] = await list("named");
  while (titleEvents.length < 2) await Bun.sleep(1);
  expect(slugRequests).toEqual([[input.text, { provider: "any-provider", id: "model" }]]);
  expect(await list("named")).toEqual([{ id: tab.id, title: suggestedSlug }]);
  expect((await saved("named")).agents[0].historySlug).toBe(suggestedSlug);
  expect(titleEvents).toEqual([
    { name: "workspace_agent_title_changed", payload: { workspaceId: "named", agentId: tab.id, title: suggestedSlug } },
    { name: "workspace_title_changed", payload: { workspaceId: "named", title: suggestedSlug } },
  ]);
  expect(workspaceTitles.get("named")).toBe(suggestedSlug);
`));

test("CLI composer /name renames the tab without sending text to the terminal", () => scenario(`
  const id = await agentType.create({ workspaceId: "rename" });
  const route = module.routes[0].handle;
  const url = new URL("http://localhost/workspaces/rename/example-agents/" + id + "/composer");
  const { agentAttachmentDraftId } = await import("@kintsugi/prompt/server");
  const form = (text) => new Request(url, { method: "POST", body: new URLSearchParams({ text, attachmentDraft: agentAttachmentDraftId("rename", "example:" + id) }) });
  const explicit = await route(form("/name manual-title"), url);
  expect(explicit.status).toBe(204);
  expect(await list("rename")).toEqual([{ id, title: "manual-title" }]);
  expect((await saved("rename")).agents[0].historySlug).toBe("manual-title");
  expect((await saved("rename")).agents[0].input.text).toBe("");
  expect(titleEvents).toEqual([
    { name: "workspace_agent_title_changed", payload: { workspaceId: "rename", agentId: id, title: "manual-title" } },
    { name: "workspace_title_changed", payload: { workspaceId: "rename", title: "manual-title" } },
  ]);
  expect((await route(form("/name"), url)).status).toBe(422);
  expect(await list("rename")).toEqual([{ id, title: "manual-title" }]);
`));

test("CLI /name leaves a Workspace with its own name alone", () => scenario(`
  workspaceTitles.set("own-name", "chosen-by-hand");
  const id = await agentType.create({ workspaceId: "own-name" });
  const url = new URL("http://localhost/workspaces/own-name/example-agents/" + id + "/composer");
  const { agentAttachmentDraftId } = await import("@kintsugi/prompt/server");
  const response = await module.routes[0].handle(new Request(url, { method: "POST", body: new URLSearchParams({ text: "/name tab-title", attachmentDraft: agentAttachmentDraftId("own-name", "example:" + id) }) }), url);
  expect(response.status).toBe(204);
  expect(workspaceTitles.get("own-name")).toBe("chosen-by-hand");
  expect(titleEvents.map((event) => event.name)).toEqual(["workspace_agent_title_changed"]);
`));

test("a late automatic title cannot replace a manual CLI /name", () => scenario(`
  suggestedSlug = "automatic-title";
  slugDelay = Promise.withResolvers();
  await agentType.launch.prepareWorkspace("race", { agent: { input: { text: "Investigate the timeout", images: [], attachmentNotes: [] } } });
  const [{ id }] = await list("race");
  while (!slugRequests.length) await Bun.sleep(1);
  const url = new URL("http://localhost/workspaces/race/example-agents/" + id + "/composer");
  const { agentAttachmentDraftId } = await import("@kintsugi/prompt/server");
  const response = await module.routes[0].handle(new Request(url, { method: "POST", body: new URLSearchParams({ text: "/name manual-title", attachmentDraft: agentAttachmentDraftId("race", "example:" + id) }) }), url);
  expect(response.status).toBe(204);
  slugDelay.resolve();
  await Bun.sleep(20);
  expect(await list("race")).toEqual([{ id, title: "manual-title" }]);
  expect((await saved("race")).agents[0].historySlug).toBe("manual-title");
  expect(titleEvents.map((event) => event.name)).toEqual(["workspace_agent_title_changed", "workspace_title_changed"]);
`));

test("CLI composer /name uses the saved prompt when no title is supplied", () => scenario(`
  const id = await agentType.create({ workspaceId: "context" });
  const url = new URL("http://localhost/workspaces/context/example-agents/" + id + "/composer");
  const { agentAttachmentDraftId } = await import("@kintsugi/prompt/server");
  const form = (text) => new Request(url, { method: "POST", body: new URLSearchParams({ text, attachmentDraft: agentAttachmentDraftId("context", "example:" + id) }) });
  expect((await module.routes[0].handle(form("Investigate the timeout"), url)).status).toBe(200);
  suggestedSlug = "investigate-timeout";
  const response = await module.routes[0].handle(form("/name"), url);
  expect(response.status).toBe(204);
  expect(slugRequests).toEqual([["Investigate the timeout", undefined]]);
  expect(await list("context")).toEqual([{ id, title: "investigate-timeout" }]);
`));

test("startup failure leaves a durable tab with its actual error", () => scenario(`
  startError = new Error("tmux service unavailable");
  const id = await agentType.create({ workspaceId: "failure" });
  expect((await saved("failure")).agents[0]).toMatchObject({ id, error: "tmux service unavailable" });
  expect(await list("failure")).toEqual([{ id, title: "Example CLI" }]);
`));

test("adapter preparation failures are retained without launching a process", () => scenario(`
  preparationError = new Error("credentials could not be installed");
  await agentType.create({ workspaceId: "failure" });
  expect((await saved("failure")).agents[0].error).toBe(preparationError.message);
  expect(calls).toHaveLength(0);
  expect(launches).toHaveLength(0);
  await agentType.launch.prepareWorkspace("failure");
  expect(preparations).toHaveLength(1);
`));

test("an ended CLI keeps its process, and what it left, until the tab is closed", () => scenario(`
  const id = await agentType.create({ workspaceId: "ended" });
  const ended = { state: "exited", exitCode: 42, aborted: false, timedOut: false, output: { ansi: "install failed", text: "install failed" } };
  setProcessState("ended", id, ended);
  const { createCliAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/agents.ts"))});
  const agents = createCliAgents(adapter);
  expect(await agents.terminalState("ended", agents.get("ended", id))).toEqual(ended);
  const tab = (await agentType.tabs.render({ workspaceId: "ended", agentId: id })).html;
  expect(tab).toContain("Session ended (exit 42)");
  expect(tab).toContain('<pre class="cli-terminal-output">install failed</pre>');
  expect(tab).not.toContain("observable-terminal-host");
  expect(tab).not.toContain("cli-agent-composer");
  expect(released).toEqual([]);
  await agentType.tabs.close({ workspaceId: "ended", agentId: id });
  expect(released).toEqual([id]);
  expect(await list("ended")).toEqual([]);
`));

test("closing an Agent whose process is gone releases it without restarting it", () => scenario(`
  const id = await agentType.create({ workspaceId: "missing" });
  setProcessState("missing", id, { state: "lost" });
  await agentType.tabs.close({ workspaceId: "missing", agentId: id });
  expect(released).toEqual([id]);
  expect(await list("missing")).toEqual([]);
  expect(launches).toHaveLength(1);
`));

test("a failed release propagates and preserves the tab", () => scenario(`
  const id = await agentType.create({ workspaceId: "broken" });
  releaseError = new Error("container unavailable");
  await expect(agentType.tabs.close({ workspaceId: "broken", agentId: id })).rejects.toThrow("container unavailable");
  expect(await list("broken")).toHaveLength(1);
`));

test("concurrent provisioning claims launch once, and recovery never resubmits", () => scenario(`
  const context = { agent: { input: { text: "Only once", images: [], attachmentNotes: [] } } };
  await Promise.all([agentType.launch.prepareWorkspace("recovery", context), agentType.launch.prepareWorkspace("recovery", context)]);
  await createCliAgentModule(adapter).agentType.launch.prepareWorkspace("recovery", context);
  expect(started).toHaveLength(1);
  expect(launches).toHaveLength(1);
  expect(await list("recovery")).toHaveLength(1);
`));

test("Agent types and Workspaces have independent Agent stores", () => scenario(`
  const other = createCliAgentModule({ ...adapter, id: "other", label: "Other CLI" }).agentType;
  const [first, second, third] = await Promise.all([
    agentType.create({ workspaceId: "one" }), other.create({ workspaceId: "one" }), agentType.create({ workspaceId: "two" }),
  ]);
  expect(new Set([first, second, third]).size).toBe(3);
  expect((await saved("one")).agents.map(s => s.id)).toEqual([first]);
  expect((await saved("one", "other")).agents.map(s => s.id)).toEqual([second]);
  expect((await saved("two")).agents.map(s => s.id)).toEqual([third]);
`));

test("existing CLI placeholders, Claude and Pi agents retain paths, IDs and tmux names", () => scenario(`
  for (const id of ["codex-cli", "claude", "pi"]) {
    const session = { id: "old-" + id, title: "Existing tab", tmuxSession: id + "-existing", input: { text: "Never submit", images: [], attachmentNotes: [] }, model: "saved-model", thinkingLevel: "high", firstPresentation: true, ...(id !== "codex-cli" ? { kind: id } : {}) };
    const path = process.env.KINTSUGI_DATA_DIR + "/workspaces/legacy/metadata/" + id + "-agents.json";
    await Bun.write(path, JSON.stringify({ sessions: [session] }));
    const legacy = createCliAgentModule({ ...adapter, id }).agentType;
    expect(await legacy.tabs.list({ workspaceId: "legacy" })).toEqual([{ id: session.id, title: session.title }]);
    await legacy.launch.prepareWorkspace("legacy");
    expect(await Bun.file(path).json()).toEqual({ sessions: [session] });
    await legacy.tabs.close({ workspaceId: "legacy", agentId: session.id });
    expect(calls.at(-1)[1]).toContain("kill-session -t '=" + id + "-existing'");
  }
  expect(launches).toHaveLength(0);
  expect(preparations).toHaveLength(0);
`));

test("setup errors reject before a session is claimed", () => scenario(`
  setupError = new Error("connect account");
  await expect(agentType.create({ workspaceId: "no-auth" })).rejects.toThrow("connect account");
  await expect(agentType.launch.prepare({})).rejects.toThrow("connect account");
  await expect(agentType.launch.submit(new FormData())).rejects.toThrow("connect account");
  await expect(agentType.launch.prepareWorkspace("no-auth")).rejects.toThrow("connect account");
  expect(await list("no-auth")).toEqual([]);
  expect(preparations).toHaveLength(0);
`));

test("launch settings are prepared by the adapter for both form and programmatic launches", () => scenario(`
  const settings = { model: "local::model" };
  expect(await agentType.launch.prepare(settings)).toEqual({ agent: settings });
  const form = new FormData();
  form.set("model", "local::other");
  form.set("thinkingLevel", "high");
  const submitted = await agentType.launch.submit(form);
  expect(await submitted.prepare()).toEqual({ agent: { model: "local::other", thinkingLevel: "high" } });
  const minimal = createCliAgentModule({ ...adapter, id: "minimal", prepareWorkspace: undefined }).agentType;
  await minimal.create({ workspaceId: "local" });
  expect(preparations).toHaveLength(0);
  expect(launches).toHaveLength(1);
`));

test("an Agent reports starting until its process starts, and readiness waits for it", () => scenario(`
  const { createCliAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/agents.ts"))});
  const entered = Promise.withResolvers();
  const preparation = Promise.withResolvers();
  const agents = createCliAgents({ ...adapter, prepareWorkspace: async () => { entered.resolve(); await preparation.promise; } });
  const launch = agents.create("starting");
  await entered.promise;
  const [claim] = agents.list("starting");
  expect(await agents.terminalState("starting", claim)).toEqual({ state: "starting" });
  let ready = false;
  const readiness = agents.ready("starting", claim.id).then(session => { ready = true; return session; });
  await Bun.sleep(10);
  expect(ready).toBe(false);
  expect(started).toHaveLength(0);
  preparation.resolve();
  expect(await launch).toBe(claim.id);
  expect(await readiness).toBe(claim);
  expect(started).toHaveLength(1);
  expect(await agents.terminalState("starting", claim)).toEqual({ state: "running", interactive: true });
`));

test("failed startup releases readiness waiters with its error, and starts no process", () => scenario(`
  const { createCliAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/agents.ts"))});
  const entered = Promise.withResolvers();
  const preparation = Promise.withResolvers();
  const agents = createCliAgents({ ...adapter, prepareWorkspace: async () => { entered.resolve(); await preparation.promise; throw new Error("preparation failed"); } });
  const launch = agents.create("failed-start");
  await entered.promise;
  const [claim] = agents.list("failed-start");
  const readiness = agents.ready("failed-start", claim.id);
  preparation.resolve();
  await launch;
  expect((await readiness).error).toBe("preparation failed");
  expect(started).toHaveLength(0);
`));

test("authenticated turn boundaries identify the exact CLI session and close revokes it", () => scenario(`
  const { createKintsugiEventBus } = await import("@kintsugi/core");
  const { configureAgentMcp, handleAgentMcpRequest, subscribeWorkspaceAgentBusy } = await import("@kintsugi/agent/server");
  const events = createKintsugiEventBus();
  const finished = [];
  const busy = [];
  const attention = [];
  module.initialize({ events, registry: { requestAttention(workspaceId) { attention.push(workspaceId); } }, registerSocketHandler() {} });
  events.on("workspace_agent_turn_finished", event => { finished.push(event); });
  subscribeWorkspaceAgentBusy(event => { busy.push(event); });
  configureAgentMcp(events);
  const id = await agentType.create({ workspaceId: "completion" });
  const script = calls.find(call => call[2]?.stdin?.includes("Authorization: Bearer"))[2].stdin;
  const token = script.match(/Authorization: Bearer ([\\w.-]+)/)[1];
  const request = (headers = {}, method = "POST", boundary = "finished") => new Request("http://localhost/agent-turn-" + boundary, { method, headers: { authorization: "Bearer " + token, ...headers } });
  expect((await handleAgentMcpRequest(request(), "another-workspace")).status).toBe(401);
  expect((await handleAgentMcpRequest(request({ origin: "http://localhost" }), "completion")).status).toBe(403);
  expect((await handleAgentMcpRequest(request({}, "GET"), "completion")).status).toBe(405);
  expect((await handleAgentMcpRequest(request({ authorization: "Bearer invalid" }), "completion")).status).toBe(401);
  expect(finished).toEqual([]);
  expect(busy).toEqual([]);
  expect(attention).toEqual([]);
  expect((await handleAgentMcpRequest(request({}, "POST", "started"), "completion")).status).toBe(204);
  expect(finished).toEqual([]);
  expect(attention).toEqual([]);
  expect((await handleAgentMcpRequest(request(), "completion")).status).toBe(204);
  // The turn ends just after the response, once the adapter finds its history settled.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(busy).toEqual([
    { workspaceId: "completion", agentKey: "agent:" + id, busy: true },
    { workspaceId: "completion", agentKey: "agent:" + id, busy: false },
  ]);
  expect(finished).toEqual([{ workspaceId: "completion", agentId: id }]);
  expect(attention).toEqual(["completion"]);
  await events.emit("workspace_agent_turn_finished", { workspaceId: "completion", agentId: "delegated-or-other-provider" });
  await events.emit("workspace_agent_turn_finished", { workspaceId: "another-workspace", agentId: id });
  expect(attention).toEqual(["completion"]);
  await agentType.tabs.close({ workspaceId: "completion", agentId: id });
  expect((await handleAgentMcpRequest(request({}, "POST", "started"), "completion")).status).toBe(401);
`));

test("startup failure revokes credentials issued before adapter preparation", () => scenario(`
  const { handleAgentMcpRequest } = await import("@kintsugi/agent/server");
  let token;
  adapter.prepareSession = async (_workspaceId, _sessionId, mcp) => {
    token = mcp.token;
    throw new Error("session configuration failed");
  };
  const id = await agentType.create({ workspaceId: "failed-credentials" });
  expect((await saved("failed-credentials")).agents[0]).toMatchObject({ id, error: "session configuration failed" });
  expect(launches).toHaveLength(0);
  const request = new Request("http://localhost/agent-turn-finished", { method: "POST", headers: { authorization: "Bearer " + token } });
  expect((await handleAgentMcpRequest(request, "failed-credentials")).status).toBe(401);
`));


test("automatic recovery restores missing processes once without replaying saved input", () => scenario(`
  const { createCliAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/agents.ts"))});
  const resumed = [];
  const agents = createCliAgents({ ...adapter, resumeScript: async (...args) => { resumed.push(args); return "printf resumed"; } }, async () => {});
  const settings = { model: "provider::saved", thinkingLevel: "high", input: { text: "NEVER REPLAY", images: [], attachmentNotes: ["original attachment"] } };
  const id = await agents.create("restore", settings);
  // Its terminal went with the workspace's restart.
  setProcessState("restore", id, { state: "lost" });
  await Promise.all([agents.restoreWorkspace("restore"), agents.restoreWorkspace("restore")]);
  expect(released).toEqual([id]);
  expect(started).toHaveLength(2);
  expect(started[1].options.command).toBe("printf resumed");
  expect(resumed).toHaveLength(1);
  expect(resumed[0][0]).toBe("restore");
  expect(resumed[0][1]).toEqual({ model: settings.model, thinkingLevel: settings.thinkingLevel });
  expect(resumed[0][2].id).toBe(id);
  expect(launches).toHaveLength(1);
  expect((await saved("restore")).agents[0]).toMatchObject({ id, input: settings.input });
`));

test("a renamed adapter keeps its earlier metadata file and restores agents of its earlier kind", () => scenario(`
  const { createCliAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/agents.ts"))});
  const resumed = [];
  const agents = createCliAgents({ ...adapter, id: "renamed", legacyId: "original", resumeScript: async (...args) => { resumed.push(args[2].id); return "printf resumed"; } }, async () => {});
  const path = process.env.KINTSUGI_DATA_DIR + "/workspaces/renamed/metadata/original-agents.json";
  const agent = (id, kind) => ({ id, title: "Existing tab", tmuxSession: "original-" + id, input: { text: "", images: [], attachmentNotes: [] }, kind });
  await Bun.write(path, JSON.stringify({ agents: [agent("earlier", "original"), agent("placeholder")] }));
  expect(agents.list("renamed").map(agent => agent.id)).toEqual(["earlier", "placeholder"]);
  await agents.restoreWorkspace("renamed");
  expect(resumed).toEqual(["earlier"]);
  // Started before terminal processes: its CLI in tmux stops, and it resumes as a terminal process.
  expect(calls.some(call => call[1].includes("kill-session -t '=original-earlier'"))).toBe(true);
  const records = (await Bun.file(path).json()).agents;
  expect(records.find(agent => agent.id === "earlier").tmuxSession).toBeUndefined();
  expect(records.find(agent => agent.id === "placeholder").tmuxSession).toBe("original-placeholder");
  const id = await agents.create("renamed");
  expect((await Bun.file(path).json()).agents.find(agent => agent.id === id)).toMatchObject({ kind: "renamed" });
`));

test("recovery leaves running and ended CLIs alone", () => scenario(`
  const { createCliAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/agents.ts"))});
  const agents = createCliAgents({ ...adapter, resumeScript: async () => { throw new Error("must not resume"); } }, async () => {});
  const id = await agents.create("existing");
  for (const state of [{ state: "running", interactive: true }, { state: "exited", exitCode: 42, aborted: false, timedOut: false, output: { ansi: "", text: "" } }]) {
    setProcessState("existing", id, state);
    await agents.restoreWorkspace("existing");
  }
  expect(released).toEqual([]);
  expect((await saved("existing")).agents[0].error).toBeUndefined();
  expect(launches).toHaveLength(1);
`));

test("one restoration failure preserves its tab and does not block other agents", () => scenario(`
  const { createCliAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/agents.ts"))});
  const resumed = [];
  const agents = createCliAgents({ ...adapter, resumeScript: async (_workspaceId, _settings, session) => { resumed.push(session.id); if (resumed.length === 1) throw new Error("native history could not be loaded"); return "printf resumed"; } }, async () => {});
  const first = await agents.create("failure");
  const second = await agents.create("failure");
  setProcessState("failure", first, { state: "lost" });
  setProcessState("failure", second, { state: "lost" });
  await agents.restoreWorkspace("failure");
  expect(resumed).toEqual([first, second]);
  expect((await saved("failure")).agents[0]).toMatchObject({ id: first, error: "native history could not be loaded" });
  expect((await saved("failure")).agents[1].error).toBeUndefined();
`));

test("a CLI turn ends only once the adapter finds its native history settled", () => scenario(`
  const { subscribeWorkspaceAgentBusy } = await import("@kintsugi/agent/server");
  const busy = [];
  subscribeWorkspaceAgentBusy((event) => busy.push(event.busy));
  let settled = false;
  const checked = [];
  turnSettled = async (workspaceId, id) => { checked.push([workspaceId, id]); return settled; };
  const { id, signal } = await turnSignals("settling");
  await signal("started");
  expect((await signal("finished")).status).toBe(204);
  await Bun.sleep(250);
  expect(busy).toEqual([true]);
  expect(checked.length).toBeGreaterThan(1);
  expect(checked[0]).toEqual(["settling", id]);
  settled = true;
  await Bun.sleep(150);
  expect(busy).toEqual([true, false]);
`));

test("a CLI turn whose native history never settles ends after ten seconds", () => scenario(`
  const { subscribeWorkspaceAgentBusy } = await import("@kintsugi/agent/server");
  const busy = [];
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  subscribeWorkspaceAgentBusy((event) => busy.push(event.busy));
  const realNow = Date.now;
  let elapsed = 0;
  Date.now = () => realNow() + elapsed;
  turnSettled = async () => false;
  const { id, signal } = await turnSignals("unsettled");
  await signal("started");
  await signal("finished");
  elapsed = 9_000;
  await Bun.sleep(250);
  expect(busy).toEqual([true]);
  elapsed = 10_000;
  await Bun.sleep(250);
  expect(busy).toEqual([true, false]);
  expect(errors).toEqual(["Example CLI history for " + id + " did not settle within 10s of its finished turn"]);
`));

test("a CLI turn ending with StopFailure times out after ten seconds without logging", () => scenario(`
  const { subscribeWorkspaceAgentBusy } = await import("@kintsugi/agent/server");
  const busy = [];
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  subscribeWorkspaceAgentBusy((event) => busy.push(event.busy));
  const realNow = Date.now;
  let elapsed = 0;
  Date.now = () => realNow() + elapsed;
  turnSettled = async () => false;
  const { id, signal } = await turnSignals("unsettled");
  await signal("started");
  await signal("failed");
  elapsed = 9_000;
  await Bun.sleep(250);
  expect(busy).toEqual([true]);
  elapsed = 10_000;
  await Bun.sleep(250);
  expect(busy).toEqual([true, false]);
  expect(errors).toEqual([]);
`));

test("a launch prompt stays busy through preparation and installation until its first turn finishes", () => scenario(`
  const busy = [];
  const { subscribeWorkspaceAgentBusy, configureAgentMcp, handleAgentMcpRequest } = await import("@kintsugi/agent/server");
  subscribeWorkspaceAgentBusy(event => busy.push(event));
  configureAgentMcp({ on() {}, emit: async () => {} });
  preparationDelay = Promise.withResolvers();
  const launch = agentType.launch.prepareWorkspace("installing", { agent: { input: { text: "Hello", images: [], attachmentNotes: [] } } });
  while (!preparations.length) await Bun.sleep(1);
  const [{ id }] = await list("installing");
  expect(busy).toEqual([{ workspaceId: "installing", agentKey: "agent:" + id, busy: true }]);
  preparationDelay.resolve();
  await launch;
  // tmux is ready, but the installer has not reported a native turn yet.
  expect(busy).toHaveLength(1);
  const token = calls.findLast(call => call[2]?.stdin?.includes("Authorization: Bearer"))[2].stdin.match(/Authorization: Bearer ([\\w.-]+)/)[1];
  const signal = boundary => handleAgentMcpRequest(new Request("http://localhost/agent-turn-" + boundary, { method: "POST", headers: { authorization: "Bearer " + token } }), "installing");
  await signal("started");
  expect(busy.every(event => event.busy)).toBe(true);
  await signal("finished");
  while (busy.at(-1).busy) await Bun.sleep(1);
  expect(busy.at(-1)).toEqual({ workspaceId: "installing", agentKey: "agent:" + id, busy: false });
`));

test("a prompted startup failure clears busy; empty interactive launches do not claim work", () => scenario(`
  const busy = [];
  const { subscribeWorkspaceAgentBusy } = await import("@kintsugi/agent/server");
  subscribeWorkspaceAgentBusy(event => busy.push(event.busy));
  preparationError = new Error("Preparation failed");
  await agentType.launch.prepareWorkspace("failed-prompt", { agent: { input: { text: "Hello", images: [], attachmentNotes: [] } } });
  expect(busy).toEqual([true, false]);
  preparationError = undefined;
  await agentType.create({ workspaceId: "interactive" });
  expect(busy).toEqual([true, false]);
`));

test("the terminal reports installation failure even when the CLI script owns its own EXIT trap", () => scenario(`
  launchScript = "set -eu; trap 'printf installation-failed >&2' EXIT; exit 7";
  await agentType.launch.prepareWorkspace("installer-failure", { agent: { input: { text: "Hello", images: [], attachmentNotes: [] } } });
  const [{ id }] = await list("installer-failure");
  const directory = process.env.KINTSUGI_DATA_DIR;
  const signalScript = directory + "/signal.sh";
  const signalFile = directory + "/boundary";
  const { shellQuote } = await import("@kintsugi/core");
  await Bun.write(signalScript, 'printf "%s" "$1" > ' + shellQuote(signalFile));
  // Run the actual terminal command, replacing only its authenticated relay script.
  const command = started[0].options.command.replaceAll("/home/agent/.local/share/kintsugi-agents/" + id + "/turn-signal.sh", signalScript);
  const child = Bun.spawn(["/bin/bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(7);
  expect(stderr).toBe("installation-failed");
  expect(await Bun.file(signalFile).text()).toBe("failed");
`));

test("native prompt preparation includes shared and plugin guidance once per launch and refreshes it on resume", () => scenario(`
  const { configureAgentMcp } = await import("@kintsugi/agent/server");
  const { createKintsugiEventBus } = await import("@kintsugi/core");
  const events = createKintsugiEventBus();
  let prepared = 0;
  events.on("agent_system_prompt_prepare", ({ lines, agentId }) => {
    lines.push("Plugin guidance " + agentId + " revision " + ++prepared + " " + "x".repeat(12000));
  });
  configureAgentMcp(events);
  const prompts = [];
  adapter.prepareSession = async (_workspaceId, session, mcp) => {
    prompts.push(mcp.instructions);
    expect(JSON.parse(Buffer.from(mcp.token.split(".")[0], "base64url").toString())).toMatchObject({ agentId: session.id, instructionDelivery: "system-prompt" });
    return {};
  };
  const id = await agentType.create({ workspaceId: "native-prompt" });
  expect(prepared).toBe(1);
  expect(prompts[0]).toContain("You are running inside of an online coding tool called Kintsugi.");
  expect(prompts[0]).toContain("Plugin guidance " + id + " revision 1");
  adapter.resumeScript = async () => "true";
  setProcessState("native-prompt", id, { state: "lost" });
  const { createCliAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/agents.ts"))});
  await createCliAgents(adapter, async () => {}).restoreWorkspace("native-prompt");
  expect(prepared).toBe(2);
  expect(prompts[1]).toContain("Plugin guidance " + id + " revision 2");
  expect(prompts[1]).not.toContain("revision 1");
`));

test("native prompts add .agents-in-the-cloud/AGENTS.md and leave the root AGENTS.md to the CLI", () => scenario(`
  agentsFiles.set("/work/AGENTS.md", "Root guidance");
  agentsFiles.set("/work/.agents-in-the-cloud/AGENTS.md", "Presentation guidance");
  const prompts = [];
  adapter.prepareSession = async (_workspaceId, _session, mcp) => { prompts.push(mcp.instructions); return {}; };
  await agentType.create({ workspaceId: "agents-files" });
  expect(prompts[0]).toContain("# Project instructions: /work/.agents-in-the-cloud/AGENTS.md\\n\\nPresentation guidance");
  expect(prompts[0]).not.toContain("Root guidance");
`));
