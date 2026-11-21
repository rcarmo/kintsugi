import { chown, chmod, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, statfs, truncate } from "node:fs/promises";
import { join } from "node:path";
import { createKeyedOperationQueue } from "../../../packages/core/src/index.ts";
import { defaultWorkspaceDiskGiB, GiB, workspaceDiskIdPattern, workspaceDiskImageDirectory, workspaceDiskImageSuffix, workspaceDiskRoot, type WorkspaceDiskSnapshot } from "../../../packages/shared/src/workspace-disk.ts";

/** Private data lives on one sparse, bounded filesystem. Never mount an image supplied by a workspace. */
export function createWorkspaceDisks(options: {
  mountRoot?: string;
  imageRoot?: string;
  command(args: string[]): Promise<string>;
  containerExists(id: string): Promise<boolean>;
}) {
  const mounts = options.mountRoot ?? workspaceDiskRoot;
  const images = options.imageRoot ?? join("/data/supervisor", workspaceDiskImageDirectory);
  const lock = createKeyedOperationQueue();
  const run = options.command;
  const path = (id: string) => join(mounts, id);
  const image = (id: string) => join(images, id + workspaceDiskImageSuffix);
  const temporaryImage = (id: string) => image(id) + ".new";
  function validate(id: string) {
    if (!workspaceDiskIdPattern.test(id)) throw new Error("Invalid workspace disk ID");
  }
  async function backing(id: string) {
    const file = await lstat(image(id), { throwIfNoEntry: false });
    if (file && (!file.isFile() || file.uid !== 0 || file.nlink !== 1 || (file.mode & 0o777) !== 0o600 || file.size % GiB || file.size < GiB || file.size > 1024 * GiB)) {
      throw new Error("Invalid workspace disk image");
    }
    return file;
  }
  async function mountInfo(target: string) {
    return (await readFile("/proc/self/mountinfo", "utf8")).split("\n").findLast(line => line.split(" ")[4] === target);
  }
  async function mountedDevice(id: string): Promise<string | undefined> {
    const mount = await mountInfo(path(id));
    if (!mount) return;
    const [kind, device] = mount.split(" - ")[1]!.split(" ");
    if (kind !== "ext4" || !/^\/dev\/loop\d+$/.test(device ?? "") || (await run(["losetup", "--noheadings", "--raw", "--output", "BACK-FILE", device!])).trim() !== image(id)) {
      throw new Error("Unexpected workspace disk mount; leaving it untouched");
    }
    return device;
  }
  async function mountDisk(id: string): Promise<string> {
    const existing = await mountedDevice(id);
    if (existing) return existing;
    const target = path(id);
    await mkdir(target, { mode: 0, recursive: true });
    const directory = await lstat(target);
    if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o777) !== 0 || (await readdir(target)).length) throw new Error("Workspace disk mount point is not empty and protected");
    // mount's loop device is auto-cleared after the final reference goes away.
    await run(["mount", "-t", "ext4", "-o", "loop,nodev,nosuid,discard", image(id), target]);
    const device = await mountedDevice(id);
    if (!device) throw new Error("Workspace disk mount did not appear");
    return device;
  }
  async function createImage(id: string) {
    const temporary = temporaryImage(id);
    // Only unpublished images may be discarded after an interrupted format.
    await rm(temporary, { force: true });
    const fd = await open(temporary, "wx", 0o600);
    try { await fd.truncate(defaultWorkspaceDiskGiB * GiB); }
    finally { await fd.close(); }
    try {
      await run(["mkfs.ext4", "-q", "-F", "-m", "0", temporary]);
      const formatted = await open(temporary, "r+");
      try { await formatted.sync(); } finally { await formatted.close(); }
      await rename(temporary, image(id));
      const directory = await open(images, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  async function usage(id: string): Promise<WorkspaceDiskSnapshot> {
    const file = await backing(id);
    const device = await mountedDevice(id);
    if (!file || !device) throw new Error("Workspace disk is not mounted");
    // A sparse image can have grown before resize2fs succeeds. Read the applied
    // filesystem geometry, not the image's length or statfs's usable blocks.
    const [fs, geometry] = await Promise.all([statfs(path(id)), run(["env", "LC_ALL=C", "tune2fs", "-l", device])]);
    const blocks = Number(/^Block count:\s+(\d+)$/m.exec(geometry)?.[1]);
    const blockSize = Number(/^Block size:\s+(\d+)$/m.exec(geometry)?.[1]);
    const appliedBytes = blocks * blockSize;
    // Ext4 can commit some block groups before a resize is interrupted.
    if (!Number.isSafeInteger(appliedBytes) || appliedBytes < GiB || appliedBytes > file.size) throw new Error("Invalid workspace filesystem size");
    const limitGiB = appliedBytes / GiB;
    const requestedLimitGiB = file.size / GiB;
    const snapshot: WorkspaceDiskSnapshot = { limitGiB, usedBytes: (fs.blocks - fs.bfree) * fs.bsize, availableBytes: fs.bavail * fs.bsize };
    if (limitGiB !== requestedLimitGiB) snapshot.requestedLimitGiB = requestedLimitGiB;
    return snapshot;
  }
  async function mountAndRecover(id: string) {
    const device = await mountDisk(id);
    // Repeatable if interrupted after expanding the backing file but before growing ext4.
    await run(["losetup", "--set-capacity", device]);
    await run(["resize2fs", device]);
    await chmod(path(id), 0o755);
    // The workspace sees individual subdirectories, never the root or the backing file.
    for (const name of ["checkout", "home", "docker"]) {
      const directory = join(path(id), name);
      const existing = await lstat(directory, { throwIfNoEntry: false });
      if (existing && !existing.isDirectory()) throw new Error("Invalid workspace disk directory");
      if (!existing) await mkdir(directory, { mode: 0o700 });
      if (name !== "docker") await chown(directory, 1000, 1000);
    }
  }
  return {
    async initialize(onFailure: (id: string, error: Error) => void) {
      await mkdir(mounts, { recursive: true, mode: 0o755 });
      await mkdir(images, { recursive: true, mode: 0o700 });
      const root = await mountInfo(mounts);
      if (!root) await run(["mount", "--bind", mounts, mounts]);
      if (!root?.split(" - ")[0]!.split(" ").some(field => field.startsWith("shared:"))) await run(["mount", "--make-rshared", mounts]);
      for (const name of await readdir(images)) {
        if (!name.endsWith(workspaceDiskImageSuffix)) continue;
        const id = name.slice(0, -workspaceDiskImageSuffix.length);
        try { validate(id); await backing(id); await mountAndRecover(id); }
        catch (error) { onFailure(id, error instanceof Error ? error : new Error(String(error))); }
      }
    },
    async prepare(id: string): Promise<WorkspaceDiskSnapshot> {
      validate(id);
      return lock(id, async () => {
        if (!await backing(id)) {
          if (await options.containerExists(id)) throw new Error("Existing workspaces are not migrated to managed disks");
          await createImage(id);
        }
        await mountAndRecover(id);
        return usage(id);
      });
    },
    async inspect(id: string): Promise<WorkspaceDiskSnapshot | null> {
      validate(id);
      return lock(id, async () => await backing(id) ? usage(id) : null);
    },
    async grow(id: string, limitGiB: number): Promise<WorkspaceDiskSnapshot> {
      validate(id);
      if (!Number.isInteger(limitGiB) || limitGiB < 1 || limitGiB > 1024) throw new Error("Enter a disk size between 1 and 1024 GiB");
      return lock(id, async () => {
        const file = await backing(id);
        if (!file) throw new Error("This workspace does not have a managed disk");
        if (limitGiB * GiB < file.size) throw new Error(`Workspace disks can only grow. Retry with at least ${file.size / GiB} GiB.`);
        await mountDisk(id);
        await truncate(image(id), limitGiB * GiB);
        const fd = await open(image(id), "r+");
        try { await fd.sync(); } finally { await fd.close(); }
        await mountAndRecover(id);
        const applied = await usage(id);
        if (applied.requestedLimitGiB !== undefined) throw new Error("The disk did not finish growing. Try again.");
        return applied;
      });
    },
    async remove(id: string): Promise<null> {
      validate(id);
      return lock(id, async () => {
        const file = await backing(id);
        const unfinished = await lstat(temporaryImage(id), { throwIfNoEntry: false });
        if (!file && !unfinished) return null;
        if (await options.containerExists(id)) throw new Error("Remove the workspace container before removing its disk");
        if (await mountedDevice(id)) await run(["umount", path(id)]);
        if (await lstat(path(id), { throwIfNoEntry: false })) await rmdir(path(id));
        if (file) await rm(image(id));
        if (unfinished) await rm(temporaryImage(id));
        return null;
      });
    },
  };
}
