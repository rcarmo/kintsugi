import { expect, test } from "bun:test";
import { workspaceRuntimeUnits } from "./workspace-systemd-units.ts";

test("socket-activated Docker loads the workspace proxy environment", () => {
  const units = workspaceRuntimeUnits();
  const service = units["docker.service"].split("[Service]\n")[1]!;
  expect(service.split("\n")).toContain("EnvironmentFile=/.kintsugi/environment");
  expect(units["docker.socket"]).toContain("WantedBy=sockets.target");
});

test("workspace services use the finite container task budget instead of systemd's percentage default", () => {
  for (const [name, unit] of Object.entries(workspaceRuntimeUnits())) {
    if (!name.endsWith(".service")) continue;
    const service = unit.split("[Service]\n")[1]!;
    expect(service.split("\n")).toContain("TasksMax=infinity");
  }
});

test("manager defaults also remove the implicit init.scope task ceiling", async () => {
  const configuration = await Bun.file(new URL("../rootfs/etc/systemd/system.conf.d/90-kintsugi-workspace-limits.conf", import.meta.url)).text();
  expect(configuration).toContain("[Manager]\n");
  expect(configuration.split("\n")).toContain("DefaultTasksMax=infinity");
  expect(configuration).not.toContain("DefaultLimitNPROC");
});
