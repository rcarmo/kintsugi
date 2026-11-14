import { expect, test } from "bun:test";
import { unavailableResourceCounter, type ResourceSnapshot } from "@kintsugi/core/resource-metrics";
import { createResourceMeters } from "../src/server/resource-meters.ts";

const snapshot = (): ResourceSnapshot => ({ scope: "system", system: unavailableResourceCounter(), workspaces: {} });
const workspace = (id: string) => ({ id, title: id, parked: false });
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

test("meter subscriptions share one collection clock, deduplicate selections and stop when the last viewer leaves", async () => {
  const calls: string[][] = [], errors: Error[] = [];
  const gate = Promise.withResolvers<ResourceSnapshot>();
  const meters = createResourceMeters({ workspace, intervalMs: 15, onError: error => errors.push(error), load: async ids => {
    calls.push([...ids]);
    return calls.length === 1 ? gate.promise : snapshot();
  } });
  const first = meters.subscribe("a", () => {}), second = meters.subscribe("a", () => {}), third = meters.subscribe("b", () => {});
  expect(calls).toEqual([["a"]]);
  await Bun.sleep(35); expect(calls).toHaveLength(1);
  gate.resolve(snapshot());
  await until(() => calls.length >= 2);
  expect(calls[1]).toEqual(["a", "b"]);
  first.unsubscribe(); second.unsubscribe();
  await until(() => calls.some(ids => ids.length === 1 && ids[0] === "b"));
  third.unsubscribe(); third.unsubscribe();
  const stopped = calls.length; await Bun.sleep(45);
  expect(calls).toHaveLength(stopped); expect(errors).toEqual([]);
});

test("disconnect aborts pending probes and fences stale completions from a newly subscribed view", async () => {
  const signals: AbortSignal[] = [], gates: ReturnType<typeof Promise.withResolvers<ResourceSnapshot>>[] = [];
  const meters = createResourceMeters({ workspace, intervalMs: 15, onError: () => {}, load: async (_ids, signal) => {
    signals.push(signal); const gate = Promise.withResolvers<ResourceSnapshot>(); gates.push(gate); return gate.promise;
  } });
  const first = meters.subscribe("old", () => {}); first.unsubscribe();
  expect(signals[0]!.aborted).toBe(true);
  const next = meters.subscribe("new", () => {});
  gates[0]!.resolve(snapshot()); await Bun.sleep(30);
  expect(signals).toHaveLength(2); expect(signals[1]!.aborted).toBe(false);
  next.unsubscribe(); gates[1]!.resolve(snapshot());
  await Bun.sleep(30); expect(signals).toHaveLength(2);
});

test("failed probes retry on the shared clock and workspace selection is bounded to 32 IDs", async () => {
  const calls: string[][] = [], errors: Error[] = [];
  const meters = createResourceMeters({ workspace, intervalMs: 15, onError: error => errors.push(error), load: async ids => {
    calls.push([...ids]); if (calls.length === 1) throw new Error("fixture probe failed"); return snapshot();
  } });
  const subscriptions = Array.from({ length: 40 }, (_, index) => meters.subscribe(`id-${index}`, () => {}));
  await until(() => calls.length >= 2);
  subscriptions.forEach(subscription => subscription.unsubscribe());
  expect(errors).toHaveLength(1); expect(calls[1]).toHaveLength(32);
});
