import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { kintsugiEnv, runDocker, waitForCommand, commandSignal, workloadCgroupArgs, shellQuote, type KintsugiEventBus } from "@kintsugi/core";
import { appTerminalProcesses, runTerminalProcess, tailTerminalOutput, tailTerminalText, terminalOutputDisplayBytes } from "@kintsugi/observable-terminal/server";
import { appTerminalProcessSocketPath } from "@kintsugi/observable-terminal/shared";
import { type WorkspaceImageMetadata } from "./metadata.ts";
import { ensureGeneratedDefaultWorkspaceImage, prepareDefaultWorkspaceImage } from "./default-image.ts";
export { ensureGeneratedDefaultWorkspaceImage, prepareDefaultWorkspaceImage } from "./default-image.ts";
import { pruneSupersededWorkspaceImages, workspaceImageKindLabel, type WorkspaceImageKind } from "./prune.ts";
import { dockerImageStoreQueue, workspaceImageStoreWaitReporter } from "./image-store-queue.ts";
import { buildRepositoryImage } from "./repository-builder.ts";
import { dockerImageId, dockerServerPlatform, nativeImageExists as imageExists, reuseDefaultWorkspaceImage } from "./local-images.ts";

type WorkspaceImageBuildSource = { kind: "default" } | { kind: "repository"; baseImage: string };

interface WorkspaceImageBuildTask {
  tag: string;
  owner?: string;
  modules: string[];
  /** The build's output once finished, with its terminal colors. */
  output: string;
  /** Where to watch the build while it runs. */
  terminalSocketPath?: string;
  promise: Promise<void>;
}

interface ResolveWorkspaceImageOptions {
  workspaceId?: string;
  events?: KintsugiEventBus;
  sourcePath?: string;
  dockerfile?: string;
  buildOutput?: "inherit";
}

const buildTasks = new Map<string, WorkspaceImageBuildTask>();
const defaultImageRefFile = new URL("../../../.kintsugi-default-workspace-image", import.meta.url);

function namespaceSlug(): string {
  return (kintsugiEnv("NAMESPACE") || "host").replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
}

function contextBaseDir(): string {
  return join("/tmp", "kintsugi-workspace-image-context", namespaceSlug());
}

async function pullImage(tag: string, options: ResolveWorkspaceImageOptions): Promise<void> {
  if (await imageExists(tag)) return;
  const platform = await dockerServerPlatform();
  const result = await dockerImageStoreQueue.run({
    label: `Pulling workspace image ${tag}`,
    onWait: workspaceImageStoreWaitReporter({ events: options.events, workspaceId: options.workspaceId }),
  }, () => runDocker(["pull", "--platform", platform, tag]));
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `docker pull ${tag} failed`);
}

async function reportImageProgress(events: KintsugiEventBus | undefined, workspaceId: string | undefined, task: WorkspaceImageBuildTask): Promise<void> {
  if (!events || !workspaceId) return;
  await events.emit("workspace_provision_progress", {
    workspaceId,
    detail: `Image: ${task.tag}${task.modules.length ? ` · Modules: ${task.modules.join(", ")}` : ""}`,
    output: task.output,
    terminalSocketPath: task.terminalSocketPath,
  });
}

async function dockerBuildArgs(tag: string, kind: WorkspaceImageKind, dockerfile: string, contextDir: string, options: ResolveWorkspaceImageOptions): Promise<string[]> {
  return [
    "build",
    ...(kind === "default" ? await workloadCgroupArgs() : []),
    "--builder", "default",
    ...(options.buildOutput === "inherit" ? ["--progress=plain"] : []),
    ...(kintsugiEnv("WORKSPACE_IMAGE_NO_CACHE") === "1" ? ["--no-cache"] : []),
    "--label", `${workspaceImageKindLabel}=${kind}`,
    "-t", tag,
    "-f", dockerfile,
    contextDir,
  ];
}

function startBuildTask(metadata: WorkspaceImageMetadata, source: WorkspaceImageBuildSource, dockerfile: string, contextDir: string, options: ResolveWorkspaceImageOptions): WorkspaceImageBuildTask {
  const { kind } = source;
  const { tag, modules } = metadata;
  const existing = buildTasks.get(tag);
  if (existing) return existing;

  const task: WorkspaceImageBuildTask = { tag, owner: options.workspaceId, modules, output: "", promise: Promise.resolve() };
  task.promise = dockerImageStoreQueue.run({
    label: `Building workspace image ${tag}`,
    onWait: workspaceImageStoreWaitReporter({ events: options.events, workspaceId: options.workspaceId }),
  }, async () => {
    const buildStartedAt = new Date();
    const args = await dockerBuildArgs(tag, kind, dockerfile, contextDir, options);
    const build = async (dockerCommand: string[]) => {
      if (options.buildOutput === "inherit") {
        const proc = Bun.spawn([...dockerCommand, ...args], { cwd: contextDir, env: { ...process.env, DOCKER_BUILDKIT: "1" }, stdout: "inherit", stderr: "inherit", stdin: "ignore", signal: commandSignal() });
        const exitCode = await proc.exited;
        if (exitCode !== 0) throw new Error(`docker build failed with exit code ${exitCode}`);
      } else {
        const result = await runTerminalProcess(appTerminalProcesses(), {
          cwd: contextDir,
          command: `echo "Starting Docker image build..."\nDOCKER_BUILDKIT=1 ${[...dockerCommand, ...args].map(shellQuote).join(" ")}`,
        }, async (id) => {
          task.terminalSocketPath = appTerminalProcessSocketPath(id);
          await reportImageProgress(options.events, options.workspaceId, task);
        });
        task.terminalSocketPath = undefined;
        task.output = tailTerminalOutput(result.output.ansi, terminalOutputDisplayBytes);
        if (result.exitCode !== 0) throw new Error(`docker build failed with exit code ${result.exitCode}\n\n${tailTerminalText(result.output.text)}`);
      }
    };
    if (source.kind === "repository") await buildRepositoryImage(source.baseImage, tag, build);
    else await build(["docker"]);
    pruneSupersededWorkspaceImages(kind, buildStartedAt);
  }).finally(() => {
    buildTasks.delete(tag);
  });

  buildTasks.set(tag, task);
  return task;
}

async function waitForBuildTask(task: WorkspaceImageBuildTask, options: ResolveWorkspaceImageOptions): Promise<void> {
  await reportImageProgress(options.events, options.workspaceId, task);
  try {
    if (task.owner === options.workspaceId) await task.promise;
    else await waitForCommand(task.promise);
  } finally {
    if (!commandSignal()?.aborted) await reportImageProgress(options.events, options.workspaceId, task);
  }
}

async function bakedDefaultWorkspaceImageRef(): Promise<string | undefined> {
  const file = Bun.file(defaultImageRefFile);
  if (!(await file.exists())) return undefined;
  const ref = (await file.text()).trim();
  return ref || undefined;
}

async function inspectDefaultWorkspaceImage(): Promise<string | undefined> {
  const baked = await bakedDefaultWorkspaceImageRef();
  if (baked) return await imageExists(baked) ? baked : undefined;
  const context = await prepareDefaultWorkspaceImage();
  try { return await reuseDefaultWorkspaceImage(context.metadata.tag) ? context.metadata.tag : undefined; }
  finally { await context.dispose(); }
}

export async function ensureDefaultWorkspaceImage(options: ResolveWorkspaceImageOptions = {}): Promise<string> {
  const baked = await bakedDefaultWorkspaceImageRef();
  if (baked) {
    await pullImage(baked, options);
    return baked;
  }
  const innerKintsugi = existsSync("/run/kintsugi-parent");
  return ensureGeneratedDefaultWorkspaceImage({
    force: !innerKintsugi && kintsugiEnv("WORKSPACE_IMAGE_NO_CACHE") === "1",
    build: async ({ contextDir, dockerfile, metadata }) => {
      if (innerKintsugi) {
        const signature = metadata.tag.slice("kintsugi-workspace:".length);
        throw new Error(`Inner Kintsugi needs a default workspace image with signature ${signature} but that has not been preloaded. Exiting instead of building this image, so we do not flood the outer kintsugi with many parallel image builds.`);
      }
      await waitForBuildTask(startBuildTask(metadata, { kind: "default" }, dockerfile, contextDir, options), options);
    },
  });
}

function splitDockerfileInstructions(dockerfile: string): string[] {
  const instructions: string[] = [];
  let current = "";
  for (const line of dockerfile.split("\n")) {
    current = current ? `${current}\n${line}` : line;
    if (!line.trimEnd().endsWith("\\")) {
      instructions.push(current);
      current = "";
    }
  }
  if (current) instructions.push(current);
  return instructions;
}

function removeAptListCleanup(instruction: string): string {
  return instruction
    .replaceAll(/\\\n\s*&&\s*rm\s+-rf\s+\/var\/lib\/apt\/lists\/\*\s*/g, "")
    .replaceAll(/\s*&&\s*rm\s+-rf\s+\/var\/lib\/apt\/lists\/\*/g, "");
}

interface AptCacheMountResult {
  instruction: string;
  changed: boolean;
}

function addAptCacheMount(instruction: string): AptCacheMountResult {
  const cleaned = removeAptListCleanup(instruction);
  const next = cleaned.replace(/^(\s*)RUN\s+apt-get\s+update\b/, "$1RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\\n    apt-get update");
  return { instruction: next, changed: next !== cleaned || cleaned !== instruction };
}

async function optimizedRepoDockerfile(sourcePath: string, dockerfile: string): Promise<string> {
  const source = await readFile(dockerfile, "utf8");
  const instructions = splitDockerfileInstructions(source);
  let changed = false;
  const optimized = instructions.map((instruction) => {
    const result = addAptCacheMount(instruction);
    changed ||= result.changed;
    return result.instruction;
  });
  if (!changed) return dockerfile;

  optimized.splice(1, 0, "RUN rm -f /etc/apt/apt.conf.d/docker-clean \\\n && printf '%s\\n' 'Binary::apt::APT::Keep-Downloaded-Packages \"true\";' > /etc/apt/apt.conf.d/keep-cache");
  const generatedDir = join(contextBaseDir(), "repo-dockerfiles");
  await mkdir(generatedDir, { recursive: true });
  const generated = join(generatedDir, `${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}.Dockerfile`);
  await writeFile(generated, `# syntax=docker/dockerfile:1\n${optimized.join("\n")}\n`);
  return generated;
}

export function repositoryWorkspaceImageTag(baseImage: string, dockerfileContents: string | Uint8Array): string {
  const hash = createHash("sha256");
  // Do not reuse repository images produced before builder isolation.
  hash.update("kintsugi-repo-workspace-dockerfile-v6\n");
  hash.update(baseImage); hash.update("\0");
  hash.update(dockerfileContents); hash.update("\0");
  return `kintsugi-workspace:${hash.digest("hex").slice(0, 16)}`;
}

async function repoWorkspaceImageMetadata(dockerfile: string, baseImage: string): Promise<WorkspaceImageMetadata> {
  const contents = await readFile(dockerfile);
  if (contents.toString("utf8").split("\n")[0].trim() !== "FROM kintsugi-workspace") throw new Error(`${dockerfile} must start with FROM kintsugi-workspace`);
  return { tag: repositoryWorkspaceImageTag(baseImage, contents), modules: ["repo"] };
}

export async function workspaceDockerfile(sourcePath: string, override?: string): Promise<string> {
  if (!override?.trim()) return join(sourcePath, ".kintsugi", "Dockerfile");
  const dir = join(contextBaseDir(), "project-dockerfiles");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${createHash("sha256").update(override).digest("hex")}.Dockerfile`);
  await writeFile(path, override);
  return path;
}

async function inspectWorkspaceImageReference(options: Pick<ResolveWorkspaceImageOptions, "sourcePath" | "dockerfile"> = {}): Promise<string | undefined> {
  const baseImage = await inspectDefaultWorkspaceImage();
  if (!baseImage) return undefined;
  if (!options.sourcePath) return baseImage;

  const dockerfile = await workspaceDockerfile(options.sourcePath, options.dockerfile);
  if (!(await Bun.file(dockerfile).exists())) return baseImage;

  const metadata = await repoWorkspaceImageMetadata(dockerfile, baseImage);
  return await imageExists(metadata.tag) ? metadata.tag : undefined;
}

export async function inspectWorkspaceImage(options: Pick<ResolveWorkspaceImageOptions, "sourcePath" | "dockerfile"> = {}): Promise<string | undefined> {
  const image = await inspectWorkspaceImageReference(options);
  return image ? await dockerImageId(image) : undefined;
}

export async function resolveWorkspaceImage(options: ResolveWorkspaceImageOptions = {}): Promise<string> {
  const baseImage = await ensureDefaultWorkspaceImage(options);
  if (!options.sourcePath) return baseImage;

  const dockerfile = await workspaceDockerfile(options.sourcePath, options.dockerfile);
  if (!(await Bun.file(dockerfile).exists())) return baseImage;

  const metadata = await repoWorkspaceImageMetadata(dockerfile, baseImage);
  if (kintsugiEnv("WORKSPACE_IMAGE_NO_CACHE") !== "1" && await imageExists(metadata.tag)) return metadata.tag;
  const buildDockerfile = await optimizedRepoDockerfile(options.sourcePath, dockerfile);
  const task = startBuildTask(metadata, { kind: "repository", baseImage }, buildDockerfile, options.sourcePath, options);
  await waitForBuildTask(task, options);
  return metadata.tag;
}
