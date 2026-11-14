import { unavailableResourceCounter, type ResourceCounter } from "./resource-metrics.ts";

type WorkspaceCounters = Record<string, ResourceCounter>;
/** Slow Docker metadata must not hold System readings hostage or trigger overlapping probes. */
export function createWorkspaceCounterProbe(load: (ids: readonly string[], signal: AbortSignal) => Promise<WorkspaceCounters>, options: {
  onError(error: Error): void;
  waitMs?: number;
  timeoutMs?: number;
}) {
  let pending: Promise<WorkspaceCounters> | undefined;
  let completed: WorkspaceCounters | undefined;
  let controller: AbortController | undefined;
  const unavailable = (ids: readonly string[]): WorkspaceCounters => Object.fromEntries(ids.map(id => [id, unavailableResourceCounter()]));
  const pick = (values: WorkspaceCounters, ids: readonly string[]): WorkspaceCounters => Object.fromEntries(ids.map(id => [id, values[id] ?? unavailableResourceCounter()]));
  return {
    async read(ids: readonly string[], signal?: AbortSignal): Promise<WorkspaceCounters> {
      signal?.throwIfAborted();
      if (!ids.length) return {};
      if (completed && ids.every(id => Object.hasOwn(completed!, id))) {
        const result = pick(completed, ids); completed = undefined; return result;
      }
      completed = undefined;
      if (!pending) {
        const abort = controller = new AbortController();
        const timeout = setTimeout(() => abort.abort(new Error("Workspace resource probe timed out")), options.timeoutMs ?? 10_000);
        pending = Promise.resolve().then(async () => {
          try {
            const result = await load(ids, abort.signal);
            abort.signal.throwIfAborted();
            completed = result;
            return result;
          } catch (error) {
            options.onError(error instanceof Error ? error : new Error(String(error)));
            return unavailable(ids);
          } finally {
            clearTimeout(timeout); pending = undefined;
            if (controller === abort) controller = undefined;
          }
        });
      }
      const waiting = pending;
      const fallback = Promise.withResolvers<WorkspaceCounters>();
      const timer = setTimeout(() => fallback.resolve(unavailable(ids)), options.waitMs ?? 1500);
      const aborted = () => fallback.reject(signal?.reason ?? new Error("Resource probe cancelled"));
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        const result = await Promise.race([waiting, fallback.promise]);
        if (completed === result) completed = undefined;
        return pick(result, ids);
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", aborted); }
    },
    cancel(): void { completed = undefined; controller?.abort(new Error("Resource probe cancelled")); },
  };
}
