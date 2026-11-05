import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import {
  kintsugiDataPath,
  runCommand,
  createKeyedOperationQueue,
  KintsugiCoreError,
  dockerHostKintsugiDataPath,
  getKintsugiRuntimeContext,
  invalidArguments,
  shellQuote,
  type KintsugiEventBus,
  type CommandResult,
} from "@kintsugi/core";
import { gitHostingGitConfiguration } from "@kintsugi/git-hosting";
import { appTerminalProcesses, runTerminalProcess, tailTerminalOutput, tailTerminalText, terminalOutputDisplayBytes } from "@kintsugi/observable-terminal/server";
import { appTerminalProcessSocketPath } from "@kintsugi/observable-terminal/shared";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { workspaceTemplateIdFromInit, workspaceTemplateIdOfInit, getWorkspaceTemplateConfiguration, listWorkspaceTemplates, isGitWorkspaceTemplateInit } from "./workspace-template.ts";
import { workspaceSourceSshEnvironment, stopWorkspaceSshAgent } from "./ssh-agent.ts";
import { effectiveEnvironment } from "./environment.ts";

export interface PreparedWorkspaceSource {
  workspaceId: string;
  worktreePath: string;
  cleanupPath: string;
  gitUrl: string;
  branch: string | null;
  resolvedCommit: string | null;
  templateKey: string;
}

const workspaceSourceMetadataSchema = Type.Object({
  workspaceId: Type.String(),
  gitUrl: Type.String(),
  branch: Type.Union([Type.String(), Type.Null()]),
  effectiveBranch: Type.Union([Type.String(), Type.Null()]),
  templateKey: Type.String(),
  resolvedCommit: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
type WorkspaceSourceMetadata = Static<typeof workspaceSourceMetadataSchema>;

// Process-local: multiple server processes sharing a data directory would need a file lock.
const withTemplateLock = createKeyedOperationQueue();
const reflinkSupportByDir = new Map<string, Promise<boolean>>();
const regularCopyWarnings = new Set<string>();

function sourceRoot(): string {
  return getKintsugiRuntimeContext().kintsugiDataDir;
}

function templateKey(gitUrl: string, branch: string | null): string {
  return createHash("sha256").update(`${gitUrl.trim()}\0${branch?.trim() ?? ""}`).digest("hex").slice(0, 16);
}

function templateDir(key: string): string {
  return join(sourceRoot(), "git-templates", key);
}

function templateRepoPath(key: string): string {
  return join(templateDir(key), "repo");
}

/** The last cached checkout for this template, if a workspace has populated it. */
export async function cachedWorkspaceTemplateSourcePath(workspaceTemplateId: string): Promise<string> {
  const { gitUrl, branch } = await getWorkspaceTemplateConfiguration(workspaceTemplateId);
  return templateRepoPath(templateKey(gitUrl, branch));
}

function workspaceSourceDir(workspaceId: string): string {
  return join(sourceRoot(), "workspaces", workspaceId);
}

export function workspaceTemplateDataDirKey(workspaceTemplateId: string): string {
  return createHash("sha256").update(workspaceTemplateId).digest("hex").slice(0, 16);
}

export async function workspaceTemplatePersistentMount(workspaceTemplateId: string): Promise<{ source: string; target: "/persistent" }> {
  const runtime = getKintsugiRuntimeContext();
  const key = workspaceTemplateDataDirKey(workspaceTemplateId);
  await mkdir(kintsugiDataPath(runtime, "projects", key, "persistent"), { recursive: true });
  return { source: dockerHostKintsugiDataPath(runtime, "projects", key, "persistent"), target: "/persistent" };
}

function workspaceWorktreePath(workspaceId: string): string {
  return join(workspaceSourceDir(workspaceId), "work");
}

async function command(name: string, args: string[], options: { env?: Record<string, string | undefined> } = {}): Promise<CommandResult> {
  const result = await runCommand([name, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env } });
  return { ...result, stdout: result.stdout.toString() };
}

async function requireCommand(name: string, args: string[], options: { env?: Record<string, string | undefined>; errorCode?: string } = {}): Promise<CommandResult> {
  const result = await command(name, args, options);
  if (result.exitCode !== 0) {
    throw new KintsugiCoreError(options.errorCode ?? "workspace_source_failed", (result.stderr || result.stdout).trim() || `${name} ${args.join(" ")} failed`);
  }
  return result;
}

async function git(args: string[], options: { errorCode?: string } = {}): Promise<CommandResult> {
  const credentials = gitHostingGitConfiguration();
  return await requireCommand("git", ["-c", `credential.helper=${credentials.command}`, ...credentials.configArgs, ...args], {
    env: credentials.environment,
    errorCode: options.errorCode ?? "git_error",
  });
}

async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

async function ensureTemplate(gitUrl: string, branch: string | null, key: string, options: { workspaceId: string; events?: KintsugiEventBus; logPath: string; sshEnv: Record<string, string> }): Promise<{ repoPath: string; resolvedCommit: string | null; effectiveBranch: string | null }> {
  const dir = templateDir(key);
  const repoPath = templateRepoPath(key);
  const tmpPath = join(dir, `repo.tmp-${process.pid}-${Date.now()}`);
  const effectiveBranchPath = join(dir, `effective-branch-${process.pid}-${Date.now()}.txt`);
  const resolvedCommitPath = join(dir, `resolved-commit-${process.pid}-${Date.now()}.txt`);
  await mkdir(dir, { recursive: true });
  await rm(tmpPath, { recursive: true, force: true });
  await rm(effectiveBranchPath, { force: true });
  await rm(resolvedCommitPath, { force: true });

  const branchNotFoundExitCode = 44;
  const credentials = gitHostingGitConfiguration();
  const script = `
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
repo_path=${shellQuote(repoPath)}
tmp_path=${shellQuote(tmpPath)}
git_url=${shellQuote(gitUrl)}
branch=${shellQuote(branch ?? "")}
credential_helper=${shellQuote(credentials.command)}
effective_branch_file=${shellQuote(effectiveBranchPath)}
resolved_commit_file=${shellQuote(resolvedCommitPath)}

git_cmd() { git -c credential.helper="$credential_helper" ${credentials.configArgs.map(shellQuote).join(" ")} "$@"; }
trap 'rm -rf "$tmp_path"' EXIT

# Inspect the remote, not the cached checkout: local branches may retain old commits.
remote_refs="$(git_cmd ls-remote --refs "$git_url")"
if [ -z "$remote_refs" ] || [ ! -d "$repo_path/.git" ]; then
  rm -rf "$tmp_path"
  git_cmd clone "$git_url" "$tmp_path"
  rm -rf "$repo_path"
  mv "$tmp_path" "$repo_path"
fi

git_cmd -C "$repo_path" remote set-url origin "$git_url"
git_cmd lfs version
git_cmd -C "$repo_path" lfs install --local

if [ -z "$remote_refs" ]; then
  # Clone preserves the advertised unborn default branch when Git provides it.
  # An explicit branch is also valid here: there are no remote branches to miss.
  if [ -n "$branch" ]; then
    git_cmd check-ref-format --branch "$branch"
    git_cmd -C "$repo_path" symbolic-ref HEAD "refs/heads/$branch"
  fi
  effective_branch="$(git_cmd -C "$repo_path" symbolic-ref --short HEAD)"
  : > "$resolved_commit_file"
else
  git_cmd -C "$repo_path" fetch --prune --force --tags origin

  if [ -n "$branch" ]; then
    effective_branch="$branch"
    reset_ref="refs/remotes/origin/$branch"
    git_cmd -C "$repo_path" show-ref --verify --quiet "$reset_ref" || {
      status=$?
      if [ "$status" -eq 1 ]; then exit ${branchNotFoundExitCode}; fi
      exit "$status"
    }
    git_cmd -C "$repo_path" checkout -B "$effective_branch" "$reset_ref"
  else
    git_cmd -C "$repo_path" remote set-head origin -a
    remote_head="$(git_cmd -C "$repo_path" symbolic-ref --short refs/remotes/origin/HEAD)"
    case "$remote_head" in origin/*) ;; *) echo "could not resolve origin default branch for $git_url" >&2; exit 2 ;; esac
    effective_branch="\${remote_head#origin/}"
    reset_ref="$remote_head"
    git_cmd -C "$repo_path" checkout -B "$effective_branch" "$reset_ref"
  fi

  git_cmd -C "$repo_path" reset --hard "$reset_ref"
  git_cmd -C "$repo_path" clean -ffdx
  git_cmd -C "$repo_path" lfs pull origin "$effective_branch"
  git_cmd -C "$repo_path" submodule sync --recursive
  git_cmd -C "$repo_path" submodule update --init --recursive --checkout --force
  git_cmd -C "$repo_path" submodule foreach --quiet --recursive 'git clean -ffdx && git lfs install --local && git lfs pull'

  git_cmd -C "$repo_path" rev-parse HEAD > "$resolved_commit_file"
fi

status="$(git_cmd -C "$repo_path" status --porcelain=v1)"
if [ -n "$status" ]; then
  echo "template checkout is dirty after reset:" >&2
  echo "$status" >&2
  exit 3
fi

printf '%s\n' "$effective_branch" > "$effective_branch_file"
`;

  const env = { ...options.sshEnv, ...credentials.environment };
  const result = await runTerminalProcess(appTerminalProcesses(), { command: script, cwd: dir, env }, async (id) => {
    await options.events?.emit("workspace_provision_progress", { workspaceId: options.workspaceId, detail: "Clone repository", terminalSocketPath: appTerminalProcessSocketPath(id) });
  });
  await appendFile(options.logPath, result.output.text).catch(() => undefined);
  await options.events?.emit("workspace_provision_progress", { workspaceId: options.workspaceId, output: tailTerminalOutput(result.output.ansi, terminalOutputDisplayBytes), terminalSocketPath: undefined });
  if (result.exitCode === branchNotFoundExitCode) {
    throw new KintsugiCoreError("branch_not_found", `Branch "${branch}" was not found. Open template settings and correct the branch after # in Repository, or remove it to use the default branch. Then create a new workspace.`);
  }
  if (result.exitCode !== 0) {
    const detail = tailTerminalText(result.output.text) || `git provisioning failed with exit code ${result.exitCode}`;
    const trustHelp = result.output.text.includes("Host key verification failed") ? "\nConfigure verified server keys in template settings → Trusted SSH servers, then retry workspace creation." : "";
    throw new KintsugiCoreError("git_error", `${detail}${trustHelp}`);
  }

  const effectiveBranch = (await readFile(effectiveBranchPath, "utf8")).trim() || null;
  const resolvedCommit = (await readFile(resolvedCommitPath, "utf8")).trim() || null;
  await rm(effectiveBranchPath, { force: true });
  await rm(resolvedCommitPath, { force: true });

  const metadata = {
    gitUrl,
    branch,
    effectiveBranch,
    templateKey: key,
    resolvedCommit,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

  return { repoPath, resolvedCommit, effectiveBranch };
}

function reflinkCopyArgs(src: string, dest: string): string[] | null {
  const os = platform();
  if (os === "darwin") return ["-cR", src, dest];
  if (os === "linux") return ["--reflink=always", "-a", src, dest];
  return null;
}

function regularCopyArgs(src: string, dest: string): string[] | null {
  const os = platform();
  if (os === "darwin") return ["-pR", src, dest];
  if (os === "linux") return ["-a", src, dest];
  return null;
}

async function detectReflinkSupport(dir: string): Promise<boolean> {
  const realDir = await realpath(dir).catch(() => resolve(dir));
  const cached = reflinkSupportByDir.get(realDir);
  if (cached) return await cached;

  const probe = (async () => {
    const args = reflinkCopyArgs("", "");
    if (!args) return false;

    const probeDir = join(dir, `.reflink-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const src = join(probeDir, "src");
    const dest = join(probeDir, "dest");
    try {
      await mkdir(probeDir, { recursive: true });
      await writeFile(src, "kintsugi reflink probe\n");
      const result = await command("cp", reflinkCopyArgs(src, dest)!);
      return result.exitCode === 0;
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();

  reflinkSupportByDir.set(realDir, probe);
  return await probe;
}

function warnRegularCopy(dir: string): void {
  if (regularCopyWarnings.has(dir)) return;
  regularCopyWarnings.add(dir);
  console.warn(`Kintsugi warning: ${dir} does not appear to support copy-on-write/reflink copies; workspace creation will use regular copies and may be slower than ideal.`);
}

async function copyWorkspaceTemplate(src: string, dest: string, supportProbeDir: string): Promise<void> {
  if (await detectReflinkSupport(supportProbeDir)) {
    const args = reflinkCopyArgs(src, dest);
    if (!args) throw new KintsugiCoreError("cow_unavailable", `copy-on-write workspace copies are not supported on ${platform()}`);
    await requireCommand("cp", args, { errorCode: "cow_unavailable" });
    return;
  }

  warnRegularCopy(supportProbeDir);
  const args = regularCopyArgs(src, dest);
  if (!args) throw new KintsugiCoreError("copy_unavailable", `workspace template copies are not supported on ${platform()}`);
  await requireCommand("cp", args, { errorCode: "copy_unavailable" });
}

async function verifyStandaloneWorktree(worktreePath: string): Promise<void> {
  await git(["-C", worktreePath, "rev-parse", "--is-inside-work-tree"]);
  const common = await git(["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = await realpath(resolve(common.stdout.trim()));
  const expected = await realpath(resolve(join(worktreePath, ".git")));
  if (commonDir !== expected) {
    throw new KintsugiCoreError("workspace_source_invalid", `workspace git common dir is ${commonDir}, expected ${expected}`);
  }
  if (await pathExists(join(worktreePath, ".git", "objects", "info", "alternates"))) {
    throw new KintsugiCoreError("workspace_source_invalid", "workspace git checkout unexpectedly uses alternates");
  }
}

export async function prepareWorkspaceSource(options: { workspaceId: string; gitUrl: string; branch: string | null; worktreePath?: string; workspaceTemplateId?: string; events?: KintsugiEventBus }): Promise<PreparedWorkspaceSource> {
  const gitUrl = options.gitUrl.trim();
  if (!gitUrl) throw invalidArguments("missing git URL");
  const branch = options.branch?.trim() || null;
  const key = templateKey(gitUrl, branch);
  const cleanupPath = workspaceSourceDir(options.workspaceId);
  const worktreePath = options.worktreePath ?? workspaceWorktreePath(options.workspaceId);

  return await withTemplateLock(key, async () => {
    await mkdir(cleanupPath, { recursive: true });
    if (await pathExists(worktreePath)) {
      const entries = await readdir(worktreePath);
      if (entries.length > 0) throw new KintsugiCoreError("workspace_source_exists", `workspace source is not empty: ${worktreePath}`);
    }
    const tmpWorkPath = join(cleanupPath, `work.tmp-${process.pid}-${Date.now()}`);
    await rm(tmpWorkPath, { recursive: true, force: true });
    const logPath = join(cleanupPath, `project-provision-${Date.now()}.log`);

    try {
      await writeFile(logPath, `Preparing template ${gitUrl}${branch ? `#${branch}` : ""}\n`);
      const sshEnv = await workspaceSourceSshEnvironment(options.workspaceId, options.workspaceTemplateId);
      const template = await ensureTemplate(gitUrl, branch, key, { workspaceId: options.workspaceId, events: options.events, logPath, sshEnv });
      await copyWorkspaceTemplate(template.repoPath, tmpWorkPath, sourceRoot());
      await verifyStandaloneWorktree(tmpWorkPath);
      await rm(worktreePath, { recursive: true, force: true });
      await rename(tmpWorkPath, worktreePath);

      const metadata: WorkspaceSourceMetadata = {
        workspaceId: options.workspaceId,
        gitUrl,
        branch,
        effectiveBranch: template.effectiveBranch,
        templateKey: key,
        resolvedCommit: template.resolvedCommit,
        createdAt: new Date().toISOString(),
      };
      await writeFile(join(cleanupPath, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

      return {
        workspaceId: options.workspaceId,
        worktreePath,
        cleanupPath,
        gitUrl,
        branch,
        resolvedCommit: template.resolvedCommit,
        templateKey: key,
      };
    } catch (error) {
      await stopWorkspaceSshAgent(options.workspaceId);
      await rm(tmpWorkPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export function registerWorkspaceTemplateWorkspaceInitEvents(events: KintsugiEventBus): void {
  events.on("workspace_image_configure", async (configuration) => {
    if (!isGitWorkspaceTemplateInit(configuration.init)) return;
    const workspaceTemplateId = workspaceTemplateIdFromInit(configuration.init);
    configuration.dockerfile = (await listWorkspaceTemplates()).workspaceTemplates.find((workspaceTemplate) => workspaceTemplate.id === workspaceTemplateId)?.dockerfile;
  });
  events.on("workspace_source_prepare", async ({ workspaceId, init, workHostPath }) => {
    if (!isGitWorkspaceTemplateInit(init)) return;
    await prepareWorkspaceSource({ workspaceId, gitUrl: init.gitUrl, branch: init.branch, workspaceTemplateId: workspaceTemplateIdFromInit(init), worktreePath: workHostPath, events });
  });

  events.on("workspace_plan_prepare", async ({ workspaceId, init, plan }) => {
    if (isGitWorkspaceTemplateInit(init)) {
      const settings = await getWorkspaceTemplateConfiguration(workspaceTemplateIdFromInit(init));
      plan.privileged = settings.privileged;
      plan.seedConfigEnabled = settings.seedConfigEnabled;
      plan.dockerSupportSettingsUrl = `/workspace-templates/${encodeURIComponent(workspaceTemplateIdFromInit(init))}/settings?section=privileged`;
      plan.preloadImages = [...settings.preloadImages ?? []];
      plan.mounts.push({ type: "bind", ...(await workspaceTemplatePersistentMount(workspaceTemplateIdFromInit(init))) });
    }
    Object.assign(plan.env, await effectiveEnvironment(workspaceTemplateIdOfInit(init)));

    const metadataPath = join(workspaceSourceDir(workspaceId), "metadata.json");
    if (!existsSync(metadataPath)) return;
    const metadata = Value.Parse(workspaceSourceMetadataSchema, JSON.parse(await readFile(metadataPath, "utf8")));
    if (metadata.resolvedCommit !== null) plan.labels["com.kintsugi.source-commit"] = metadata.resolvedCommit;
    plan.labels["com.kintsugi.source-template"] = metadata.templateKey;
  });
}
