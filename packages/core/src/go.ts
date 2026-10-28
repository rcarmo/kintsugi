/** Runs the local Go toolchain. Imports nothing, so scripts can load it from a bare checkout. */
async function go(args: string[], directory: string, env: Record<string, string> = {}): Promise<void> {
  const run = Bun.spawn(["go", ...args], { cwd: directory, env: { ...process.env, ...env, GOTOOLCHAIN: "go1.27.3" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  if (exitCode !== 0) throw new Error(`go ${args[0]} failed in ${directory}:\n${stdout}${stderr}`);
}

/** Builds a static Linux binary. Always run it: Go's build cache makes an unchanged build take about 0.1 s. */
export function buildGoProgram(directory: string, output: string, platform: string): Promise<void> {
  const [os, arch] = platform.split("/");
  return go(["build", "-trimpath", "-ldflags=-s -w", "-o", output, "."], directory, { CGO_ENABLED: "0", GOOS: os!, GOARCH: arch! });
}

/** Runs a Go module's tests, for `bun test`. */
export function runGoTests(directory: string): Promise<void> {
  return go(["test", "./..."], directory);
}
