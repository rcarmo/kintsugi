// bun images/patched-docker/smoke-test.ts [image] [linux/arm64|linux/amd64]
// Requires Docker, network access for the fixture, and a Linux kernel with EROFS.
// Each run owns its containers/volumes and removes them, including on failure.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = process.argv[2] ?? "kintsugi-patched-docker:dev";
const platform = process.argv[3] ?? "linux/arm64";
assert(["linux/arm64", "linux/amd64"].includes(platform));
const architecture = platform.split("/")[1];
const id = `kintsugi-runtime-smoke-${architecture}-${process.pid}`;
const producer = `${id}-producer`;
const consumer = `${id}-consumer`;
const cache = `${id}-cache`;
const volumes = [cache, `${producer}-data`, `${consumer}-data`];
const containers: string[] = [];
const createdVolumes: string[] = [];
const context = await mkdtemp(join(tmpdir(), "kintsugi-runtime-smoke-"));
const base = "docker.io/library/golang:1.26.10@sha256:672c944cfd07599b5f1bb179869270cdc94c6254e41db4d431259693cb286b82";

async function command(args: string[], check = true) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (check) assert.equal(code, 0, `${args.join(" ")}\n${stdout}\n${stderr}`);
  return { stdout, stderr, code };
}
async function exec(container: string, ...args: string[]) {
  return (await command(["docker", "exec", container, ...args])).stdout;
}
async function ctr(container: string, ...args: string[]) {
  return exec(container, "ctr", "--namespace", "moby", ...args);
}
async function ready(container: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await command(["docker", "exec", container, "docker", "info"], false);
    if (result.code === 0) return;
    const running = await command(["docker", "inspect", "--format", "{{.State.Running}}", container]);
    if (running.stdout.trim() !== "true") break;
    await Bun.sleep(500);
  }
  assert.fail(await execLogs(container));
}
async function execLogs(container: string) {
  const logs = await command(["docker", "logs", container], false);
  return logs.stdout + logs.stderr;
}
async function start(container: string, readonly: boolean) {
  await command(["docker", "run", "--detach", "--privileged", "--platform", platform,
    "--name", container, "--mount", `type=volume,src=${container}-data,dst=/data`,
    "--mount", `type=volume,src=${cache},dst=/data/erofs-cache${readonly ? ",readonly" : ""}`,
    image]);
  containers.push(container);
  await ready(container);
}
interface Descriptor { digest: string; platform?: { os: string; architecture: string } }
interface Manifest { manifests?: Descriptor[]; layers?: Descriptor[] }
async function layers(container: string) {
  const listing = await ctr(container, "images", "list");
  let digest = listing.trim().split("\n")[1].split(/\s+/)[2];
  for (;;) {
    const manifest: Manifest = JSON.parse(await ctr(container, "content", "get", digest));
    if (manifest.layers) return manifest.layers.map((layer) => layer.digest);
    const selected = manifest.manifests?.find((entry) =>
      entry.platform?.os === "linux" && entry.platform.architecture === architecture);
    assert(selected, "fixture has no matching platform");
    digest = selected.digest;
  }
}
async function cacheHashes() {
  return exec(consumer, "sh", "-c", "find /data/erofs-cache -name '*.erofs' -type f -exec sha256sum {} + | sort");
}
try {
  for (const volume of volumes) {
    await command(["docker", "volume", "create", volume]);
    createdVolumes.push(volume);
  }
  await start(producer, false);
  console.log(`${platform}: fetching fixture and preparing EROFS cache`);
  await ctr(producer, "content", "fetch", "--platform", platform, base);
  const baseLayers = await layers(producer);
  assert(baseLayers.length > 1, "exercise reuse across multiple cached layers");
  // Force collection after ctr has opened the temporary decompressed layer but
  // before mkfs consumes it. Without the cache command's lease this truncates
  // mkfs input and produces EIO, even though the original layer blob is intact.
  const mkfsWrapper = join(context, "mkfs.erofs");
  await writeFile(mkfsWrapper, `#!/bin/sh
set -eu
ctr --namespace moby leases create --id "cache-gc-$$" >/dev/null
ctr --namespace moby leases delete --sync "cache-gc-$$"
touch /tmp/cache-gc-exercised
echo mkfs >> /tmp/cache-builds
exec /usr/bin/mkfs.erofs "$@"
`);
  await command(["docker", "cp", mkfsWrapper, `${producer}:/usr/local/bin/mkfs.erofs`]);
  await exec(producer, "chmod", "+x", "/usr/local/bin/mkfs.erofs");
  await ctr(producer, "images", "build-erofs-cache", "--platform", platform, base, "/data/erofs-cache");
  await exec(producer, "test", "-f", "/tmp/cache-gc-exercised");
  const builds = () => exec(producer, "cat", "/tmp/cache-builds");
  const firstBuilds = await builds();
  await ctr(producer, "images", "build-erofs-cache", "--platform", platform, base, "/data/erofs-cache");
  assert.equal(await builds(), firstBuilds, "a warm cache must not invoke mkfs");
  // A partially cold image must convert only its missing layer, leaving all
  // other published files (including their inode and timestamp) untouched.
  await exec(producer, "sh", "-ec", `find /data/erofs-cache -name '*.erofs' -type f | sort > /tmp/cache-files
missing="$(head -n 1 /tmp/cache-files)"
rm "$missing"
tail -n +2 /tmp/cache-files | xargs stat -c '%n %i %Y' > /tmp/cache-before`);
  await ctr(producer, "images", "build-erofs-cache", "--platform", platform, base, "/data/erofs-cache");
  assert.equal(await builds(), firstBuilds + "mkfs\n", "only the missing layer should invoke mkfs");
  await exec(producer, "sh", "-ec", "tail -n +2 /tmp/cache-files | xargs stat -c '%n %i %Y' > /tmp/cache-after; diff /tmp/cache-before /tmp/cache-after");
  await exec(producer, "rm", "/usr/local/bin/mkfs.erofs");
  await start(consumer, true);
  // BuildKit asks containerd for an empty diff while preparing a scratch base.
  // The EROFS differ must decline that mount list without crashing the daemon.
  await writeFile(join(context, "Dockerfile"), "FROM scratch\nCOPY dependency /dependency\n");
  await writeFile(join(context, "dependency"), "scratch layer works\n");
  await command(["docker", "cp", context, `${consumer}:/scratch`]);
  await exec(consumer, "docker", "build", "--network=none", "--tag", "smoke:scratch", "/scratch");
  await exec(consumer, "docker", "create", "--name", "scratch-check", "smoke:scratch", "/dependency");
  await exec(consumer, "docker", "cp", "scratch-check:/dependency", "/tmp/scratch-dependency");
  assert.equal(await exec(consumer, "cat", "/tmp/scratch-dependency"), "scratch layer works\n");
  await exec(consumer, "docker", "rm", "scratch-check");
  // Each docker cp remounts the rootfs right after the previous mount. Only kernels
  // that default overlayfs to index=on (e.g. Arch) catch a missing index=off here.
  await exec(consumer, "docker", "create", "--name", "remount-check", "smoke:scratch", "/dependency");
  for (const target of ["/first", "/second"]) await exec(consumer, "docker", "cp", "/scratch/dependency", `remount-check:${target}`);
  await exec(consumer, "docker", "rm", "remount-check");
  await exec(consumer, "ctr", "version");
  const hashes = await cacheHashes();
  const started = performance.now();
  await ctr(consumer, "images", "pull", "--platform", platform, "--snapshotter", "erofs", base);
  console.log(`${platform}: preload ${((performance.now() - started) / 1000).toFixed(2)}s`);
  // Reproduce systemd's cgroup layout: init lives in a child while the parent
  // delegates a domain controller. CLONE_INTO_CGROUP(parent) must fail EBUSY,
  // then runc must use a fresh exec.Cmd and join init's actual child cgroup.
  await exec(consumer, "docker", "run", "--detach", "--name", "exec-cgroup-check",
    "--privileged", "--cgroupns=host", "--network=none", "--entrypoint", "sh", base, "-ec", `
parent="/sys/fs/cgroup$(awk -F: '$1 == 0 {print $3}' /proc/self/cgroup)"
mkdir "$parent/exec-child"
echo $$ > "$parent/exec-child/cgroup.procs"
echo +memory > "$parent/cgroup.subtree_control"
touch /tmp/exec-cgroup-ready
exec sleep infinity
`);
  for (let attempt = 0; ; attempt++) {
    const ready = await command(["docker", "exec", consumer, "docker", "exec", "exec-cgroup-check", "test", "-f", "/tmp/exec-cgroup-ready"], false);
    if (ready.code === 0) break;
    assert(attempt < 30, `cgroup exec fixture failed: ${ready.stderr}`);
    await Bun.sleep(100);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = await exec(consumer, "docker", "exec", "exec-cgroup-check", "cat", "/proc/self/cgroup");
    assert.match(actual.trim(), /\/exec-child$/, "exec must join init's delegated child cgroup");
  }
  await exec(consumer, "docker", "rm", "--force", "exec-cgroup-check");
  console.log(`${platform}: cgroup-v2 exec fallback passed`);
  const assertNoBaseBlobs = async () => {
    const content = new Set((await ctr(consumer, "content", "list", "--quiet")).trim().split("\n"));
    for (const digest of baseLayers) assert(!content.has(digest), `base blob downloaded: ${digest}`);
  };
  await assertNoBaseBlobs();
  const links = await exec(consumer, "sh", "-c", "find /data/containerd/io.containerd.snapshotter.v1.erofs/snapshots -name layer.erofs -type l -exec readlink {} +");
  assert.equal(links.trim().split("\n").length, baseLayers.length);
  assert(links.trim().split("\n").every((link) => link.startsWith("/data/erofs-cache/")));
  await writeFile(join(context, "hello.go"), 'package main\nimport "fmt"\nfunc main(){fmt.Println("shared EROFS build works")}\n');
  await writeFile(join(context, "Dockerfile"), `FROM ${base}\nCOPY hello.go /src/hello.go\nRUN CGO_ENABLED=0 go build -o /hello /src/hello.go\nCMD ["/hello"]\n`);
  await command(["docker", "cp", context, `${consumer}:/context`]);
  const buildStarted = performance.now();
  const build = await exec(consumer, "docker", "build", "--network=none", "--no-cache", "--progress=plain",
    "--output", "type=image,store-allow-incomplete=true", "--tag", "smoke:result", "/context");
  console.log(`${platform}: build ${((performance.now() - buildStarted) / 1000).toFixed(2)}s`, build);
  await assertNoBaseBlobs();
  assert.equal(await cacheHashes(), hashes);
  assert.match(await exec(consumer, "docker", "run", "--rm", "--network=none", "smoke:result"), /shared EROFS build works/);
  await command(["docker", "restart", "--time", "30", consumer]);
  await ready(consumer);
  assert.match(await exec(consumer, "docker", "run", "--rm", "--network=none", "smoke:result"), /shared EROFS build works/);
  await assertNoBaseBlobs();
  assert.equal(await cacheHashes(), hashes);
  // Failure of either managed daemon must terminate the container, not leave it healthy.
  await exec(consumer, "sh", "-c", "kill -TERM $(cat /var/run/docker.pid)");
  const exitCode = await command(["docker", "wait", consumer]);
  assert.equal(exitCode.stdout.trim(), "0");
  console.log(`${platform}: PASS (${baseLayers.length} cached base layers; forced GC during cache creation; no base blobs fetched; restart and supervision passed)`);
} catch (error) {
  for (const container of containers) console.error(await execLogs(container));
  throw error;
} finally {
  for (const container of containers.reverse()) await command(["docker", "rm", "--force", container]);
  for (const volume of createdVolumes.reverse()) await command(["docker", "volume", "rm", volume]);
  await rm(context, { recursive: true });
}
