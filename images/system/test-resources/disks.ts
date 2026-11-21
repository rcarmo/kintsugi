// Run as root in a disposable mount namespace: sudo unshare --mount bun images/system/test-resources/disks.ts
import { strict as assert } from "node:assert";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GiB } from "../../../packages/shared/src/workspace-disk.ts";
import { createWorkspaceDisks } from "../src/workspace-disks.ts";

if (process.getuid?.() !== 0 || await readFile("/proc/self/mountinfo", "utf8") === await readFile("/proc/1/mountinfo", "utf8")) {
  throw new Error("Run in a private mount namespace as root");
}
const fixture = await mkdtemp(join(tmpdir(), "kintsugi-disk-integration-"));
const mountRoot = join(fixture, "mounts"), imageRoot = join(fixture, "images"), appRoot = join(fixture, "app");
const disk = join(mountRoot, "fixture"), checkout = join(disk, "checkout"), cache = join(disk, "docker", "cache");
async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw new Error(`${args.join(" ")}: ${err}`);
  return out;
}
let containerExists = true, failResize = false;
const options = { mountRoot, imageRoot,
  command: async (args: string[]) => {
    if (failResize && args[0] === "resize2fs") throw new Error("Fixture interrupted resize");
    return command(args);
  },
  containerExists: async (id: string) => id === "fixture" && containerExists,
};
const disks = createWorkspaceDisks(options);
let reader: ReturnType<typeof Bun.spawn> | undefined;
try {
  await chmod(fixture, 0o755);
  await disks.initialize((_id, error) => { throw error; });
  assert.equal(await disks.inspect("fixture"), null);
  await assert.rejects(disks.prepare("fixture"), /Existing workspaces/);
  await assert.rejects(disks.prepare("../../fixture"), /Invalid/);
  await mkdir(appRoot);
  // An app-like child binds the shared parent before the workspace is provisioned.
  reader = Bun.spawn(["unshare", "--mount", "--propagation", "unchanged", "sh", "-ec", `
    mount --rbind "$1" "$2"; mount --make-rslave "$2"; touch "$3/ready"
    while [ ! -e "$3/view" ]; do sleep .05; done
    stat -c %d "$2/fixture/checkout"
  `, "fixture", mountRoot, appRoot, fixture], { stdout: "pipe", stderr: "inherit" });
  for (let i = 0; i < 100 && !await Bun.file(join(fixture, "ready")).exists(); i++) await Bun.sleep(30);
  assert.ok(await Bun.file(join(fixture, "ready")).exists());
  containerExists = false;
  const state = await disks.prepare("fixture");
  assert.equal(state.limitGiB, 8);
  assert.ok(state.availableBytes > 7 * GiB);
  await writeFile(join(fixture, "view"), "");
  assert.equal(await reader.exited, 0);
  assert.equal((await new Response(reader.stdout).text()).trim(), String((await lstat(checkout)).dev));
  await writeFile(join(checkout, "retained.txt"), "retained");
  await command(["runuser", "-u", "agent", "--", "fallocate", "-l", "6G", join(checkout, "local")]);
  await assert.rejects(command(["fallocate", "-l", "3G", cache]), /No space left/);
  await rm(cache);
  assert.ok((await disks.inspect("fixture"))!.usedBytes >= 6 * GiB);
  await assert.rejects(disks.grow("fixture", 7), /only grow/);
  failResize = true;
  await assert.rejects(disks.grow("fixture", 10), /Fixture interrupted resize/);
  const pending = await disks.inspect("fixture");
  assert.equal(pending?.limitGiB, 8);
  assert.equal(pending?.requestedLimitGiB, 10);
  failResize = false;
  // Online resize can advance by a subset of block groups before a host I/O error.
  const device = (await command(["findmnt", "-nr", "-o", "SOURCE", "--mountpoint", disk])).trim();
  await command(["resize2fs", device, "8704M"]);
  const partial = await disks.inspect("fixture");
  assert.equal(partial?.limitGiB, 8.5);
  assert.equal(partial?.requestedLimitGiB, 10);
  const grown = await disks.grow("fixture", 10);
  assert.equal(grown.limitGiB, 10);
  assert.ok(grown.availableBytes > 3 * GiB);
  assert.equal(grown.requestedLimitGiB, undefined);
  const testFile = join(checkout, "discard-me");
  // Actual writes allocate blocks on the backing filesystem; discard must punch those holes again.
  await command(["dd", "if=/dev/zero", `of=${testFile}`, "bs=1M", "count=24", "conv=fsync", "status=none"]);
  const image = join(imageRoot, "fixture.ext4");
  const allocated = (await lstat(image)).blocks;
  await rm(testFile);
  await command(["sync", "-f", checkout]);
  assert.ok((await lstat(image)).blocks < allocated - 16 * 1024 ** 2 / 512);
  await command(["fallocate", "-l", "3G", cache]);
  console.log("8 GiB enforced across checkout and Docker paths; 10 GiB online growth; app mount propagation verified.");

  await command(["umount", disk]);
  const restored = createWorkspaceDisks(options);
  await restored.initialize((_id, error) => { throw error; });
  const rootMounts = (await readFile("/proc/self/mountinfo", "utf8")).split("\n").filter(line => line.split(" ")[4] === mountRoot);
  assert.equal(rootMounts.length, 1);
  assert.equal((await restored.inspect("fixture"))!.limitGiB, 10);
  assert.equal(await readFile(join(checkout, "retained.txt"), "utf8"), "retained");
  assert.equal((await lstat(cache)).size, 3 * GiB);
  containerExists = true;
  await assert.rejects(restored.remove("fixture"), /Remove the workspace container/);
  containerExists = false;
  await restored.remove("fixture");
  assert.equal(await restored.inspect("fixture"), null);
  const orphan = join(imageRoot, "interrupted.ext4.new");
  await writeFile(orphan, "fixture unpublished image");
  await restored.remove("interrupted");
  assert.equal(await lstat(orphan, { throwIfNoEntry: false }), undefined);
  console.log("Interrupted resize, trim, remount and unpublished-image cleanup verified; removal refused with a container.");
} finally {
  if (reader && reader.exitCode === null) { reader.kill(); await reader.exited; }
  containerExists = false;
  await disks.remove("fixture");
  await command(["umount", "--recursive", mountRoot]);
  await rm(fixture, { recursive: true, force: true });
}
