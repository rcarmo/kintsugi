/** Run the bundled script inside a disposable System. Uses a loopback-only registry,
 * real app-derived images, Docker downloads and the actual supervisor. The only
 * injected dependency is discovery of fixture releases instead of public GHCR.
 * No browser or UI assertions. Retains fixtures on failure for diagnosis.
 */
import { createKintsugiEventBus } from "@kintsugi/core";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { prepareUpdate } from "../src/server/docker.ts";
import { UpdateManager } from "../src/server/index.ts";
import { readStoredUpdateChannel, writeStoredUpdateChannel } from "../src/server/settings-store.ts";

process.env.ATELIER_DATA_DIR = "/data/app";

const name = `updater-${randomUUID().slice(0, 8)}`;
const directory = `/tmp/${name}`;
const registry = "127.0.0.1:5500";
const registryContainer = `${name}-registry`;
const marker = `/data/app/${name}-healthy`;
const log: string[] = [];
async function docker(...args: string[]) {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`docker ${args.slice(0, 4).join(" ")}: ${stderr || stdout}`);
  return stdout.trim();
}
async function supervisor(path: string, body?: { image?: string }) {
  const response = await fetch(`http://127.0.0.1:3001${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  assert(response.ok || response.status === 303, `supervisor ${path}: ${response.status} ${await response.clone().text()}`);
  return response;
}
async function statusSnapshot() {
  return Value.Parse(Type.Object({ healthy: Type.Boolean(), busy: Type.Boolean(), failure: Type.Optional(Type.String()), logs: Type.Array(Type.String()) }), await (await supervisor("/status")).json());
}
async function wait(description: string, check: () => Promise<boolean>, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(250); }
  throw new Error(`Timed out: ${description}`);
}
async function appId() { return docker("inspect", "kintsugi", "--format", "{{.Id}}"); }
async function workspaceIds() { return (await docker("ps", "-aq", "--filter", "label=com.kintsugi.type=workspace")).split("\n").filter(Boolean).sort(); }
async function releaseDigest(tag: string) {
  const response = await fetch(`http://${registry}/v2/kintsugi/manifests/${tag}`, { headers: { accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" } });
  assert(response.ok, `registry manifest ${tag}: ${response.status}`);
  const digest = response.headers.get("docker-content-digest");
  assert(digest && digest.startsWith("sha256:"));
  return digest;
}
async function build(tag: string, dockerfile: string) {
  const file = `${directory}/${tag}.Dockerfile`;
  await writeFile(file, dockerfile);
  await docker("build", "-f", file, "-t", `${registry}/kintsugi:${tag}`, directory);
  await docker("push", `${registry}/kintsugi:${tag}`);
}
function manager(digest: string) {
  return new UpdateManager({
    detectRuntime: async () => ({ currentDigest: `sha256:${"0".repeat(64)}` }),
    // Fixture registry supplies immutable manifests; preparation is the production code.
    fetchMetadata: async () => ({ digest }),
    prepareUpdate: (reference, progress) => prepareUpdate(`${registry}/kintsugi@${reference.split("@")[1]}`, progress),
    readChannel: readStoredUpdateChannel, writeChannel: writeStoredUpdateChannel,
    setInterval: () => {},
  });
}
function testContext() {
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

const context = testContext().ctx;
async function restored(previousAppId: string) {
  await wait("new app healthy", async () => {
    const status = await statusSnapshot();
    if (status.failure) throw new Error(status.failure);
    return status.healthy && !status.busy && await appId() !== previousAppId;
  });
}

await wait("initial app healthy", async () => { const status = await statusSnapshot(); return status.healthy && !status.busy; });
await mkdir(directory);
const initialImage = await docker("inspect", "kintsugi", "--format", "{{.Image}}");
const initialApp = await appId();
const beforeWorkspaces = await workspaceIds();
assert(beforeWorkspaces.length > 0, "keep at least one workspace running to verify updates preserve it");
const previousChannel = await readFile("/data/app/update.json", "utf8").catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
try {
  // A transient runtime outage must recover the same container, not replace it.
  await docker("pause", "kintsugi");
  try {
    await wait("runtime health failure", async () => {
      const status = await statusSnapshot();
      return Boolean(status.failure) && !status.busy;
    });
    await supervisor("/recheck", {});
    assert.equal((await statusSnapshot()).healthy, false, "recheck preserves an unhealthy app");
    assert.equal(await appId(), initialApp, "recheck must not replace the app");
  } finally {
    await docker("unpause", "kintsugi");
  }
  await wait("automatic health recovery", async () => {
    const status = await statusSnapshot();
    return status.healthy && !status.busy && !status.failure;
  });
  assert.equal(await appId(), initialApp, "automatic recovery must not replace the app");
  assert.deepEqual(await workspaceIds(), beforeWorkspaces);
  log.push("Transient runtime health failure recovered without replacing the app");

  await docker("run", "-d", "--name", registryContainer, "-p", "127.0.0.1:5500:5000", "registry:2");
  await wait("fixture registry", async () => { try { return (await fetch(`http://${registry}/v2/`)).ok; } catch { return false; } });
  const base = `${name}-base:local`;
  await docker("tag", initialImage, base);
  const dependency = `${registry}/kintsugi:${name}-dependency`;
  const label = JSON.stringify(JSON.stringify([dependency]));
  await build(`${name}-good`, `FROM ${base}\nLABEL eagerly-preload=${label}\n`);
  const goodDigest = await releaseDigest(`${name}-good`);
  const good = manager(goodDigest);
  await good.initialize(context);
  await good.startPull();
  assert.equal(good.snapshot().state, "failed", "missing dependency fails preparation");
  assert.equal(await appId(), initialApp, "preparation failure leaves old app running");
  assert((await statusSnapshot()).healthy);
  log.push("Preparation failure retained healthy old app");
  await build(`${name}-dependency`, `FROM ${base}\nLABEL kintsugi.update-test-dependency=${name}\n`);
  await good.startPull();
  assert.equal(good.snapshot().state, "ready_to_restart", "dependency retry prepares candidate");
  await good.setUpdateChannel("latest");
  await good.startPull();
  const acceptedAt = Date.now();
  await good.restart();
  assert.equal((await statusSnapshot()).healthy, false, "ACK occurs after switching away from healthy app");
  for (const path of ["/workspaces/existing?agent=root", "/settings?section=update"]) {
    const response = await supervisor(path);
    assert.equal(response.status, 303, "app destinations redirect to System progress");
    assert.equal(response.headers.get("location"), "/");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  await restored(initialApp);
  assert.deepEqual(await workspaceIds(), beforeWorkspaces);
  assert.equal(JSON.parse(await readFile("/data/app/update.json", "utf8")).releaseChannel, "latest");
  log.push(`Successful real-app replacement in ${Date.now() - acceptedAt}ms; workspaces/channel retained`);

  const failingCode = `if(await Bun.file(${JSON.stringify(marker)}).exists()){await import('/app/apps/web/src/server/main.ts')}else{console.log('acceptance: deliberately unhealthy');Bun.serve({hostname:'0.0.0.0',port:3000,fetch(){return new Response('deliberately unhealthy',{status:503})}})}`;
  await build(`${name}-unhealthy`, `FROM ${base}\nLABEL eagerly-preload=${JSON.stringify("[]")}\nCMD ${JSON.stringify(["bun", "-e", failingCode])}\n`);
  const unhealthy = manager(await releaseDigest(`${name}-unhealthy`));
  await unhealthy.initialize(context); await unhealthy.startPull();
  const healthyApp = await appId();
  await unhealthy.restart();
  await wait("unhealthy candidate failure", async () => Boolean((await statusSnapshot()).failure), 180_000);
  const failed = await statusSnapshot();
  assert.equal(failed.healthy, false);
  assert(failed.logs.some((line) => line.includes("deliberately unhealthy")), "supervisor retains candidate logs");
  assert.deepEqual(await workspaceIds(), beforeWorkspaces);
  await writeFile(marker, "retry should now start real Kintsugi");
  const failedApp = await appId();
  assert.notEqual(failedApp, healthyApp);
  await supervisor("/retry", {});
  await restored(failedApp);
  assert.deepEqual(await workspaceIds(), beforeWorkspaces);
  log.push("Unhealthy app exposed logs, preserved workspaces and recovered on retry");

  // Restore the exact initial production app, keeping this acceptance fixture out of normal use.
  const fixtureApp = await appId();
  if (previousChannel === undefined) { const process = Bun.spawn(["rm", "-f", "/data/app/update.json"]); await process.exited; }
  else await writeFile("/data/app/update.json", previousChannel);
  await supervisor("/update", { image: initialImage });
  await restored(fixtureApp);
  const cleanup = Bun.spawn(["rm", "-f", marker]); await cleanup.exited;
  await docker("rm", "-f", registryContainer);
  console.log(JSON.stringify({ passed: true, checks: log }, null, 2));
} catch (error) {
  console.error("Fixture retained:", { directory, registryContainer, initialImage, marker, log });
  throw error;
}
