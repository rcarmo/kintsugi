import { lstat, mkdir, readlink, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { getKintsugiRuntimeContext, kintsugiDataPath, writeJsonAtomic } from "@kintsugi/core";
import { hostAvailable, hostRequest, readSystemVersion } from "@kintsugi/host/control";
import { workspaceDiskIdPattern, workspaceDiskRoot } from "@kintsugi/shared/workspace-disk";
import { workspaceDiskResourceVersion, workspaceDiskSystemVersion } from "@kintsugi/shared/system-version";

const available = async () => hostAvailable() && await readSystemVersion() >= workspaceDiskSystemVersion;
const root = (id: string) => join(workspaceDiskRoot, id);
const metadata = (id: string) => kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", id);
const checkout = (id: string) => join(root(id), "checkout", "work");

async function existingLink(path: string, target: string) {
  const previous = await lstat(path, { throwIfNoEntry: false });
  if (!previous) return false;
  if (!previous.isSymbolicLink() || await readlink(path) !== target) throw new Error("Existing workspace data cannot be replaced by a managed disk");
  return true;
}

export async function prepareWorkspaceDisk(id: string) {
  if (!await available()) return;
  if (!workspaceDiskIdPattern.test(id)) throw new Error("Invalid workspace disk ID");
  const disk = root(id), directory = metadata(id);
  await mkdir(directory, { recursive: true });
  const links = [{ path: join(directory, "work"), target: checkout(id) }, { path: join(directory, "home-local"), target: join(disk, "home") }];
  const present = await Promise.all(links.map(({ path, target }) => existingLink(path, target)));
  // Publish ownership first so interrupted provisioning can be cleaned up without inspecting the filesystem image.
  for (const [i, { path, target }] of links.entries()) if (!present[i]) await symlink(target, path);
  await writeJsonAtomic(join(directory, "metadata", "resource-policy.json"), { version: workspaceDiskResourceVersion }, { mode: 0o600 });
  await hostRequest({ operation: "disk", action: "prepare", workspaceId: id });
  const local = await stat(join(disk, "checkout"));
  if (local.dev === (await stat(workspaceDiskRoot)).dev) throw new Error("Workspace disk mount is not visible to the app");
  await mkdir(checkout(id), { recursive: true });
  return { checkout: checkout(id), docker: join(disk, "docker") };
}

async function managed(id: string) {
  const path = join(metadata(id), "work");
  const file = await lstat(path, { throwIfNoEntry: false });
  return file?.isSymbolicLink() === true && await readlink(path) === checkout(id);
}

export async function requireWorkspaceDiskControl(id: string) {
  if (await managed(id) && !await available()) throw new Error("Managing this workspace disk needs System compatibility version 8. Update the installation first.");
}

export async function removeWorkspaceDisk(id: string) {
  if (!await managed(id)) return;
  await requireWorkspaceDiskControl(id);
  await hostRequest({ operation: "disk", action: "remove", workspaceId: id });
}

export async function inspectWorkspaceDisk(id: string) {
  if (!await managed(id)) return null;
  await requireWorkspaceDiskControl(id);
  const result = await hostRequest({ operation: "disk", action: "inspect", workspaceId: id });
  if (!result) throw new Error("Workspace disk is unavailable");
  return result;
}

export async function growWorkspaceDisk(id: string, limitGiB: number) {
  if (!await managed(id)) throw new Error("This workspace was created without a managed disk");
  await requireWorkspaceDiskControl(id);
  const result = await hostRequest({ operation: "disk", action: "grow", workspaceId: id, limitGiB });
  if (!result) throw new Error("Workspace disk is unavailable");
  return result;
}
