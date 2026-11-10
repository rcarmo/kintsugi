import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceRuntimeUnits } from "../../workspace-image/src/workspace-systemd-units.ts";
import { readStorageDriver } from "@kintsugi/core";
import type { WorkspaceDockerPlan } from "./types.ts";

/** Snapshot Docker support and setup; runtime units are owned by the image. */
export async function prepareWorkspaceSystemd(plan: WorkspaceDockerPlan, directory: string, init: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const helperUnit = join(directory, "kintsugi-helper.service");
  await writeFile(helperUnit, workspaceRuntimeUnits()["kintsugi-helper.service"]);
  plan.containerFiles.push({ source: helperUnit, target: "/usr/lib/systemd/system/kintsugi-helper.service" });
  const systemd = await prepareWorkspaceTaskDefaults(directory);
  plan.containerFiles.push({ source: systemd, target: "/etc" });
  const source = join(directory, "init.sh");
  await writeFile(source, init);
  plan.containerFiles.push({ source, target: "/.kintsugi/init.sh" });
  const configuration = join(directory, "kintsugi");
  await mkdir(configuration, { recursive: true });
  await writeFile(join(configuration, "docker-support"), `${plan.privileged ? "enabled" : "disabled"}\n${plan.dockerSupportSettingsUrl ?? ""}\n`);
  await writeFile(join(configuration, "storage.json"), JSON.stringify({ driver: await readStorageDriver() }));
  // docker cp cannot create a file's missing parent directory in a stopped container.
  // Copy the directory into /etc so provisioning owns its creation, too.
  plan.containerFiles.push({ source: configuration, target: "/etc" });
  // systemd needs a writable cgroup mount; Docker can grant one without privileged mode.
  plan.extraArgs.push(...(plan.privileged ? ["--privileged"] : ["--security-opt", "writable-cgroups=true"]));
  plan.extraArgs.push("--cgroupns=private", "--tmpfs", "/run", "--stop-signal", "SIGRTMIN+3");
}

/** Refresh implicit manager task caps before a cold start; preserve explicit unit limits. */
export async function prepareWorkspaceTaskDefaults(directory: string): Promise<string> {
  const systemd = join(directory, "systemd");
  await mkdir(join(systemd, "system.conf.d"), { recursive: true });
  await writeFile(join(systemd, "system.conf.d", "90-kintsugi-workspace-limits.conf"), "[Manager]\nDefaultTasksMax=infinity\n");
  return systemd;
}
