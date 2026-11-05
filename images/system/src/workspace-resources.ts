import { chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { workspaceOomGroupKills } from "./workspace-oom-events.ts";
import { createKeyedOperationQueue, readTextIfExists, writeJsonAtomic } from "../../../packages/core/src/index.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { workspaceResourceLimitsSchema, workspaceResourceChangeSchema, type WorkspaceResourceChange, type WorkspaceResourceSnapshot, type WorkspaceResourceUsage, type WorkspaceResourceLimits } from "../../../packages/shared/src/workspace-resources.ts";

const GiB = 1024 ** 3;
export function workspaceResourceDefaults(memory: number, cpus: number) {
  return { memory: Math.min(4 * GiB, Math.floor(memory / 2)), cpus: Math.max(0.25, Math.min(4, cpus)), pids: 1024 };
}
const limitsSchema = workspaceResourceLimitsSchema;
const recordSchema = Type.Object({ limits: limitsSchema, managed: Type.Optional(Type.Boolean()), pending: Type.Optional(Type.Boolean()), applyError: Type.Optional(Type.String()), desiredRunning: Type.Optional(Type.Boolean()), oomKills: Type.Integer({ minimum: 0 }), blockedAt: Type.Optional(Type.Number()), reason: Type.Optional(Type.String()), source: Type.Optional(Type.String()), containerId: Type.Optional(Type.String()), observedOom: Type.Optional(Type.Number()), lastOomExit: Type.Optional(Type.String()), exitCode: Type.Optional(Type.Integer()), restartCount: Type.Optional(Type.Integer()), finishedAt: Type.Optional(Type.String()), lastExitAt: Type.Optional(Type.String()), lastExitCode: Type.Optional(Type.Integer()) });
type RecordState = Static<typeof recordSchema>;
// Docker is a privileged external boundary. Do not return its Env/Cmd/Error or arbitrary image metadata in diagnostics.
const inspectSchema = Type.Array(Type.Object({ Id: Type.String(), Name: Type.String(), Config: Type.Object({ Image: Type.Optional(Type.String()), ExposedPorts: Type.Optional(Type.Union([Type.Null(), Type.Record(Type.String(), Type.Unknown())])), Labels: Type.Union([Type.Null(), Type.Record(Type.String(), Type.String())]) }), State: Type.Object({ Running: Type.Boolean(), OOMKilled: Type.Boolean(), Pid: Type.Integer(), ExitCode: Type.Integer(), FinishedAt: Type.String(), StartedAt: Type.Optional(Type.String()), Status: Type.Optional(Type.String()) }), NetworkSettings: Type.Optional(Type.Object({ Networks: Type.Optional(Type.Record(Type.String(), Type.Object({ IPAddress: Type.Optional(Type.String()), GlobalIPv6Address: Type.Optional(Type.String()) }))), Ports: Type.Optional(Type.Union([Type.Null(), Type.Record(Type.String(), Type.Union([Type.Null(), Type.Array(Type.Object({ HostIp: Type.String(), HostPort: Type.String() }))]))])) })), RestartCount: Type.Integer(), HostConfig: Type.Object({ CpusetCpus: Type.Optional(Type.String()), RestartPolicy: Type.Optional(Type.Object({ Name: Type.String() })), Memory: Type.Number(), MemorySwap: Type.Number(), NanoCpus: Type.Number(), PidsLimit: Type.Union([Type.Null(), Type.Number()]) }) }));
type Container = Static<typeof inspectSchema>[number];
export function createWorkspaceResourceControl(options: { memory: number; cpus: number; swap?: number; swapSupported?: boolean; systemMemory?: number; sample?: (container: Container) => Promise<WorkspaceResourceUsage>; cgroupParent: string; docker(...args: string[]): Promise<string>; file?: string; appData?: string; park?: (id: string) => Promise<void>; readOom?: (container: Container) => Promise<number>; now?: () => number }) {
  const file = options.file ?? "/data/supervisor/workspace-resources.json";
  const defaults = workspaceResourceDefaults(options.memory, options.cpus);
  const budget = Math.floor(options.memory * 0.8); // Per-workspace ceiling; the shared aggregate cap also covers source readers and image builds.
  const serialize = createKeyedOperationQueue();
  // Track admitted starts until Docker reports them running, not capacity reservations.
  const pending = new Map<string, number>();
  const now = options.now ?? Date.now;
  let closing = false;
  let state: Record<string, RecordState>;
  async function load() { state ??= Value.Parse(Type.Record(Type.String(), recordSchema), JSON.parse(await readTextIfExists(file) ?? "{}")); }
  const save = () => writeJsonAtomic(file, state, { mode: 0o600 });
  const idOf = (c: Container) => { const id = c.Config.Labels?.["com.kintsugi.workspace-id"]; return id && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) && c.Config.Labels?.["com.kintsugi.type"] === "workspace" && c.Name === `/kintsugi-${id}` ? id : undefined; };
  async function containers() {
    const ids = (await options.docker("ps", "-aq", "--filter", "label=com.kintsugi.type=workspace")).split(/\s+/).filter(Boolean);
    return ids.length ? Value.Parse(inspectSchema, JSON.parse(await options.docker("inspect", ...ids))).filter(c => idOf(c)) : [];
  }
  function entry(c: Container): RecordState {
    const id = idOf(c)!;
    if (!Object.hasOwn(state, id)) {
      const memory = c.HostConfig.Memory || defaults.memory;
      state[id] = { limits: { memory, memorySwap: c.HostConfig.MemorySwap > 0 ? c.HostConfig.MemorySwap : memory, cpus: c.HostConfig.NanoCpus > 0 ? c.HostConfig.NanoCpus / 1e9 : defaults.cpus, pids: c.HostConfig.PidsLimit && c.HostConfig.PidsLimit > 0 ? c.HostConfig.PidsLimit : defaults.pids }, oomKills: 0 };
    }
    const current = state[id]!;
    if (current.containerId === c.Id && !current.managed) {
      const config = c.HostConfig;
      if (config.Memory > 0) current.limits.memory = config.Memory;
      if (config.MemorySwap > 0) current.limits.memorySwap = config.MemorySwap;
      if (config.NanoCpus > 0) current.limits.cpus = config.NanoCpus / 1e9;
      if (config.PidsLimit && config.PidsLimit > 0) current.limits.pids = config.PidsLimit;
    }
    return current;
  }
  async function apply(c: Container, e: RecordState) {
    const p = e.limits;
    if (p.memory > budget) throw new Error(`RAM limit exceeds the per-workspace maximum of ${budget} bytes.`);
    if (p.memorySwap < p.memory || p.memorySwap - p.memory > (options.swap ?? 0) || (options.swapSupported === false && p.memorySwap > p.memory)) throw new Error("Additional swap limit exceeds the installation's shared workload swap capacity.");
    if (p.cpus > options.cpus) throw new Error("CPU limit exceeds the installation's effective CPU capacity.");
    await options.docker("update", "--memory", String(p.memory), ...options.swapSupported === false ? [] : ["--memory-swap", String(p.memorySwap)], "--cpus", String(p.cpus), "--pids-limit", String(p.pids), "--cpu-shares", "128", "--restart", "no", c.Id);
  }
  async function cgroup(c: Container) {
    let processGroup: string;
    try { processGroup = await readFile(`/proc/${c.State.Pid}/cgroup`, "utf8"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    const membership = processGroup.trim().split("\n").find(l => l.startsWith("0::"))?.slice(3);
    if (!membership?.startsWith(options.cgroupParent + "/")) throw new Error("Workspace cgroup is outside its resource boundary");
    const parts = membership.split("/");
    const index = parts.findIndex(p => p === c.Id || p === `docker-${c.Id}.scope`);
    if (index < 0) throw new Error("Cannot identify the workspace cgroup");
    return join("/sys/fs/cgroup", parts.slice(0, index + 1).join("/"));
  }
  async function oom(c: Container) {
    if (options.readOom) return options.readOom(c);
    const root = await cgroup(c); if (!root) return;
    await writeFile(join(root, "memory.oom.group"), "1");
    return workspaceOomGroupKills(root);
  }
  async function observe(c: Container, e: RecordState) {
    if (e.containerId !== c.Id) { e.containerId = c.Id; e.observedOom = 0; }
    e.exitCode = c.State.ExitCode; e.restartCount = c.RestartCount; e.finishedAt = c.State.FinishedAt;
    if (!c.State.Running && c.State.FinishedAt && !c.State.FinishedAt.startsWith("0001-")) { e.lastExitAt = c.State.FinishedAt; e.lastExitCode = c.State.ExitCode; }
    let count = e.observedOom ?? 0;
    if (c.State.Running) {
      const observed = await oom(c);
      if (observed === undefined) return; // Exited between Docker inspect and /proc; inspect its final state next time.
      count = observed;
    }
    const exit = c.State.OOMKilled && c.State.FinishedAt !== e.lastOomExit;
    if (count > (e.observedOom ?? 0) || exit) {
      e.oomKills += count > (e.observedOom ?? 0) ? count - (e.observedOom ?? 0) : e.blockedAt === undefined ? 1 : 0;
      e.observedOom = count; if (exit) e.lastOomExit = c.State.FinishedAt;
      e.desiredRunning = false;
      e.blockedAt = now(); e.reason = "Workspace stopped after OOM. Park it, then explicitly unpark after 60 seconds to retry.";
      e.source = exit ? "workspace-container OOM exit" : "child-process cgroup OOM";
      await save(); // Persist the circuit breaker before any stop or restart operation.
      await markParked(idOf(c)!);
    }
    e.observedOom = count;
  }
  async function markPolicy(id: string) {
    const { existsSync } = await import("node:fs");
    const directory = join(options.appData ?? "/data/app", "workspaces", id, "metadata");
    if (!existsSync(join(directory,".."))) return;
    const path = join(directory,"resource-policy.json");
    const previous = await readTextIfExists(path);
    if (previous !== undefined) { Value.Parse(Type.Object({version:Type.Integer({minimum:1,maximum:1})}),JSON.parse(previous)); return; }
    await writeJsonAtomic(path,{version:1},{mode:0o600}); await chown(path,1000,1000);
  }
  async function markParked(id: string) {
    if (options.park) return options.park(id);
    const directory = join(options.appData ?? "/data/app", "workspaces", id, "metadata");
    // Persist the existing parked marker, which older app/System pairs also understand on rollback.
    const { existsSync } = await import("node:fs");
    if (!existsSync(join(directory, ".."))) return;
    await mkdir(directory, { recursive: true });
    const path = join(directory, "parked");
    await writeFile(path, "", { mode: 0o600 }); await chown(path, 1000, 1000);
  }
  async function stop(c: Container) { pending.delete(idOf(c)!); if (c.State.Running) await options.docker("stop", "--time", "3", c.Id); }
  const actual = (c: Container): WorkspaceResourceLimits => ({ memory: c.HostConfig.Memory, memorySwap: c.HostConfig.MemorySwap, cpus: c.HostConfig.NanoCpus / 1e9, pids: c.HostConfig.PidsLimit ?? 0 });
  const withinCapacity = (limits: WorkspaceResourceLimits) => limits.memory <= budget && limits.memorySwap >= limits.memory && limits.memorySwap - limits.memory <= (options.swapSupported === false ? 0 : options.swap ?? 0) && limits.cpus <= options.cpus;
  const sameLimits = (a: WorkspaceResourceLimits, b: WorkspaceResourceLimits) => a.memory === b.memory && (a.memorySwap === b.memorySwap || (options.swapSupported === false && b.memorySwap === b.memory)) && a.cpus === b.cpus && a.pids === b.pids;
  async function usage(c: Container): Promise<WorkspaceResourceUsage> {
    if (options.sample) return options.sample(c);
    if (!c.State.Running) return {};
    const root = await cgroup(c); if (!root) return {};
    const number = async (name: string) => { const text = await readTextIfExists(join(root,name)); return text === undefined || text.trim() === "max" ? undefined : Number(text); };
    const [memory,memoryPeak,swap,ownMemory,ownSwap,ownPids,cpu] = await Promise.all([number("memory.current"),number("memory.peak"),number("memory.swap.current"),number("memory.max"),number("memory.swap.max"),number("pids.max"),readTextIfExists(join(root,"cpu.max"))]);
    const cpuReading = async () => Number((await readFile(join(root,"cpu.stat"),"utf8")).match(/^usage_usec (\d+)$/m)![1]);
    const start = performance.now(), before = await cpuReading(); await Bun.sleep(150); const after = await cpuReading();
    const [quota,period] = cpu?.trim().split(/\s+/) ?? ["max","100000"];
    let effectiveMemory=Math.min(options.memory,ownMemory??options.memory),effectiveSwap=Math.min(options.swap??0,ownSwap??options.swap??0),effectiveCpus=Math.min(options.cpus,quota==="max"?options.cpus:Number(quota)/Number(period)),effectivePids=ownPids;
    for(let path=dirname(root);path!=="/sys/fs/cgroup";path=dirname(path)){
      const [ram,extra,pids,limit]=await Promise.all([readTextIfExists(join(path,"memory.max")),readTextIfExists(join(path,"memory.swap.max")),readTextIfExists(join(path,"pids.max")),readTextIfExists(join(path,"cpu.max"))]);
      if(ram?.trim()!=="max"&&ram!==undefined)effectiveMemory=Math.min(effectiveMemory,Number(ram));
      if(extra?.trim()!=="max"&&extra!==undefined)effectiveSwap=Math.min(effectiveSwap,Number(extra));
      if(pids?.trim()!=="max"&&pids!==undefined)effectivePids=Math.min(effectivePids??Infinity,Number(pids));
      if(limit){const [q,p]=limit.trim().split(/\s+/);if(q!=="max")effectiveCpus=Math.min(effectiveCpus,Number(q)/Number(p));}
    }
    return { memory,memoryPeak,swap,cpuCores:Math.max(0,(after-before)/((performance.now()-start)*1000)),effectiveMemory,effectiveAdditionalSwap:effectiveSwap,effectiveCpus,effectivePids };
  }
  // Informational sums only: workspace limits overlap, they do not reserve shared capacity.
  function otherLimits(all: Container[], id: string) {
    const others = all.filter(c=>idOf(c)!==id && (c.State.Running || pending.has(idOf(c)!)));
    return { memory:others.reduce((n,c)=>n+Math.max(entry(c).limits.memory,c.HostConfig.Memory),0),swap:others.reduce((n,c)=>n+Math.max(0,entry(c).limits.memorySwap-entry(c).limits.memory,c.HostConfig.MemorySwap-c.HostConfig.Memory),0) };
  }
  async function snapshot(c: Container, all: Container[]): Promise<WorkspaceResourceSnapshot> {
    const id=idOf(c)!, e=entry(c), other=otherLimits(all,id);
    let sample:WorkspaceResourceUsage={}; let metricsError:string|undefined;
    try { sample=await usage(c); } catch(error) { console.error("Workspace cgroup metrics unavailable",error); metricsError="Cgroup usage is unavailable. Refresh before lowering limits."; }
    const meminfo=await readFile("/proc/meminfo","utf8");
    return { workspaceId:id,containerId:c.Id,image:c.Config.Image ?? "",state:{running:c.State.Running,status:c.State.Status ?? (c.State.Running?"running":"stopped"),oomKilled:c.State.OOMKilled,exitCode:c.State.ExitCode,restartCount:c.RestartCount,restartPolicy:c.HostConfig.RestartPolicy?.Name ?? "",finishedAt:c.State.FinishedAt,startedAt:c.State.StartedAt ?? ""},desired:e.limits,applied:actual(c),usage:sample,
      capacity:{hostMemory:Number(meminfo.match(/^MemTotal:\s+(\d+)/m)![1])*1024,hostAvailable:Number(meminfo.match(/^MemAvailable:\s+(\d+)/m)![1])*1024,systemMemory:options.systemMemory ?? options.memory,workspaceBudget:budget,otherCpus:all.filter(v=>idOf(v)!==id&&(v.State.Running||pending.has(idOf(v)!))).reduce((n,v)=>n+entry(v).limits.cpus,0),otherMemory:other.memory,swapSupported:options.swapSupported !== false,additionalSwapBudget:options.swap ?? 0,otherAdditionalSwap:other.swap,cpus:options.cpus},
      lastExit:e.lastExitAt?{code:e.lastExitCode??0,finishedAt:e.lastExitAt,reason:e.source??`Container exit ${e.lastExitCode??0}`}:undefined,oomKills:e.oomKills,restartSource:e.source,blockedAt:e.blockedAt,failure:e.applyError ?? (e.managed&&!withinCapacity(e.limits)?"Saved limits exceed the current installation capacity. Reduce them before retrying.":e.reason) ?? metricsError,inSync:sameLimits(actual(c),e.limits)&&!e.pending&&(!e.managed||withinCapacity(e.limits)),pending:(e.pending ?? false)||(!!e.managed&&!withinCapacity(e.limits)),affinity:c.HostConfig.CpusetCpus ?? "",
      addresses:Object.entries(c.NetworkSettings?.Networks ?? {}).slice(0,64).map(([network,v])=>({network,ipv4:v.IPAddress ?? "",ipv6:v.GlobalIPv6Address ?? ""})),
      publishedPorts:Object.entries(c.NetworkSettings?.Ports ?? {}).slice(0,256).flatMap(([containerPort,bindings])=>(bindings??[]).slice(0,16).map(b=>({containerPort,hostIp:b.HostIp,hostPort:b.HostPort}))),exposedPorts:Object.keys(c.Config.ExposedPorts ?? {}).slice(0,256) };
  }
  const summary = () => ({ budget, aggregateMemory: options.memory, aggregateSwap: options.swap ?? 0, defaults, totalWorkspaces: Object.keys(state ?? {}).length, workspaces: Object.fromEntries(Object.entries(state ?? {}).sort(([,a],[,b]) => (b.blockedAt ?? 0) - (a.blockedAt ?? 0)).slice(0,128)) });
  return {
    status() { return summary(); },
    inspect(workspaceId: string) { return serialize("resources",async()=>{ await load(); const all=await containers(),c=all.find(c=>idOf(c)===workspaceId);if(!c)throw Error("Workspace resource target not found");return snapshot(c,all); }); },
    configure(workspaceId: string, input: WorkspaceResourceChange) { return serialize("resources",async()=>{
      if(closing)throw Error("System resource control is stopping");
      const changes=Value.Parse(workspaceResourceChangeSchema,input);await load();const all=await containers(),c=all.find(c=>idOf(c)===workspaceId);if(!c)throw Error("Workspace resource target not found");
      const e=entry(c);
      if(changes.memory>budget)throw Error(`RAM limit exceeds the per-workspace maximum of ${budget} bytes.`);
      if((options.swapSupported===false&&changes.additionalSwap>0)||changes.additionalSwap>(options.swap??0))throw Error("Additional swap limit exceeds the installation's shared workload swap capacity.");
      if(changes.cpus>options.cpus)throw Error("CPU limit exceeds the installation's effective CPU capacity.");
      const sample=await usage(c);
      if(c.State.Running && (sample.memory===undefined ? changes.memory<(c.HostConfig.Memory||Infinity) : changes.memory<sample.memory) && !changes.acknowledgeMemoryReduction)throw Error("Lowering RAM below current or unknown usage can kill processes. Confirm the reduction before applying.");
      await markPolicy(workspaceId);
      e.limits={memory:changes.memory,memorySwap:changes.memory+changes.additionalSwap,cpus:Math.floor(changes.cpus*1e9)/1e9,pids:e.limits.pids};e.managed=true;e.pending=true;delete e.applyError;await save();
      try { await apply(c,e);e.pending=false; }catch(error){console.error("Workspace resource update failed",error);e.applyError="Docker refused the resource update. Desired settings are saved; effective settings may differ. Refresh and retry, or park/unpark.";}
      await save();const fresh=await containers();return snapshot(fresh.find(v=>idOf(v)===workspaceId)??c,fresh);
    }); },
    shutdown() { closing = true; return serialize("resources", async () => {}); },
    reconcile(boot = false, restoreIds: readonly string[] = []) { return serialize("resources", async () => {
      if (closing) return { ...summary(), restore: [] };
      await load(); const before = JSON.stringify(state); const restore: string[] = []; const all = (await containers()).sort((a,b) => idOf(a)!.localeCompare(idOf(b)!));
      for (const c of all) {
        const known = Object.hasOwn(state, idOf(c)!);
        const e = entry(c);
        if (e.managed) await markPolicy(idOf(c)!);
        const previousFinish = e.finishedAt;
        try {
          await observe(c,e);
          if (e.managed && c.State.Running && (e.pending || !sameLimits(actual(c),e.limits) || !withinCapacity(e.limits))) {
            e.pending = true; e.applyError ??= "Docker settings differ from the saved configuration. Apply the saved limits or park/unpark to reconcile.";
            await options.docker("update", "--restart", "no", "--cpu-shares", "128", c.Id);
          } else { await apply(c,e); e.pending = false; delete e.applyError; }
        }
        catch (error) {
          e.reason = "Workspace stopped: resource control could not apply or verify its boundary.";
          console.error(e.reason, error); await save(); await markParked(idOf(c)!); await stop(c); continue;
        }
        if (e.blockedAt !== undefined) { e.desiredRunning = false; await stop(c); continue; }
        if (boot && !c.State.Running) {
          if (e.desiredRunning || (e.desiredRunning === undefined && restoreIds.includes(c.Id))) restore.push(c.Id);
          else if (!known || e.desiredRunning === false) { e.desiredRunning = false; e.reason = "Stopped workspace kept parked during recovery; explicit unpark is required."; await markParked(idOf(c)!); }
        } else if (!boot && !c.State.Running && e.desiredRunning && (!pending.has(idOf(c)!) || c.State.FinishedAt !== previousFinish)) {
          e.desiredRunning = false; e.reason = "Workspace kept parked after its container stopped; explicit unpark is required."; await markParked(idOf(c)!);
        }
        if (c.State.Running) {
          if (e.desiredRunning === false) { await markParked(idOf(c)!); await stop(c); continue; }
          e.desiredRunning = true; pending.delete(idOf(c)!);
        }
      }
      if (before !== JSON.stringify(state)) await save(); return { ...summary(), restore };
    }); },
    park(workspaceId: string) { return serialize("resources", async () => {
      await load(); const c = (await containers()).find(c => idOf(c) === workspaceId); if (!c) throw new Error("Workspace resource target not found");
      const e = entry(c); e.desiredRunning = false;
      if (e.blockedAt === undefined) e.reason = "Workspace is parked; explicit unpark is required.";
      pending.delete(workspaceId); await save(); await markParked(workspaceId); return null;
    }); },
    admit(workspaceId: string, recover = false) { return serialize("resources", async () => {
      if (closing) throw new Error("System resource control is stopping");
      await load(); const all = await containers(); const c = all.find(c => idOf(c) === workspaceId); if (!c) throw new Error("Workspace resource target not found");
      const e = entry(c); await observe(c,e);
      if (c.State.Running && e.managed && (e.pending || !sameLimits(actual(c), e.limits))) throw new Error("Saved resource changes are pending. Apply them explicitly, or park the workspace before starting it.");
      if (e.blockedAt !== undefined) {
        if (!recover || now() - e.blockedAt < 60_000) throw new Error(e.reason);
        delete e.blockedAt; delete e.reason;
      }
      if (e.desiredRunning === false && !recover) throw new Error("Workspace is parked; explicit unpark is required.");
      for (const [id, until] of pending) if (until <= now()) pending.delete(id);
      await apply(c,e); e.pending = false; delete e.applyError; e.desiredRunning = true; delete e.reason; await save(); pending.set(workspaceId, now() + 60_000);
      return null;
    }); },
  };
}
