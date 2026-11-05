#!/usr/bin/env bun

import { Type } from "typebox";
import { Value } from "typebox/value";
import { appRepository, imageNamespace } from "../packages/shared/src/publishing.ts";
import { join } from "node:path";
import { buildGoProgram, workloadCgroupArgs } from "@kintsugi/core";
import { rmSync } from "node:fs";
import { arch } from "node:os";
import { imageHasPlatforms } from "../packages/workspace-image/src/local-images.ts";
import { registryImageHasPlatforms } from "./image-platforms.ts";
import { prepareDefaultWorkspaceImage, ensureGeneratedDefaultWorkspaceImage } from "@kintsugi/workspace-image";

const usage = `Build the Kintsugi Docker image.

Usage:
  bun run scripts/build-kintsugi-image.ts [options]

Options:
  --image <name>        Image repository/name (default: ${appRepository})
  --tag <tag>           Tag to apply. May be passed more than once (default: git describe/short sha)
  --latest             Tag the image as <image>:latest (default)
  --no-latest          Do not update latest (release staging)
  --builder <name>     Buildx builder (local Docker context with --helper-context)
  --helper-context <name> SSH Docker context for the non-native slice (release orchestration)
  --native-platform <value> Local daemon platform when using --helper-context
  --stable             Also tag the image as <image>:stable
  --push               Push the built images instead of only loading them locally. Uses GH_PACKAGE_TOKEN for ghcr.io.
  --platform <value>   Docker platform(s), e.g. linux/amd64 or linux/amd64,linux/arm64
  --no-cache           Build without Docker cache
  --workspace          Force building the default workspace image even when the deterministic tag already exists
  --progress <value>   Docker progress mode (auto, plain, tty, quiet, rawjson)
  --build-arg K=V      Extra Kintsugi app Docker build argument. May be passed more than once
  --help               Show this help

Examples:
  bun run image:build
  bun run image:build -- --tag v0.1.0 --latest
  bun run image:publish -- --stable --platform linux/amd64,linux/arm64
`;

interface Options {
  image: string;
  tags: string[];
  latest: boolean;
  stable: boolean;
  push: boolean;
  platform?: string;
  builder?: string;
  helperContext?: string;
  nativePlatform?: string;
  noCache: boolean;
  forceWorkspace: boolean;
  progress?: string;
  buildArgs: string[];
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  console.error("\n" + usage);
  process.exit(1);
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    image: appRepository,
    tags: [],
    latest: true,
    stable: false,
    push: false,
    noCache: false,
    forceWorkspace: false,
    buildArgs: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    } else if (arg === "--image") {
      options.image = takeValue(args, i, arg);
      i++;
    } else if (arg === "--tag" || arg === "-t") {
      options.tags.push(takeValue(args, i, arg));
      i++;
    } else if (arg === "--latest") {
      options.latest = true;
    } else if (arg === "--no-latest") {
      options.latest = false;
    } else if (arg === "--builder") {
      options.builder = takeValue(args, i, arg);
      i++;
    } else if (arg === "--helper-context") {
      options.helperContext = takeValue(args, i++, arg);
    } else if (arg === "--native-platform") {
      options.nativePlatform = takeValue(args, i++, arg);
    } else if (arg === "--stable") {
      options.stable = true;
    } else if (arg === "--push") {
      options.push = true;
    } else if (arg === "--platform") {
      options.platform = takeValue(args, i, arg);
      i++;
    } else if (arg === "--no-cache") {
      options.noCache = true;
    } else if (arg === "--workspace") {
      options.forceWorkspace = true;
    } else if (arg === "--progress") {
      options.progress = takeValue(args, i, arg);
      i++;
    } else if (arg === "--build-arg") {
      const value = takeValue(args, i, arg);
      if (["KINTSUGI_DEFAULT_WORKSPACE_IMAGE", "KINTSUGI_EAGERLY_PRELOAD", "ATELIER_DEFAULT_WORKSPACE_IMAGE", "ATELIER_EAGERLY_PRELOAD"].includes(value.split("=")[0]!)) {
        fail("The release script owns the default workspace reference and preload label");
      }
      options.buildArgs.push(value);
      i++;
    } else {
      fail(`unknown option: ${arg}`);
    }
  }

  return options;
}

function run(command: string[], options: { quiet?: boolean } = {}): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", stdin: "inherit" });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    if (!options.quiet) {
      if (stdout) console.error(stdout);
      if (stderr) console.error(stderr);
    }
    throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
  }
  return stdout;
}

async function runInherited(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
}

function maybeRun(command: string[]): string | undefined {
  try {
    return run(command, { quiet: true });
  } catch {
    return undefined;
  }
}

function authenticateGhcr(options: Options): void {
  if (!options.push || !options.image.startsWith("ghcr.io/")) return;

  const token = process.env.GH_PACKAGE_TOKEN?.trim();
  if (!token) throw new Error("GH_PACKAGE_TOKEN is required to publish images to ghcr.io");

  const result = Bun.spawnSync(
    ["docker", "login", "ghcr.io", "--username", imageNamespace.split("/")[1]!, "--password-stdin"],
    { stdin: new TextEncoder().encode(token), stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) throw new Error(`docker login ghcr.io failed with exit code ${result.exitCode}`);
}

function dockerArchitecture(): string {
  const value = arch();
  if (value === "x64") return "amd64";
  if (value === "arm64") return "arm64";
  if (value === "arm") return "arm";
  return value;
}

function requestedPlatforms(options: Options): string[] {
  return options.platform?.split(",").map((platform) => platform.trim()).filter(Boolean) ?? [`linux/${dockerArchitecture()}`];
}

async function workspaceImageExists(ref: string, options: Options): Promise<boolean> {
  const platforms = requestedPlatforms(options);
  return options.push ? registryImageHasPlatforms(ref, platforms, maybeRun) : imageHasPlatforms(ref, platforms);
}

function sanitizeTag(tag: string): string {
  const sanitized = tag.trim().replaceAll(/[^A-Za-z0-9_.-]/g, "-").replaceAll(/^[.-]+/g, "").slice(0, 128);
  return sanitized || "local";
}

function defaultTag(): string {
  return sanitizeTag(
    maybeRun(["git", "describe", "--tags", "--always", "--dirty"]) ||
    maybeRun(["git", "rev-parse", "--short=12", "HEAD"]) ||
    "local",
  );
}

function gitCommitId(): string {
  const commit = maybeRun(["git", "rev-parse", "HEAD"]);
  const dirty = maybeRun(["git", "status", "--porcelain"]) ? "-dirty" : "";
  return commit ? `${commit}${dirty}` : "unknown";
}

function workspaceImageRepository(appImage: string): string {
  return `${appImage}-workspace`;
}

function workspaceHashTag(metadataTag: string): string {
  const marker = "kintsugi-workspace:";
  if (!metadataTag.startsWith(marker)) throw new Error(`unexpected workspace image metadata tag: ${metadataTag}`);
  return metadataTag.slice(marker.length);
}

function dockerBuildCommand(options: Options, args: string[], context?: string): string[] {
  if (options.platform?.includes(",") && !options.push) fail("multi-platform builds require --push");
  const command = options.builder || options.platform || options.push
    ? ["docker", ...(context ? ["--context", context] : []), "buildx", "build", ...(options.push ? ["--push", "--provenance=false"] : ["--load"])]
    : ["docker", "build"];
  return [
    ...command,
    // System cgroup paths belong to the local daemon, never the SSH helper.
    ...(context && context === options.helperContext ? [] : resourceBuildArgs),
    ...(options.builder && !context ? ["--builder", options.builder] : []),
    ...(options.platform ? ["--platform", options.platform] : []),
    ...(options.noCache ? ["--no-cache"] : []),
    ...(options.progress ? ["--progress", options.progress] : []),
    ...args,
  ];
}

const options = parseArgs(process.argv.slice(2));
if (options.helperContext && (!options.push || !options.builder || !["linux/amd64", "linux/arm64"].includes(options.nativePlatform ?? "") || options.platform !== "linux/amd64,linux/arm64")) {
  fail("--helper-context requires --push, --builder, --native-platform and --platform linux/amd64,linux/arm64");
}
const resourceBuildArgs = await workloadCgroupArgs();

async function buildImage(refs: string[], args: string[]): Promise<void> {
  if (!options.helperContext) {
    await runInherited(dockerBuildCommand(options, [...refs.flatMap(ref => ["--tag", ref]), ...args]));
    return;
  }
  const slices: string[] = [];
  for (const platform of requestedPlatforms(options)) {
    const slice = `${refs[0]}-${platform.split("/")[1]}`;
    // Integrated docker builders must be selected via their Docker context.
    const context = platform === options.nativePlatform ? options.builder : options.helperContext;
    await runInherited(dockerBuildCommand({ ...options, platform }, ["--tag", slice, ...args], context));
    const descriptor = JSON.parse(run(["docker", "buildx", "imagetools", "inspect", slice, "--format", "{{json .Manifest}}"]));
    if (!/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)) throw new Error(`Registry returned no digest for ${slice}`);
    slices.push(`${slice}@${descriptor.digest}`);
  }
  await runInherited(["docker", "buildx", "imagetools", "create", ...refs.flatMap(ref => ["--tag", ref]), ...slices]);
}
authenticateGhcr(options);
// Release tooling may live outside the detached checkout used as the app build context.
// Generate its paired workspace image from that same checkout, not this script's imports.
const workspaceContext = await prepareDefaultWorkspaceImage(process.cwd());
const workspaceContextDir = workspaceContext.contextDir;
process.on("exit", () => rmSync(workspaceContextDir, { recursive: true, force: true }));

const tags = options.tags.length > 0 ? options.tags.map(sanitizeTag) : [defaultTag()];
if (options.latest) tags.push("latest");
if (options.stable) tags.push("stable");
const uniqueTags = [...new Set(tags)];
const imageRefs = uniqueTags.map((tag) => `${options.image}:${tag}`);

const workspaceMetadata = workspaceContext.metadata;
const workspaceTag = workspaceHashTag(workspaceMetadata.tag);
const workspaceRepo = workspaceImageRepository(options.image);
const defaultWorkspaceImageRef = `${workspaceRepo}:${workspaceTag}`;

let shouldBuildWorkspace = false;

console.log();
console.log(`${options.push ? "Publishing" : "Building"} Kintsugi image:`);
for (const ref of imageRefs) console.log(`  ${ref}`);
console.log(`  default workspace image: ${defaultWorkspaceImageRef}`);
console.log();
await ensureGeneratedDefaultWorkspaceImage({
  context: workspaceContext,
  force: options.forceWorkspace || options.noCache,
  imageName: () => defaultWorkspaceImageRef,
  exists: async ref => workspaceImageExists(ref, options),
  build: async () => { shouldBuildWorkspace = true; await buildImage([defaultWorkspaceImageRef], ["--file", `${workspaceContextDir}/Dockerfile`, workspaceContextDir]); },
});
// Bind the app to the exact multi-platform workspace manifest just published.
let publishedWorkspaceRef = defaultWorkspaceImageRef;
if (options.push) {
  const descriptor = JSON.parse(run(["docker", "buildx", "imagetools", "inspect", defaultWorkspaceImageRef, "--format", "{{json .Manifest}}"]));
  if (!/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)) throw new Error("Registry returned no workspace manifest digest");
  publishedWorkspaceRef = `${defaultWorkspaceImageRef}@${descriptor.digest}`;
}

const defaultBuildArgs = [
  `KINTSUGI_COMMIT_ID=${gitCommitId()}`,
  `KINTSUGI_DEFAULT_WORKSPACE_IMAGE=${publishedWorkspaceRef}`,
  `KINTSUGI_EAGERLY_PRELOAD=${JSON.stringify([publishedWorkspaceRef])}`,
];
const allBuildArgs = [...defaultBuildArgs, ...options.buildArgs];

// Tooling may come from a different checkout. Stamp the requirement from the image's source tree.
const compatibility = Value.Parse(Type.Object({ label: Type.String(), version: Type.Integer({ minimum: 0, maximum: 2147483647 }), networkLabel: Type.String(), networkVersion: Type.Integer({ minimum: 0, maximum: 2147483647 }), resourceLabel: Type.String(), resourceVersion: Type.Integer({ minimum: 0, maximum: 2147483647 }), source: Type.String() }), JSON.parse(run(["bun", "-e", 'import {requiredSystemVersion as version,requiredSystemVersionLabel as label,networkPolicyVersionLabel as networkLabel,networkPolicyVersion as networkVersion,resourcePolicyVersionLabel as resourceLabel,resourcePolicyVersion as resourceVersion} from "./packages/shared/src/system-version.ts";import {imageSource as source} from "./packages/shared/src/publishing.ts";process.stdout.write(JSON.stringify({label,version,networkLabel,networkVersion,resourceLabel,resourceVersion,source}));'])));
for (const platform of requestedPlatforms(options)) {
  await buildGoProgram(join(process.cwd(), "packages/workspace-helper/helper"), join(process.cwd(), "packages/workspace-helper/dist", platform.replace("/", "-"), "kintsugi-workspace-helper"), platform);
}

await buildImage(imageRefs, [
  "--label", `org.opencontainers.image.source=${compatibility.source}`,
  "--label", `${compatibility.label}=${compatibility.version}`,
  "--label", `${compatibility.networkLabel}=${compatibility.networkVersion}`,
  "--label", `${compatibility.resourceLabel}=${compatibility.resourceVersion}`,
  ...allBuildArgs.flatMap((buildArg) => ["--build-arg", buildArg]),
  "--file", "apps/web/Dockerfile", ".",
]);

console.log();
console.log(options.push ? "Published:" : "Built:");
console.log(`  ${defaultWorkspaceImageRef}${shouldBuildWorkspace ? "" : " (reused)"}`);
for (const ref of imageRefs) console.log(`  ${ref}`);
