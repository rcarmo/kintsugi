import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { command } from "./system/command.ts";
import { HostService, startHostService } from "./system/service.ts";
import { hostRequest } from "./server/connection.ts";
import { parseHostRequest, parseHostInput, type HostCommand, type HostSample, type HostReply } from "./protocol.ts";
import { unavailableResourceCounter } from "@kintsugi/core/resource-metrics";
import { cpuPercent, counters, effectiveCpu, filesystemUsage } from "./system/sampler.ts";

const sample: HostSample = { sampledAt: "2026-01-01T00:00:00.000Z", durationMs: 1000, metrics: [], sections: [] };
test("sample cache and concurrent requests share one bounded collection", async () => {
  let count = 0;
  const service = new HostService(async () => { count++; await Bun.sleep(10); return sample; });
  await Promise.all([service.handle({ operation: "sample" }), service.handle({ operation: "sample", fresh: true })]);
  expect(count).toBe(1);
  expect(await service.handle({ operation: "sample" })).toEqual(sample);
  expect(count).toBe(1);
  await service.handle({ operation: "sample", fresh: true });
  expect(count).toBe(2);
});
test("failed sampling can be retried", async () => {
  let count = 0;
  const service = new HostService(async () => { if (++count === 1) throw new Error("broken"); return sample; });
  await expect(service.handle({ operation: "sample" })).rejects.toThrow("broken");
  expect(await service.handle({ operation: "sample" })).toEqual(sample);
});
test("CPU uses interval usage and the tightest ancestor quota", () => {
  expect(effectiveCpu(["max 100000", "150000 100000", "200000 100000"], 8)).toBe(1.5);
  expect(cpuPercent(1000, 751000, 1000, 1.5)).toBe(50);
  expect(counters("usage_usec 42\nnr_throttled 3\n")).toEqual({ usage_usec: 42, nr_throttled: 3 });
});
test("disk and inode usage validate df output", () => {
  expect(filesystemUsage("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 91 9 91% /data")).toEqual({ size: 100, used: 91, available: 9, percent: 91 });
  expect(filesystemUsage("Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/loop0 0 0 0 - /data")).toBeNull();
  expect(() => filesystemUsage("broken")).toThrow();
});
test("control boundary rejects unknown operations, session injection and invalid dimensions", () => {
  expect(() => parseHostRequest('{"operation":"exec","command":"whoami"}')).toThrow();
  expect(() => parseHostRequest('{"operation":"terminate","id":"anything; shell"}')).toThrow();
  expect(() => parseHostRequest(JSON.stringify({ operation: "attach", id: `host-${crypto.randomUUID()}`, cols: 100000 }))).toThrow();
  expect(() => parseHostInput('{"input":"ls"}')).toThrow();
  expect(() => parseHostRequest(JSON.stringify({ operation: "rename", id: `host-${crypto.randomUUID()}`, title: "Removed operation" }))).toThrow();
});

describe.skip("System terminal lifecycle over private socket", () => {
  let directory: string;
  let socketPath: string;
  const tmuxSocketName = `host-test-${crypto.randomUUID()}`;
  let server: Awaited<ReturnType<typeof startHostService>>;
  const call = <Command extends HostCommand>(request: Command) => hostRequest(request, socketPath);
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "kintsugi-host-"));
    socketPath = join(directory, "host.sock");
    server = await startHostService({ socketPath, tmuxSocketName, root: "/unused", effectiveMemory: 0 });
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await command(["tmux", "-L", tmuxSocketName, "kill-server"]);
    await rm(directory, { recursive: true });
  });
  test("starts empty and preserves explicitly created sessions across disconnect and restart", async () => {
    expect(await call({ operation: "list" })).toEqual([]);
    const first = await call({ operation: "create" });
    const second = await call({ operation: "create" });
    expect(await call({ operation: "list" })).toEqual([first, second]);
    const marker = join(directory, "process-survived");
    const socket = createConnection(socketPath);
    const lines = createInterface({ input: socket });
    const attached = new Promise<void>((resolve, reject) => {
      socket.on("error", reject);
      lines.on("line", line => { const reply: HostReply = JSON.parse(line); if (reply.type === "result") resolve(); if (reply.type === "error") reject(new Error(reply.message)); });
    });
    socket.write(`${JSON.stringify({ operation: "attach", id: first.id, cols: 80, rows: 24 })}\n`);
    await attached;
    socket.write(`${JSON.stringify(`sleep 0.3; printf alive > '${marker}'\r`)}\n`);
    await Bun.sleep(100);
    socket.destroy(); lines.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = await startHostService({ socketPath, tmuxSocketName, root: "/unused", effectiveMemory: 0 });
    await Bun.sleep(500);
    expect(await Bun.file(marker).text()).toBe("alive");
    expect((await call({ operation: "list" })).length).toBe(2);
    await call({ operation: "terminate", id: first.id });
    expect((await call({ operation: "list" })).map(t => t.id)).toEqual([second.id]);
    await call({ operation: "terminate", id: second.id });
    expect(await call({ operation: "list" })).toEqual([]);
  });
});

test("global RAM policy uses a private typed operation without workspace or command overrides", async () => {
  const request: HostCommand = { operation: "resource-policy", action: "configure", changes: { maximumMemory: 1024 ** 3 } };
  expect(parseHostRequest(JSON.stringify(request))).toEqual(request);
  expect(() => parseHostRequest(JSON.stringify({ ...request, workspaceId: "other" }))).toThrow();
  expect(() => parseHostRequest(JSON.stringify({ ...request, changes: { maximumMemory: 0 } }))).toThrow();
  const service = new HostService(async () => sample);
  await expect(service.handle({ operation: "resource-policy", action: "inspect" })).rejects.toThrow("unavailable");
  service.resourceControl = async command => {
    expect(command.operation).toBe("resource-policy");
    return { maximumMemory: 1024 ** 3, capacity: 2 * 1024 ** 3, defaultMemory: 1024 ** 3 };
  };
  expect(await service.handle({ operation: "resource-policy", action: "inspect" })).toMatchObject({ maximumMemory: 1024 ** 3 });
});

test("resource counter commands are bounded, read-only and dispatched separately from expensive diagnostics", async () => {
  expect(parseHostRequest('{"operation":"meters","workspaceIds":["a","b"]}')).toEqual({ operation: "meters", workspaceIds: ["a", "b"] });
  expect(() => parseHostRequest(JSON.stringify({ operation: "meters", workspaceIds: Array(33).fill("a") }))).toThrow();
  expect(() => parseHostRequest('{"operation":"meters","workspaceIds":["../escape"]}')).toThrow();
  const service = new HostService(async () => { throw Error("Full diagnostics must not run for meters"); });
  await expect(service.handle({ operation: "meters", workspaceIds: [] })).rejects.toThrow("unavailable");
  service.meters = async ids => { expect(ids).toEqual(["a"]); return { scope: "system", system: unavailableResourceCounter(), workspaces: {} }; };
  expect(await service.handle({ operation: "meters", workspaceIds: ["a"] })).toMatchObject({ scope: "system", workspaces: {} });
});
