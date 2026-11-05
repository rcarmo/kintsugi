import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKintsugiEventBus } from "@kintsugi/core";
import type { WorkspaceDockerPlan } from "@kintsugi/workspace";
import { registerWorkspaceProxyEvents } from "../src/egress/egress-proxy.ts";

test("workspace certificate defaults support modern Yarn without disabling TLS verification", async () => {
  const previousDataDir = process.env.KINTSUGI_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-proxy-env-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
  try {
    const events = createKintsugiEventBus();
    registerWorkspaceProxyEvents(events);
    await events.emit("workspace_plan_prepare", { workspaceId: "certificate-defaults", workHostPath: "/tmp/work", workContainerPath: "/work", plan });

    expect(plan.env).not.toHaveProperty("YARN_CA_FILE");
    expect(plan.env.NODE_EXTRA_CA_CERTS).toBe("/run/kintsugi-mitm-ca.crt");
    expect(plan.mounts).toContainEqual({ type: "bind", source: join(process.env.KINTSUGI_DOCKER_HOST_DATA_DIR ?? directory, "proxy-ca", "kintsugi-mitm-ca.pem"), target: plan.env.NODE_EXTRA_CA_CERTS, readonly: true });
    expect(plan.initScripts).toContain("cat /run/kintsugi-mitm-ca.crt >> /etc/ssl/certs/ca-certificates.crt");
    expect(plan.env.NPM_CONFIG_CAFILE).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(plan.env).not.toHaveProperty("NODE_TLS_REJECT_UNAUTHORIZED");
    expect(plan.env).not.toHaveProperty("YARN_ENABLE_STRICT_SSL");
  } finally {
    for (const cleanup of plan.cleanup) await cleanup();
    if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});
