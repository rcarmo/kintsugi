import { resourceReading, unavailableResourceCounter, type ResourceCounter, type ResourceReading, type ResourceSnapshot } from "./resource-metrics.ts";

export const resourceHistoryWindowMs = 150_000;
export const resourceHistorySampleLimit = 60;
export const resourceHistoryScopeLimit = 32;
export interface ResourceHistoryPoint { at: number; reading: ResourceReading }
export interface ResourceHistory { identity: string; points: readonly ResourceHistoryPoint[]; lastGood?: ResourceHistoryPoint }
export interface ResourceHistoryReading { reading: ResourceReading; at?: number; stale: boolean }
function hasReading(reading: ResourceReading): boolean {
  return reading.state === "running" && [reading.memory, reading.cpuPercent, reading.readPerSecond, reading.writePerSecond].some(value => value !== null);
}
export function resourceHistoryReading(history: ResourceHistory | undefined, at: number | undefined): ResourceHistoryReading {
  const latest = history?.points.at(-1);
  if (latest && at !== undefined && latest.at <= at && at - latest.at <= 7500 && (hasReading(latest.reading) || latest.reading.state === "stopped")) return { ...latest, stale: false };
  if (latest?.reading.state === "stopped") return { ...latest, stale: at !== latest.at };
  if (history?.lastGood) return { ...history.lastGood, stale: true };
  return { reading: resourceReading(unavailableResourceCounter()), stale: false };
}

/** Bounded, clock-ordered observations. Never interpolate missing measurements or mix containers. */
export function appendResourceHistory(history: ResourceHistory | undefined, counter: ResourceCounter, before: ResourceCounter | undefined, at: number): ResourceHistory {
  const identity = counter.state === "running" ? counter.identity : history?.identity ?? counter.identity;
  const ordered = history?.identity === identity && (history.points.at(-1)?.at ?? -Infinity) < at;
  const points = ordered ? history.points.filter(point => point.at >= at - resourceHistoryWindowMs) : [];
  const point = { at, reading: resourceReading(counter, before) };
  const lastGood = hasReading(point.reading) ? point : ordered ? history?.lastGood : undefined;
  return { identity, points: [...points, point].slice(-resourceHistorySampleLimit), lastGood };
}

/** Retain recent inactive selections without keeping unbounded per-workspace caches. Active scopes win. */
export function retainResourceHistories(histories: ReadonlyMap<string, ResourceHistory>, active: readonly string[], at: number): Map<string, ResourceHistory> {
  const selected = new Set(active);
  const recent = [...histories].filter(([, history]) => (history.points.at(-1)?.at ?? -Infinity) >= at - resourceHistoryWindowMs);
  const inactive = recent.filter(([id]) => !selected.has(id));
  const current = recent.filter(([id]) => selected.has(id));
  return new Map([...inactive.slice(-Math.max(0, resourceHistoryScopeLimit - current.length)), ...current].slice(-Math.max(resourceHistoryScopeLimit, current.length)));
}

export function resourceMemoryHeadroom(reading: ResourceReading): number | null {
  return reading.memory === null || reading.memoryLimit === null ? null : Math.max(0, reading.memoryLimit - reading.memory);
}

export interface ResourceHistorySnapshot {
  scope: ResourceSnapshot["scope"];
  system: ResourceHistory;
  workspaces: ReadonlyMap<string, ResourceHistory>;
  hostMemoryAvailable: number | null;
  sampledAt?: number;
  failed: boolean;
}
function repeatedCounter(counter: ResourceCounter, before: ResourceCounter | undefined): boolean {
  return before?.identity === counter.identity && (counter.at === before.at || counter.at < before.at && counter.observedAt !== undefined && before.observedAt !== undefined && counter.observedAt <= before.observedAt);
}
// Delayed probe results retain their observation time; cached/older counters never fabricate new samples.
function observe(history: ResourceHistory | undefined, counter: ResourceCounter, before: ResourceCounter | undefined, receivedAt: number): ResourceHistory {
  // Rate counters use a process-local monotonic clock. Older System versions omit wall-clock observation time.
  const at = counter.state === "running" ? counter.observedAt ?? receivedAt : receivedAt;
  if (counter.state === "running" && history?.identity === counter.identity && repeatedCounter(counter, before)) return history;
  if (counter.state === "running" && history?.identity === counter.identity && (history.points.at(-1)?.at ?? -Infinity) >= at) {
    // A late successful probe can predate a failure marker. Insert at observation time, leaving the gap intact.
    const point = {at, reading: resourceReading(counter, before)};
    const points = [...history.points.filter(value => value.at !== at), point].filter(value => value.at >= receivedAt - resourceHistoryWindowMs).sort((a, b) => a.at - b.at).slice(-resourceHistorySampleLimit);
    return {...history, points, lastGood: hasReading(point.reading) ? point : history.lastGood};
  }
  return appendResourceHistory(history, counter, before, at);
}
/** Keep successful counter baselines through probe failures, but never across pauses or stops. */
export function createResourceHistoryStore() {
  let state: ResourceHistorySnapshot | undefined;
  let systemBefore: ResourceCounter | undefined;
  let workspacesBefore = new Map<string, ResourceCounter>();
  function publish(snapshot: ResourceSnapshot, ids: readonly string[], at: number, failed = false, active: readonly string[] = ids): void {
    if (ids.length > resourceHistoryScopeLimit) throw new Error("Too many resource history scopes");
    const histories = new Map(state?.workspaces);
    const activeIds = new Set(active);
    const next = new Map([...workspacesBefore].filter(([id]) => activeIds.has(id)));
    for (const id of ids) {
      const counter = snapshot.workspaces[id] ?? unavailableResourceCounter();
      const before = workspacesBefore.get(id);
      histories.set(id, observe(histories.get(id), counter, before, at));
      if (counter.state === "running" && !repeatedCounter(counter, before)) next.set(id, counter);
      else if (counter.state === "stopped") next.delete(id);
    }
    state = { scope: snapshot.scope, sampledAt: failed ? undefined : at, failed,
      system: observe(state?.system, snapshot.system, systemBefore, at),
      workspaces: retainResourceHistories(histories, active, at),
      hostMemoryAvailable: failed ? state?.hostMemoryAvailable ?? null : snapshot.hostMemoryAvailable ?? null,
    };
    if (snapshot.system.state === "running" && !repeatedCounter(snapshot.system, systemBefore)) systemBefore = snapshot.system;
    else if (snapshot.system.state === "stopped") systemBefore = undefined;
    workspacesBefore = next;
  }
  return {
    read(): ResourceHistorySnapshot | undefined { return state; },
    publish,
    fail(ids: readonly string[], at: number, active: readonly string[] = ids): void {
      publish({ scope: state?.scope ?? "system", system: unavailableResourceCounter(), workspaces: {} }, ids, at, true, active);
    },
    pause(): void {
      if (state) state = { ...state, sampledAt: undefined };
      systemBefore = undefined; workspacesBefore.clear();
    },
  };
}
