import { source, type Fixture, type HighlightPath, type Sample } from "./cases.ts";

export interface Measurement {
  path: HighlightPath;
  fixture: Fixture;
  chunkSize: number;
  expectedUpdates: number;
  bun: string;
  platform: string;
  timedOut: boolean;
  exitCode: number;
  samples: Sample[];
  stderr: string;
}

export async function measure(path: HighlightPath, fixture: Fixture, chunkSize = 0, budgetMs = 10_000): Promise<Measurement> {
  const code = source(fixture);
  // child.ts streams decoded content into renderToolCard, not serialized tool JSON.
  const inputLength = code.length;
  const child = Bun.spawn([process.execPath, new URL("./child.ts", import.meta.url).pathname, path, fixture, String(chunkSize)], {
    stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  // This timer lives OUTSIDE the process doing regex work, so it can preempt a stall.
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, budgetMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => clearTimeout(timeout));
  const records = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return {
    path, fixture, chunkSize, expectedUpdates: chunkSize ? Math.ceil(inputLength / chunkSize) : 3,
    bun: Bun.version, platform: `${process.platform}/${process.arch}`,
    timedOut, exitCode, samples: records.filter((record): record is Sample => "step" in record), stderr,
  };
}

export function summary(result: Measurement) {
  return {
    path: result.path, fixture: result.fixture, chunkSize: result.chunkSize,
    bun: result.bun, platform: result.platform, timedOut: result.timedOut,
    completedUpdates: result.samples.length,
    expectedUpdates: result.expectedUpdates,
    totalMs: result.samples.reduce((sum, sample) => sum + sample.elapsedMs, 0),
    maxUpdateMs: Math.max(0, ...result.samples.map((sample) => sample.elapsedMs)),
    highlightCalls: result.samples.reduce((sum, sample) => sum + sample.highlightCalls, 0),
    highlightedCharacters: result.samples.reduce((sum, sample) => sum + sample.highlightedCharacters, 0),
    maxHighlightMs: Math.max(0, ...result.samples.map((sample) => sample.maxHighlightMs)),
    // Full cases distinguish first use from the two repeated calls; streamed cases retain each prefix.
    samples: result.samples,
  };
}
