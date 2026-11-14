import { readFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";

const reading = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
export const resourceCounterSchema = Type.Object({
  identity: Type.String(), at: Type.Number(),
  state: Type.Union([Type.Literal("running"), Type.Literal("stopped"), Type.Literal("unavailable")]),
  cpuUsec: reading, cpus: reading, memory: reading, memoryLimit: reading,
  readBytes: reading, writeBytes: reading,
});
export type ResourceCounter = Static<typeof resourceCounterSchema>;
export const resourceSnapshotSchema = Type.Object({
  scope: Type.Union([Type.Literal("system"), Type.Literal("local")]),
  system: resourceCounterSchema,
  workspaces: Type.Record(Type.String(), resourceCounterSchema),
});
export type ResourceSnapshot = Static<typeof resourceSnapshotSchema>;
export function unavailableResourceCounter(state: ResourceCounter["state"] = "unavailable"): ResourceCounter {
  return { identity: "", at: Date.now(), state, cpuUsec: null, cpus: null, memory: null, memoryLimit: null, readBytes: null, writeBytes: null };
}

export function ioCounters(text: string) {
  let readBytes = 0, writeBytes = 0;
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const [device, ...fields] = line.trim().split(/\s+/);
    if (!/^\d+:\d+$/.test(device!) || !fields.length) throw new Error("Invalid cgroup I/O device");
    for (const field of fields) {
      if (!/^[a-z_]+=\d+$/.test(field)) throw new Error("Invalid cgroup I/O field");
      const [key, raw] = field.split("=");
      if (key !== "rbytes" && key !== "wbytes") continue;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid cgroup I/O counter");
      if (key === "rbytes") readBytes += value; else writeBytes += value;
    }
  }
  return { readBytes, writeBytes };
}

async function optionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    // Missing controllers and unreadable host mounts are unavailable, not zero usage.
    if (error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))) return null;
    throw error;
  }
}
function number(text: string | null): number | null {
  if (text === null || text.trim() === "max") return null;
  if (!text.trim()) throw new Error("Empty cgroup resource counter");
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid cgroup resource counter");
  return value;
}
export function cpusetSize(text: string): number {
  return text.trim().split(",").reduce((sum, range) => {
    if (!/^\d+(?:-\d+)?$/.test(range)) throw new Error("Invalid cgroup CPU set");
    const [start, end = start] = range.split("-").map(Number);
    if (end! < start!) throw new Error("Invalid cgroup CPU range");
    return sum + end! - start! + 1;
  }, 0);
}

/** Read cumulative kernel counters only; no sleeps, subprocesses or workspace starts. */
export async function readCgroupResourceCounter(root: string, identity: string, boundary = "/sys/fs/cgroup"): Promise<ResourceCounter> {
  if (root.split("/").includes("..") || (root !== boundary && !root.startsWith(boundary + "/"))) throw new Error("Resource cgroup is outside its boundary");
  const paths: string[] = [];
  for (let path = root; ; path = dirname(path)) {
    paths.push(path);
    if (path === boundary) break;
  }
  const [cpu, memory, io, affinity, limits] = await Promise.all([
    optionalFile(join(root, "cpu.stat")), optionalFile(join(root, "memory.current")),
    optionalFile(join(root, "io.stat")), optionalFile(join(root, "cpuset.cpus.effective")),
    Promise.all(paths.map(async path => Promise.all([optionalFile(join(path, "cpu.max")), optionalFile(join(path, "memory.max"))]))),
  ]);
  let cpus = availableParallelism(), memoryLimit = totalmem();
  if (affinity?.trim()) cpus = Math.min(cpus, cpusetSize(affinity));
  for (const [quota, ram] of limits) {
    if (quota && !quota.startsWith("max")) {
      const [amount, period] = quota.trim().split(/\s+/).map(Number);
      if (!(amount! > 0 && period! > 0)) throw new Error("Invalid cgroup CPU quota");
      cpus = Math.min(cpus, amount! / period!);
    }
    const limit = number(ram);
    if (limit !== null) memoryLimit = Math.min(memoryLimit, limit);
  }
  return {
    identity, at: performance.now(), state: cpu === null && memory === null && io === null ? "unavailable" : "running",
    cpuUsec: number(cpu?.match(/^usage_usec (\d+)$/m)?.[1] ?? null), cpus,
    memory: number(memory), memoryLimit,
    ...(io === null ? { readBytes: null, writeBytes: null } : ioCounters(io)),
  };
}

export interface ResourceReading {
  state: ResourceCounter["state"]; cpuPercent: number | null; cpus: number | null;
  memory: number | null; memoryLimit: number | null;
  readPerSecond: number | null; writePerSecond: number | null;
}
/** First samples, replaced containers and reset counters never manufacture a zero rate. */
export function resourceReading(current: ResourceCounter, before?: ResourceCounter): ResourceReading {
  const seconds = before && before.identity === current.identity && before.state === "running" && current.state === "running" ? (current.at - before.at) / 1000 : 0;
  function rate(after: number | null, previous: number | null | undefined): number | null {
    return seconds > 0 && after !== null && previous !== null && previous !== undefined && after >= previous ? (after - previous) / seconds : null;
  }
  const cpuRate = rate(current.cpuUsec, before?.cpuUsec);
  return { state: current.state, cpuPercent: cpuRate === null || !current.cpus ? null : cpuRate / (current.cpus * 10000), cpus: current.cpus,
    memory: current.memory, memoryLimit: current.memoryLimit,
    readPerSecond: rate(current.readBytes, before?.readBytes), writePerSecond: rate(current.writeBytes, before?.writeBytes) };
}
