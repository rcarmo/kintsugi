import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function scenario(script: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "terminal-lifecycle-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const workspace = await import("@kintsugi/workspace");
      const observable = await import("@kintsugi/observable-terminal/server");
      // tmux sessions others started, and the terminal processes Terminal views start, per workspace.
      const sessions = new Map(), processes = new Map();
      const of = (map, id) => map.get(id) ?? map.set(id, new Set()).get(id);
      let failCreation = false, callbacks;
      mock.module("@kintsugi/workspace", () => ({
        ...workspace,
        execWorkspaceShell: async (id, command) => {
          await Bun.sleep(5);
          const names = of(sessions, id);
          const result = { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
          if (command.includes("list-sessions")) result.stdout = [...names].map(name => [name, 0, 0, "bash"].join("\\u001f")).join("\\n");
          if (command.includes("kill-session")) names.delete(command.match(/kill-session -t '([^']+)'/)[1]);
          return result;
        },
        workspaceTerminalProcesses: (id) => ({
          async start(options) {
            await Bun.sleep(5);
            if (failCreation) { failCreation = false; throw new Error("creation failed"); }
            expect(options.interactive).toBe(true);
            of(processes, id).add(options.id);
          },
          async release(processId) { of(processes, id).delete(processId); },
        }),
      }));
      mock.module(import.meta.resolve("@kintsugi/observable-terminal/server").replace("/index.ts", "/attach.ts"), () => ({ ...observable, attachObservableTerminal: (_options, events) => {
        callbacks = events;
        return { write() {}, resize() {}, close() {} };
      } }));
      const { createWorkspaceTerminal: create, attachWorkspaceTerminal: attach, deleteWorkspaceTerminal: remove, listWorkspaceTerminals: list } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/workspace-terminals.ts"))});
      ${script}
    `], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, KINTSUGI_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("concurrent terminal creation starts one process each and retains every record", () => scenario(`
  const created = await Promise.all(Array.from({ length: 8 }, () => create("one")));
  expect(new Set(created.map(t => t.title)).size).toBe(8);
  expect(created.map(t => t.tmuxSession)).toEqual(created.map(t => observable.terminalProcessSession(t.id)));
  expect(await list("one")).toEqual(created);
  expect([...processes.get("one")].sort()).toEqual(created.map(t => t.id).sort());
`));

test("create, attach and delete serialize together and recover after rejected operations", () => scenario(`
  const original = await create("one");
  of(sessions, "one").add("external");
  const [, attached, created] = await Promise.all([remove("one", original.id), attach("one", "external"), create("one")]);
  expect(await list("one")).toEqual([attached, created]);
  expect(processes.get("one").has(original.id)).toBe(false);
  await remove("one", attached.id);
  expect(sessions.get("one").has("external")).toBe(true);
  failCreation = true;
  const [failed, recovered] = await Promise.allSettled([create("one"), create("one")]);
  expect(failed.status).toBe("rejected");
  expect(recovered.status).toBe("fulfilled");
  expect(await list("one")).toHaveLength(2);
`));

test("an attached terminal's socket sends final diagnostics before closing", () => scenario(`
  of(sessions, "one").add("external");
  const terminal = await attach("one", "external");
  const { createTerminalSocketHandler } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/sockets.ts"))});
  const handler = createTerminalSocketHandler();
  const { terminalViewKey } = await import(${JSON.stringify(join(import.meta.dir, "../../src/shared.ts"))});
  const connection = await handler(new URL("http://localhost/workspaces/one/views/" + encodeURIComponent(terminalViewKey(terminal.id)) + "/ws"));
  const events = [];
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  await connection.open({ send: chunk => events.push(new TextDecoder().decode(chunk)), close: () => {
    events.push("closed");
    resolveClosed();
  } });
  callbacks.onData(new TextEncoder().encode("can't find session"));
  callbacks.onExit(1);
  await closed;
  expect(events).toEqual(["can't find session", "closed"]);
`));

test("existing terminal metadata keeps its flat format, IDs and session ownership", () => scenario(`
  const existing = { id: "saved-id", title: "Saved terminal", tmuxSession: "existing-session", sessionRelationship: "attached" };
  // Started by a Terminal view before terminal processes, so closing it kills its session.
  const owned = { id: "owned-id", title: "Terminal 1", tmuxSession: "Terminal 1", sessionRelationship: "owned" };
  of(sessions, "legacy").add("existing-session").add("Terminal 1");
  const path = process.env.KINTSUGI_DATA_DIR + "/workspaces/legacy/metadata/terminals.json";
  await Bun.write(path, JSON.stringify([existing, owned]));
  expect(await list("legacy")).toEqual([existing, owned]);
  const created = await create("legacy");
  expect(await Bun.file(path).json()).toEqual([existing, owned, created]);
  await remove("legacy", existing.id);
  await remove("legacy", owned.id);
  expect(await Bun.file(path).json()).toEqual([created]);
  expect([...sessions.get("legacy")]).toEqual(["existing-session"]);
`));

test("invalid terminal cwd is rejected before workspace operations", () => scenario(`
  for (const cwd of ["/tmp/qa-run", "/work-other", "relative/path"]) {
    await expect(create("one", { title: "QA terminal", cwd, command: "pwd" })).rejects.toMatchObject({
      code: "terminal_invalid_cwd",
      message: "terminal cwd must be under /work: " + cwd,
    });
  }
  expect(processes.size).toBe(0);
  expect(await list("one")).toEqual([]);
  for (const cwd of [undefined, "", "  ", "/work", "/work/project"]) {
    await create("one", { cwd });
  }
  expect(await list("one")).toHaveLength(5);
`));
