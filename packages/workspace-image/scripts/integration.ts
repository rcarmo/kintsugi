// bun packages/workspace-image/scripts/integration.ts
// Uses the selected Docker context. Requires its Linux kernel to support EROFS.
// No System installation, host bind mounts, registry credentials, or parent services.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDefaultWorkspaceImage } from "../src/index.ts";

if (process.argv.length > 3) throw new Error("usage: bun packages/workspace-image/scripts/integration.ts [local-workspace-image]");
const id = `kintsugi-workspace-test-${process.pid}-${Date.now()}`;
const producer = `${id}-producer`;
const workspace = `${id}-workspace`;
const network = `${id}-network`;
const cache = `${id}-cache`;
const parents = `${id}-parents`;
const containers: string[] = [];
const volumes: string[] = [];
let createdNetwork = false;
const directory = await mkdtemp(join(tmpdir(), "kintsugi-workspace-test-"));
const token = crypto.randomUUID();

async function command(args: string[], check = true, input?: Uint8Array) {
  const child = Bun.spawn(args, { stdin: input, stdout: "pipe", stderr: "pipe" });
  const [out, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  const stdout = Buffer.from(out);
  if (check) assert.equal(code, 0, `${args.join(" ")}\n${stdout}\n${stderr}`);
  return { stdout, stderr, code };
}
async function exec(container: string, ...args: string[]) {
  return (await command(["docker", "exec", container, ...args])).stdout.toString();
}
async function state(container: string, service: string) {
  return (await command(["docker", "exec", container, "systemctl", "is-active", service], false)).stdout.toString().trim();
}
async function waitReady(container: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await command(["docker", "exec", container, "test", "-f", "/.kintsugi/ready"], false)).code === 0) return;
    await Bun.sleep(500);
  }
  throw new Error(`Gateway did not become ready: ${container}`);
}
async function start(image: string, name: string, writableCache: boolean) {
  const data = `${name}-data`;
  await command(["docker", "volume", "create", data]); volumes.push(data);
  await command(["docker", "create", "--name", name, "--privileged", "--cgroupns=private", "--tmpfs", "/run", "--stop-signal", "SIGRTMIN+3",
    "--network", network, "--mount", `type=volume,src=${data},dst=/data`,
    "--mount", `type=volume,src=${cache},dst=/data/erofs-cache${writableCache ? "" : ",readonly"}`,
    "--mount", `type=volume,src=${parents},dst=/run/kintsugi-parent,readonly`, image]);
  containers.push(name);
  await command(["docker", "cp", join(directory, "docker-support"), `${name}:/etc/kintsugi/docker-support`]);
  await command(["docker", "cp", join(directory, "token"), `${name}:/etc/kintsugi-workspace-gateway-token`]);
  await command(["docker", "start", name]);
  await waitReady(name);
  assert.equal(await state(name, "containerd.service"), "inactive");
  assert.equal(await state(name, "docker.service"), "inactive");
  assert.equal(await state(name, "docker.socket"), "active");
}
async function ctr(container: string, ...args: string[]) { return exec(container, "ctr", "--namespace", "moby", ...args); }

// Containerd records cache-backed layers as snapshot labels rather than symlinks.
async function cachedLayerBlobs(container: string) {
  const keys = (await ctr(container, "snapshots", "--snapshotter", "erofs", "ls")).trim().split("\n").slice(1).map((line) => line.split(/\s+/)[0]!);
  const blobs: string[] = [];
  for (const key of keys) {
    const labels: Record<string, string> = JSON.parse(await ctr(container, "snapshots", "--snapshotter", "erofs", "info", key)).Labels ?? {};
    if (labels["io.containerd.erofs.v1/blob.source"] === "cache") blobs.push(labels["io.containerd.erofs.v1/blob.ref"]!);
  }
  return blobs;
}
async function hashes() { return exec(producer, "sh", "-c", "find /data/erofs-cache -name '*.erofs' -type f -exec sha256sum {} + | sort"); }

try {
  console.log("Ensure the real module-contributed workspace image (first run may build)");
  const image = process.argv[2] ?? await ensureDefaultWorkspaceImage({ buildOutput: "inherit" });
  const before = (await command(["docker", "image", "inspect", "--format", "{{.Id}} {{.Created}}", image])).stdout.toString();
  if (!process.argv[2]) assert.equal(await ensureDefaultWorkspaceImage({ buildOutput: "inherit" }), image);
  assert.equal((await command(["docker", "image", "inspect", "--format", "{{.Id}} {{.Created}}", image])).stdout.toString(), before);
  console.log(`Reused ${image}`);
  await writeFile(join(directory, "token"), token);
  await writeFile(join(directory, "docker-support"), "enabled\n\n");
  for (const volume of [cache, parents]) { await command(["docker", "volume", "create", volume]); volumes.push(volume); }
  await command(["docker", "network", "create", network]); createdNetwork = true;
  await start(image, producer, true);
  await start(image, workspace, false);
  console.log("Booted with empty parent socket directory; neither Docker daemon started");
  assert.notEqual((await exec(workspace, "findmnt", "--noheadings", "--output", "FSTYPE", "--target", "/tmp")).trim(), "tmpfs");
  await command(["docker", "exec", "--user", "agent", workspace, "sh", "-c", "echo tmp-persistence-ok > /tmp/persistence-marker"]);
  assert.notEqual((await command(["docker", "exec", workspace, "touch", "/data/erofs-cache/must-not-write"], false)).code, 0);
  await exec(workspace, "curl", "--fail", "--silent", "--max-time", "30", "https://example.com");

  await writeFile(join(directory, "server.py"), "from http.server import BaseHTTPRequestHandler, HTTPServer\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b'localhost-gateway-ok')\nHTTPServer(('127.0.0.1',8080),Handler).serve_forever()\n");
  await command(["docker", "exec", "-i", workspace, "tee", "/tmp/server.py"], true, new Uint8Array(await Bun.file(join(directory, "server.py")).arrayBuffer()));
  await exec(workspace, "systemd-run", "--unit", "test-dev-server", "/usr/bin/python3", "/tmp/server.py");
  const ip = (await command(["docker", "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", workspace])).stdout.toString().trim();
  assert.equal(await exec(producer, "curl", "--fail", "--silent", "--retry", "3", "--retry-connrefused", "--max-time", "10", `http://${ip}:2999/products`,
    "-H", `X-Kintsugi-Gateway-Token: ${token}`, "-H", "X-Kintsugi-Gateway-Port: 8080", "-H", "X-Kintsugi-Gateway-Protocol: http", "-H", "X-Kintsugi-Gateway-Host: localhost:8080"), "localhost-gateway-ok");
  console.log("Internet access and gateway forwarding to a localhost-only server passed");

  await exec(producer, "systemctl", "start", "containerd.service");
  const platform = (await command(["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"])).stdout.toString().trim();
  const source = "docker.io/library/postgres:17";
  await ctr(producer, "content", "fetch", "--platform", platform, source);
  await ctr(producer, "images", "build-erofs-cache", source, "/data/erofs-cache");
  const originalHashes = await hashes();
  assert(originalHashes.length > 0);
  const archive = (await command(["docker", "exec", producer, "kintsugi-image-transfer", "export", "--platform", platform, source])).stdout;
  await writeFile(join(directory, "metadata.tar"), archive);
  const tarJson = async (path: string) => JSON.parse((await command(["tar", "xOf", join(directory, "metadata.tar"), path])).stdout.toString());
  const index = await tarJson("index.json");
  const manifest = await tarJson(`blobs/${index.manifests[0].digest.replace(":", "/")}`);

  // Offline consumer proves neither import nor build downloads a base layer.
  await command(["docker", "network", "disconnect", network, workspace]);
  await exec(workspace, "systemctl", "start", "containerd.service");
  const ref = (await command(["docker", "exec", "-i", workspace, "kintsugi-image-transfer", "import"], true, archive)).stdout.toString().trim();
  assert.equal(await state(workspace, "docker.service"), "inactive", "preloading must not start dockerd");
  assert.equal(await state(producer, "docker.service"), "inactive");
  async function noBaseBlobs() {
    const blobs = new Set((await ctr(workspace, "content", "list", "--quiet")).trim().split("\n"));
    for (const layer of manifest.layers) assert(!blobs.has(layer.digest), `base layer was downloaded: ${layer.digest}`);
  }
  await noBaseBlobs();
  const links = await cachedLayerBlobs(workspace);
  assert.equal(links.length, manifest.layers.length);
  assert(links.every(link => link.startsWith("/data/erofs-cache/")));
  console.log("Preloaded Postgres using containerd only, backed by readonly shared EROFS files");

  await command(["docker", "exec", "--user", "agent", workspace, "docker", "info"]);
  assert.match(await exec(workspace, "docker", "run", "--rm", "--network=none", ref, "postgres", "--version"), /PostgreSQL.*17\./);
  assert.equal(await state(workspace, "docker.service"), "active");
  await writeFile(join(directory, "Dockerfile"), `FROM ${ref}\nRUN postgres --version && echo workspace-build-ok > /marker\nCMD ["cat", "/marker"]\n`);
  await exec(workspace, "mkdir", "/tmp/build");
  await command(["docker", "exec", "-i", workspace, "tee", "/tmp/build/Dockerfile"], true, new Uint8Array(await Bun.file(join(directory, "Dockerfile")).arrayBuffer()));
  const started = performance.now();
  await exec(workspace, "docker", "build", "--network=none", "--no-cache", "--output", "type=image,store-allow-incomplete=true", "-t", "workspace-test:derived", "/tmp/build");
  console.log(`Offline cached Docker build: ${((performance.now() - started)/1000).toFixed(2)}s`);
  assert.equal((await exec(workspace, "docker", "run", "--rm", "--network=none", "workspace-test:derived")).trim(), "workspace-build-ok");
  await noBaseBlobs();
  await exec(workspace, "sh", "-c", "echo private-data > /data/persistence-marker");
  await command(["docker", "restart", "--time", "30", workspace]);
  await waitReady(workspace);
  assert.equal(await state(workspace, "docker.service"), "inactive");
  assert.equal(await state(workspace, "containerd.service"), "inactive");
  assert.equal((await exec(workspace, "cat", "/data/persistence-marker")).trim(), "private-data");
  assert.equal((await exec(workspace, "cat", "/tmp/persistence-marker")).trim(), "tmp-persistence-ok");
  assert.equal((await exec(workspace, "docker", "run", "--rm", "--network=none", "workspace-test:derived")).trim(), "workspace-build-ok");
  await noBaseBlobs();
  assert.equal(await hashes(), originalHashes);
  console.log("PASS: image reuse, lazy daemons, preload, readonly cache, offline run/build, gateway, internet, restart persistence");
} catch (error) {
  for (const container of containers) console.error((await command(["docker", "exec", container, "journalctl", "--no-pager", "-n", "100"], false)).stdout.toString());
  throw error;
} finally {
  for (const container of containers.reverse()) await command(["docker", "rm", "--force", container]);
  for (const volume of volumes.reverse()) await command(["docker", "volume", "rm", volume]);
  if (createdNetwork) await command(["docker", "network", "rm", network]);
  await rm(directory, { recursive: true, force: true });
}
