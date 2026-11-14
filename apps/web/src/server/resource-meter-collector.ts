import {createResourceHistoryStore, resourceHistoryScopeLimit} from "@kintsugi/core/resource-history";
import type {inspectResourceCounters} from "@kintsugi/workspace";

export const resourceMeterIntervalMs = 2500;
/** App-owned collection. Viewers only read history; they never control probes or baselines. */
export function createResourceMeterCollector(options: {
  load: typeof inspectResourceCounters;
  workspaceIds(): readonly string[];
  onError(error: Error): void;
  intervalMs?: number;
}) {
  const history = createResourceHistoryStore(), listeners = new Set<() => void>();
  let started = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, collecting: AbortController | undefined;
  async function tick(epoch: number): Promise<void> {
    const ids = [...new Set(options.workspaceIds())];
    // Keep the wire/probe batch bounded without excluding installations with over 32 workspaces.
    const batches = ids.length ? Array.from({length: Math.ceil(ids.length / resourceHistoryScopeLimit)}, (_, index) => ids.slice(index * resourceHistoryScopeLimit, (index + 1) * resourceHistoryScopeLimit)) : [[]];
    for (const batch of batches) {
      if (!started || epoch !== generation) return;
      const abort = collecting = new AbortController(), timeout = setTimeout(() => abort.abort(), 4000);
      try {
        const snapshot = await options.load(batch, abort.signal);
        if (!started || epoch !== generation) return;
        abort.signal.throwIfAborted();
        history.publish(snapshot, batch, Date.now(), false, ids);
      } catch (error) {
        if (!started || epoch !== generation) return;
        options.onError(error instanceof Error ? error : new Error(String(error)));
        history.fail(batch, Date.now(), ids);
      } finally {
        clearTimeout(timeout);
        if (collecting === abort) collecting = undefined;
      }
      for (const changed of listeners) changed();
    }
    if (started && epoch === generation) {
      timer = setTimeout(() => {timer = undefined; void tick(epoch);}, options.intervalMs ?? resourceMeterIntervalMs);
      timer.unref();
    }
  }
  return {
    read: history.read,
    watch(changed: () => void) {listeners.add(changed); return () => {listeners.delete(changed);};},
    start(): void {if (started) return; started = true; void tick(++generation);},
    stop(): void {
      started = false; generation++;
      clearTimeout(timer); timer = undefined;
      collecting?.abort(); collecting = undefined;
      history.pause();
    },
  };
}
