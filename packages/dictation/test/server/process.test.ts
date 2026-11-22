import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const processModule = new URL("../../src/server/process.ts", import.meta.url).href;

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for transcription process lifecycle");
    await Bun.sleep(20);
  }
}

async function isDead(pid: number): Promise<boolean> {
  try {
    // A reparented zombie has already released its model memory and listener.
    return /^State:\s+Z/m.test(await readFile(`/proc/${pid}/status`, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return true;
    throw error;
  }
}

for (const exit of ["normal", "SIGTERM", "SIGKILL", "stop-child"] as const) {
  test(`transcription child is disposed on ${exit}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "transcription-process-"));
    const ready = join(directory, "ready.json");
    const fixture = join(directory, "parent.ts");
    const argument = "argument with spaces and 'quotes'";
    await Bun.write(fixture, `
      import { spawnTranscriptionProcess } from ${JSON.stringify(processModule)};
      const child = spawnTranscriptionProcess([
        process.execPath, "-e",
        ${JSON.stringify(`
          await Bun.write(${JSON.stringify(ready)}, JSON.stringify({
            pid: process.pid, parent: process.ppid,
            cache: process.env.XDG_CACHE_HOME, args: process.argv.slice(1),
          }));
          setInterval(() => {}, 1000);
        `)}, ${JSON.stringify(argument)},
      ], ${JSON.stringify(directory)});
      const action = await new Response(Bun.stdin.stream()).text();
      if (action === "stop-child") {
        child.kill();
        await child.exited;
        await Bun.write(${JSON.stringify(join(directory, "stopped"))}, "stopped");
        setInterval(() => {}, 1000);
      } else {
        process.exit(0);
      }
    `);
    const parent = Bun.spawn([process.execPath, fixture], {
      stdin: "pipe", stdout: "inherit", stderr: "inherit",
    });
    let childPid: number | undefined;
    try {
      await waitFor(() => Bun.file(ready).exists());
      const details = await Bun.file(ready).json();
      childPid = details.pid;
      expect(details.parent).toBe(parent.pid);
      expect(details.cache).toBe(directory);
      expect(details.args).toEqual([argument]);
      if (exit === "normal" || exit === "stop-child") {
        parent.stdin.write(exit);
        parent.stdin.end();
      } else {
        parent.kill(exit);
      }
      if (exit === "stop-child") {
        await waitFor(() => Bun.file(join(directory, "stopped")).exists());
        expect(parent.exitCode).toBeNull();
      } else {
        await parent.exited;
      }
      await waitFor(() => isDead(details.pid));
      childPid = undefined; // Already verified stopped; do not signal this PID again.
    } finally {
      try {
        parent.kill("SIGKILL");
        await parent.exited;
        if (childPid !== undefined && !await isDead(childPid)) {
          // Failure cleanup still races with a child that is already exiting.
          try { process.kill(childPid, "SIGKILL"); }
          catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 10_000);
}
