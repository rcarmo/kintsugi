import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "@kintsugi/core";
import { createTerminalProcesses } from "../../src/server/terminal-process.ts";

test("stop publishes a complete not-run exit marker to concurrent readers", async () => {
  const root = await mkdtemp(join(tmpdir(), "terminal-exit-publication-"));
  const publishing = join(root, "publishing");
  const resume = join(root, "resume");
  const ready = Promise.withResolvers<void>();
  const watcher = watch(root, (_event, file) => { if (file === "publishing") ready.resolve(); });
  // Hold printf after the shell has opened its output redirection, before it writes.
  const pause = String.raw`printf() {
    if [ "$1" = 'none\n' ]; then
      : > ${shellQuote(publishing)}
      while [ ! -f ${shellQuote(resume)} ]; do sleep 0.01; done
    fi
    command printf "$@"
  }
`;
  let stopping: Promise<void> | undefined;
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    // This scenario never starts a session and must not consult the user's tmux server.
    await writeFile(join(bin, "tmux"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const processes = createTerminalProcesses({
      root,
      start() { throw new Error("No process should start"); },
      async run(start) {
        const [shell, flag, script, ...args] = start.argv;
        const child = Bun.spawn([shell!, flag!, pause + script!, ...args], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
        return { exitCode, stdout: Buffer.from(stdout), stderr };
      },
    });
    stopping = processes.stop("never-started");
    await ready.promise;
    try {
      const duringPublication = processes.state("never-started");
      expect(await Bun.file(join(root, "never-started", "exit")).exists()).toBe(false);
      await writeFile(resume, "");
      expect(await duringPublication).toMatchObject({ state: "exited", exitCode: null, aborted: true, timedOut: false });
    } finally {
      await writeFile(resume, "");
      await stopping;
    }
    expect(await processes.state("never-started")).toMatchObject({ state: "exited", exitCode: null, aborted: true, timedOut: false });
  } finally {
    watcher.close();
    await writeFile(resume, "");
    await stopping;
    await rm(root, { recursive: true, force: true });
  }
});

test("release cannot remove an exit snapshot while state is reading it", async () => {
  const root = await mkdtemp(join(tmpdir(), "terminal-exit-release-"));
  const dir = join(root, "completed");
  const resume = join(root, "resume");
  const reading = Promise.withResolvers<void>();
  const releasing = Promise.withResolvers<void>();
  const watcher = watch(root, (_event, file) => {
    if (file === "reading") reading.resolve();
    if (file === "releasing") releasing.resolve();
  });
  let state: ReturnType<ReturnType<typeof createTerminalProcesses>["state"]> | undefined;
  let release: Promise<void> | undefined;
  try {
    await mkdir(dir);
    await writeFile(join(dir, "exit"), "0\n");
    await writeFile(join(dir, "output"), "complete output\n");
    const bin = join(root, "bin"); await mkdir(bin);
    await writeFile(join(bin, "tmux"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const hooks = `cat() {
      if [ "$1" = ${shellQuote(join(dir, "exit"))} ]; then
        : > ${shellQuote(join(root, "reading"))}
        while [ ! -f ${shellQuote(resume)} ]; do sleep 0.01; done
      fi
      command cat "$@"
    }
    flock() {
      if [ "$1" = 9 ]; then : > ${shellQuote(join(root, "releasing"))}; fi
      command flock "$@"
    }
`;
    const processes = createTerminalProcesses({
      root,
      start() { throw new Error("No process should start"); },
      async run(start) {
        const [shell, flag, script, ...args] = start.argv;
        const child = Bun.spawn([shell!, flag!, hooks + script!, ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
        return { exitCode, stdout: Buffer.from(stdout), stderr };
      },
    });
    state = processes.state("completed"); await reading.promise;
    release = processes.release("completed"); await releasing.promise;
    expect(await Bun.file(join(dir, "exit")).exists()).toBe(true);
    await writeFile(resume, "");
    expect(await state).toMatchObject({ state: "exited", exitCode: 0, output: { text: "complete output" } });
    await release;
    expect(await processes.state("completed")).toEqual({ state: "missing" });
  } finally {
    watcher.close(); await writeFile(resume, ""); await state; await release;
    await rm(root, { recursive: true, force: true });
  }
});
