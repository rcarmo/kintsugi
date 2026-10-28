import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep transport mocks and workspace metadata isolated from other packages.
async function scenario(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "codex-runtime-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const connections = [];
      const requests = [];
      const turns = [];
      const reviewSettings = [];
      let resumeError;
      let requestFailure;
      let compactNotifications = true;
      let startCount = 0;
      const launchSettings = { model: "openai-codex::model", thinkingLevel: "medium" };
      const models = [{ model: "model", hidden: false, displayName: "Model", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }];
      let reviewNotifications = true;
      let goal = null;
      let skills = { data: [] };
      let plugins = { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
      let mcpPages = [{ data: [], nextCursor: null }];
      let appPages = [{ data: [], nextCursor: null }];
      const turn = (id, status = "completed") => ({ id, status, items: [], itemsView: "full", error: null, startedAt: 100, completedAt: status === "inProgress" ? null : 101, durationMs: 1000 });
      const setupPath = ${JSON.stringify(join(import.meta.dir, "../src/server/setup.ts"))};
      mock.module(setupPath, () => ({
        agentTypeId: "codex", label: "Codex", codexHome: id => "/codex/" + id,
        prepareCodex: async () => ({ instructions: "instructions", mcp: { url: "http://localhost/mcp", token: "test" } }), requireSetup: async () => {},
        settings: { prepare: async () => ({ ...launchSettings }), renderFooter: async () => "" },
      }));
      mock.module(${JSON.stringify(join(import.meta.dir, "../src/server/transport.ts"))}, () => ({
        openCodexTransport: async (workspaceId, home, notification, failed) => {
          let nativeModel = "model";
          let nativeEffort = "medium";
          const connection = { notification, failed, closed: false, rpc: {
            notify() {}, async request(method, params) {
              requests.push({ method, params });
              if (requestFailure?.method === method) { const error = requestFailure.error; requestFailure = undefined; throw error; }
              if (method === "initialize") return {};
              if (method === "model/list") return { data: models, nextCursor: null };
              if (method === "thread/resume" && resumeError) throw resumeError;
              if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
                nativeModel = params.model ?? nativeModel;
                nativeEffort = params.config?.model_reasoning_effort ?? nativeEffort;
                return { thread: { id: method === "thread/fork" ? "forked-thread" : params.threadId ?? "thread-" + ++startCount, turns: method === "thread/start" ? [] : [...turns] }, model: nativeModel, reasoningEffort: nativeEffort };
              }
              if (method === "thread/settings/update") { nativeModel = params.model; nativeEffort = params.effort; return {}; }
              if (method === "thread/compact/start") {
                if (compactNotifications) {
                  const value = turn("compact-" + turns.length); turns.push(value);
                  notification({ method: "turn/started", params: { threadId: params.threadId, turn: { ...value, status: "inProgress" } } });
                  notification({ method: "turn/completed", params: { threadId: params.threadId, turn: value } });
                }
                return {};
              }
              if (method === "turn/start") { const value = turn("turn-" + turns.length); turns.push(value); return { turn: value }; }
              if (method === "thread/list") return { data: [{ id: "saved-thread", turns: [] }], nextCursor: params.cursor ? null : "next-page", backwardsCursor: null };
              if (method === "review/start") { reviewSettings.push({ model: nativeModel, effort: nativeEffort }); const value = turn("review", "inProgress"); turns.push(value); if (reviewNotifications) notification({ method: "turn/started", params: { threadId: params.threadId, turn: value } }); return { turn: turn("review-operation", "inProgress"), reviewThreadId: params.threadId }; }
              if (method === "thread/goal/set") { goal = { ...(goal ?? {}), objective: params.objective ?? goal?.objective, status: params.status }; return { goal }; }
              if (method === "thread/goal/get") return { goal };
              if (method === "thread/goal/clear") { goal = null; return { cleared: true }; }
              if (method === "skills/list") return skills;
              if (method === "hooks/list") return { data: [] };
              if (method === "plugin/list") return plugins;
              if (method === "plugin/install") return { appsNeedingAuth: [] };
              if (method === "skills/config/write") { for (const entry of skills.data) for (const skill of entry.skills) if (skill.path === params.path) skill.enabled = params.enabled; return { effectiveEnabled: params.enabled }; }
              if (method === "config/value/write") return { status: "ok" };
              if (method === "mcpServerStatus/list") return mcpPages[params.cursor ? 1 : 0];
              if (method === "app/list") return appPages[params.cursor ? 1 : 0];
              if (method === "thread/read") return { thread: { turns: [...turns] } };
              return {};
            },
          }, async close() { this.closed = true; } };
          connections.push(connection);
          return connection;
        },
      }));
      const rendering = await import(${JSON.stringify(join(import.meta.dir, "../src/server/render.ts"))});
      mock.module(${JSON.stringify(join(import.meta.dir, "../src/server/render.ts"))}, () => ({ ...rendering, liveRegions: runtime => [{ target: "state", html: JSON.stringify(runtime.state.turns) }] }));
      const busy = await import("@kintsugi/agent/server");
      const busyEvents = [];
      mock.module("@kintsugi/agent/server", () => ({ ...busy, publishWorkspaceAgentBusy(event) { busyEvents.push(event); } }));
      const handlers = new Map();
      const events = { on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, async emit(name, payload) { for (const handler of handlers.get(name) ?? []) await handler(payload); } };
      const { createCodexAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/runtime.ts"))});
      const agents = createCodexAgents(() => events);
      const input = { text: "hello", images: [], attachmentNotes: [] };
      ${script}
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ATELIER_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("concurrent acquisitions resume a failed runtime once and preserve its subscribers", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  await runtime.send(input, "first");
  const publications = [];
  const subscription = runtime.presentation.subscribe(value => publications.push(value));
  connections[0].failed(new Error("Disconnected"));
  const recovered = await Promise.all([agents.ready("workspace", id), agents.ready("workspace", id)]);
  expect(recovered).toEqual([runtime, runtime]);
  expect(connections).toHaveLength(2);
  expect(connections[0].closed).toBe(true);
  expect(requests.filter(value => value.method === "thread/resume")).toHaveLength(1);
  expect(runtime.failure).toBeUndefined();
  expect(runtime.selection.models).toHaveLength(1);
  await runtime.send(input, "second");
  runtime.presentation.flush();
  expect(publications).toHaveLength(2);
  expect(runtime.state.turns).toHaveLength(2);
  subscription.unsubscribe();
  await agents.disposeAll();
`));

test("failed recovery remains visible and a later acquisition can retry it", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  await runtime.send(input, "first");
  connections[0].failed(new Error("Disconnected"));
  resumeError = new Error("Resume failed");
  await expect(agents.ready("workspace", id)).rejects.toThrow("Resume failed");
  expect(runtime.failure.message).toBe("Resume failed");
  resumeError = undefined;
  expect(await agents.ready("workspace", id)).toBe(runtime);
  expect(connections).toHaveLength(3);
  expect(connections[1].closed).toBe(true);
  await agents.disposeAll();
`));

test("prompt admission does not read the rollout before Codex completes the turn", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  await runtime.send(input, "first");
  expect(requests.filter(value => value.method === "thread/read")).toHaveLength(0);
  connections[0].notification({ method: "turn/completed", params: { threadId: "thread-1", turn: turns[0] } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(requests.filter(value => value.method === "thread/read")).toHaveLength(1);
  await agents.disposeAll();
`));

test("reveal resolves nested activity to its owning turn, but not final answers", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  runtime.state.hydrate([{ ...turn("working"), items: [
    { type: "reasoning", id: "reasoning", summary: ["Thinking"], content: [] },
    { type: "commandExecution", id: "command", command: "pwd", status: "completed", aggregatedOutput: "/work", durationMs: 1, exitCode: 0 },
    { type: "userMessage", id: "initial", clientId: "initial", content: [] },
    { type: "userMessage", id: "steering", clientId: "steering", content: [] },
    { type: "agentMessage", id: "answer", text: "Done", phase: "final_answer" },
  ] }]);
  const { codexRoutes } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/routes.ts"))});
  const route = codexRoutes(agents);
  const reveal = async key => { const url = new URL("http://localhost/workspaces/workspace/codex-agents/" + id + "/reveal/" + key); return (await route(new Request(url), url)).json(); };
  for (const key of ["reasoning", "command"]) expect(await reveal(key)).toEqual({ turnId: "working" });
  for (const key of ["initial", "steering", "answer", "missing"]) expect(await reveal(key)).toEqual({ turnId: null });
  await agents.disposeAll();
`));

test("completion requests workspace attention only for this module's agents", () => scenario(`
  const attention = [];
  const { kintsugiServerModule: module } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/index.ts"))});
  module.initialize({ events, registry: { requestAttention: id => attention.push(id) }, onWorkspaceRemoved() {} });
  const id = await module.agentType.create({ workspaceId: "workspace" });
  await events.emit("workspace_agent_turn_finished", { workspaceId: "workspace", agentId: id });
  await events.emit("workspace_agent_turn_finished", { workspaceId: "workspace", agentId: "builtin" });
  await events.emit("workspace_agent_turn_finished", { workspaceId: "other", agentId: id });
  expect(attention).toEqual(["workspace"]);
  await events.emit("kintsugi_host_stopping", {});
`));

test("compaction and review use native RPCs and reject unsafe active-turn operations", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  await runtime.command({ kind: "compact" }, "compact");
  expect(requests.find(value => value.method === "thread/compact/start").params).toEqual({ threadId: "thread-1" });
  expect(requests.some(value => value.method === "turn/start")).toBe(false);
  await runtime.command({ kind: "review", target: { type: "baseBranch", branch: "main" } }, "review");
  expect(requests.find(value => value.method === "review/start").params).toEqual({ threadId: "thread-1", target: { type: "baseBranch", branch: "main" }, delivery: "inline" });
  expect(runtime.isBusy).toBe(true);
  for (const command of [{ kind: "compact" }, { kind: "fork" }, { kind: "resume" }, { kind: "review" }]) await expect(runtime.command(command, "busy")).rejects.toThrow("Stop Codex");
  await agents.disposeAll();
`));

test("fork and resume persist the selected native thread even without prompt submissions", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  await runtime.command({ kind: "fork" }, "fork");
  expect(runtime.record.threadId).toBe("forked-thread");
  const listed = await runtime.command({ kind: "resume", cursor: "next-page" }, "list");
  expect(listed.kind).toBe("resume");
  expect(requests.find(value => value.method === "thread/list").params).toMatchObject({ cwd: "/work", cursor: "next-page" });
  await runtime.command({ kind: "resume", threadId: "saved-thread" }, "resume");
  expect(runtime.record.threadId).toBe("saved-thread");
  connections[0].failed(new Error("Disconnected"));
  await agents.ready("workspace", id);
  expect(requests.filter(value => value.method === "thread/resume").map(value => value.params.threadId)).toEqual(["saved-thread", "saved-thread"]);
  expect(runtime.record.submissions).toHaveLength(0);
  await agents.disposeAll();
`));

test("goal actions update Codex native state and preserve the materialized thread", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  expect(await runtime.command({ kind: "goal" }, "show")).toEqual({ kind: "goal", goal: null });
  await runtime.command({ kind: "goal", objective: "Finish the task" }, "set");
  expect(runtime.record.threadId).toBe("thread-1");
  expect(goal).toEqual({ objective: "Finish the task", status: "active" });
  await runtime.command({ kind: "goal", status: "paused" }, "pause");
  expect(goal).toEqual({ objective: "Finish the task", status: "paused" });
  expect(await runtime.command({ kind: "goal", clear: true }, "clear")).toEqual({ kind: "goal", goal: null });
  expect(requests.some(value => value.method === "turn/start")).toBe(false);
  await agents.disposeAll();
`));

test("skill selection sends a validated native skill reference, never an arbitrary path", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  skills = { data: [{ cwd: "/work", skills: [{ name: "example", path: "/work/.agents/skills/example/SKILL.md", enabled: true }], errors: [] }] };
  await runtime.command({ kind: "skills", name: "example" }, "use-skill");
  const sent = requests.find(value => value.method === "turn/start");
  expect(sent.params.input.at(-1)).toEqual({ type: "skill", name: "example", path: "/work/.agents/skills/example/SKILL.md" });
  await runtime.command({ kind: "skills", name: "example" }, "use-skill");
  expect(requests.filter(value => value.method === "turn/start")).toHaveLength(1);
  skills.data[0].skills[0].enabled = false;
  await expect(runtime.command({ kind: "skills", name: "example" }, "disabled")).rejects.toThrow("enabled Codex skill");
  await agents.disposeAll();
`));

test("native catalogs include every page and inspection never submits a prompt", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  mcpPages = [{ data: [{ name: "first" }], nextCursor: "more" }, { data: [{ name: "second" }], nextCursor: null }];
  appPages = [{ data: [{ id: "first" }], nextCursor: "more" }, { data: [{ id: "second" }], nextCursor: null }];
  expect((await runtime.command({ kind: "mcp", verbose: true }, "mcp")).servers.map(value => value.name)).toEqual(["first", "second"]);
  expect((await runtime.command({ kind: "apps" }, "apps")).apps.map(value => value.id)).toEqual(["first", "second"]);
  for (const kind of ["skills", "hooks", "plugins"]) expect((await runtime.command({ kind }, kind)).kind).toBe(kind);
  expect(requests.some(value => value.method === "turn/start")).toBe(false);
  await agents.disposeAll();
`));

test("slash-command HTTP operations expose native results rather than send literal commands", () => scenario(`
  const id = await agents.create("workspace");
  const { codexRoutes } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/routes.ts"))});
  const route = codexRoutes(agents);
  const url = new URL("http://localhost/workspaces/workspace/codex-agents/" + id + "/messages");
  const response = await route(new Request(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ text: "/mcp" }) }), url);
  expect(response.status).toBe(200);
  expect((await response.json()).command.kind).toBe("mcp");
  expect(requests.some(value => value.method === "turn/start")).toBe(false);
  await agents.disposeAll();
`));

test("form commands accept absent pagination fields and validate native skill choices", () => scenario(`
  const id = await agents.create("workspace");
  const { codexRoutes } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/routes.ts"))});
  const route = codexRoutes(agents);
  const url = new URL("http://localhost/workspaces/workspace/codex-agents/" + id + "/commands");
  const body = new FormData(); body.set("text", "/resume");
  const response = await route(new Request(url, { method: "POST", body }), url);
  expect(response.status).toBe(200);
  expect(requests.find(value => value.method === "thread/list").params.cursor).toBeUndefined();
  skills = { data: [{ cwd: "/work", skills: [{ name: "example", path: "/work/.agents/skills/example/SKILL.md", enabled: true }], errors: [] }] };
  const forged = new FormData(); forged.set("text", "/skills example"); forged.set("skillPath", "/tmp/unlisted/SKILL.md");
  await expect(route(new Request(url, { method: "POST", body: forged }), url)).rejects.toThrow("enabled Codex skill");
  expect(requests.some(value => value.method === "turn/start")).toBe(false);
  await agents.disposeAll();
`));


test("skill settings validate inventory paths and use Codex’s persistent configuration", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const path = "/work/.agents/skills/example/SKILL.md";
  skills = { data: [{ cwd: "/work", skills: [{ name: "example", path, enabled: false }], errors: [] }] };
  await expect(runtime.command({ kind: "skills", name: "example", path: "/tmp/forged", enabled: true }, "forged")).rejects.toThrow("native Codex catalog");
  const result = await runtime.command({ kind: "skills", name: "example", path, enabled: true }, "enable");
  expect(result.skills.data[0].skills[0].enabled).toBe(true);
  expect(requests.filter(value => value.method === "skills/config/write")).toEqual([{ method: "skills/config/write", params: { path, enabled: true } }]);
  expect(requests.some(value => value.method === "turn/start")).toBe(false);
  await agents.disposeAll();
`));

test("plugin and app mutations resolve native catalog identities before writing settings", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  plugins.marketplaces = [{ name: "curated", path: null, plugins: [{ id: "example@curated", name: "example" }] }];
  appPages = [{ data: [{ id: "connector_example" }], nextCursor: null }];
  await expect(runtime.command({ kind: "plugins", action: "install", id: "forged" }, "forged-plugin")).rejects.toThrow("native Codex catalog");
  await expect(runtime.command({ kind: "apps", enabled: true, id: "forged" }, "forged-app")).rejects.toThrow("native Codex catalog");
  await runtime.command({ kind: "plugins", action: "install", id: "example@curated" }, "install");
  expect(requests.find(value => value.method === "plugin/install").params).toEqual({ pluginName: "example", marketplacePath: null, remoteMarketplaceName: "curated", installAttemptId: "install" });
  await runtime.command({ kind: "plugins", action: "uninstall", id: "example@curated" }, "uninstall");
  expect(requests.find(value => value.method === "plugin/uninstall").params).toEqual({ pluginId: "example@curated" });
  await runtime.command({ kind: "apps", enabled: false, id: "connector_example" }, "disable");
  expect(requests.find(value => value.method === "config/value/write").params).toEqual({ keyPath: 'apps."connector_example".enabled', value: false, mergeStrategy: "replace" });
  expect(requests.some(value => value.method === "turn/start")).toBe(false);
  await agents.disposeAll();
`));


test("review operation IDs never become phantom turns and pending starts stay busy", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  reviewNotifications = false;
  await runtime.command({ kind: "review", target: { type: "uncommittedChanges" } }, "review");
  expect(runtime.isBusy).toBe(true);
  expect(runtime.state.turns).toHaveLength(0);
  connections[0].notification({ method: "item/completed", params: { threadId: "thread-1", turnId: "review", item: { type: "enteredReviewMode", id: "review-mode", review: "current changes" } } });
  expect(runtime.state.activeTurn.id).toBe("review");
  turns[0] = turn("review");
  connections[0].notification({ method: "turn/completed", params: { threadId: "thread-1", turn: turns[0] } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(runtime.isBusy).toBe(false);
  expect(runtime.state.turns.map(value => value.id)).toEqual(["review"]);
  await agents.disposeAll();
`));


test("a finished turn reloads prompt templates it added for the composer", () => scenario(`
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { workspaceWorkHostPath } = await import("@kintsugi/workspace");
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  await runtime.send(input, "first");
  expect(runtime.completionCatalog).not.toContain('data-command-trigger="/ship"');
  const prompts = workspaceWorkHostPath("workspace") + "/.kintsugi/prompts";
  await mkdir(prompts, { recursive: true });
  await writeFile(prompts + "/ship.md", "---\\ncomposer-button: true\\n---\\nShip it");
  connections[0].notification({ method: "turn/started", params: { threadId: "thread-1", turn: turn("turn-0", "inProgress") } });
  connections[0].notification({ method: "turn/completed", params: { threadId: "thread-1", turn: turn("turn-0") } });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(runtime.isBusy).toBe(false);
  expect(runtime.completionCatalog).toContain('data-command-trigger="/ship"');
  await agents.disposeAll();
`));


test("native new starts a Codex thread without submitting an inference prompt", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const result = await runtime.command({ kind: "new" }, "new");
  expect(result.kind).toBe("done");
  expect(requests.filter(value => value.method === "thread/start")).toHaveLength(2);
  expect(requests.some(value => value.method === "turn/start")).toBe(false);
  expect(runtime.state.turns).toHaveLength(0);
  await agents.disposeAll();
`));

test("launch and thread transitions apply the selected native reasoning effort", () => scenario(`
  launchSettings.thinkingLevel = "high";
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  expect(requests.find(value => value.method === "thread/start").params.config).toEqual({ model_reasoning_effort: "high" });
  await runtime.command({ kind: "fork" }, "fork");
  expect(runtime.record.thinkingLevel).toBe("high");
  await runtime.command({ kind: "resume", threadId: "saved" }, "resume");
  expect(runtime.record.thinkingLevel).toBe("high");
  await runtime.command({ kind: "new" }, "new");
  connections[0].failed(new Error("Disconnected"));
  await agents.ready("workspace", id);
  for (const value of requests.filter(value => ["thread/start", "thread/resume", "thread/fork"].includes(value.method))) {
    expect(value.params.config).toEqual({ model_reasoning_effort: "high" });
  }
  await agents.disposeAll();
`));

test("picker changes update native thread settings before reviews without sending a prompt", () => scenario(`
  models.push({ model: "other", hidden: false, displayName: "Other", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] });
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  await runtime.configure({ model: "openai-codex::other" });
  await runtime.configure({ thinkingLevel: "high" });
  expect(requests.filter(value => value.method === "thread/settings/update").map(value => value.params)).toEqual([
    { threadId: "thread-1", model: "other", effort: "medium" },
    { threadId: "thread-1", model: "other", effort: "high" },
  ]);
  expect(runtime.record).toMatchObject({ model: "openai-codex::other", thinkingLevel: "high" });
  await runtime.command({ kind: "review", target: { type: "uncommittedChanges" } }, "review");
  expect(reviewSettings).toEqual([{ model: "other", effort: "high" }]);
  expect(requests.findIndex(value => value.method === "review/start")).toBeGreaterThan(requests.findLastIndex(value => value.method === "thread/settings/update"));
  expect(requests.some(value => value.method === "turn/start")).toBe(false);
  await agents.disposeAll();
`));

test("a rejected native settings update leaves the picker selection unchanged", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const { CodexRpcError } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/rpc.ts"))});
  requestFailure = { method: "thread/settings/update", error: new CodexRpcError("Unsupported settings") };
  await expect(runtime.configure({ thinkingLevel: "high" })).rejects.toThrow("Unsupported settings");
  expect(runtime.record.thinkingLevel).toBe("medium");
  await runtime.configure({ thinkingLevel: "high" });
  expect(runtime.record.thinkingLevel).toBe("high");
  await agents.disposeAll();
`));

test("compaction stays busy between its RPC reply and native turn notifications", () => scenario(`
  compactNotifications = false;
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const command = { kind: "compact" };
  const result = await runtime.command(command, "compact");
  expect(runtime.isBusy).toBe(true);
  expect(runtime.state.activeTurn).toBeUndefined();
  expect(busyEvents.at(-1)).toMatchObject({ agentKey: "agent:" + id, busy: true });
  expect(await runtime.command(command, "compact")).toEqual(result);
  expect(requests.filter(value => value.method === "thread/compact/start")).toHaveLength(1);
  for (const next of [{ kind: "new" }, { kind: "fork" }, { kind: "resume", threadId: "saved" }, { kind: "compact" }, { kind: "review", target: { type: "uncommittedChanges" } }]) {
    await expect(runtime.command(next, "next")).rejects.toThrow("Stop Codex");
  }
  expect(requests.filter(value => value.method === "thread/start")).toHaveLength(1);
  const active = turn("compaction", "inProgress");
  connections[0].notification({ method: "turn/started", params: { threadId: "thread-1", turn: active } });
  expect(runtime.isBusy).toBe(true);
  turns.push(turn("compaction"));
  connections[0].notification({ method: "turn/completed", params: { threadId: "thread-1", turn: turns[0] } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(runtime.isBusy).toBe(false);
  expect(busyEvents.at(-1).busy).toBe(false);
  await runtime.command({ kind: "new" }, "next");
  await agents.disposeAll();
`));

test("explicit compaction rejection clears busy state and allows the same request to retry", () => scenario(`
  compactNotifications = false;
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const { CodexRpcError } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/rpc.ts"))});
  requestFailure = { method: "thread/compact/start", error: new CodexRpcError("Cannot compact") };
  await expect(runtime.command({ kind: "compact" }, "compact")).rejects.toThrow("Cannot compact");
  expect(runtime.isBusy).toBe(false);
  expect(runtime.record.commandSubmissions).toHaveLength(0);
  await runtime.command({ kind: "compact" }, "compact");
  expect(runtime.isBusy).toBe(true);
  expect(requests.filter(value => value.method === "thread/compact/start")).toHaveLength(2);
  await agents.disposeAll();
`));

test("new and fork deduplicate concurrent retries and replay saved results after restart", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  for (const kind of ["new", "fork"]) {
    const results = await Promise.all([runtime.command({ kind }, kind), runtime.command({ kind }, kind)]);
    expect(results[0]).toEqual(results[1]);
  }
  expect(requests.filter(value => value.method === "thread/start")).toHaveLength(2);
  expect(requests.filter(value => value.method === "thread/fork")).toHaveLength(1);
  const selected = runtime.record.threadId;
  await agents.disposeAll();
  const restored = createCodexAgents(() => events);
  const reopened = await restored.ready("workspace", id);
  expect(await reopened.command({ kind: "new" }, "new")).toEqual({ kind: "done", message: "New Codex conversation started." });
  expect(await reopened.command({ kind: "fork" }, "fork")).toEqual({ kind: "done", message: "Conversation forked." });
  expect(reopened.record.threadId).toBe(selected);
  expect(requests.filter(value => value.method === "thread/start")).toHaveLength(2);
  expect(requests.filter(value => value.method === "thread/fork")).toHaveLength(1);
  await restored.disposeAll();
`));

test("command request IDs cannot be reused for different payloads or prompts", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  await runtime.command({ kind: "new" }, "shared");
  await expect(runtime.command({ kind: "fork" }, "shared")).rejects.toThrow("different command");
  await expect(runtime.send(input, "shared")).rejects.toThrow("used for a command");
  await runtime.send(input, "prompt");
  await expect(runtime.command({ kind: "new" }, "prompt")).rejects.toThrow("used for a prompt");
  expect(requests.some(value => value.method === "thread/fork")).toBe(false);
  await agents.disposeAll();
`));

test("uncertain command outcomes stay claimed across restart instead of repeating the mutation", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  requestFailure = { method: "thread/fork", error: new Error("Lost reply") };
  await expect(runtime.command({ kind: "fork" }, "fork")).rejects.toThrow("Lost reply");
  await expect(runtime.command({ kind: "fork" }, "fork")).rejects.toThrow("uncertain outcome");
  await agents.disposeAll();
  const restored = createCodexAgents(() => events);
  const reopened = await restored.ready("workspace", id);
  await expect(reopened.command({ kind: "fork" }, "fork")).rejects.toThrow("uncertain outcome");
  expect(requests.filter(value => value.method === "thread/fork")).toHaveLength(1);
  await restored.disposeAll();
`));

test("a failed catalog read after mutation admission does not allow the mutation to repeat", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const { CodexRpcError } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/rpc.ts"))});
  requestFailure = { method: "thread/goal/get", error: new CodexRpcError("Cannot read goal") };
  const command = { kind: "goal", objective: "Finish the task" };
  await expect(runtime.command(command, "goal")).rejects.toThrow("Cannot read goal");
  await expect(runtime.command(command, "goal")).rejects.toThrow("uncertain outcome");
  expect(requests.filter(value => value.method === "thread/goal/set")).toHaveLength(1);
  await agents.disposeAll();
`));

test("catalog mutations replay their results while inspection remains fresh", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  skills = { data: [{ cwd: "/work", skills: [{ name: "example", path: "/work/.agents/skills/example/SKILL.md", enabled: false }], errors: [] }] };
  plugins.marketplaces = [{ name: "curated", path: null, plugins: [{ id: "example@curated", name: "example" }] }];
  appPages = [{ data: [{ id: "example" }], nextCursor: null }];
  const mutations = [
    { kind: "resume", threadId: "saved" },
    { kind: "goal", objective: "Finish the task" },
    { kind: "skills", name: "example", enabled: true },
    { kind: "plugins", action: "install", id: "example@curated" },
    { kind: "apps", id: "example", enabled: true },
  ];
  for (const command of mutations) {
    const result = await runtime.command(command, command.kind);
    expect(await runtime.command(command, command.kind)).toEqual(result);
  }
  for (const method of ["thread/resume", "thread/goal/set", "skills/config/write", "plugin/install", "config/value/write"]) {
    expect(requests.filter(value => value.method === method)).toHaveLength(1);
  }
  expect((await runtime.command({ kind: "goal" }, "inspect")).goal.objective).toBe("Finish the task");
  goal.objective = "A new objective";
  expect((await runtime.command({ kind: "goal" }, "inspect")).goal.objective).toBe("A new objective");
  expect(runtime.record.commandSubmissions).toHaveLength(mutations.length);
  await agents.disposeAll();
`));

test("messages and commands endpoints share durable command admission", () => scenario(`
  const id = await agents.create("workspace");
  const { codexRoutes } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/routes.ts"))});
  const route = codexRoutes(agents);
  const send = async operation => {
    const url = new URL("http://localhost/workspaces/workspace/codex-agents/" + id + "/" + operation);
    return route(new Request(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ text: "/new", requestId: "retry" }) }), url);
  };
  const first = await send("messages");
  const retried = await send("commands");
  expect(first.status).toBe(202);
  expect(retried.status).toBe(202);
  expect((await retried.json()).command).toEqual((await first.json()).command);
  expect(requests.filter(value => value.method === "thread/start")).toHaveLength(2);
  await agents.disposeAll();
`));
