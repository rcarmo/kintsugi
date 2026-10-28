import { createKintsugiEventBus } from "@kintsugi/core";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateManager, createUpdateRouteHandler, type UpdateManagerDeps } from "../../src/server/index.ts";
import { readStoredUpdateChannel, writeStoredUpdateChannel } from "../../src/server/settings-store.ts";
import { requestSupervisorUpdate } from "../../src/server/supervisor.ts";

function context() {
  const sidebar: string[] = [];
  const broadcasts: string[] = [];
  return {
    sidebar,
    broadcasts,
    ctx: {
      events: createKintsugiEventBus(),
      registry: { setAgentBusy: () => {}, requestSurfaceAttention: () => undefined, requestAttention: () => undefined },
      globalSidebarContributions: { set: (_id: string, html?: string, regions?: readonly import("@kintsugi/shared").LiveRegion[]) => {
        sidebar.push(html ?? "");
        broadcasts.push(regions?.map(region => region.html).join("") ?? "");
      } },
      createWorkView: async () => {},
      presentWorkView: async () => {},
      invalidateWorkspace: () => {},
      deleteCurrentWorkspace: async () => ({ deleted: false, blocked: false }),
      registerSocketHandler: () => {},
      publishWorkspacePort: async () => { throw new Error("not used"); },
      publishWorkspaceFiles: async () => { throw new Error("not used"); },
      registerWorkspaceAppResolver: () => {},
      registerProvisioningHook: () => {},
      onWorkspaceRemoved: () => {},
    },
  };
}

function noInterval() {}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const oldDigest = `sha256:${"a".repeat(64)}`;
const newDigest = `sha256:${"b".repeat(64)}`;
const newerDigest = `sha256:${"c".repeat(64)}`;
const exact = `ghcr.io/rcarmo/kintsugi@${newDigest}`;
function manager(extra: UpdateManagerDeps = {}) {
  return new UpdateManager({
    detectRuntime: async () => ({ currentDigest: oldDigest }),
    readSystemVersion: async () => 1,
    readNetworkStateVersion: async () => 0,
    readResourceStateVersion: async () => 0,
    fetchMetadata: async () => ({ digest: newDigest, requiredSystemVersion: 0 }),
    prepareUpdate: async (reference) => ({ reference, imageId: "sha256:prepared-image-id" }),
    setInterval: noInterval, ...extra,
  });
}
test("automatic release checks run once a day after the startup check", async () => {
  let tick: (() => void) | undefined;
  let interval = 0;
  let checks = 0;
  const instance = manager({
    fetchMetadata: async () => { checks += 1; return { digest: newDigest, requiredSystemVersion: 0 }; },
    setInterval: (callback, ms) => { tick = callback; interval = ms; },
  });
  await instance.initialize(context().ctx);
  expect(checks).toBe(1);
  expect(interval).toBe(24 * 60 * 60 * 1000);
  tick!();
  await Bun.sleep(0);
  expect(checks).toBe(2);
});

test("installation release checks wait a day while manual checks remain immediate", async () => {
  const day = 24 * 60 * 60 * 1000;
  let now = 1_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let tick: (() => void) | undefined;
  let checks = 0;
  const status = async () => ({ phase: "idle" as const, message: "Up to date" });
  const instance = manager({
    installationClient: {
      installed: async () => true, status,
      check: async () => { checks += 1; return status(); },
      prepare: status, apply: status, rollback: status,
    },
    setInterval: callback => { tick = callback; },
  });
  try {
    await instance.initialize(context().ctx);
    expect(checks).toBe(1);
    now += 5 * 60 * 1000;
    tick!();
    await Bun.sleep(0);
    expect(checks).toBe(1);
    await instance.checkNow();
    expect(checks).toBe(2);
    now += day - 1;
    tick!();
    await Bun.sleep(0);
    expect(checks).toBe(2);
    now += 1;
    tick!();
    await Bun.sleep(0);
    expect(checks).toBe(3);
  } finally {
    clock.mockRestore();
  }
});

test("non-System installations neither discover updates nor accept update operations", async () => {
  const instance = manager({ detectRuntime: async () => undefined, fetchMetadata: async () => { throw new Error("must not check"); } });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().selfUpdatable).toBe(false);
  expect(() => instance.startPull()).toThrow("System-managed");
  const route = createUpdateRouteHandler(instance);
  for (const path of ["/update/start", "/update/restart", "/update/check-now", "/settings/update-channel"]) {
    const url = new URL(path, "http://localhost");
    expect((await route(new Request(url, { method: "POST" }), url))!.status).toBe(409);
  }
});
test("download remains in progress until all preparation completes; restart uses the exact prepared image", async () => {
  const gate = deferred();
  const requests: string[] = [];
  const instance = manager({ prepareUpdate: async (reference, progress) => {
    expect(reference).toBe(exact);
    progress({ kind: "progress", percent: 60, message: "Downloading workspace image" });
    await gate.promise;
    return { reference, imageId: "sha256:prepared-image-id" };
  }, requestUpdate: async (image) => { requests.push(image); } });
  await instance.initialize(context().ctx);
  const pull = instance.startPull();
  expect(instance.startPull()).toBe(pull);
  await Bun.sleep(0); // The data-format preflight completes before downloads begin.
  expect(instance.snapshot()).toMatchObject({ state: "pulling", percent: 60 });
  await expect(instance.restart()).rejects.toThrow("No prepared update");
  await expect(instance.setUpdateChannel("latest")).rejects.toThrow("in progress");
  gate.resolve(); await pull;
  expect(instance.snapshot().state).toBe("ready_to_restart");
  await instance.restart();
  expect(requests).toEqual(["sha256:prepared-image-id"]);
  expect(instance.snapshot().state).toBe("restarting");
  await expect(instance.restart()).rejects.toThrow("already in progress");
});
test("preparation failure keeps the old app running and offers a retry", async () => {
  let attempts = 0;
  const instance = manager({ prepareUpdate: async (reference) => {
    if (++attempts === 1) throw new Error("workspace image unavailable");
    return { reference, imageId: "sha256:prepared" };
  }, requestUpdate: async () => { throw new Error("must not restart while preparing"); } });
  await instance.initialize(context().ctx);
  await instance.startPull();
  expect(instance.snapshot()).toMatchObject({ state: "failed", error: "workspace image unavailable" });
  await expect(instance.restart()).rejects.toThrow("No prepared update");
  await instance.startPull();
  expect(instance.snapshot()).toMatchObject({ state: "ready_to_restart", error: undefined });
});
test("supervisor failure keeps prepared image available for retry", async () => {
  let requests = 0;
  const instance = manager({ requestUpdate: async () => { if (++requests === 1) throw new Error("supervisor busy"); } });
  await instance.initialize(context().ctx); await instance.startPull();
  await expect(instance.restart()).rejects.toThrow("supervisor busy");
  expect(instance.snapshot()).toMatchObject({ state: "ready_to_restart", error: "supervisor busy" });
  await instance.restart();
  expect(requests).toBe(2);
});
test("restart route acknowledges same-origin reload only after supervisor acceptance", async () => {
  const accepted = deferred();
  const instance = manager({ requestUpdate: async () => accepted.promise });
  await instance.initialize(context().ctx); await instance.startPull();
  const route = createUpdateRouteHandler(instance);
  const url = new URL("https://kintsugi.example/update/restart?surface=settings");
  const pending = route(new Request(url, { method: "POST" }), url);
  expect(instance.snapshot().state).toBe("restarting");
  accepted.resolve();
  const response = (await pending)!;
  expect(response.status).toBe(204);
  expect(response.headers.get("x-kintsugi-reload")).toBe("true");
  expect(response.headers.has("location")).toBe(false);
});
test("background checks cannot replace a pinned download or prepared target", async () => {
  const pendingCheck = deferred<{ digest: string; requiredSystemVersion?: number }>();
  let checks = 0;
  const instance = manager({ fetchMetadata: async () => ++checks === 1 ? { digest: newDigest, requiredSystemVersion: 0 } : pendingCheck.promise });
  await instance.initialize(context().ctx);
  const stale = instance.checkNow();
  await Bun.sleep(0); // Admit the registry request before starting the immutable download.
  await instance.startPull();
  pendingCheck.resolve({ digest: newerDigest, requiredSystemVersion: 0 });
  await stale;
  await instance.checkNow();
  expect(instance.snapshot().target!.digest).toBe(newDigest);
  expect(instance.snapshot().state).toBe("ready_to_restart");
  expect(checks).toBe(2);
});
test("channel changes persist, discard prior prepared images, and survive manager restart", async () => {
  const previous = process.env.ATELIER_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-update-settings-"));
  process.env.ATELIER_DATA_DIR = directory;
  try {
    await writeStoredUpdateChannel("stable");
    expect(JSON.parse(await readFile(join(directory, "update.json"), "utf8"))).toEqual({ releaseChannel: "stable", releaseSelection: "stable" });
    const dependencies = { readChannel: readStoredUpdateChannel, writeChannel: writeStoredUpdateChannel };
    const instance = manager(dependencies);
    await instance.initialize(context().ctx); await instance.startPull();
    await instance.setUpdateChannel("latest");
    await expect(instance.restart()).rejects.toThrow("No prepared update");
    const restarted = manager(dependencies);
    await restarted.initialize(context().ctx);
    expect(restarted.snapshot().updateChannel).toBe("latest");
    expect(JSON.parse(await readFile(join(directory, "update.json"), "utf8"))).toEqual({ releaseChannel: "latest", releaseSelection: "latest" });
  } finally {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR; else process.env.ATELIER_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
test("a superseded channel check cannot publish success or failure", async () => {
  for (const fail of [false, true]) {
    const pending = deferred<{ digest: string; requiredSystemVersion?: number }>();
    const instance = manager({ readChannel: async () => "stable", fetchMetadata: async (channel) => channel === "latest" ? pending.promise : { digest: newDigest, requiredSystemVersion: 0 } });
    await instance.initialize(context().ctx);
    const stale = instance.setUpdateChannel("latest");
    await Bun.sleep(0);
    await instance.setUpdateChannel("stable");
    const snapshot = instance.snapshot();
    if (fail) pending.reject(new Error("registry failed")); else pending.resolve({ digest: newerDigest, requiredSystemVersion: 0 });
    await stale;
    expect(instance.snapshot()).toEqual(snapshot);
  }
});
test("supervisor protocol sends only immutable image ID and requires acceptance", async () => {
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("http://127.0.0.1:3001/update");
    expect(JSON.parse(String(init!.body))).toEqual({ image: "sha256:prepared" });
    return Response.json({ accepted: true }, { status: 202 });
  });
  await requestSupervisorUpdate("sha256:prepared", fetcher);
  await expect(requestSupervisorUpdate("sha256:prepared", async () => new Response("busy", { status: 409 }))).rejects.toThrow("busy");
});

test("new installations discover latest updates and pin their immutable image", async () => {
  const channels: string[] = [];
  const prepared: string[] = [];
  const instance = manager({
    readChannel: async () => undefined,
    fetchMetadata: async (channel) => { channels.push(channel); return { digest: newDigest, requiredSystemVersion: 0 }; },
    prepareUpdate: async (reference) => { prepared.push(reference); return { reference, imageId: "sha256:latest-image" }; },
  });
  expect(instance.snapshot().updateChannel).toBe("latest");
  await instance.initialize(context().ctx);
  expect(instance.snapshot()).toMatchObject({ updateChannel: "latest", state: "available" });
  expect(channels).toEqual(["latest"]);
  await instance.startPull();
  expect(prepared).toEqual([exact]);
  expect(instance.snapshot().state).toBe("ready_to_restart");
});

test.each(["stable", "latest"] as const)("stored %s channel overrides the latest default", async (channel) => {
  const channels: string[] = [];
  const instance = manager({
    readChannel: async () => channel,
    fetchMetadata: async (selected) => { channels.push(selected); return { digest: newDigest, requiredSystemVersion: 0 }; },
  });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().updateChannel).toBe(channel);
  expect(channels).toEqual([channel]);
});

test("switching from stable to latest persists the channel and refreshes the target", async () => {
  const previous = process.env.ATELIER_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-latest-settings-"));
  process.env.ATELIER_DATA_DIR = directory;
  try {
    await writeStoredUpdateChannel("stable");
    const channels: string[] = [];
    const dependencies = {
      readChannel: readStoredUpdateChannel,
      writeChannel: writeStoredUpdateChannel,
      fetchMetadata: async (channel: "stable" | "latest" | "custom") => {
        channels.push(channel);
        return { digest: channel === "latest" ? newerDigest : newDigest, requiredSystemVersion: 0 };
      },
    };
    const instance = manager(dependencies);
    await instance.initialize(context().ctx);
    await instance.startPull();
    await instance.setUpdateChannel("latest");
    expect(channels).toEqual(["stable", "latest"]);
    expect(instance.snapshot()).toMatchObject({ updateChannel: "latest", state: "available", target: { digest: newerDigest, requiredSystemVersion: 0 } });
    await expect(instance.restart()).rejects.toThrow("No prepared update");
    expect(await readStoredUpdateChannel()).toBe("latest");
    const restarted = manager(dependencies);
    await restarted.initialize(context().ctx);
    expect(restarted.snapshot().updateChannel).toBe("latest");
  } finally {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR; else process.env.ATELIER_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("fork updates pin the configured app repository rather than upstream", async () => {
  const releaseSource = { appRepository: "ghcr.io/example/fork-app", systemRepository: "ghcr.io/example/fork-system" };
  const references: string[] = [];
  const instance = manager({ readSource: async () => releaseSource, prepareUpdate: async reference => { references.push(reference); return { reference, imageId: "prepared" }; } });
  await instance.initialize(context().ctx);
  await instance.startPull();
  expect(references).toEqual([`ghcr.io/example/fork-app@${newDigest}`]);
  instance.snapshot().releaseSource.appRepository = "ghcr.io/other/app";
  expect(instance.snapshot().releaseSource.appRepository).toBe(releaseSource.appRepository);
});

test("changing source persists and discards the old prepared target", async () => {
  const saved: string[] = [];
  const instance = manager({ writeSource: async source => { saved.push(source.appRepository); } });
  await instance.initialize(context().ctx);
  await instance.startPull();
  await instance.setReleaseSource({ appRepository: "ghcr.io/example/app", systemRepository: "ghcr.io/example/system", appVersion: "v1" });
  expect(saved).toEqual(["ghcr.io/example/app"]);
  expect(instance.snapshot().state).toBe("available");
  await expect(instance.restart()).rejects.toThrow("No prepared update");
});

test("JSON source and update controls return JSON without Turbo markup", async () => {
  const instance = manager();
  await instance.initialize(context().ctx);
  const handler = createUpdateRouteHandler(instance);
  for (const [path, method, body] of [
    ["/settings/release-source", "GET", undefined],
    ["/update/status", "GET", undefined],
    ["/settings/release-source", "POST", JSON.stringify({ appRepository: "ghcr.io/example/app", systemRepository: "ghcr.io/example/system" })],
    ["/settings/update-channel", "POST", JSON.stringify({ channel: "stable" })],
    ["/update/check-now", "POST", "{}"],
  ] as const) {
    const url = new URL(path, "http://localhost");
    const response = (await handler(new Request(url, { method, body, headers: { accept: "application/json", "content-type": "application/json" } }), url))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  }
});

test("Latest follows the configured custom repositories and Custom reopens their fields", async () => {
  const previous = process.env.ATELIER_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "custom-channel-"));
  process.env.ATELIER_DATA_DIR = directory;
  try {
    const { readStoredReleaseSource, writeStoredReleaseSource } = await import("../../src/server/settings-store.ts");
    await writeStoredReleaseSource({ appRepository: "docker.io/example/app", systemRepository: "ghcr.io/example/system", appVersion: "v2" });
    expect(await readStoredUpdateChannel()).toBe("custom");
    await writeStoredUpdateChannel("stable");
    expect(await readStoredUpdateChannel()).toBe("stable");
    expect((await readStoredReleaseSource())!.appRepository).toBe("docker.io/example/app");
    await writeStoredUpdateChannel("custom");
    expect(await readStoredUpdateChannel()).toBe("custom");
    const instance = manager({ readChannel: readStoredUpdateChannel, readSource: readStoredReleaseSource, writeChannel: writeStoredUpdateChannel });
    await instance.initialize(context().ctx);
    expect(instance.snapshot().updateChannel).toBe("custom");
    await instance.setUpdateChannel("latest");
    const references: string[] = [];
    const upstream = manager({ readChannel: readStoredUpdateChannel, readSource: readStoredReleaseSource, prepareUpdate: async reference => { references.push(reference); return { reference, imageId: "test" }; } });
    await upstream.initialize(context().ctx); await upstream.startPull();
    expect(references).toEqual([`docker.io/example/app@${newDigest}`]);
  } finally {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR; else process.env.ATELIER_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid release configuration disables updates without aborting app initialization", async () => {
  const instance = manager({ readSource: async () => { throw new Error("Invalid release settings"); } });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().state).toBe("failed");
  expect(instance.snapshot().error).toBe("Invalid release settings");
  expect(() => instance.startPull()).toThrow("No update is available");
  await instance.setReleaseSource({ appRepository: "ghcr.io/example/app", systemRepository: "ghcr.io/example/system" });
  expect(instance.snapshot().updateChannel).toBe("custom");
  expect(instance.snapshot().state).toBe("available");
});

test("unchanged revision does not report a platform/index digest difference as an update", async () => {
  const instance = manager({ detectRuntime: async () => ({ currentDigest: oldDigest, currentRevision: "same" }), fetchMetadata: async () => ({ digest: newDigest, requiredSystemVersion: 0, revision: "same" }) });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().state).toBe("idle");
});

test("saving a source returns success even if its subsequent registry check fails", async () => {
  let fail = false;
  const instance = manager({ fetchMetadata: async () => { if (fail) throw new Error("Registry unavailable"); return { digest: newDigest, requiredSystemVersion: 0 }; } });
  await instance.initialize(context().ctx); fail = true;
  const url = new URL("http://localhost/settings/release-source");
  const response = (await createUpdateRouteHandler(instance)(new Request(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ appRepository: "ghcr.io/example/app", systemRepository: "ghcr.io/example/system" }) }), url))!;
  expect(response.status).toBe(200);
  expect(instance.snapshot().state).toBe("failed");
  expect(instance.snapshot().updateChannel).toBe("custom");
});

test("unlabelled images compare the running index digest with the remote index", async () => {
  const instance = manager({ detectRuntime: async () => ({ currentDigest: oldDigest }), fetchMetadata: async () => ({ digest: newDigest, requiredSystemVersion: 0, indexDigest: oldDigest }) });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().state).toBe("idle");
});


test("existing controls use a whole-installation plan rather than the app updater",async()=>{
  const plan={id:crypto.randomUUID(),app:exact,system:`ghcr.io/rcarmo/kintsugi-system@${newerDigest}`,available:true,selection:"selection",previousSystem:oldDigest,previousApp:oldDigest};
  const calls:string[]=[];
  const installationClient={installed:async()=>true,status:async()=>({phase:"available" as const,plan,message:"available"}),check:async()=>({phase:"available" as const,plan,message:"available"}),prepare:async(id:string)=>{calls.push("prepare:"+id);return {phase:"ready" as const,plan,message:"ready"};},apply:async(id:string)=>{calls.push("apply:"+id);return {phase:"updating" as const,plan,message:"updating"};},rollback:async()=>({phase:"updating" as const,plan,message:"rollback"})};
  const instance=manager({installationClient,prepareUpdate:async()=>{throw Error("app-only preparation must not run");},requestUpdate:async()=>{throw Error("app-only replacement must not run");}});
  await instance.initialize(context().ctx);expect(instance.snapshot().updateScope).toBe("installation");
  await instance.startPull();expect(instance.snapshot().state).toBe("ready_to_restart");await instance.restart();expect(instance.snapshot().state).toBe("restarting");expect(calls).toEqual(["prepare:"+plan.id,"apply:"+plan.id]);
});

test("an installed but unavailable updater fails closed",async()=>{
  const unavailable=async()=>{throw Error("host service unavailable");};
  const instance=manager({installationClient:{installed:async()=>true,status:unavailable,check:unavailable,prepare:unavailable,apply:unavailable,rollback:unavailable}});
  await instance.initialize(context().ctx);expect(instance.snapshot()).toMatchObject({updateScope:"installation",state:"failed"});expect(()=>instance.startPull()).toThrow("No update is available");
});


test("installation progress polls quickly and clears restarting when the host finishes",async()=>{
  let phase:import("@kintsugi/shared/installation-update").InstallationUpdate["phase"]="updating";let tick:(()=>void)|undefined;let milliseconds=0;
  const status=async()=>({phase,message:phase});
  const instance=manager({installationClient:{installed:async()=>true,status,check:status,prepare:status,apply:status,rollback:status},setInterval:(callback,ms)=>{tick=callback;milliseconds=ms;}});
  await instance.initialize(context().ctx);expect(milliseconds).toBe(2000);expect(instance.snapshot().state).toBe("restarting");phase="succeeded";tick!();await Bun.sleep(0);expect(instance.snapshot().state).toBe("idle");
});


test("temporary service loss during restart recovers without app-only fallback",async()=>{
  let available=false;let tick:(()=>void)|undefined;const status=async()=>{if(!available)throw Error("socket unavailable");return {phase:"succeeded" as const,message:"healthy"};};
  const instance=manager({installationClient:{installed:async()=>true,status,check:status,prepare:status,apply:status,rollback:status},setInterval:callback=>{tick=callback;}});
  await instance.initialize(context().ctx);expect(instance.snapshot()).toMatchObject({updateScope:"installation",state:"failed"});available=true;tick!();await Bun.sleep(0);expect(instance.snapshot().state).toBe("idle");
});

test("app-only updates requiring newer services are refused before downloading", async () => {
  let downloads = 0;
  const instance = manager({ readSystemVersion: async () => 1, fetchMetadata: async () => ({ digest: newDigest, requiredSystemVersion: 2 }), prepareUpdate: async () => { downloads++; return { reference: exact, imageId: "unused" }; } });
  await instance.initialize(context().ctx);
  expect(instance.snapshot()).toMatchObject({ state: "available", systemVersion: 1, targetNeedsInstaller: true });
  await instance.startPull();
  expect(instance.snapshot().state).toBe("installer_required");
  expect(downloads).toBe(0);
  await instance.checkNow();
  expect(instance.snapshot().state).toBe("installer_required");
});

test("unknown metadata cannot authorise replacement; verified legacy requirements can", async () => {
  for (const requiredSystemVersion of [undefined, 0]) {
    let downloads = 0;
    const instance = manager({ readSystemVersion: async () => 0, fetchMetadata: async () => ({ digest: newDigest, requiredSystemVersion }), prepareUpdate: async () => { downloads++; return { reference: exact, imageId: "prepared" }; } });
    await instance.initialize(context().ctx);
    await instance.startPull();
    expect(downloads).toBe(requiredSystemVersion === undefined ? 0 : 1);
    expect(instance.snapshot().state).toBe(requiredSystemVersion === undefined ? "installer_required" : "ready_to_restart");
  }
});

test("a new compatible target clears installer guidance without changing saved sources", async () => {
  let requirement = 2;
  let writes = 0;
  const instance = manager({ readSystemVersion: async () => 1, fetchMetadata: async () => ({ digest: requirement === 2 ? newDigest : newerDigest, requiredSystemVersion: requirement }), writeSource: async () => { writes++; } });
  await instance.initialize(context().ctx); await instance.startPull();
  expect(instance.snapshot().state).toBe("installer_required");
  requirement = 1;
  await instance.checkNow();
  expect(instance.snapshot()).toMatchObject({ state: "available", targetNeedsInstaller: false });
  expect(writes).toBe(0);
});

test("a data-incompatible app-only downgrade is refused before downloading", async () => {
  let downloads = 0;
  const instance = manager({ readSystemVersion: async () => 2, readNetworkStateVersion: async () => 2, fetchMetadata: async () => ({ digest: newDigest, requiredSystemVersion: 0, networkPolicyVersion: 0 }), prepareUpdate: async () => { downloads++; return { reference: exact, imageId: "unused" }; } });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().targetNeedsPolicyReset).toBe(true);
  await instance.startPull();
  expect(instance.snapshot().state).toBe("installer_required");
  expect(downloads).toBe(0);
});

const revision = (n: number) => n.toString(16).padStart(40, "0");
const history = { releases: [], targetHasNotes: false, compareUrl: `https://github.com/rcarmo/kintsugi/compare/${revision(1)}...${revision(2)}` };
test("release notes use the installed and selected app revisions without changing the update", async () => {
  const instance = manager({
    detectRuntime: async () => ({ currentDigest: oldDigest, currentRevision: revision(1) }),
    fetchMetadata: async () => ({ digest: newDigest, revision: revision(2), requiredSystemVersion: 0 }),
    fetchReleaseHistory: async (current, target) => { expect([current, target]).toEqual([revision(1), revision(2)]); return history; },
  });
  await instance.initialize(context().ctx);
  const before = instance.snapshot();
  expect(await instance.releaseHistory()).toEqual(history);
  expect(instance.snapshot()).toEqual(before);
});
test("paired notes resolve the plan's immutable app digest, not a channel", async () => {
  const status = async () => ({ phase: "available" as const, message: "Update available", plan: { id: "plan", app: exact, system: `ghcr.io/rcarmo/kintsugi-system@${newDigest}`, available: true, selection: "latest", previousApp: oldDigest, previousSystem: oldDigest } });
  const instance = manager({
    detectRuntime: async () => ({ currentDigest: oldDigest, currentRevision: revision(1) }),
    installationClient: { installed: async () => true, status, check: status, prepare: status, apply: status, rollback: status },
    resolveNotesMetadata: async reference => { expect(reference).toBe(exact); return {digest:newDigest,revision:revision(2)}; },
    fetchReleaseHistory: async (current, target) => { expect([current, target]).toEqual([revision(1), revision(2)]); return history; },
  });
  await instance.initialize(context().ctx);
  expect(await instance.releaseHistory()).toEqual(history);
});
test("custom release sources never receive default-repository history or an implicit source change", async () => {
  let fetched = false;
  const instance = manager({ detectRuntime: async () => ({currentDigest:oldDigest,currentRevision:revision(1)}), resolveNotesMetadata: async () => ({digest:newDigest,revision:revision(2)}), readSource: async () => ({ appRepository: "docker.io/example/private", systemRepository: "ghcr.io/example/system", appVersion: "v3" }), fetchReleaseHistory: async () => { fetched = true; return history; } });
  await instance.initialize(context().ctx);
  const before = instance.snapshot();
  await expect(instance.releaseHistory()).rejects.toThrow("no GitHub source label");
  expect(fetched).toBe(false);
  expect(instance.snapshot()).toEqual(before);
});
test("missing revisions and failed history leave the selected update usable", async () => {
  const missing = manager();
  await missing.initialize(context().ctx);
  await expect(missing.releaseHistory()).rejects.toThrow("does not identify");
  const instance = manager({ detectRuntime: async () => ({ currentDigest: oldDigest, currentRevision: revision(1) }), fetchMetadata: async () => ({ digest: newDigest, revision: revision(2), requiredSystemVersion: 0 }), fetchReleaseHistory: async () => { throw new Error("GitHub unavailable"); } });
  await instance.initialize(context().ctx);
  await expect(instance.releaseHistory()).rejects.toThrow("GitHub unavailable");
  expect(instance.snapshot().state).toBe("available");
  await instance.startPull();
  expect(instance.snapshot().state).toBe("ready_to_restart");
});
test("an in-flight notes response cannot describe a superseded update selection", async () => {
  const pending = deferred<typeof history>();
  const instance = manager({ detectRuntime: async () => ({ currentDigest: oldDigest, currentRevision: revision(1) }), fetchMetadata: async () => ({ digest: newDigest, revision: revision(2), requiredSystemVersion: 0 }), fetchReleaseHistory: () => pending.promise });
  await instance.initialize(context().ctx);
  const notes = instance.releaseHistory();
  await instance.setUpdateChannel("stable");
  pending.resolve(history);
  await expect(notes).rejects.toThrow("selection changed");
});

test("custom notes resolve the configured pinned image and use its GitHub source label", async () => {
  const instance=manager({detectRuntime:async()=>({currentDigest:oldDigest,currentRevision:revision(1)}),readSource:async()=>({appRepository:"docker.io/example/app",systemRepository:"ghcr.io/example/system",appVersion:"v3"}),resolveNotesMetadata:async reference=>{expect(reference).toBe(`docker.io/example/app@${newDigest}`);return {digest:newDigest,revision:revision(2),source:"https://github.com/example/code.git"};},fetchReleaseHistory:async(_current,_target,_fetcher,options)=>{expect(options?.repository).toBe("example/code");return history;}});
  await instance.initialize(context().ctx);const before=instance.snapshot();expect(await instance.releaseHistory()).toEqual(history);expect(instance.snapshot()).toEqual(before);
});
test("explicit GitHub notes override does not mutate sources or need registry rediscovery", async () => {
  let inspected=false;const instance=manager({detectRuntime:async()=>({currentDigest:oldDigest,currentRevision:revision(1)}),readSource:async()=>({appRepository:"docker.io/example/app",systemRepository:"ghcr.io/example/system"}),fetchMetadata:async()=>({digest:newDigest,revision:revision(2),requiredSystemVersion:0}),resolveNotesMetadata:async()=>{inspected=true;throw Error("not needed");},fetchReleaseHistory:async(_current,_target,_fetcher,options)=>{expect(options?.repository).toBe("example/notes");return history;}});
  await instance.initialize(context().ctx);const before=instance.snapshot();await instance.releaseHistory("example/notes");expect(inspected).toBe(false);expect(instance.snapshot()).toEqual(before);await expect(instance.releaseHistory("https://evil.example/repo")).rejects.toThrow("owner/name");
});
test("older metadata readers cannot substitute a moving channel for a pinned notes target", async () => {
  const instance=manager({detectRuntime:async()=>({currentDigest:oldDigest,currentRevision:revision(1)}),fetchMetadata:async()=>({digest:newDigest,requiredSystemVersion:0}),resolveNotesMetadata:async()=>({digest:newerDigest,revision:revision(2),source:"https://github.com/example/repo"})});
  await instance.initialize(context().ctx);await expect(instance.releaseHistory()).rejects.toThrow("selected image changed");expect(instance.snapshot().state).toBe("available");
});

test("resource-incompatible app-only downgrades refuse download and keep configuration intact",async()=>{
  let downloads=0;const instance=manager({readSystemVersion:async()=>3,readResourceStateVersion:async()=>1,fetchMetadata:async()=>({digest:newDigest,requiredSystemVersion:0,resourcePolicyVersion:0}),prepareUpdate:async()=>{downloads++;return{reference:exact,imageId:"unused"};}});
  await instance.initialize(context().ctx);expect(instance.snapshot().targetNeedsResourceReader).toBe(true);await instance.startPull();expect(instance.snapshot().state).toBe("installer_required");expect(downloads).toBe(0);
});
test("resource requirements added after preparation are revalidated before app activation",async()=>{
  let required=0,requests=0;const instance=manager({readResourceStateVersion:async()=>required,requestUpdate:async()=>{requests++;}});await instance.initialize(context().ctx);await instance.startPull();required=1;
  await expect(instance.restart()).rejects.toThrow("resource-aware");expect(requests).toBe(0);
});
