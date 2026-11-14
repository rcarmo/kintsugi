import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceResourceControl, workspaceResourceDefaults } from "./workspace-resources.ts";
const GiB = 1024 ** 3;
function container(id: string, memory = 0) { return { Id: id, Name: `/kintsugi-${id}`, Config: { Labels: { "com.kintsugi.type": "workspace", "com.kintsugi.workspace-id": id } }, State: { Running: false, OOMKilled: false, Pid: 100, ExitCode: 0, FinishedAt: "" }, RestartCount: 0, HostConfig: { Memory: memory, MemorySwap: memory, NanoCpus: 0, PidsLimit: 0 } }; }
async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(); try { await body(f); } finally { await rm(f.directory, { recursive: true, force: true }); }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-resource-control-")); const file = join(directory, "state.json");
  const containers = [container("a"),container("b"),container("c"),container("d")];
  let time = 1000; let failUpdate=false; const kills = new Map<string,number>(); const parked: string[] = []; const calls: string[][] = [];
  async function docker(...args: string[]) {
    calls.push(args);
    if (args[0] === "ps") return containers.map(c => c.Id).join("\n");
    if (args[0] === "inspect") return JSON.stringify(containers);
    const c = containers.find(c => c.Id === args.at(-1))!;
    if (args[0] === "stop") { c.State.Running = false; return c.Id; }
    if(args[0]==="update"&&args.includes("--memory")&&failUpdate)throw Error("Fixture Docker update refused");
    if (args[0] === "update") { if(args.includes("--memory")) c.HostConfig.Memory = Number(args[args.indexOf("--memory")+1]); if(args.includes("--memory-swap")) c.HostConfig.MemorySwap = Number(args[args.indexOf("--memory-swap")+1]); if(args.includes("--cpus")) c.HostConfig.NanoCpus = Number(args[args.indexOf("--cpus")+1])*1e9; if(args.includes("--pids-limit")) c.HostConfig.PidsLimit = Number(args[args.indexOf("--pids-limit")+1]); return c.Id; }
    throw Error("Unexpected Docker operation");
  }
  const create = (swap = 0, swapSupported = true) => createWorkspaceResourceControl({ appData:join(directory,"app"), pids:4096, policyFile: join(directory, "global-policy.json"), swap, swapSupported, memory: 8*GiB, cpus: 6, cgroupParent: "/fixture/workloads", file, docker, now: () => time, readOom: async c => kills.get(c.Id) ?? 0, sample: async c => c.State.Running ? {tasks:64,memory: 128*1024**2,memoryPeak:256*1024**2,swap:0,cpuCores:.5,effectiveMemory:c.HostConfig.Memory,effectiveAdditionalSwap:0,effectiveCpus:c.HostConfig.NanoCpus/1e9}: {}, park: async id => { parked.push(id); } });
  return { directory, file, containers, calls, kills, parked, create, refuseUpdate: (value:boolean) => { failUpdate=value; }, advance: (ms: number) => { time += ms; } };
}
test("workspace defaults bound memory, CPU and processes on small and large installations", () => {
  expect(workspaceResourceDefaults(2*GiB,1)).toEqual({ memory: GiB, cpus: 1, pids: 1024 });
  expect(workspaceResourceDefaults(8*GiB,8)).toEqual({ memory: 4*GiB, cpus: 4, pids: 1024 });
  expect(workspaceResourceDefaults(64*GiB,64)).toEqual({ memory: 4*GiB, cpus: 4, pids: 1024 });
});
test("concurrent admission accepts overlapping RAM and CPU caps before Docker starts containers", () => fixture(async f => {
  const control = f.create();
  expect((await Promise.allSettled(["a","b","c","d"].map(id => control.admit(id)))).map(r=>r.status)).toEqual(["fulfilled","fulfilled","fulfilled","fulfilled"]);
  const snapshot=await control.inspect("a");
  expect(snapshot.capacity.otherMemory+snapshot.desired.memory).toBeGreaterThan(snapshot.capacity.workspaceBudget);
  expect(snapshot.capacity.otherCpus!+snapshot.desired.cpus).toBeGreaterThan(snapshot.capacity.cpus);
  expect(f.calls.filter(c=>c[0]==="update").every(c=>c.includes("no")&&c.includes("128"))).toBe(true);
}));
test("reconciliation keeps healthy overlapping 4+2+2 GiB caps and preserves management/build headroom", () => fixture(async f => {
  f.containers[0]!.HostConfig.Memory=4*GiB;f.containers[0]!.HostConfig.MemorySwap=4*GiB;
  f.containers.slice(1,3).forEach(c=>{c.HostConfig.Memory=2*GiB;c.HostConfig.MemorySwap=2*GiB;});
  f.containers.slice(0,3).forEach(c=>{c.State.Running=true;}); const control=f.create(),result=await control.reconcile();
  await control.reconcile(true);
  expect(f.containers.filter(c=>c.State.Running)).toHaveLength(3);expect(f.parked).toEqual([]);
  expect(["a","b","c"].every(id=>control.status().workspaces[id]!.desiredRunning)).toBe(true);
  expect(result.budget).toBe(Math.floor(8*GiB*.8));expect(result.aggregateMemory).toBe(8*GiB);
  // Even caps summing above the actual parent hard cap are not reservations.
  f.containers[3]!.State.Running=true;await control.reconcile();
  expect(f.containers.every(c=>c.State.Running)).toBe(true);expect(f.parked).toEqual([]);expect(f.calls.some(c=>c[0]==="stop")).toBe(false);
}));
test("configure allows overlapping limits while peers are running and pending admission", () => fixture(async f => {
  const control=f.create(2*GiB);
  await control.configure("a",{memory:4*GiB,additionalSwap:2*GiB,cpus:6});await control.admit("a");f.containers[0]!.State.Running=true;
  await control.configure("b",{memory:2*GiB,additionalSwap:2*GiB,cpus:6});await control.admit("b");
  f.containers[2]!.State.Running=true;
  const changed=await control.configure("c",{memory:2*GiB,additionalSwap:2*GiB,cpus:6});
  expect(changed.inSync).toBe(true);expect(changed.capacity.otherMemory).toBe(6*GiB);expect(changed.capacity.otherAdditionalSwap).toBe(4*GiB);
  await control.admit("c");f.containers[1]!.State.Running=true;f.containers[2]!.State.Running=true;
  await control.reconcile();expect(f.containers.slice(0,3).every(c=>c.State.Running)).toBe(true);expect(f.parked).toEqual([]);
  const maximum=await control.configure("d",{memory:changed.capacity.workspaceBudget,additionalSwap:2*GiB,cpus:6});
  expect(maximum.inSync).toBe(true);await control.admit("d");
}));
test("a child OOM trips durable containment without restarting the app or unrelated workspace", () => fixture(async f => {
  f.containers[0]!.State.Running=true;f.containers[1]!.State.Running=true;
  const control=f.create();await control.reconcile();f.kills.set("a",1);await control.reconcile();
  expect(f.containers[0]!.State.Running).toBe(false);expect(f.containers[1]!.State.Running).toBe(true);expect(f.parked).toContain("a");
  const state=JSON.parse(await readFile(f.file,"utf8"));expect(state.a.source).toBe("child-process cgroup OOM");expect(state.a.oomKills).toBe(1);
  const restored=f.create();await expect(restored.admit("a")).rejects.toThrow("OOM");
  await expect(restored.admit("a",true)).rejects.toThrow("OOM");f.advance(60_001);
  await expect(restored.admit("a")).rejects.toThrow("OOM");await restored.admit("a",true);
}));
test("PID 1 OOM exits stay blocked across replacement and explicit retry has a cooldown", () => fixture(async f => {
  const c=f.containers[0]!;c.State.OOMKilled=true;c.State.ExitCode=137;c.State.FinishedAt="2026-10-16T19:00:00Z";
  const control=f.create();await control.reconcile();expect(control.status().workspaces.a!.source).toBe("workspace-container OOM exit");
  f.containers[0]={...c,Id:"new-a",State:{...c.State,OOMKilled:false}};
  await expect(f.create().admit("a")).rejects.toThrow("OOM");
}));
test("nonzero operator limits survive controller restart, container recreation and future Docker changes", () => fixture(async f => {
  const c=f.containers[0]!;c.HostConfig.Memory=GiB;c.HostConfig.MemorySwap=GiB;c.HostConfig.NanoCpus=1e9;c.HostConfig.PidsLimit=256;
  await f.create().reconcile();f.containers[0]=container("a");f.containers[0]!.Id="replacement-a";
  await f.create().admit("a");expect(f.containers[0]!.HostConfig.Memory).toBe(GiB);expect(f.containers[0]!.HostConfig.NanoCpus).toBe(1e9);
  f.containers[0]!.HostConfig.Memory=512*1024**2;f.containers[0]!.HostConfig.MemorySwap=512*1024**2;
  await f.create().reconcile();
  expect(JSON.parse(await readFile(f.file,"utf8")).a.limits.memory).toBe(512*1024**2);
}));
test("diagnostics omit Docker commands/environment and retain only bounded structured runtime metadata", () => fixture(async f => {
  Object.assign(f.containers[0]!.Config,{Env:["TOKEN=do-not-report"],Cmd:["secret-command"]});
  const control=f.create();await control.reconcile();const report=JSON.stringify(control.status());expect(report).not.toContain("do-not-report");expect(report).not.toContain("secret-command");
}));

test("boot recovery leaves previously stopped containers parked rather than starting them", () => fixture(async f => {
  const result=await f.create().reconcile(true);
  expect(result.restore).toEqual([]);expect(f.parked).toEqual(["a","b","c","d"]);
  expect(f.calls.some(c=>c[0]==="start")).toBe(false);
}));
test("healthy running intent survives a hard restart, but a later operator stop clears it", () => fixture(async f => {
  f.containers[0]!.State.Running=true;const control=f.create();await control.reconcile();
  f.containers[0]!.State.Running=false;
  expect((await f.create().reconcile(true)).restore).toContain("a");
  await control.reconcile();expect(f.parked).toContain("a");
  expect((await f.create().reconcile(true)).restore).not.toContain("a");
}));

test("shutdown drains the observer without turning a service stop into a parked workspace", () => fixture(async f => {
  f.containers[0]!.State.Running=true;const control=f.create();await control.reconcile();await control.shutdown();
  f.containers[0]!.State.Running=false;await control.reconcile();expect(f.parked).not.toContain("a");
  await expect(control.admit("a")).rejects.toThrow("stopping");
  expect((await f.create().reconcile(true)).restore).toContain("a");
}));

test("explicit parking blocks attention-driven or stale-restore relaunches until explicit unpark", () => fixture(async f => {
  const control=f.create();await control.park("a");
  await expect(control.admit("a")).rejects.toThrow("explicit unpark");
  expect((await f.create().reconcile(true,["a"])).restore).not.toContain("a");
  f.containers[0]!.State.Running=true;await control.reconcile();expect(f.containers[0]!.State.Running).toBe(false);
  await control.admit("a",true);
}));

test("inspection is read-only and exposes desired, applied, usage and capacity without container secrets", () => fixture(async f => {
  f.containers[0]!.State.Running=true;const control=f.create();await control.reconcile();const before=await readFile(f.file,"utf8"),index=f.calls.length;
  const snapshot=await control.inspect("a");expect(snapshot.containerId).toBe("a");expect(snapshot.usage.memoryPeak).toBe(256*1024**2);expect(snapshot.desired.memory).toBe(4*GiB);expect(snapshot.inSync).toBe(true);
  expect(snapshot.capacity.workspaceBudget).toBe(Math.floor(8*GiB*.8));expect(f.calls.slice(index).every(c=>c[0]==="ps"||c[0]==="inspect")).toBe(true);expect(await readFile(f.file,"utf8")).toBe(before);
}));
test("RAM and CPU changes apply live and survive recreation without restarting unrelated workspaces", () => fixture(async f => {
  f.containers[0]!.State.Running=true;const control=f.create();await control.reconcile();const index=f.calls.length;
  const changed=await control.configure("a",{memory:GiB,additionalSwap:0,cpus:1.5});expect(changed.inSync).toBe(true);expect(changed.applied.memory).toBe(GiB);expect(changed.applied.memorySwap).toBe(GiB);expect(changed.applied.cpus).toBe(1.5);expect(changed.state.running).toBe(true);
  expect(f.calls.slice(index).some(c=>c[0]==="start"||c[0]==="stop"||c[0]==="restart")).toBe(false);
  f.containers[0]=container("a");f.containers[0]!.Id="new-a";await f.create().admit("a");expect(f.containers[0]!.HostConfig.Memory).toBe(GiB);expect(f.containers[0]!.HostConfig.NanoCpus).toBe(1.5e9);
}));
test("unsafe reductions need acknowledgement and individual limits must be finite and within capacity", () => fixture(async f => {
  f.containers[0]!.State.Running=true;const control=f.create();await control.reconcile();const before=await readFile(f.file,"utf8");
  await expect(control.configure("a",{memory:64*1024**2,additionalSwap:0,cpus:1})).rejects.toThrow("Confirm");expect(await readFile(f.file,"utf8")).toBe(before);
  for(const memory of [0,-1,Infinity,NaN])await expect(control.configure("a",{memory,additionalSwap:0,cpus:1})).rejects.toThrow();
  await expect(control.configure("a",{memory:7*GiB,additionalSwap:0,cpus:1})).rejects.toThrow("per-workspace maximum");
  await expect(control.configure("a",{memory:GiB,additionalSwap:1024**2,cpus:1})).rejects.toThrow("swap");
  await expect(control.configure("a",{memory:GiB,additionalSwap:0,cpus:7})).rejects.toThrow("CPU");
  const applied=await control.configure("a",{memory:64*1024**2,additionalSwap:0,cpus:1,acknowledgeMemoryReduction:true});expect(applied.inSync).toBe(true);
}));

test("failed live applies keep desired settings durable and do not silently retry or mark them in sync", () => fixture(async f => {
  f.containers[0]!.State.Running=true;const control=f.create();await control.reconcile();f.refuseUpdate(true);
  const failed=await control.configure("a",{memory:3*GiB,additionalSwap:0,cpus:2});expect(failed.pending).toBe(true);expect(failed.inSync).toBe(false);expect(failed.applied.memory).toBe(4*GiB);expect(failed.desired.memory).toBe(3*GiB);
  f.refuseUpdate(false);const restored=f.create();await restored.reconcile();expect(f.containers[0]!.HostConfig.Memory).toBe(4*GiB);expect((await restored.inspect("a")).pending).toBe(true);
  await expect(restored.admit("a")).rejects.toThrow("pending");
  // A failed live apply is not a reservation blocking another workspace.
  expect((await restored.configure("b",{memory:4*GiB,additionalSwap:0,cpus:6})).inSync).toBe(true);await restored.admit("b");
  expect((await restored.configure("a",{memory:3*GiB,additionalSwap:0,cpus:2})).inSync).toBe(true);
}));
test("additional swap caps overlap but each is bounded by shared swap capacity", () => fixture(async f => {
  const extra=128*1024**2,control=f.create(extra);
  for(const id of ["a","b","c","d"])await control.configure(id,{memory:GiB,additionalSwap:extra,cpus:1});
  expect((await control.inspect("a")).applied.memorySwap).toBe(GiB+extra);
  expect((await Promise.allSettled(["a","b","c","d"].map(id=>control.admit(id)))).every(r=>r.status==="fulfilled")).toBe(true);
  await expect(control.configure("a",{memory:GiB,additionalSwap:extra+1,cpus:1})).rejects.toThrow("swap capacity");
  f.containers.forEach(c=>{c.State.Running=true;});await control.reconcile();expect(f.parked).toEqual([]);
}));

test("kernels without swap controls still apply RAM and CPU safely without pretending to grant swap",()=>fixture(async f=>{
  const control=f.create(0,false);await control.reconcile();
  const changed=await control.configure("a",{memory:GiB,additionalSwap:0,cpus:1});expect(changed.inSync).toBe(true);expect(changed.capacity.swapSupported).toBe(false);
  expect(f.calls.filter(c=>c[0]==="update").every(c=>!c.includes("--memory-swap"))).toBe(true);
  await expect(control.configure("a",{memory:GiB,additionalSwap:1024**2,cpus:1})).rejects.toThrow("swap");
}));
test("pending admission protects startup intent, then expires so an operator stop stays parked",()=>fixture(async f=>{
  const control=f.create();await control.admit("a");await control.reconcile();expect(control.status().workspaces.a!.desiredRunning).toBe(true);expect(f.parked).not.toContain("a");
  f.advance(60_001);await control.admit("b");await control.reconcile();expect(control.status().workspaces.a!.desiredRunning).toBe(false);expect(f.parked).toContain("a");
}));
test("admission rejects individual operator caps beyond RAM, CPU or swap capacity",()=>fixture(async f=>{
  for(const configure of [(c:ReturnType<typeof container>)=>{c.HostConfig.Memory=7*GiB;c.HostConfig.MemorySwap=7*GiB;},(c:ReturnType<typeof container>)=>{c.HostConfig.NanoCpus=7e9;},(c:ReturnType<typeof container>)=>{c.HostConfig.Memory=GiB;c.HostConfig.MemorySwap=2*GiB;}]){
    configure(f.containers[0]=container("a"));await expect(f.create().admit("a")).rejects.toThrow();
  }
}));
test("last exit metadata remains visible after a successful retry and later recreation",()=>fixture(async f=>{
  const c=f.containers[0]!;c.State.OOMKilled=true;c.State.ExitCode=137;c.State.FinishedAt="2026-10-16T19:00:00Z";const control=f.create();await control.reconcile();f.advance(60_001);await control.admit("a",true);
  c.State.Running=true;c.State.OOMKilled=false;c.State.ExitCode=0;c.State.FinishedAt="0001-01-01T00:00:00Z";await control.reconcile();const value=await control.inspect("a");expect(value.lastExit).toMatchObject({code:137,finishedAt:"2026-10-16T19:00:00Z"});
}));

test("global workspace RAM caps persist, bound defaults and reject individual limits above them", () => fixture(async f => {
  const control = f.create();
  expect((await control.policy()).maximumMemory).toBe(Math.floor(8 * GiB * .8));
  const policy = await control.configurePolicy({ maximumMemory: 2 * GiB });
  expect(policy.defaultMemory).toBe(2 * GiB);
  expect(policy.configuredMaximumMemory).toBe(2 * GiB);
  await control.admit("a");
  expect(f.containers[0]!.HostConfig.Memory).toBe(2 * GiB);
  await expect(control.configure("b", { memory: 3 * GiB, additionalSwap: 0, cpus: 1 })).rejects.toThrow("per-workspace maximum");
  const restored = f.create();
  expect((await restored.policy()).maximumMemory).toBe(2 * GiB);
  await restored.admit("c");
  expect(f.containers[2]!.HostConfig.Memory).toBe(2 * GiB);
  expect(JSON.parse(await readFile(join(f.directory, "global-policy.json"), "utf8"))).toEqual({ version: 2, maximumMemory: 2 * GiB });
}));

test("reducing the global cap refuses conflicting saved or running allocations without resizing", () => fixture(async f => {
  const control = f.create();
  await control.configurePolicy({ maximumMemory: 4 * GiB });
  await control.configure("a", { memory: 3 * GiB, additionalSwap: 0, cpus: 1 });
  const file = join(f.directory, "global-policy.json"), before = await readFile(file, "utf8"), calls = f.calls.length;
  await expect(control.configurePolicy({ maximumMemory: 2 * GiB })).rejects.toThrow("a");
  expect(await readFile(file, "utf8")).toBe(before);
  expect(f.calls.slice(calls).some(call => ["update", "stop"].includes(call[0]!))).toBe(false);
  await control.configure("a", { memory: GiB, additionalSwap: 0, cpus: 1 });
  f.containers[1]!.State.Running = true;
  await expect(control.configurePolicy({ maximumMemory: 2 * GiB })).rejects.toThrow("b");
  await control.configure("b", { memory: GiB, additionalSwap: 0, cpus: 1, acknowledgeMemoryReduction: true });
  expect((await control.configurePolicy({ maximumMemory: 2 * GiB })).maximumMemory).toBe(2 * GiB);
}));

test("a global cap fences an out-of-band oversized running container without killing peers", () => fixture(async f => {
  const control = f.create(); await control.configurePolicy({ maximumMemory: 2 * GiB });
  await control.admit("a"); await control.admit("b");
  f.containers[0]!.State.Running = true; f.containers[1]!.State.Running = true;
  f.containers[0]!.HostConfig.Memory = 3 * GiB; f.containers[0]!.HostConfig.MemorySwap = 3 * GiB;
  await control.reconcile();
  expect(f.containers[0]!.State.Running).toBe(false);
  expect(f.containers[1]!.State.Running).toBe(true);
  expect(f.parked).toEqual(["a"]);
}));

test("global cap input and capacity validation leave policy unchanged", () => fixture(async f => {
  const control = f.create(); await control.configurePolicy({ maximumMemory: GiB });
  for (const maximumMemory of [0, -1, NaN, Infinity, 7 * GiB]) await expect(control.configurePolicy({ maximumMemory })).rejects.toThrow();
  expect((await control.policy()).maximumMemory).toBe(GiB);
}));

test("global RAM cap includes managed allocations whose containers are temporarily absent", () => fixture(async f => {
  const control = f.create(); await control.configure("a", { memory: 3 * GiB, additionalSwap: 0, cpus: 1 });
  f.containers.shift();
  await expect(control.configurePolicy({ maximumMemory: GiB })).rejects.toThrow("a");
}));

test("task defaults persist for new workspaces without resizing existing containers", () => fixture(async f => {
  const control=f.create();await control.reconcile();const before=f.calls.length;
  const policy=await control.configurePolicy({maximumMemory:4*GiB,defaultPids:2048});
  expect(policy.defaultPids).toBe(2048);expect(policy.pidsCapacity).toBe(4096);
  expect(f.calls.slice(before).some(c=>c[0]==="update"||c[0]==="stop")).toBe(false);
  expect((await control.inspect("a")).desired.pids).toBe(1024);
  f.containers.push(container("new"));await control.admit("new");
  expect(f.containers.at(-1)!.HostConfig.PidsLimit).toBe(2048);
  const restored=f.create();expect((await restored.policy()).defaultPids).toBe(2048);
  await restored.configurePolicy({maximumMemory:4*GiB});
  expect((await restored.policy()).defaultPids).toBe(2048);
  expect(JSON.parse(await readFile(join(f.directory,"global-policy.json"),"utf8"))).toEqual({version:3,maximumMemory:4*GiB,defaultPids:2048});
}));
test("task overrides apply live, survive restart and do not restart or resize peers",()=>fixture(async f=>{
  const control=f.create();await control.reconcile();f.containers[0]!.State.Running=true;
  const before=f.calls.length,changed=await control.configure("a",{memory:4*GiB,additionalSwap:0,cpus:4,pids:2048});
  expect(changed.applied.pids).toBe(2048);expect(changed.desired.pids).toBe(2048);expect(changed.inSync).toBe(true);
  expect(f.calls.slice(before).filter(c=>c[0]==="update").every(c=>c.at(-1)==="a")).toBe(true);
  expect(f.calls.slice(before).some(c=>c[0]==="stop"||c[0]==="start")).toBe(false);
  expect((await f.create().inspect("a")).desired.pids).toBe(2048);
  f.refuseUpdate(true);const failed=await control.configure("a",{memory:4*GiB,additionalSwap:0,cpus:4,pids:3072});
  expect(failed.pending).toBe(true);expect(failed.desired.pids).toBe(3072);expect(failed.applied.pids).toBe(2048);
}));
test("task validation refuses zero, tiny, fractional and over-budget defaults and overrides",()=>fixture(async f=>{
  const control=f.create();await control.configurePolicy({maximumMemory:4*GiB,defaultPids:1024});
  for(const pids of [0,127,-1,128.5,NaN,Infinity,4097]){
    await expect(control.configurePolicy({maximumMemory:4*GiB,defaultPids:pids})).rejects.toThrow();
    await expect(control.configure("a",{memory:GiB,additionalSwap:0,cpus:1,pids})).rejects.toThrow();
  }
  expect((await control.policy()).defaultPids).toBe(1024);
}));
test("task overrides refuse reductions below current usage before Docker is changed",()=>fixture(async f=>{
  const control=f.create();await control.reconcile();f.containers[0]!.State.Running=true;
  // A cgroup snapshot with a real task count is independent of process names or terminal markup.
  const busy=createWorkspaceResourceControl({memory:8*GiB,cpus:6,pids:4096,file:f.file,policyFile:join(f.directory,"global-policy.json"),cgroupParent:"/fixture/workloads",docker:async(...args)=>{f.calls.push(args);if(args[0]==="ps")return"a";if(args[0]==="inspect")return JSON.stringify([f.containers[0]]);throw Error("Docker must not be updated");},sample:async()=>({tasks:300,memory:128*1024**2})});
  await expect(busy.configure("a",{memory:4*GiB,additionalSwap:0,cpus:4,pids:256})).rejects.toThrow("Stop workspace processes");
}));

test("explicit task settings retain their version-3 downgrade fence after later RAM-only changes",()=>fixture(async f=>{
  await mkdir(join(f.directory,"app/workspaces/a"),{recursive:true});
  const control=f.create();
  await control.configure("a",{memory:GiB,additionalSwap:0,cpus:1,pids:2048});
  const marker=join(f.directory,"app/workspaces/a/metadata/resource-policy.json");
  expect(JSON.parse(await readFile(marker,"utf8"))).toEqual({version:3});
  await control.configure("a",{memory:2*GiB,additionalSwap:0,cpus:1});
  expect(JSON.parse(await readFile(marker,"utf8"))).toEqual({version:3});
  expect((await f.create().inspect("a")).desired.pids).toBe(2048);
}));

test("meter counters do not admit, start, reconfigure or persist parked/missing workspaces", () => fixture(async f => {
  const control = f.create();
  expect(await control.counters([])).toEqual({}); expect(f.calls).toEqual([]);
  const result = await control.counters(["a", "missing"]);
  expect(Object.keys(result).sort()).toEqual(["a", "missing"]);
  expect(result.a!.state).toBe("stopped"); expect(result.a!.cpuUsec).toBeNull();
  expect(result.missing!.state).toBe("unavailable");
  expect(f.calls.every(call => ["ps", "inspect"].includes(call[0]!))).toBe(true);
  expect(f.calls[0]).toContain("name=^/kintsugi-(a|missing)$");
  expect(await Bun.file(f.file).exists()).toBe(false);
}));
