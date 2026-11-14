import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runDocker, withCommandSignal } from "@kintsugi/core";
import { readCgroupResourceCounter, unavailableResourceCounter, resourceSnapshotSchema, type ResourceSnapshot, type ResourceCounter } from "@kintsugi/core/resource-metrics";
import { hostAvailable, hostRequest, readSystemVersion } from "@kintsugi/host/control";
import { resourceMetersSystemVersion } from "@kintsugi/shared/system-version";
import { Type } from "typebox";
import { Value } from "typebox/value";

const containersSchema = Type.Array(Type.Object({
  Id: Type.String(), Name: Type.String(), Config: Type.Object({ Labels: Type.Union([Type.Null(), Type.Record(Type.String(), Type.String())]) }),
  State: Type.Object({ Running: Type.Boolean(), Pid: Type.Integer({ minimum: 0 }), StartedAt: Type.String() }),
}));

/** Local mode has no privileged System service. Inspect only already-existing containers. */
async function localWorkspaceCounters(ids: readonly string[], signal: AbortSignal): Promise<Record<string, ResourceCounter>> {
  const result: Record<string, ResourceCounter> = Object.fromEntries(ids.map(id => [id, unavailableResourceCounter()]));
  if (!ids.length) return result;
  const inspection = await withCommandSignal(signal, () => runDocker(["inspect", ...ids.map(id => `kintsugi-${id}`)], { maxOutputBytes: 1024 * 1024 }));
  // Docker still returns the existing containers when another selected workspace has disappeared.
  if (!inspection.stdout.trim()) throw new Error("Local Docker resource inspection failed");
  const containers = Value.Parse(containersSchema, JSON.parse(inspection.stdout));
  await Promise.all(containers.map(async container => {
    const id = container.Config.Labels?.["com.kintsugi.workspace-id"];
    if (!id || !ids.includes(id) || container.Name !== `/kintsugi-${id}` || container.Config.Labels?.["com.kintsugi.type"] !== "workspace") return;
    if (!container.State.Running) { result[id] = unavailableResourceCounter("stopped"); return; }
    try {
      const membership = (await readFile(`/proc/${container.State.Pid}/cgroup`, "utf8")).split("\n").find(line => line.startsWith("0::"))?.slice(3);
      const parts = membership?.split("/") ?? [];
      const end = parts.findIndex(part => part === container.Id || part === `docker-${container.Id}.scope`);
      if (end < 0 || parts.includes("..")) throw new Error("Workspace cgroup is not visible on this host");
      result[id] = await readCgroupResourceCounter(join("/sys/fs/cgroup", ...parts.slice(0, end + 1)), `${container.Id}:${container.State.StartedAt}`);
    } catch (error) { console.error("Local workspace resource counters unavailable", id, error); }
  }));
  return result;
}

export async function inspectResourceCounters(workspaceIds: readonly string[], signal: AbortSignal): Promise<ResourceSnapshot> {
  const ids = Value.Parse(Type.Array(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$" }), { maxItems: 32 }), [...new Set(workspaceIds)]);
  if (hostAvailable()) {
    if (await readSystemVersion((input, init) => fetch(input, { ...init, signal })) < resourceMetersSystemVersion) throw new Error("Update System for live resource meters.");
    return Value.Parse(resourceSnapshotSchema, await hostRequest({ operation: "meters", workspaceIds: ids }, undefined, { signal }));
  }
  const [system, workspaces] = await Promise.all([
    readCgroupResourceCounter("/sys/fs/cgroup", "local"),
    localWorkspaceCounters(ids, signal).catch(error => {
      if (!signal.aborted) console.error("Local workspace resource inspection failed", error);
      return Object.fromEntries(ids.map(id => [id, unavailableResourceCounter()]));
    }),
  ]);
  return { scope: "local", system, workspaces };
}
