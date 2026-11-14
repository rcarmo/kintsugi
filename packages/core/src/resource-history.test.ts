import { expect, test } from "bun:test";
import { appendResourceHistory, createResourceHistoryStore, resourceHistoryReading, retainResourceHistories, resourceHistorySampleLimit, resourceHistoryWindowMs, resourceMemoryHeadroom, type ResourceHistory } from "./resource-history.ts";
import { resourceReading, unavailableResourceCounter, type ResourceCounter } from "./resource-metrics.ts";

const counter = (changes: Partial<ResourceCounter> = {}): ResourceCounter => ({ identity: "workspace:start", at: 1000, observedAt: changes.at ?? 1000, state: "running", cpuUsec: 1000000, cpus: 2, memory: 1024, memoryLimit: 4096, readBytes: 100, writeBytes: 300, ...changes });

test("resource history is bounded by both observation count and real elapsed time", () => {
  let history: ResourceHistory | undefined;
  for (let i = 0; i < 100; i++) history = appendResourceHistory(history, counter(), undefined, i * 2500);
  expect(history!.points).toHaveLength(resourceHistorySampleLimit);
  expect(history!.points[0]!.at).toBe(100000);
  history = appendResourceHistory(history, counter(), undefined, 1000000);
  expect(history.points).toHaveLength(1);
  expect(history.points[0]!.reading.cpuPercent).toBeNull();
});
test("container changes and non-monotonic observation clocks cannot splice unrelated histories", () => {
  let history = appendResourceHistory(undefined, counter(), undefined, 1000);
  history = appendResourceHistory(history, counter({ identity: "new:start" }), counter(), 2000);
  expect(history.points).toHaveLength(1); expect(history.identity).toBe("new:start");
  expect(history.points[0]!.reading.cpuPercent).toBeNull();
  history = appendResourceHistory(history, counter({ identity: "new:start" }), undefined, 1500);
  expect(history.points).toHaveLength(1); expect(history.points[0]!.at).toBe(1500);
});
test("missing/parked samples preserve a gap, not a fabricated zero or a connection across a restarted workspace", () => {
  let history = appendResourceHistory(undefined, counter(), undefined, 1000);
  history = appendResourceHistory(history, unavailableResourceCounter("stopped"), counter(), 3500);
  expect(history.identity).toBe("workspace:start"); expect(history.points).toHaveLength(2);
  expect(history.points[1]!.reading.memory).toBeNull(); expect(history.points[1]!.reading.readPerSecond).toBeNull();
  history = appendResourceHistory(history, counter({ identity: "workspace:restarted" }), undefined, 6000);
  expect(history.points).toHaveLength(1); expect(history.points[0]!.reading.cpuPercent).toBeNull();
});
test("cached selection histories keep active workspaces, expire idle data and never exceed 32 scopes", () => {
  const history = appendResourceHistory(undefined, counter(), undefined, 1000);
  const cache = new Map(Array.from({ length: 40 }, (_, i) => [`workspace-${i}`, history]));
  const retained = retainResourceHistories(cache, ["workspace-0", "workspace-1"], 2000);
  expect(retained.size).toBe(32); expect(retained.has("workspace-0")).toBe(true); expect(retained.has("workspace-1")).toBe(true);
  expect(retainResourceHistories(retained, [], 2000 + resourceHistoryWindowMs).size).toBe(0);
});
test("RAM headroom is unused cgroup capacity, never negative, and unavailable is not zero", () => {
  expect(resourceMemoryHeadroom(resourceReading(counter()))).toBe(3072);
  expect(resourceMemoryHeadroom(resourceReading(counter({ memory: 8192 })))).toBe(0);
  expect(resourceMemoryHeadroom(resourceReading(counter({ memory: null })))).toBeNull();
  expect(resourceMemoryHeadroom(resourceReading(counter({ memoryLimit: null })))).toBeNull();
});

test("intermittent failures preserve last good values and CPU/I/O baselines instead of causing permanent dashes", () => {
  const store = createResourceHistoryStore();
  store.publish({ scope: "system", system: counter(), workspaces: { a: counter() }, hostMemoryAvailable: 10000 }, ["a"], 1000);
  store.fail(["a"], 3500);
  let state = store.read()!;
  const stale = resourceHistoryReading(state.workspaces.get("a"), state.sampledAt);
  expect(stale.stale).toBe(true); expect(stale.at).toBe(1000); expect(stale.reading.memory).toBe(1024);
  expect(state.hostMemoryAvailable).toBe(10000); expect(state.workspaces.get("a")!.points.at(-1)!.reading.memory).toBeNull();
  const after = counter({ at: 6000, cpuUsec: 2000000, readBytes: 200, writeBytes: 800 });
  store.publish({ scope: "system", system: after, workspaces: { a: after } }, ["a"], 6000);
  state = store.read()!;
  const fresh = resourceHistoryReading(state.workspaces.get("a"), state.sampledAt);
  expect(fresh.stale).toBe(false); expect(fresh.reading.cpuPercent).toBe(10); expect(fresh.reading.readPerSecond).toBe(20); expect(fresh.reading.writePerSecond).toBe(100);
});
test("missing workspace metrics leave System fresh, retain a marked stale workspace, and recover independently", () => {
  const store = createResourceHistoryStore();
  store.publish({ scope: "system", system: counter(), workspaces: { a: counter() } }, ["a"], 1000);
  store.publish({ scope: "system", system: counter({ at: 3500 }), workspaces: { a: unavailableResourceCounter() } }, ["a"], 3500);
  let state = store.read()!;
  expect(resourceHistoryReading(state.system, state.sampledAt).stale).toBe(false);
  expect(resourceHistoryReading(state.workspaces.get("a"), state.sampledAt).stale).toBe(true);
  store.publish({ scope: "system", system: counter({ at: 6000 }), workspaces: { a: counter({ at: 6000, cpuUsec: 2000000 }) } }, ["a"], 6000);
  state = store.read()!;
  expect(resourceHistoryReading(state.workspaces.get("a"), state.sampledAt).reading.cpuPercent).toBe(10);
});
test("pauses retain bounded chart history and marked stale values but never average activity across idle periods", () => {
  const store = createResourceHistoryStore();
  store.publish({ scope: "local", system: counter(), workspaces: { a: counter() } }, ["a"], 1000);
  store.pause();
  expect(resourceHistoryReading(store.read()!.system, store.read()!.sampledAt).stale).toBe(true);
  store.publish({ scope: "local", system: counter({ at: 6000 }), workspaces: { a: counter({ at: 6000 }) } }, ["a"], 6000);
  const state = store.read()!;
  expect(state.system.points).toHaveLength(2); expect(resourceHistoryReading(state.system, state.sampledAt).reading.cpuPercent).toBeNull();
});
test("long outages keep only one last-good observation beyond the bounded chart window; stops never display old usage", () => {
  const store = createResourceHistoryStore();
  store.publish({ scope: "local", system: counter(), workspaces: { a: counter() } }, ["a"], 1000);
  for (let i = 1; i < 100; i++) store.fail(["a"], 1000 + i * 2500);
  let state = store.read()!;
  expect(state.system.points).toHaveLength(60); expect(resourceHistoryReading(state.system, state.sampledAt).at).toBe(1000);
  store.publish({ scope: "local", system: counter({ at: 300000 }), workspaces: { a: unavailableResourceCounter("stopped") } }, ["a"], 300000);
  state = store.read()!;
  expect(resourceHistoryReading(state.workspaces.get("a"), state.sampledAt).reading.memory).toBeNull();
  expect(resourceHistoryReading(state.workspaces.get("a"), state.sampledAt).reading.state).toBe("stopped");
});

test("delayed counters keep uneven observation timestamps and cached results cannot fabricate samples", () => {
  const store = createResourceHistoryStore();
  store.publish({scope: "system", system: counter(), workspaces: {a: counter()}}, ["a"], 2000);
  const later = counter({at: 4100, cpuUsec: 1620000});
  store.publish({scope: "system", system: later, workspaces: {a: later}}, ["a"], 9000);
  store.publish({scope: "system", system: later, workspaces: {a: later}}, ["a"], 10000);
  const history = store.read()!.workspaces.get("a")!;
  expect(history.points.map(point => point.at)).toEqual([1000, 4100]);
  expect(history.points[1]!.reading.cpuPercent).toBe(10);
});
test("late valid observations insert before failure gaps without shifting them to arrival time", () => {
  const store = createResourceHistoryStore();
  store.publish({scope: "system", system: counter(), workspaces: {a: counter()}}, ["a"], 1000);
  store.fail(["a"], 3500);
  const late = counter({at: 2500, cpuUsec: 1300000});
  store.publish({scope: "system", system: late, workspaces: {a: late}}, ["a"], 6000);
  const history = store.read()!.workspaces.get("a")!;
  expect(history.points.map(point => point.at)).toEqual([1000, 2500, 3500]);
  expect(history.points[1]!.reading.cpuPercent).toBe(10);
  expect(history.points[2]!.reading.memory).toBeNull();
  expect(resourceHistoryReading(history, 6000).stale).toBe(true);
  store.publish({scope: "system", system: counter({at: 9000}), workspaces: {a: counter({at: 9000})}}, ["a"], 9100);
  expect(resourceHistoryReading(store.read()!.workspaces.get("a"), 9100).stale).toBe(false);
});
test("separate probe batches retain all active baselines and remove parked baselines", () => {
  const store = createResourceHistoryStore(), active = ["a", "b"];
  store.publish({scope: "system", system: counter(), workspaces: {a: counter()}}, ["a"], 1000, false, active);
  store.publish({scope: "system", system: counter({at: 1100}), workspaces: {b: counter({at: 1100})}}, ["b"], 1100, false, active);
  store.publish({scope: "system", system: counter({at: 3500}), workspaces: {a: counter({at: 3500, cpuUsec: 1500000})}}, ["a"], 3500, false, active);
  expect(store.read()!.workspaces.get("a")!.points.at(-1)!.reading.cpuPercent).toBe(10);
  store.publish({scope: "system", system: counter({at: 4000}), workspaces: {b: counter({at: 4000})}}, ["b"], 4000, false, ["b"]);
  store.publish({scope: "system", system: counter({at: 6000}), workspaces: {a: counter({at: 6000})}}, ["a"], 6000, false, active);
  expect(store.read()!.workspaces.get("a")!.points.at(-1)!.reading.cpuPercent).toBeNull();
});

test("legacy System monotonic clocks use arrival time without fabricating cached observations", () => {
  const store = createResourceHistoryStore(), legacy = counter();delete legacy.observedAt;
  store.publish({scope: "system", system: legacy, workspaces: {a: legacy}}, ["a"], 1700000000000);
  store.publish({scope: "system", system: legacy, workspaces: {a: legacy}}, ["a"], 1700000005000);
  expect(store.read()!.system.points.map(point => point.at)).toEqual([1700000000000]);
  const next = {...legacy, at: 4000, cpuUsec: 1600000};
  store.publish({scope: "system", system: next, workspaces: {a: next}}, ["a"], 1700000005500);
  expect(store.read()!.system.points.map(point => point.at)).toEqual([1700000000000, 1700000005500]);
  expect(store.read()!.system.points.at(-1)!.reading.cpuPercent).toBe(10);
});

test("a System process monotonic-clock restart rebases rates without freezing RAM or history", () => {
  for (const legacy of [false, true]) {
    const store = createResourceHistoryStore();
    for (const [at, observedAt, cpuUsec, memory] of [[10000, 1000, 1000000, 1024], [500, 2000, 1200000, 2048], [2500, 4000, 1600000, 3072]]) {
      const value = counter({at, observedAt, cpuUsec, memory});if (legacy) delete value.observedAt;
      store.publish({scope: "system", system: value, workspaces: {}}, [], observedAt!);
    }
    expect(store.read()!.system.points.map(point => point.reading.memory)).toEqual([1024, 2048, 3072]);
    expect(store.read()!.system.points[1]!.reading.cpuPercent).toBeNull();
    expect(store.read()!.system.points[2]!.reading.cpuPercent).toBe(10);
  }
});
