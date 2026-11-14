import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpusetSize, ioCounters, readCgroupResourceCounter, resourceReading, unavailableResourceCounter, type ResourceCounter } from "./resource-metrics.ts";

const counter = (changes: Partial<ResourceCounter> = {}): ResourceCounter => ({ identity: "container:started", at: 1000, state: "running", cpuUsec: 1000000, cpus: .5, memory: 1024, memoryLimit: 4096, readBytes: 100, writeBytes: 300, ...changes });
test("CPU normalizes elapsed cumulative use by effective fractional cores; I/O reports byte rates", () => {
  const reading = resourceReading(counter({ at: 3000, cpuUsec: 1500000, readBytes: 300, writeBytes: 900 }), counter());
  expect(reading).toEqual({ state: "running", cpuPercent: 50, cpus: .5, memory: 1024, memoryLimit: 4096, readPerSecond: 100, writePerSecond: 300 });
});
test("initial readings, replaced/restarted containers, backwards clocks and counter resets have no invented rates", () => {
  expect(resourceReading(counter()).cpuPercent).toBeNull();
  for (const changes of [{ identity: "replacement" }, { at: 1000 }, { at: 0 }, { cpuUsec: 0, readBytes: 0, writeBytes: 0 }, { state: "stopped" as const }]) {
    const reading = resourceReading(counter({ at: 3000, ...changes }), counter());
    expect(reading.cpuPercent).toBeNull(); expect(reading.readPerSecond).toBeNull(); expect(reading.writePerSecond).toBeNull();
  }
  expect(resourceReading(counter({ at: 3000, cpuUsec: null }), counter()).cpuPercent).toBeNull();
  expect(resourceReading(counter({ at: 3000, cpus: 0 }), counter()).cpuPercent).toBeNull();
});
test("one reset subsystem does not erase independent evidence; unavailable/stopped samples break baselines", () => {
  const reading = resourceReading(counter({ at: 3000, cpuUsec: 0, readBytes: 300 }), counter());
  expect(reading.cpuPercent).toBeNull(); expect(reading.readPerSecond).toBe(100); expect(reading.memory).toBe(1024);
  expect(resourceReading(counter(), unavailableResourceCounter()).cpuPercent).toBeNull();
  expect(unavailableResourceCounter("stopped").memory).toBeNull();
});
test("quota-window bursts remain visible above 100% rather than silently altering measurements", () => {
  expect(resourceReading(counter({ at: 2000, cpuUsec: 2000000 }), counter()).cpuPercent).toBe(200);
});
test("I/O sums the kernel's reported device counters, ignores operation/discard counts, and distinguishes empty from malformed", () => {
  expect(ioCounters("8:0 rbytes=100 wbytes=200 rios=1 wios=2 dbytes=999\n8:16 wbytes=40 rbytes=20\n")).toEqual({ readBytes: 120, writeBytes: 240 });
  expect(ioCounters("")).toEqual({ readBytes: 0, writeBytes: 0 });
  expect(() => ioCounters("8:0 rbytes=-1")).toThrow(); expect(() => ioCounters("8:0 wbytes=garbage")).toThrow();
  expect(() => ioCounters("not-a-device rbytes=1")).toThrow(); expect(() => ioCounters("8:0 garbage")).toThrow();
  expect(cpusetSize("0-3,7,9-10\n")).toBe(7);
  expect(() => cpusetSize("4-2")).toThrow(); expect(() => cpusetSize("oops")).toThrow();
});
test("cgroup sampling includes mount-root/ancestor quotas and memory limits without sleeping", async () => {
  const root = await mkdtemp(join(tmpdir(), "kintsugi-meter-cgroup-"));
  const parent = join(root, "workloads"), child = join(parent, "container");
  try {
    await mkdir(child, { recursive: true });
    for (const [path, cpu, memory] of [[root, "200000 100000", "4194304"], [parent, "50000 100000", "2097152"], [child, "max 100000", "8388608"]]) {
      await writeFile(join(path!, "cpu.max"), cpu!); await writeFile(join(path!, "memory.max"), memory!);
    }
    await writeFile(join(child, "cpu.stat"), "usage_usec 200000\n");
    await writeFile(join(child, "memory.current"), "524288\n");
    await writeFile(join(child, "cpuset.cpus.effective"), "0-3,7\n");
    await writeFile(join(child, "io.stat"), "8:0 rbytes=200 wbytes=400\n");
    const result = await readCgroupResourceCounter(child, "fixture", root);
    expect(result).toMatchObject({ identity: "fixture", state: "running", cpus: .5, memoryLimit: 2097152, memory: 524288, cpuUsec: 200000, readBytes: 200, writeBytes: 400 });
    await rm(join(child, "io.stat"));
    const missing = await readCgroupResourceCounter(child, "fixture", root);
    expect(missing.readBytes).toBeNull(); expect(missing.writeBytes).toBeNull(); expect(missing.memory).toBe(524288);
    await rm(join(child, "cpu.stat")); await rm(join(child, "memory.current"));
    expect((await readCgroupResourceCounter(child, "fixture", root)).state).toBe("unavailable");
    await expect(readCgroupResourceCounter(join(root, "..", "outside"), "bad", root)).rejects.toThrow("outside");
  } finally { await rm(root, { recursive: true, force: true }); }
});
