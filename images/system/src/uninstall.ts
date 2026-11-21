import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNotFoundError } from "../../../packages/core/src/fs.ts";
import { workspaceDiskIdPattern, workspaceDiskImageDirectory, workspaceDiskImageSuffix } from "../../../packages/shared/src/workspace-disk.ts";

export const uninstallSocketPath = "/run/kintsugi-system/uninstall.sock";
export type UninstallState = { state: "running" | "failed" | "complete"; description: string };
export type UninstallPlan = { token: string; workspaceCount: number };
type Docker = (...args: string[]) => Promise<string>;

/** Inventory is independent of app health and includes parked and orphaned workspace data. */
export async function uninstallPlan(docker: Docker, dataDir = "/data/app"): Promise<UninstallPlan> {
  const labelled = await docker("ps", "-a", "--filter", "label=com.kintsugi.type=workspace", "--format", '{{.ID}}\t{{.Label "com.kintsugi.workspace-id"}}');
  const ids = new Set(labelled.split("\n").filter(Boolean).map(line => {
    const [containerId, workspaceId] = line.split("\t");
    return workspaceId?.trim() || containerId!.trim().slice(0, 8);
  }));
  try {
    for (const entry of await readdir(join(dataDir, "workspaces"), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.endsWith(".lock")) ids.add(entry.name);
    }
  } catch (error) { if (!isNotFoundError(error)) throw error; }
  // A failed or interrupted provisioning/deletion can leave a disk without app metadata.
  try {
    const images = await readdir(join(dirname(dataDir), "supervisor", workspaceDiskImageDirectory));
    for (const image of images) {
      const name = image.endsWith(".new") ? image.slice(0, -4) : image;
      if (!name.endsWith(workspaceDiskImageSuffix)) continue;
      const id = name.slice(0, -workspaceDiskImageSuffix.length);
      if (workspaceDiskIdPattern.test(id)) ids.add(id);
    }
  } catch (error) { if (!isNotFoundError(error)) throw error; }
  const token = createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex");
  return { token, workspaceCount: ids.size };
}

const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);

/** This Docker daemon belongs exclusively to System, never the host Docker daemon. */
export async function uninstallManagedResources(options: {
  token: string;
  docker: Docker;
  progress: (description: string) => Promise<void>;
  dataDir?: string;
}): Promise<void> {
  const { docker, progress, token, dataDir = "/data/app" } = options;
  await progress("Stopping the app and all workspace containers");
  const running = lines(await docker("ps", "-q"));
  if (running.length) await docker("stop", "--time", "20", ...running);
  // Freeze creation before checking the approved inventory. A changed plan requires new consent.
  if ((await uninstallPlan(docker, dataDir)).token !== token)
    throw new Error("Workspace inventory changed. Nothing has been deleted. Run --uninstall again to review the new count.");
  await progress("Deleting workspace and app containers");
  const containers = lines(await docker("ps", "-aq"));
  if (containers.length) await docker("rm", "--force", "--volumes", ...containers);
  await progress("Deleting workspace volumes and networks");
  const volumes = lines(await docker("volume", "ls", "-q"));
  if (volumes.length) await docker("volume", "rm", ...volumes);
  const networks = lines(await docker("network", "ls", "--filter", "type=custom", "-q"));
  if (networks.length) await docker("network", "rm", ...networks);
  await progress("Deleting managed images and build caches");
  await docker("builder", "prune", "--all", "--force");
  await docker("image", "prune", "--all", "--force");
  await progress("Verifying managed resources are gone");
  if (lines(await docker("ps", "-aq")).length || lines(await docker("volume", "ls", "-q")).length ||
      lines(await docker("network", "ls", "--filter", "type=custom", "-q")).length ||
      lines(await docker("image", "ls", "-q")).length)
    throw new Error("Managed Docker resources remain. The installation volume has not been removed; run --uninstall again.");
  await progress("Deleting projects, settings, credentials, conversations, and shared files");
  await rm(dataDir, { recursive: true, force: true });
  // Workspace disk images, shared image caches and Tailscale state disappear with the outer volume after System stops.
}
