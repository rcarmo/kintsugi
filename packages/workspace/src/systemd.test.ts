import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspaceSystemd } from "./systemd.ts";
import type { WorkspaceDockerPlan } from "./types.ts";

test("provisioning supplies setup and PID 1 requirements without replacing image-owned runtime units", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-systemd-"));
  try {
    const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
    await prepareWorkspaceSystemd(plan, directory, "echo setup");
    expect(plan.extraArgs).toEqual(["--security-opt", "writable-cgroups=true", "--cgroupns=private", "--tmpfs", "/run", "--stop-signal", "SIGRTMIN+3"]);
    expect(plan.containerFiles).toEqual([{ source: join(directory, "kintsugi-helper.service"), target: "/usr/lib/systemd/system/kintsugi-helper.service" }, { source: join(directory, "systemd"), target: "/etc" }, { source: join(directory, "init.sh"), target: "/.kintsugi/init.sh" }, { source: join(directory, "kintsugi"), target: "/etc" }]);
    expect(await readFile(join(directory, "kintsugi", "docker-support"), "utf8")).toBe("disabled\n\n");
    expect(await readFile(join(directory, "init.sh"), "utf8")).toBe("echo setup");
    expect(await readFile(join(directory, "systemd/system.conf.d/90-kintsugi-workspace-limits.conf"), "utf8")).toContain("DefaultTasksMax=infinity");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Docker opt-in keeps the ordinary privileged runtime and snapshots the settings link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-systemd-"));
  try {
    const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], privileged: true, initScripts: [], containerFiles: [], cleanup: [], dockerSupportSettingsUrl: "https://kintsugi.example/workspace-templates/app/settings?section=privileged" };
    await prepareWorkspaceSystemd(plan, directory, "echo setup");
    expect(plan.extraArgs).not.toContain("writable-cgroups=true");
    expect(plan.extraArgs).toContain("--privileged");
    expect(await readFile(join(directory, "kintsugi", "docker-support"), "utf8")).toBe("enabled\nhttps://kintsugi.example/workspace-templates/app/settings?section=privileged\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
