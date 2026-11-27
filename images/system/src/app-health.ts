import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const appHealthIntervalMs = 3_000;
const failedProbesToWithdraw = 3;
const failureConfirmationMs = 2 * appHealthIntervalMs;
const diagnosticIntervalMs = 30_000;

export type AppHealthProbe = { elapsedMs: number } & (
  | { kind: "ok" }
  | { kind: "timeout" }
  | { kind: "http"; status: number }
  | { kind: "error"; name: string; code?: string }
);
export type AppHealthState = "inactive" | "ready" | "degraded" | "recovering";

export async function probeAppHealth(url = "http://127.0.0.1:3000/up", timeoutMs = 1_000): Promise<AppHealthProbe> {
  const started = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const response = await fetch(url, { signal, redirect: "manual" });
    await response.body?.cancel();
    return response.ok ? { kind: "ok", elapsedMs: elapsed() } : { kind: "http", status: response.status, elapsedMs: elapsed() };
  } catch (error) {
    if (signal.aborted) return { kind: "timeout", elapsedMs: elapsed() };
    return { kind: "error", elapsedMs: elapsed(), name: error instanceof Error ? error.name : "Unknown error",
      code: error instanceof Error && "code" in error && error.code !== undefined ? String(error.code).slice(0, 64) : undefined };
  }
}

type HealthDiagnostic = { state: AppHealthState; probe: AppHealthProbe; consecutiveFailures: number; failedForMs: number; supervisorTimerLateMs?: number };
interface AppHealthMonitorOptions {
  probe(): Promise<AppHealthProbe>;
  routeToApp(open: boolean): Promise<void>;
  change(state: AppHealthState, previous: AppHealthState): void;
  diagnostic(event: HealthDiagnostic): void;
  stopped(): boolean;
  now?(): number;
}

/** The supervisor serialises these checks with replacement and shutdown. */
export class AppHealthMonitor {
  private current: AppHealthState = "inactive";
  private failures = 0;
  private failedSince?: number;
  private lastDiagnostic = -Infinity;

  constructor(private readonly options: AppHealthMonitorOptions) {}
  get state(): AppHealthState { return this.current; }
  get recovering(): boolean { return this.current === "degraded" || this.current === "recovering"; }

  reset(): void {
    this.current = "inactive";
    this.clearFailures();
    this.lastDiagnostic = -Infinity;
  }
  ready(): void {
    this.clearFailures();
    this.transition("ready");
  }
  private clearFailures(): void {
    this.failures = 0;
    this.failedSince = undefined;
  }
  private transition(state: AppHealthState): void {
    const previous = this.current;
    if (previous === state) return;
    this.current = state;
    this.options.change(state, previous);
  }

  async recheck(supervisorTimerLateMs?: number): Promise<void> {
    if (this.current === "inactive" || this.options.stopped()) return;
    const probe = await this.options.probe();
    if (this.options.stopped()) return;
    const now = this.options.now?.() ?? performance.now();
    const failedForMs = Math.round(now - (this.failedSince ?? now));
    const report = (state: AppHealthState) => {
      this.lastDiagnostic = now;
      this.options.diagnostic({ state, probe, consecutiveFailures: this.failures, failedForMs, supervisorTimerLateMs });
    };
    if (probe.kind === "ok") {
      if (this.current === "recovering") {
        await this.options.routeToApp(true);
        if (this.options.stopped()) return;
        report("ready");
      }
      this.ready();
      return;
    }

    this.failedSince ??= now;
    this.failures++;
    const sustained = this.current === "recovering" || (
      this.failures >= failedProbesToWithdraw && now - this.failedSince >= failureConfirmationMs
    );
    const next = sustained ? "recovering" : "degraded";
    const newlySustained = sustained && this.current !== "recovering";
    this.transition(next);
    if (newlySustained || now - this.lastDiagnostic >= diagnosticIntervalMs) report(next);
    if (sustained) await this.options.routeToApp(false);
  }
}

/** Snapshot the enclosing System cgroup, where app and workspaces share a ceiling. */
export async function healthPressureSample(cgroup: string) {
  const read = (path: string) => readFile(join(cgroup, path), "utf8");
  const [current, limit, events, stat, pressure] = await Promise.all([
    read("memory.current"), read("memory.max"), read("memory.events"), read("memory.stat"),
    read("memory.pressure").catch(error => {
      // Kernels without PSI can still provide the core memory counters.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }),
  ]);
  const counter = (text: string, key: string) => text.split("\n").find(line => line.startsWith(`${key} `))?.split(" ")[1];
  return {
    currentBytes: current.trim(), limitBytes: limit.trim(),
    limitEvents: counter(events, "max"), oomKills: counter(events, "oom_kill"),
    directScans: counter(stat, "pgscan_direct"), fileRefaults: counter(stat, "workingset_refault_file"),
    memoryPressure: pressure?.trim().split("\n").join("; "),
  };
}
