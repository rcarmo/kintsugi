import {afterEach, expect, test} from "bun:test";
import {unavailableResourceCounter, type ResourceCounter, type ResourceSnapshot} from "@kintsugi/core/resource-metrics";
import {createResourceMeterCollector} from "../src/server/resource-meter-collector.ts";

const stops: (() => void)[] = [];
afterEach(() => {for (const stop of stops.splice(0)) stop();});
function counter(id: string, at = Date.now()): ResourceCounter {return {...unavailableResourceCounter(), identity: id, at, observedAt: at, state: "running", cpuUsec: at * 100, cpus: 1, memory: 1024, memoryLimit: 4096};}
function snapshot(ids: readonly string[]): ResourceSnapshot {return {scope: "system", system: counter("system"), workspaces: Object.fromEntries(ids.map(id => [id, counter(id)]))};}
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}
test("app-owned sampling keeps all workspace histories warm with no viewers and does not overlap probes", async () => {
  const calls: string[][] = [], gate = Promise.withResolvers<ResourceSnapshot>();
  const collector = createResourceMeterCollector({workspaceIds: () => ["a", "a", "b"], intervalMs: 10, onError: error => {throw error;}, load: async ids => {calls.push([...ids]);return calls.length === 1 ? gate.promise : snapshot(ids);}});
  stops.push(collector.stop);collector.start();collector.start();
  expect(calls).toEqual([["a", "b"]]);await Bun.sleep(30);expect(calls).toHaveLength(1);
  gate.resolve(snapshot(["a", "b"]));await until(() => calls.length >= 3);
  expect(collector.read()!.workspaces.get("a")!.points.length).toBeGreaterThan(1);expect(collector.read()!.workspaces.get("b")!.points.length).toBeGreaterThan(1);
  const unwatch = collector.watch(() => {});unwatch();const before = calls.length;await until(() => calls.length > before);
  collector.stop();const stopped = calls.length;await Bun.sleep(35);expect(calls).toHaveLength(stopped);
});
test("stopping aborts probes and stale completions cannot publish into a restarted collector", async () => {
  const signals: AbortSignal[] = [], gates: ReturnType<typeof Promise.withResolvers<ResourceSnapshot>>[] = [];
  let ids = ["old"];
  const collector = createResourceMeterCollector({workspaceIds: () => ids, intervalMs: 30, onError: () => {}, load: async (_ids, signal) => {signals.push(signal);const gate = Promise.withResolvers<ResourceSnapshot>();gates.push(gate);return gate.promise;}});
  stops.push(collector.stop);collector.start();collector.stop();expect(signals[0]!.aborted).toBe(true);
  ids = ["new"];collector.start();gates[0]!.resolve(snapshot(["old"]));await Bun.sleep(10);expect(collector.read()).toBeUndefined();
  gates[1]!.resolve(snapshot(["new"]));await until(() => collector.read() !== undefined);expect([...collector.read()!.workspaces.keys()]).toEqual(["new"]);
  collector.stop();expect(signals).toHaveLength(2);
});
test("all workspaces are sampled in bounded batches, retaining more than 32 live histories", async () => {
  const ids = Array.from({length: 70}, (_, i) => `id-${i}`), calls: string[][] = [];
  const collector = createResourceMeterCollector({workspaceIds: () => ids, intervalMs: 10, onError: error => {throw error;}, load: async batch => {calls.push([...batch]);return snapshot(batch);}});
  stops.push(collector.stop);collector.start();await until(() => calls.length >= 6);collector.stop();
  expect(calls.slice(0, 3).map(batch => batch.length)).toEqual([32, 32, 6]);expect(new Set(calls.slice(0, 3).flat()).size).toBe(70);
  expect(collector.read()!.workspaces.size).toBe(70);expect(collector.read()!.workspaces.get("id-0")!.points.length).toBeGreaterThan(1);
});
test("catalogue changes apply without viewers; failures retry and System is sampled with no workspaces", async () => {
  let ids = ["a"], fail = true;const calls: string[][] = [], errors: Error[] = [];
  const collector = createResourceMeterCollector({workspaceIds: () => ids, intervalMs: 10, onError: error => errors.push(error), load: async batch => {calls.push([...batch]);if (fail) {fail = false;throw Error("fixture unavailable");}return snapshot(batch);}});
  stops.push(collector.stop);collector.start();await until(() => calls.length >= 2);ids = ["b"];await until(() => calls.some(batch => batch[0] === "b"));ids = [];await until(() => calls.some(batch => !batch.length));
  expect(errors).toHaveLength(1);expect(collector.read()!.system.points.some(point => point.reading.memory === 1024)).toBe(true);
});
