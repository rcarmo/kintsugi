import { expect, test } from "bun:test";
import { createWorkspaceCounterProbe } from "./resource-probe.ts";
import { unavailableResourceCounter, type ResourceCounter } from "./resource-metrics.ts";

const result = () => ({ a: { ...unavailableResourceCounter(), identity: "a", state: "running", memory: 1000 } satisfies ResourceCounter });
test("slow workspace probes return promptly, run once and deliver their late result on the next poll", async () => {
  let calls = 0;
  const gate = Promise.withResolvers<Record<string, ResourceCounter>>();
  const probe = createWorkspaceCounterProbe(async () => { calls++; return calls === 1 ? gate.promise : result(); }, { waitMs: 5, onError: () => {} });
  const [first, other] = await Promise.all([probe.read(["a"]), probe.read(["a"])]);
  expect(calls).toBe(1); expect(first.a!.state).toBe("unavailable"); expect(other.a!.state).toBe("unavailable");
  gate.resolve(result()); await Bun.sleep(0);
  expect((await probe.read(["a"])).a!.memory).toBe(1000); expect(calls).toBe(1);
  expect((await probe.read(["a"])).a!.memory).toBe(1000); expect(calls).toBe(2);
  probe.cancel();
});
test("workspace selection cannot receive another selection's counters from a shared pending probe", async () => {
  const gate = Promise.withResolvers<Record<string, ResourceCounter>>();
  const probe = createWorkspaceCounterProbe(async () => gate.promise, { waitMs: 5, onError: () => {} });
  const first = probe.read(["a"]), second = probe.read(["b"]);
  gate.resolve(result());
  expect(Object.keys(await first)).toEqual(["a"]);
  const next = await second; expect(Object.keys(next)).toEqual(["b"]); expect(next.b!.state).toBe("unavailable");
  probe.cancel();
});
test("bounded probe deadlines cancel the loader, release its slot and permit recovery", async () => {
  const errors: Error[] = []; let calls = 0;
  const probe = createWorkspaceCounterProbe(async (_ids, signal) => {
    if (++calls > 1) return result();
    return new Promise<Record<string, ResourceCounter>>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, { waitMs: 5, timeoutMs: 20, onError: error => errors.push(error) });
  expect((await probe.read(["a"])).a!.state).toBe("unavailable");
  await Bun.sleep(30); expect(errors).toHaveLength(1);
  expect((await probe.read(["a"])).a!.memory).toBe(1000); expect(calls).toBe(2);
  probe.cancel();
});
test("synchronous loader failures do not wedge future probes", async () => {
  let calls = 0;
  const probe = createWorkspaceCounterProbe(() => { if (++calls === 1) throw new Error("fixture"); return Promise.resolve(result()); }, { onError: () => {} });
  expect((await probe.read(["a"])).a!.state).toBe("unavailable");
  expect((await probe.read(["a"])).a!.memory).toBe(1000); expect(calls).toBe(2);
  probe.cancel();
});
