import { stopWorkspaceTemplateSshAgents, workspaceSourceSshEnvironment } from "../src/ssh-agent.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKintsugiEventBus } from "@kintsugi/core";
import { clearAppTerminalProcesses } from "@kintsugi/observable-terminal/server";
import { clearGitHostingCredential, gitHostingProvider, gitHostingProviders, saveGitHostingCredential } from "@kintsugi/git-hosting";
import { addWorkspaceTemplate, cachedWorkspaceTemplateSourcePath, createWorkspaceTemplateSshKey, deleteWorkspaceTemplateSshKey, setWorkspaceTemplateSeedConfigEnabled, setWorkspaceTemplatePrivileged, type GitWorkspaceTemplateInitInstruction } from "@kintsugi/workspace-templates";
import { prepareWorkspaceSource, registerWorkspaceTemplateWorkspaceInitEvents } from "../src/workspace-source.ts";
import type { WorkspaceDockerPlan } from "@kintsugi/workspace";

async function run(command: string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(command, { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr || stdout}`);
  return { stdout, stderr, exitCode };
}

async function createRemote(): Promise<{ root: string; remote: string; seed: string }> {
  const root = await mkdtemp(join(tmpdir(), "kintsugi-source-test-"));
  const seed = join(root, "seed");
  const remote = join(root, "repo.git");
  await run(["git", "init", "-b", "main", seed]);
  await run(["git", "config", "user.name", "Test"], { cwd: seed });
  await run(["git", "config", "user.email", "test@example.com"], { cwd: seed });
  await writeFile(join(seed, "file.txt"), "one\n");
  await run(["git", "add", "file.txt"], { cwd: seed });
  await run(["git", "commit", "-m", "one"], { cwd: seed });
  await run(["git", "clone", "--bare", seed, remote]);
  await run(["git", "remote", "add", "origin", remote], { cwd: seed });
  return { root, remote, seed };
}

async function addSubmoduleRepository(parent: { seed: string }, childRemote: string, path: string): Promise<void> {
  await run(["git", "submodule", "add", childRemote, path], { cwd: parent.seed });
  await run(["git", "commit", "-m", `add ${path}`], { cwd: parent.seed });
}

async function startGitDaemon(): Promise<{ urlFor(path: string): string; stop(): Promise<void> }> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const proc = Bun.spawn(["git", "daemon", "--verbose", "--reuseaddr", "--export-all", "--base-path=/", "--listen=127.0.0.1", `--port=${port}`, "/"], { stdout: "ignore", stderr: "pipe" });
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 5000);
  try {
    // Git emits this only after listening; a fixed sleep races startup on busy CI runners.
    while (!output.includes("Ready to rumble")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`Git daemon ${timedOut ? "startup timed out" : "exited before listening"}: ${output}`);
      output += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    proc.kill();
    await proc.exited;
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return {
    urlFor: (path) => `git://127.0.0.1:${port}${path}`,
    stop: async () => { proc.kill(); await proc.exited; },
  };
}

describe("workspace source preparation", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let previousGitHubToken: string | undefined;
  const tempRoots: string[] = [];

  beforeEach(async () => {
    previousDataDir = process.env.KINTSUGI_DATA_DIR;
    previousGitHubToken = process.env.GH_TOKEN;
    dataDir = await mkdtemp(join(tmpdir(), "kintsugi-data-test-"));
    tempRoots.push(dataDir);
    process.env.KINTSUGI_DATA_DIR = dataDir;
    delete process.env.GH_TOKEN;
  });

  afterEach(async () => {
    await clearAppTerminalProcesses();
    await stopWorkspaceTemplateSshAgents();
    for (const provider of gitHostingProviders) clearGitHostingCredential(provider);
    if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previousDataDir;
    if (previousGitHubToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHubToken;
    await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  test("prepares unborn default and explicit branches without creating commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "kintsugi-empty-source-test-"));
    tempRoots.push(root);
    const remote = join(root, "repo.git");
    await run(["git", "init", "--bare", "-b", "main", remote]);

    for (const branch of [null, "new-project"]) {
      const workspaceTemplate = (await addWorkspaceTemplate(`${remote}${branch ? `#${branch}` : ""}`)).workspaceTemplate;
      for (const attempt of ["first", "cached"]) {
        const workspaceId = `empty-${branch}-${attempt}`;
        const source = await prepareWorkspaceSource({ workspaceId, gitUrl: remote, branch });
        expect(source.resolvedCommit).toBeNull();
        expect((await run(["git", "symbolic-ref", "--short", "HEAD"], { cwd: source.worktreePath })).stdout.trim()).toBe(branch ?? "main");
        expect((await run(["git", "for-each-ref"], { cwd: source.worktreePath })).stdout).toBe("");
        expect((await run(["git", "status", "--porcelain"], { cwd: source.worktreePath })).stdout).toBe("");
        expect((await run(["git", "remote", "get-url", "origin"], { cwd: source.worktreePath })).stdout.trim()).toBe(remote);
        const metadata = await Bun.file(join(source.cleanupPath, "metadata.json")).json();
        expect(metadata.resolvedCommit).toBeNull();
        expect(metadata.effectiveBranch).toBe(branch ?? "main");

        const events = createKintsugiEventBus();
        registerWorkspaceTemplateWorkspaceInitEvents(events);
        const init: GitWorkspaceTemplateInitInstruction = { type: "project.git", projectId: workspaceTemplate.id, name: workspaceTemplate.id, gitUrl: remote, branch, sessionShareKey: workspaceTemplate.id };
        const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
        await events.emit("workspace_plan_prepare", { workspaceId, init, workHostPath: source.worktreePath, workContainerPath: "/work", plan });
        expect(plan.labels["com.kintsugi.source-commit"]).toBeUndefined();
        expect(plan.labels["com.kintsugi.source-template"]).toBe(source.templateKey);
      }
    }
  });

  test("uses the first pushed commit for later workspaces while the original stays unborn", async () => {
    const root = await mkdtemp(join(tmpdir(), "kintsugi-empty-source-test-"));
    tempRoots.push(root);
    const remote = join(root, "repo.git");
    await run(["git", "init", "--bare", "-b", "main", remote]);
    const first = await prepareWorkspaceSource({ workspaceId: "empty-first", gitUrl: remote, branch: null });
    const original = await prepareWorkspaceSource({ workspaceId: "empty-original", gitUrl: remote, branch: null });
    await run(["git", "config", "user.name", "Test"], { cwd: first.worktreePath });
    await run(["git", "config", "user.email", "test@example.com"], { cwd: first.worktreePath });
    await writeFile(join(first.worktreePath, "README.md"), "New project\n");
    await run(["git", "add", "README.md"], { cwd: first.worktreePath });
    await run(["git", "commit", "-m", "Initial commit"], { cwd: first.worktreePath });
    await run(["git", "push", "-u", "origin", "main"], { cwd: first.worktreePath });

    const next = await prepareWorkspaceSource({ workspaceId: "with-first-commit", gitUrl: remote, branch: null });
    expect(next.resolvedCommit).toBe((await run(["git", "rev-parse", "HEAD"], { cwd: first.worktreePath })).stdout.trim());
    expect(await Bun.file(join(next.worktreePath, "README.md")).text()).toBe("New project\n");
    expect((await run(["git", "ls-files"], { cwd: original.worktreePath })).stdout).toBe("");
    expect(original.resolvedCommit).toBeNull();
  });

  test("discards cached history when the remote becomes empty", async () => {
    const fixture = await createRemote();
    tempRoots.push(fixture.root);
    const first = await prepareWorkspaceSource({ workspaceId: "before-empty", gitUrl: fixture.remote, branch: "main" });
    await run(["git", "--git-dir", fixture.remote, "update-ref", "-d", "refs/heads/main"]);
    const next = await prepareWorkspaceSource({ workspaceId: "after-empty", gitUrl: fixture.remote, branch: "main" });
    expect(next.resolvedCommit).toBeNull();
    expect((await run(["git", "ls-files"], { cwd: next.worktreePath })).stdout).toBe("");
    expect(await Bun.file(join(first.worktreePath, "file.txt")).text()).toBe("one\n");
  });

  test("missing branches report a recoverable error on initial and cached preparation", async () => {
    const fixture = await createRemote();
    tempRoots.push(fixture.root);
    for (const workspaceId of ["missing-first", "missing-cached"]) {
      await expect(prepareWorkspaceSource({ workspaceId, gitUrl: fixture.remote, branch: "does-not-exist" })).rejects.toMatchObject({
        code: "branch_not_found",
        message: 'Branch "does-not-exist" was not found. Open template settings and correct the branch after # in Repository, or remove it to use the default branch. Then create a new workspace.',
      });
    }
    for (const branch of ["main", null]) {
      const source = await prepareWorkspaceSource({ workspaceId: `corrected-${branch}`, gitUrl: fixture.remote, branch });
      expect(await Bun.file(join(source.worktreePath, "file.txt")).text()).toBe("one\n");
    }
  });

  test("repository access failures are not reported as missing branches", async () => {
    await expect(prepareWorkspaceSource({ workspaceId: "unavailable", gitUrl: join(dataDir, "missing.git"), branch: "main" })).rejects.toMatchObject({ code: "git_error" });
  });

  test("provides the cached project checkout for LaunchComposer Dictation", async () => {
    const fixture = await createRemote();
    tempRoots.push(fixture.root);
    const workspaceTemplate = (await addWorkspaceTemplate(`${fixture.remote}#main`)).workspaceTemplate;
    const contextPath = join(".kintsugi", "dictation-context");
    const cachedPath = join(await cachedWorkspaceTemplateSourcePath(workspaceTemplate.id), contextPath);
    expect(await Bun.file(cachedPath).exists()).toBe(false);

    await mkdir(join(fixture.seed, ".kintsugi"));
    await writeFile(join(fixture.seed, contextPath), "Claude Code\n");
    await run(["git", "add", contextPath], { cwd: fixture.seed });
    await run(["git", "commit", "-m", "Add vocabulary"], { cwd: fixture.seed });
    await run(["git", "push", "origin", "main"], { cwd: fixture.seed });
    await prepareWorkspaceSource({ workspaceId: "ws-context", gitUrl: fixture.remote, branch: "main" });
    expect(await Bun.file(cachedPath).text()).toBe("Claude Code\n");
  });

  test("creates a standalone COW workspace checkout from a reusable template", async () => {
    const fixture = await createRemote();
    tempRoots.push(fixture.root);

    const source = await prepareWorkspaceSource({ workspaceId: "ws1", gitUrl: fixture.remote, branch: "main" });

    expect(await Bun.file(join(source.worktreePath, "file.txt")).text()).toBe("one\n");
    expect(source.cleanupPath).toBe(join(dataDir, "workspaces", "ws1"));
    const commonDir = (await run(["git", "-C", source.worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    expect(await realpath(commonDir)).toBe(await realpath(join(source.worktreePath, ".git")));
    expect(await Bun.file(join(source.worktreePath, ".git", "objects", "info", "alternates")).exists()).toBe(false);
  });

  test("applies stored git hosting tokens to host-side git commands before container creation", async () => {
    const fixture = await createRemote();
    tempRoots.push(fixture.root);
    const realGit = (await run(["which", "git"])).stdout.trim();
    const fakeBin = await mkdtemp(join(tmpdir(), "kintsugi-fake-git-"));
    tempRoots.push(fakeBin);
    const tokenLog = join(fakeBin, "tokens.log");
    const fakeGit = join(fakeBin, "git");
    await writeFile(fakeGit, `#!/bin/sh\nprintf '%s\\n' "\${GH_TOKEN-} \${GITLAB_TOKEN-} \${BITBUCKET_API_TOKEN-}" >> ${JSON.stringify(tokenLog)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
    await chmod(fakeGit, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    saveGitHostingCredential(gitHostingProvider("github"), { token: "github-token" });
    saveGitHostingCredential(gitHostingProvider("gitlab"), { token: "gitlab-token" });
    saveGitHostingCredential(gitHostingProvider("bitbucket"), { token: "bitbucket-token", account: "me@example.com" });
    try {
      await prepareWorkspaceSource({ workspaceId: "ws-token", gitUrl: fixture.remote, branch: "main" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    const tokens = (await Bun.file(tokenLog).text()).trim().split("\n");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token === "github-token gitlab-token bitbucket-token")).toBe(true);
  });

  test("initializes nested submodules recursively in the reusable template and workspace", async () => {
    const leaf = await createRemote();
    const middle = await createRemote();
    const parent = await createRemote();
    tempRoots.push(leaf.root, middle.root, parent.root);
    const daemon = await startGitDaemon();
    try {
      await addSubmoduleRepository(middle, daemon.urlFor(leaf.remote), "vendor/leaf");
      await run(["git", "push", middle.remote, "main"], { cwd: middle.seed });
      await addSubmoduleRepository(parent, daemon.urlFor(middle.remote), "deps/middle");
      await run(["git", "push", parent.remote, "main"], { cwd: parent.seed });

      const source = await prepareWorkspaceSource({ workspaceId: "ws-submodules", gitUrl: parent.remote, branch: "main" });

      expect(await Bun.file(join(source.worktreePath, "deps", "middle", "file.txt")).text()).toBe("one\n");
      expect(await Bun.file(join(source.worktreePath, "deps", "middle", "vendor", "leaf", "file.txt")).text()).toBe("one\n");
      expect((await run(["git", "-C", source.worktreePath, "submodule", "status", "--recursive"])).stdout.split("\n").filter(Boolean).every((line) => line.startsWith(" "))).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  test("persisted project key changes reach already-provisioned sockets without restarting", async () => {
    const workspaceTemplate = (await addWorkspaceTemplate("git@example.test:/repo.git")).workspaceTemplate;
    const environment = await workspaceSourceSshEnvironment("ws-live-keys", workspaceTemplate.id);
    const other = await workspaceSourceSshEnvironment("ws-no-project");
    expect(environment.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
    async function listed(env: Record<string, string>) {
      const process = Bun.spawn(["ssh-add", "-l"], { env: { ...globalThis.process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return { status: await process.exited, output: await new Response(process.stdout).text() };
    }
    expect((await listed(environment)).status).toBe(1);
    const keyPath = join(dataDir, "live-key");
    await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
    const key = await createWorkspaceTemplateSshKey(workspaceTemplate.id, await Bun.file(keyPath).text());
    const fingerprint = (await run(["ssh-keygen", "-lf", `${keyPath}.pub`])).stdout.split(/\s+/)[1]!;
    expect((await listed(environment)).output).toContain(fingerprint);
    expect((await listed(other)).status).toBe(1);
    await deleteWorkspaceTemplateSshKey(workspaceTemplate.id, key.id);
    expect((await listed(environment)).status).toBe(1);
  });

  test("updates the template for later workspaces without changing existing workspaces", async () => {
    const fixture = await createRemote();
    tempRoots.push(fixture.root);

    const first = await prepareWorkspaceSource({ workspaceId: "ws1", gitUrl: fixture.remote, branch: "main" });
    await writeFile(join(fixture.seed, "file.txt"), "two\n");
    await run(["git", "add", "file.txt"], { cwd: fixture.seed });
    await run(["git", "commit", "-m", "two"], { cwd: fixture.seed });
    await run(["git", "push", "origin", "main"], { cwd: fixture.seed });

    const second = await prepareWorkspaceSource({ workspaceId: "ws2", gitUrl: fixture.remote, branch: "main" });

    expect(await Bun.file(join(first.worktreePath, "file.txt")).text()).toBe("one\n");
    expect(await Bun.file(join(second.worktreePath, "file.txt")).text()).toBe("two\n");
    expect(first.resolvedCommit).not.toBe(second.resolvedCommit);
  });

  test("adds a shared /persistent bind mount for workspaces from the same saved project", async () => {
    const events = createKintsugiEventBus();
    registerWorkspaceTemplateWorkspaceInitEvents(events);
    const planFor = async (workspaceId: string, workspaceTemplateId: string): Promise<WorkspaceDockerPlan> => {
      const init: GitWorkspaceTemplateInitInstruction = { type: "project.git", projectId: workspaceTemplateId, name: workspaceTemplateId, gitUrl: `https://example.test/${workspaceTemplateId}.git`, branch: null, sessionShareKey: workspaceTemplateId };
      const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
      await events.emit("workspace_plan_prepare", { workspaceId, init, workHostPath: join(dataDir, "workspaces", workspaceId, "work"), workContainerPath: "/work", plan });
      return plan;
    };

    const workspaceTemplateA = (await addWorkspaceTemplate("https://example.test/workspace-template-a.git")).workspaceTemplate;
    const workspaceTemplateB = (await addWorkspaceTemplate("https://example.test/workspace-template-b.git")).workspaceTemplate;
    const first = await planFor("ws1", workspaceTemplateA.id);
    const second = await planFor("ws2", workspaceTemplateA.id);
    const other = await planFor("ws3", workspaceTemplateB.id);
    const workspaceTemplateAKey = createHash("sha256").update(workspaceTemplateA.id).digest("hex").slice(0, 16);
    const workspaceTemplateAPath = join(dataDir, "projects", workspaceTemplateAKey, "persistent");

    expect(first.mounts).toEqual([{ type: "bind", source: workspaceTemplateAPath, target: "/persistent" }]);
    expect(second.mounts).toEqual(first.mounts);
    expect(other.mounts[0]!.source).not.toBe(workspaceTemplateAPath);
    expect((await stat(workspaceTemplateAPath)).isDirectory()).toBe(true);
    expect(first.initScripts).toEqual([]);
  });

  test("only host template settings grant seeding permission to the plan", async () => {
    const events = createKintsugiEventBus();
    registerWorkspaceTemplateWorkspaceInitEvents(events);
    const template = (await addWorkspaceTemplate("https://example.test/nested.git")).workspaceTemplate;
    const other = (await addWorkspaceTemplate("https://example.test/other.git")).workspaceTemplate;
    const provision = async (projectId?: string) => {
      const init: GitWorkspaceTemplateInitInstruction | undefined = projectId ? { type: "project.git", projectId, name: "nested", gitUrl: template.gitUrl, branch: null, sessionShareKey: "nested" } : undefined;
      const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
      await events.emit("workspace_plan_prepare", { workspaceId: "seeding", init, workHostPath: join(dataDir, "workspaces", "seeding", "work"), workContainerPath: "/work", plan });
      return plan;
    };
    expect((await provision(template.id)).seedConfigEnabled).toBe(false);
    await setWorkspaceTemplateSeedConfigEnabled(template.id, true);
    expect((await provision(template.id)).seedConfigEnabled).toBe(true);
    expect((await provision(other.id)).seedConfigEnabled).toBe(false);
    expect((await provision()).seedConfigEnabled).toBeUndefined();
    await setWorkspaceTemplateSeedConfigEnabled(template.id, false);
    expect((await provision(template.id)).seedConfigEnabled).toBe(false);
  });

  test("privileged mode follows the project at provisioning and links to its settings", async () => {
    const events = createKintsugiEventBus();
    registerWorkspaceTemplateWorkspaceInitEvents(events);
    const { workspaceTemplate } = await addWorkspaceTemplate("https://example.test/privileged.git");
    const provision = async () => {
      const init: GitWorkspaceTemplateInitInstruction = { type: "project.git", projectId: workspaceTemplate.id, name: workspaceTemplate.name, gitUrl: workspaceTemplate.gitUrl, branch: null, sessionShareKey: workspaceTemplate.sessionShareKey };
      const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
      await events.emit("workspace_plan_prepare", { workspaceId: "privilege", init, workHostPath: join(dataDir, "workspaces", "privilege", "work"), workContainerPath: "/work", plan });
      return plan;
    };
    const initial = await provision();
    expect(initial.privileged).toBe(false);
    expect(initial.dockerSupportSettingsUrl).toEndWith(`/workspace-templates/${encodeURIComponent(workspaceTemplate.id)}/settings?section=privileged`);
    await setWorkspaceTemplatePrivileged(workspaceTemplate.id, true);
    expect((await provision()).privileged).toBe(true);
    await setWorkspaceTemplatePrivileged(workspaceTemplate.id, false);
    expect((await provision()).privileged).toBe(false);
  });

  test("rejects malformed persisted workspace source metadata", async () => {
    const workspaceId = "malformed-source";
    const metadataDir = join(dataDir, "workspaces", workspaceId);
    await mkdir(metadataDir, { recursive: true });
    await writeFile(join(metadataDir, "metadata.json"), JSON.stringify({
      workspaceId,
      gitUrl: "https://example.test/project.git",
      branch: null,
      effectiveBranch: "main",
      templateKey: "template",
      resolvedCommit: 42,
      createdAt: new Date().toISOString(),
    }));

    const events = createKintsugiEventBus();
    registerWorkspaceTemplateWorkspaceInitEvents(events);
    const init: GitWorkspaceTemplateInitInstruction = { type: "project.git", projectId: "project", name: "Project", gitUrl: "https://example.test/project.git", branch: null, sessionShareKey: "project" };
    const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };

    await expect(events.emit("workspace_plan_prepare", { workspaceId, init, workHostPath: join(metadataDir, "work"), workContainerPath: "/work", plan })).rejects.toThrow();
  });

});
