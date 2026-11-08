#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const root = resolve(import.meta.dir, "..");
const { values, positionals } = parseArgs({
  args: process.argv.slice(2), allowPositionals: true,
  options: {
    "batch-size": { type: "string", default: "1" },
    suite: { type: "string", default: "all" },
    from: { type: "string", default: "1" },
    to: { type: "string" },
    out: { type: "string" },
    list: { type: "boolean", default: false },
  },
});
function positiveInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}
const size = positiveInteger("batch-size", values["batch-size"]!);
const suite = Value.Parse(Type.Union([Type.Literal("all"), Type.Literal("main"), Type.Literal("native")]), values.suite);
const discovered = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard"], { cwd: root });
if (discovered.exitCode !== 0) throw new Error(discovered.stderr.toString());
const files = [...new Set(discovered.stdout.toString().trim().split("\n"))].filter(path => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)).sort();
// These fixtures require native processes/browser dependencies and run as the
// unprivileged owner in CI. Keep every file, with one fresh process per chunk.
const native = [
  "apps/web/test/kintsugi-recording.test.ts",
  "packages/observable-terminal/test/server/terminal-process.helper.test.ts",
  "packages/workspace-helper/test/authentication.helper.test.ts",
  "packages/workspace-helper/test/files.helper.test.ts",
  "packages/builtin-agent/test/server/durable-workspace-files.helper.test.ts",
  "packages/builtin-agent/test/server/durable-workspace-files-abort.helper.test.ts",
];
if (!native.every(path => files.includes(path))) throw new Error("Native suite must name existing test files");
const requested = positionals.map(path => relative(root, resolve(root, path)).replaceAll("\\", "/"));
for (const path of requested) if (!files.some(file => file === path || file.startsWith(`${path}/`))) throw new Error(`No test files found at ${path}`);
const selected = (path: string): boolean => !requested.length || requested.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
const regular = files.filter(path => !path.endsWith(".helper.test.ts") && !native.includes(path) && selected(path));
const groups: Array<{ index: number; kind: "main" | "native"; files: string[] }> = [];
for (let offset = 0; suite !== "native" && offset < regular.length; offset += size) groups.push({ index: groups.length + 1, kind: "main", files: regular.slice(offset, offset + size) });
// Native helper fixtures run alone, using exactly the existing native-suite list.
for (const path of suite === "main" ? [] : native.filter(selected)) groups.push({ index: groups.length + 1, kind: "native", files: [path] });
const from = positiveInteger("from", values.from!);
const to = values.to ? positiveInteger("to", values.to) : groups.length;
if (!groups.length || from > to || to > groups.length) throw new Error(`Invalid batch range; available batches: 1–${groups.length}`);
const chosen = groups.filter(group => group.index >= from && group.index <= to);
if (values.list) {
  console.log(JSON.stringify({ batches: groups.length, selected: chosen }, null, 2));
  process.exit(0);
}

const out = resolve(root, values.out ?? `artifacts/test-batches-${Date.now()}`);
await mkdir(out, { recursive: true });
const original = await Bun.file(join(root, "bunfig.toml")).text();
const preloads = 'preload = ["./scripts/test-lint-preload.ts", "./scripts/test-data-dir-preload.ts"]';
if (!original.includes(preloads)) throw new Error("Test preloads changed; review them before creating the bounded test configuration");
const temporary = await mkdtemp(join(tmpdir(), "kintsugi-test-batches-"));
const config = join(temporary, "bunfig.toml");
// Lint once, before tests—not concurrently in every test process. Retain data and
// namespace isolation, and preserve every other setting from the repository config.
await Bun.write(config, original.replace(preloads, `preload = [${JSON.stringify(join(root, "scripts/test-data-dir-preload.ts"))}]`));
interface RunResult { label: string; files: string[]; exitCode: number; elapsedMs: number; maxRssBytes: number | null; pass: number; skip: number; fail: number; log: string }
const results: RunResult[] = [];
const report = () => {
  const passed = results.filter(result => result.files.length).length === chosen.length && results.every(result => result.exitCode === 0);
  return Bun.write(join(out, "summary.json"), JSON.stringify({ passed, fullSuite: passed && suite === "all" && !requested.length && from === 1 && to === groups.length, suite, requested, batchSize: size, availableBatches: groups.length, selected: chosen, results }, null, 2) + "\n");
};
async function run(label: string, argv: string[], paths: string[] = []): Promise<void> {
  const log = join(out, `${label}.log`);
  await Bun.write(log, "");
  const writer = Bun.file(log).writer();
  const started = Date.now();
  console.log(`\n[test-batches] ${label}${paths.length ? `: ${paths.length} file(s)` : ""}`);
  const child = Bun.spawn(argv, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GOMAXPROCS: "1" } });
  const copy = async (stream: ReadableStream<Uint8Array>, output: NodeJS.WriteStream) => {
    for await (const chunk of stream) { writer.write(chunk); output.write(chunk); }
  };
  const [exitCode] = await Promise.all([child.exited, copy(child.stdout, process.stdout), copy(child.stderr, process.stderr)]);
  await writer.end();
  const text = (await Bun.file(log).text()).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const count = (kind: string): number => Number([...text.matchAll(new RegExp(`^\\s+(\\d+) ${kind}$`, "gm"))].at(-1)?.[1] ?? 0);
  // A successful process exit without a test summary is not evidence of a run.
  const missingTests = paths.length > 0 && !/^Ran \d+ tests? across \d+ files?/m.test(text);
  const verifiedExitCode = exitCode === 0 && (missingTests || (paths.length > 0 && count("fail") > 0)) ? 1 : exitCode;
  const result = { label, files: paths, exitCode: verifiedExitCode, elapsedMs: Date.now() - started, maxRssBytes: child.resourceUsage()?.maxRSS ?? null, pass: count("pass"), skip: count("skip"), fail: count("fail"), log };
  results.push(result);
  await report();
  console.log(`[test-batches] ${label}: exit ${verifiedExitCode}; peak subprocess RSS ${result.maxRssBytes === null ? "unavailable" : `${Math.ceil(result.maxRssBytes / 1024 / 1024)} MiB`}`);
  if (missingTests) console.error("Bun did not report test execution; refusing to count this batch as passed.");
  if (verifiedExitCode !== 0) throw new Error(`${label} failed; retained log: ${log}`);
}
try {
  await run("generate", [process.execPath, "--smol", "run", "generate:workspace-modules"]);
  await run("lint", [join(root, "node_modules/.bin/oxlint"), ".", "--threads=1"]);
  for (const group of chosen) await run(`batch-${group.index}`, [process.execPath, "test", "--smol", `--config=${config}`, ...group.files.map(path => resolve(root, path))], group.files);
  console.log(`\n[test-batches] PASS: ${chosen.length} batches; report ${join(out, "summary.json")}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
