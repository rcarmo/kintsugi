// bun images/patched-docker/image-transfer-test.ts [runtime-image] [linux/arm64|linux/amd64]
// Requires a Linux Docker host with EROFS. The consumer has no network at all.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = process.argv[2] ?? "kintsugi-patched-docker:dev";
const platform = process.argv[3] ?? "linux/arm64";
assert(["linux/arm64", "linux/amd64"].includes(platform));
const id = `kintsugi-transfer-${platform.split("/")[1]}-${process.pid}`;
const producer = `${id}-producer`;
const consumer = `${id}-consumer`;
const cache = `${id}-cache`;
const containers: string[] = [];
const volumes: string[] = [];
const context = await mkdtemp(join(tmpdir(), "kintsugi-image-transfer-"));
const source = "docker.io/library/kintsugi-transfer:local";
const registry = "docker.io/library/alpine:3.22";
const registryPinned = `${registry}@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce`;

async function command(args: string[], check = true, input?: Uint8Array) {
  const child = Bun.spawn(args, { stdin: input, stdout: "pipe", stderr: "pipe" });
  const [bytes, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited,
  ]);
  const stdout = Buffer.from(bytes);
  if (check) assert.equal(code, 0, `${args.join(" ")}\n${stdout}\n${stderr}`);
  return { stdout, stderr, code };
}
async function exec(container: string, ...args: string[]) {
  return (await command(["docker", "exec", container, ...args])).stdout.toString();
}
async function ctr(container: string, ...args: string[]) {
  return exec(container, "ctr", "--namespace", "moby", ...args);
}

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
async function ready(container: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await command(["docker", "exec", container, "docker", "info"], false)).code === 0) return;
    await Bun.sleep(500);
  }
  assert.fail(`daemon did not start: ${container}`);
}
async function start(container: string, offline: boolean) {
  for (const volume of [cache, `${container}-data`]) {
    if (volumes.includes(volume)) continue;
    await command(["docker", "volume", "create", volume]);
    volumes.push(volume);
  }
  await command(["docker", "run", "--detach", "--privileged", "--platform", platform,
    ...(offline ? ["--network", "none"] : []), "--name", container,
    "--mount", `type=volume,src=${container}-data,dst=/data`,
    "--mount", `type=volume,src=${cache},dst=/data/erofs-cache${offline ? ",readonly" : ""}`, image]);
  containers.push(container);
  await ready(container);
}
async function exportArchive(name: string) {
  return (await command(["docker", "exec", producer, "kintsugi-image-transfer", "export", "--platform", platform, name])).stdout;
}
async function importArchive(archive: Uint8Array, check = true) {
  return command(["docker", "exec", "-i", consumer, "kintsugi-image-transfer", "import"], check, archive);
}
async function transfer(name: string) {
  const sender = Bun.spawn(["docker", "exec", producer, "kintsugi-image-transfer", "export", "--platform", platform, name], { stdout: "pipe", stderr: "pipe" });
  const receiver = Bun.spawn(["docker", "exec", "-i", consumer, "kintsugi-image-transfer", "import"], { stdin: sender.stdout, stdout: "pipe", stderr: "pipe" });
  const [out, senderError, receiverError, senderCode, receiverCode] = await Promise.all([
    new Response(receiver.stdout).text(), new Response(sender.stderr).text(), new Response(receiver.stderr).text(), sender.exited, receiver.exited,
  ]);
  assert.equal(senderCode, 0, senderError);
  assert.equal(receiverCode, 0, receiverError);
  return out.trim();
}
async function archiveContents(archive: Uint8Array) {
  const path = join(context, "metadata.tar");
  await writeFile(path, archive);
  const names = (await command(["tar", "tf", path])).stdout.toString().trim().split("\n");
  assert.equal(names.length, 4);
  const read = async (name: string) => JSON.parse((await command(["tar", "xOf", path, name])).stdout.toString());
  const index = await read("index.json");
  const descriptor = index.manifests[0];
  const manifest = await read(`blobs/${descriptor.digest.replace(":", "/")}`);
  assert(!manifest.manifests, "export selects one platform, not a dangling index");
  for (const layer of manifest.layers) assert(!names.includes(`blobs/${layer.digest.replace(":", "/")}`));
  return { descriptor, manifest };
}
async function cacheHashes() {
  return exec(producer, "sh", "-c", "find /data/erofs-cache -name '*.erofs' -type f -exec sha256sum {} + | sort");
}
async function assertMissingBlobs(layers: { digest: string }[]) {
  const content = new Set((await ctr(consumer, "content", "list", "--quiet")).trim().split("\n"));
  for (const layer of layers) assert(!content.has(layer.digest), `original layer blob transferred: ${layer.digest}`);
}
async function snapshotCount() {
  return (await ctr(consumer, "snapshots", "--snapshotter", "erofs", "list")).trim().split("\n").slice(1).filter(Boolean).length;
}

try {
  await start(producer, false);
  console.log(`${platform}: build local fixture and prepare shared cache`);
  await writeFile(join(context, "Dockerfile"), `FROM ${registryPinned}\nRUN dd if=/dev/urandom of=/payload bs=1M count=32 && echo kintsugi-transfer-marker > /marker\nCMD ["cat", "/marker"]\n`);
  await command(["docker", "cp", context, `${producer}:/context`]);
  await exec(producer, "docker", "build", "--network=none", "--provenance=false", "-t", source, "/context");
  await ctr(producer, "images", "build-erofs-cache", source, "/data/erofs-cache");
  const archive = await exportArchive(source);
  const { descriptor, manifest } = await archiveContents(archive);
  assert.equal(descriptor.digest, (await ctr(producer, "images", "list")).split("\n").find((line) => line.startsWith(`${source} `))?.trim().split(/\s+/)[2]);
  await start(consumer, true);
  const hashes = await cacheHashes();

  console.log(`${platform}: reject corrupted metadata before registering image`);
  const corrupt = Buffer.from(archive);
  const markerOffset = corrupt.indexOf("kintsugi-transfer-marker");
  assert(markerOffset >= 0, "config history contains the build command");
  corrupt[markerOffset] ^= 1;
  assert.notEqual((await importArchive(corrupt, false)).code, 0);
  assert(!(await ctr(consumer, "images", "list", "--quiet")).includes(source));

  console.log(`${platform}: cache miss fails offline, restoring entry makes retry succeed`);
  const cachedFile = (await exec(producer, "sh", "-c", "find /data/erofs-cache -name '*.erofs' -type f | sort | head -1")).trim();
  assert(cachedFile.startsWith("/data/erofs-cache/"));
  await exec(producer, "mv", cachedFile, `${cachedFile}.hidden`);
  const missing = await importArchive(archive, false);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /EROFS cache miss/);
  assert(!(await ctr(consumer, "images", "list", "--quiet")).includes(source));
  await assertMissingBlobs(manifest.layers);
  await exec(producer, "mv", `${cachedFile}.hidden`, cachedFile);
  const started = performance.now();
  const ref = await transfer(source);
  assert.equal(ref, `${source}@${descriptor.digest}`);
  assert.equal((await ctr(consumer, "images", "list")).split("\n").find((line) => line.startsWith(`${source} `))?.trim().split(/\s+/)[2], descriptor.digest);
  console.log(`${platform}: streamed ${archive.byteLength} archive bytes in ${((performance.now() - started) / 1000).toFixed(2)}s`);
  const count = await snapshotCount();
  assert.equal((await importArchive(archive)).stdout.toString().trim(), ref);
  assert.equal(await snapshotCount(), count, "repeat import must not duplicate snapshots");
  await assertMissingBlobs(manifest.layers);
  const links = await cachedLayerBlobs(consumer);
  assert.equal(links.length, manifest.layers.length);
  assert(links.every((link) => link.startsWith("/data/erofs-cache/")));
  assert.match(await exec(consumer, "docker", "run", "--rm", "--network=none", ref), /kintsugi-transfer-marker/);

  await writeFile(join(context, "Dockerfile"), `FROM ${ref}\nRUN test "$(cat /marker)" = kintsugi-transfer-marker && test "$(wc -c < /payload)" = 33554432 && echo derived-ok > /derived\nCMD ["cat", "/derived"]\n`);
  await command(["docker", "cp", context, `${consumer}:/context`]);
  const buildStarted = performance.now();
  await exec(consumer, "docker", "build", "--network=none", "--no-cache", "--progress=plain", "--output", "type=image,store-allow-incomplete=true", "-t", "transfer:derived", "/context");
  console.log(`${platform}: offline build with RUN ${((performance.now() - buildStarted) / 1000).toFixed(2)}s`);
  assert.match(await exec(consumer, "docker", "run", "--rm", "--network=none", "transfer:derived"), /derived-ok/);
  await command(["docker", "restart", "--time", "30", consumer]);
  await ready(consumer);
  assert.match(await exec(consumer, "docker", "run", "--rm", "--network=none", "transfer:derived"), /derived-ok/);
  await assertMissingBlobs(manifest.layers);
  assert.equal(await cacheHashes(), hashes);

  console.log(`${platform}: same transfer path for a registry multi-platform index`);
  await ctr(producer, "content", "fetch", "--platform", platform, registryPinned);
  // This exact Alpine platform was already cached as the local fixture's base.
  const registryArchive = await archiveContents(await exportArchive(registryPinned));
  const registryRef = await transfer(registryPinned);
  assert.equal(registryRef, `${registry}@${registryArchive.descriptor.digest}`);
  assert.match(await exec(consumer, "docker", "run", "--rm", "--network=none", registryRef, "cat", "/etc/alpine-release"), /^3\.22\./);
  await assertMissingBlobs(registryArchive.manifest.layers);
  console.log(`${platform}: PASS (local and registry image transfer, offline run/build/restart, cache miss/retry, idempotency, corrupt metadata)`);
} catch (error) {
  for (const container of containers) {
    const logs = await command(["docker", "logs", container], false);
    console.error(`${container}:\n${logs.stdout}\n${logs.stderr}`);
  }
  throw error;
} finally {
  for (const container of containers.reverse()) await command(["docker", "rm", "--force", container]);
  for (const volume of volumes.reverse()) await command(["docker", "volume", "rm", volume]);
  await rm(context, { recursive: true });
}
