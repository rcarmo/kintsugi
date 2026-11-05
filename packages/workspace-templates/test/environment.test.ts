import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createKintsugiEventBus } from "@kintsugi/core";
import { addWorkspaceTemplate, createWorkspaceTemplateEnvironmentVariable, globalWorkspaceConfiguration, workspaceInitFromTemplate, setWorkspaceTemplatePreloadImages } from "@kintsugi/workspace-templates";
import { registerWorkspaceTemplateWorkspaceInitEvents } from "../src/workspace-source.ts";
import type { WorkspaceDockerPlan } from "@kintsugi/workspace";

describe("Workspace template environment", () => {
  let previousDataDir: string | undefined;
  let dataDir: string;

  beforeEach(async () => {
    previousDataDir = process.env.KINTSUGI_DATA_DIR;
    dataDir = await mkdtemp(`${tmpdir()}/kintsugi-workspace-template-environment-`);
    process.env.KINTSUGI_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("adds saved variables to Workspace template container plans", async () => {
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/repo.git")).workspaceTemplate;
    await createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "API_URL", value: "https://api.example.com" });
    await createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "EMPTY", value: "" });
    await setWorkspaceTemplatePreloadImages(workspaceTemplate.id, ["docker.io/library/postgres:17"]);
    const events = createKintsugiEventBus();
    registerWorkspaceTemplateWorkspaceInitEvents(events);
    const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };

    await events.emit("workspace_plan_prepare", { workspaceId: "workspace", init: workspaceInitFromTemplate(workspaceTemplate), workHostPath: "/tmp/work", workContainerPath: "/work", plan });

    expect(plan.env).toEqual({ API_URL: "https://api.example.com", EMPTY: "" });
    expect(plan.preloadImages).toEqual(["docker.io/library/postgres:17"]);
    await setWorkspaceTemplatePreloadImages(workspaceTemplate.id, ["docker.io/library/redis:8"]);
    expect(plan.preloadImages).toEqual(["docker.io/library/postgres:17"]);
  });

  test("adds global variables to every workspace, with template variables taking precedence", async () => {
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/repo.git")).workspaceTemplate;
    await createWorkspaceTemplateEnvironmentVariable(globalWorkspaceConfiguration, { name: "TZ", value: "UTC" });
    await createWorkspaceTemplateEnvironmentVariable(globalWorkspaceConfiguration, { name: "API_URL", value: "https://global.example.com" });
    await createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "API_URL", value: "https://template.example.com" });
    const events = createKintsugiEventBus();
    registerWorkspaceTemplateWorkspaceInitEvents(events);
    const plan = (): WorkspaceDockerPlan => ({ labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] });

    const fromTemplate = plan();
    await events.emit("workspace_plan_prepare", { workspaceId: "template-workspace", init: workspaceInitFromTemplate(workspaceTemplate), workHostPath: "/tmp/work", workContainerPath: "/work", plan: fromTemplate });
    expect(fromTemplate.env).toEqual({ TZ: "UTC", API_URL: "https://template.example.com" });

    const empty = plan();
    await events.emit("workspace_plan_prepare", { workspaceId: "empty-workspace", init: undefined, workHostPath: "/tmp/work", workContainerPath: "/work", plan: empty });
    expect(empty.env).toEqual({ TZ: "UTC", API_URL: "https://global.example.com" });
  });
});
