import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceOomGroupKills } from "./workspace-oom-events.ts";
import { createWorkspaceResourceControl } from "./workspace-resources.ts";

test("isolated child OOMs do not trip the workspace breaker; root group OOMs still do", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-local-oom-"));
  const c = { Id: "a", Name: "/kintsugi-a", Config: { Labels: { "com.kintsugi.type": "workspace", "com.kintsugi.workspace-id": "a" } }, State: { Running: true, OOMKilled: false, Pid: 100, ExitCode: 0, FinishedAt: "" }, RestartCount: 0, HostConfig: { Memory: 1024 ** 3, MemorySwap: 1024 ** 3, NanoCpus: 1e9, PidsLimit: 1024 } };
  const calls: string[][] = [], parked: string[] = [];
  const control = createWorkspaceResourceControl({ memory: 8 * 1024 ** 3, cpus: 4, cgroupParent: "/fixture", file: join(root, "state.json"), readOom: () => workspaceOomGroupKills(root), sample: async () => ({}), park: async id => { parked.push(id); }, docker: async (...args) => {
    calls.push(args);
    if (args[0] === "ps") return "a";
    if (args[0] === "inspect") return JSON.stringify([c]);
    if (args[0] === "stop") c.State.Running = false;
    return "";
  } });
  try {
    await writeFile(join(root, "memory.events"), "oom 0\noom_kill 0\noom_group_kill 0\n");
    await writeFile(join(root, "memory.events.local"), "oom 0\noom_kill 0\noom_group_kill 0\n");
    await control.reconcile();
    await writeFile(join(root, "memory.events"), "oom 9\noom_kill 9\noom_group_kill 4\n");
    await control.reconcile();
    expect(c.State.Running).toBe(true);
    expect(parked).toEqual([]);
    expect(calls.some(args => args[0] === "stop")).toBe(false);
    expect(control.status().workspaces.a?.oomKills).toBe(0);
    await writeFile(join(root, "memory.events.local"), "oom 1\noom_kill 0\noom_group_kill 1\n");
    await control.reconcile();
    expect(c.State.Running).toBe(false);
    expect(parked).toEqual(["a"]);
    expect(control.status().workspaces.a?.oomKills).toBe(1);
    await control.reconcile();
    expect(control.status().workspaces.a?.oomKills).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing local group-OOM counters fail visibly instead of falling back to hierarchical victims", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-invalid-oom-"));
  try {
    await writeFile(join(root, "memory.events.local"), "oom_kill 4\n");
    await expect(workspaceOomGroupKills(root)).rejects.toThrow("oom_group_kill");
  } finally { await rm(root, { recursive: true, force: true }); }
});
