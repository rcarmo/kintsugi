import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallManagedResources, uninstallPlan } from "./uninstall.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "system-uninstall-"));
  directories.push(root);
  const dataDir = join(root, "app");
  await mkdir(join(dataDir, "workspaces", "active"), { recursive: true });
  await mkdir(join(dataDir, "workspaces", "parked"));
  await mkdir(join(dataDir, "workspaces", "orphan"));
  await mkdir(join(dataDir, "workspaces", "identity-tombstones.lock"));
  await writeFile(join(dataDir, "settings.json"), "important settings");
  await writeFile(join(root, "unrelated"), "keep me");
  return { root, dataDir };
}
function daemon(options: { failVolumeRemoval?: boolean; leaveContainer?: boolean } = {}) {
  let containers = ["app-container", "active-container", "parked-container"];
  let running = ["app-container", "active-container"];
  let workspaces = "active-container\tactive\nparked-container\tparked";
  let volumes = ["workspace-data", "nested-docker"];
  let networks = ["workspace-network"];
  let images = ["app-image", "workspace-image"];
  const commands: string[][] = [];
  const docker = async (...args: string[]) => {
    commands.push(args);
    if (args[0] === "ps") {
      if (args.includes("label=com.kintsugi.type=workspace")) return workspaces;
      return (args.includes("-q") ? running : containers).join("\n");
    }
    if (args[0] === "stop") { running = []; return ""; }
    if (args[0] === "rm") { if (!options.leaveContainer) { containers = []; workspaces = ""; } return ""; }
    if (args[0] === "volume") {
      if (args[1] === "ls") return volumes.join("\n");
      if (options.failVolumeRemoval) throw new Error("volume is in use");
      volumes = []; return "";
    }
    if (args[0] === "network") {
      if (args[1] === "ls") return networks.join("\n");
      networks = []; return "";
    }
    if (args[0] === "builder") return "";
    if (args[0] === "image") {
      if (args[1] === "ls") return images.join("\n");
      images = []; return "";
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  return { docker, commands };
}

test("uninstall inventory deduplicates labels and data, includes parked and orphaned workspaces, and ignores locks", async () => {
  const { dataDir } = await fixture();
  const { docker } = daemon();
  const plan = await uninstallPlan(docker, dataDir);
  expect(plan.workspaceCount).toBe(3);
  expect(plan.token).toMatch(/^[a-f0-9]{64}$/);
  expect(await uninstallPlan(docker, dataDir)).toEqual(plan);
});

test("inventory includes orphaned managed disks and deduplicates in-progress images", async () => {
  const { root, dataDir } = await fixture();
  const { docker, commands } = daemon();
  const previous = await uninstallPlan(docker, dataDir);
  const images = join(root, "supervisor", "workspace-disks");
  await mkdir(images, { recursive: true });
  for (const name of ["active.ext4", "disk-only.ext4", "disk-only.ext4.new", "incomplete.ext4.new", "unrelated.log"]) {
    await writeFile(join(images, name), "synthetic image marker");
  }
  const plan = await uninstallPlan(docker, dataDir);
  expect(plan.workspaceCount).toBe(5);
  expect(plan.token).not.toBe(previous.token);
  await expect(uninstallManagedResources({ token: previous.token, docker, dataDir, progress: async () => {} })).rejects.toThrow("Workspace inventory changed");
  expect(commands.some(args => args[0] === "rm")).toBe(false);
  expect(await readFile(join(images, "disk-only.ext4"), "utf8")).toBe("synthetic image marker");
});

test("inventory uses container IDs for legacy unlabelled workspace identities and does not require app data", async () => {
  const { root } = await fixture();
  const docker = async () => "123456789abcdef\t\nabcdef123456789\tparked";
  expect((await uninstallPlan(docker, join(root, "missing"))).workspaceCount).toBe(2);
});

test("inventory errors cannot be mistaken for an empty installation", async () => {
  const { root } = await fixture();
  const dataDir = join(root, "broken");
  await mkdir(dataDir);
  await writeFile(join(dataDir, "workspaces"), "not a directory");
  await expect(uninstallPlan(async () => "", dataDir)).rejects.toMatchObject({ code: "ENOTDIR" });
  await expect(uninstallPlan(async () => { throw new Error("Docker unavailable"); }, dataDir)).rejects.toThrow("Docker unavailable");
});

test("uninstall stops writers, deletes all private-daemon resources and app state, and preserves unrelated files", async () => {
  const { root, dataDir } = await fixture();
  const { docker, commands } = daemon();
  const plan = await uninstallPlan(docker, dataDir);
  const progress: string[] = [];
  await uninstallManagedResources({ token: plan.token, docker, dataDir, progress: async description => { progress.push(description); } });
  expect(commands.find(args => args[0] === "stop")).toEqual(["stop", "--time", "20", "app-container", "active-container"]);
  expect(commands.find(args => args[0] === "rm")).toEqual(["rm", "--force", "--volumes", "app-container", "active-container", "parked-container"]);
  expect(commands.find(args => args[0] === "volume" && args[1] === "rm")).toEqual(["volume", "rm", "workspace-data", "nested-docker"]);
  expect(commands).toContainEqual(["builder", "prune", "--all", "--force"]);
  expect(progress.indexOf("Verifying managed resources are gone")).toBeLessThan(progress.indexOf("Deleting projects, settings, credentials, conversations, and shared files"));
  await expect(readFile(join(dataDir, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, "unrelated"), "utf8")).toBe("keep me");
});

test("changed inventory after confirmation stops writers but deletes nothing and requires renewed consent", async () => {
  const { dataDir } = await fixture();
  const { docker, commands } = daemon();
  const plan = await uninstallPlan(docker, dataDir);
  await mkdir(join(dataDir, "workspaces", "new-workspace"));
  await expect(uninstallManagedResources({ token: plan.token, docker, dataDir, progress: async () => {} })).rejects.toThrow("Workspace inventory changed");
  expect(commands.some(args => args[0] === "stop")).toBe(true);
  expect(commands.some(args => args[0] === "rm")).toBe(false);
  expect(await readFile(join(dataDir, "settings.json"), "utf8")).toBe("important settings");
});

test("cleanup failures remain explicit and do not erase settings before Docker cleanup succeeds", async () => {
  const { dataDir } = await fixture();
  const { docker } = daemon({ failVolumeRemoval: true });
  const plan = await uninstallPlan(docker, dataDir);
  await expect(uninstallManagedResources({ token: plan.token, docker, dataDir, progress: async () => {} })).rejects.toThrow("volume is in use");
  expect(await readFile(join(dataDir, "settings.json"), "utf8")).toBe("important settings");
});

test("cleanup does not report success when Docker leaves managed resources behind", async () => {
  const { dataDir } = await fixture();
  const { docker } = daemon({ leaveContainer: true });
  const plan = await uninstallPlan(docker, dataDir);
  await expect(uninstallManagedResources({ token: plan.token, docker, dataDir, progress: async () => {} })).rejects.toThrow("Managed Docker resources remain");
  expect(await readFile(join(dataDir, "settings.json"), "utf8")).toBe("important settings");
});
