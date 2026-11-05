import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCommandSignal } from "@kintsugi/core";
import { clearLocalTerminalProcesses, localTerminalProcesses, runLocally } from "../../src/server/local-terminal-processes.ts";
import { runTerminalProcess, terminalProcessSession } from "../../src/server/terminal-process.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await clearLocalTerminalProcesses(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

async function place() {
  const directory = await mkdtemp(join(tmpdir(), "local-terminal-processes-"));
  directories.push(directory);
  const tmux = (...args: string[]) => runLocally(join(directory, "tmux"))({ argv: ["tmux", ...args], user: "agent" }, {});
  return { directory, processes: localTerminalProcesses(directory), tmux };
}

test("local terminal processes start a tmux server of their own", async () => {
  const { directory, processes, tmux } = await place();
  const result = await runTerminalProcess(processes, { command: "echo on this machine; exit 3", cwd: directory }, () => {});
  expect(result).toMatchObject({ exitCode: 3, output: { text: "on this machine" } });
  const socket = (await tmux("display-message", "-p", "#{socket_path}")).stdout.toString().trim();
  expect(socket).toStartWith(`${directory}/tmux/`);
});

test("running a terminal process tells its id while it runs, and releases it", async () => {
  const { directory, processes } = await place();
  let running = "";
  const ready = join(directory, "continue");
  // Hold the command until the callback observes it; echo alone can already have exited.
  const result = await runTerminalProcess(processes, { command: `while [ ! -f ${ready} ]; do sleep 0.02; done; echo done`, cwd: directory }, async (id) => {
    running = id;
    expect((await processes.state(id)).state).toBe("running");
    await Bun.write(ready, "");
  });
  expect(result.output.text).toBe("done");
  expect(await processes.state(running)).toEqual({ state: "missing" });
});

test("cancelling a terminal process run kills and releases the process", async () => {
  const { directory, processes } = await place();
  const marker = join(directory, "too-late");
  const cancel = new AbortController();
  let running = "";
  const run = withCommandSignal(cancel.signal, () => runTerminalProcess(processes, { command: `sleep 30; touch ${marker}`, cwd: directory }, (id) => {
    running = id;
    cancel.abort(new Error("Preparation cancelled"));
  }));
  await expect(run).rejects.toThrow("Preparation cancelled");
  expect(await processes.state(running)).toEqual({ state: "missing" });
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("clearing forgets every process and stops those still running", async () => {
  const { directory, processes, tmux } = await place();
  const id = crypto.randomUUID();
  await processes.start({ id, command: "sleep 30", cwd: directory });
  await clearLocalTerminalProcesses(directory);
  expect(await processes.state(id)).toEqual({ state: "missing" });
  expect((await tmux("has-session", "-t", `=${terminalProcessSession(id)}`)).exitCode).not.toBe(0);
});

test("a run already cancelled when it starts the tmux server doesn't break later runs", async () => {
  const { directory, processes } = await place();
  const cancel = new AbortController();
  cancel.abort(new Error("Preparation cancelled"));
  // The very first command, the one that starts the server, runs under a cancelled signal.
  await expect(withCommandSignal(cancel.signal, () => runTerminalProcess(processes, { command: "echo first", cwd: directory }, () => {}))).rejects.toThrow("Preparation cancelled");
  const result = await runTerminalProcess(processes, { command: "echo second", cwd: directory }, () => {});
  expect(result.output.text).toBe("second");
});

test("cancelling a wait for a local process stops waiting promptly, leaving the process running", async () => {
  const { directory, processes } = await place();
  const id = crypto.randomUUID();
  await processes.start({ id, command: "sleep 30", cwd: directory });
  const cancel = new AbortController();
  const waited = withCommandSignal(cancel.signal, () => processes.waitForEnd(id));
  // Cancel only once the wait is blocked in tmux, whose client holds the pipes.
  const waiter = ["pgrep", "-f", `wait-for ${terminalProcessSession(id)}$`];
  while (Bun.spawnSync(waiter).exitCode !== 0) await Bun.sleep(50);
  const cancelled = Date.now();
  cancel.abort(new Error("Run cancelled"));
  await expect(waited).rejects.toThrow("Run cancelled");
  expect(Date.now() - cancelled).toBeLessThan(5_000);
  expect((await processes.state(id)).state).toBe("running");
}, 70_000);
