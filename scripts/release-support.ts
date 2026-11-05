import { kintsugiEnv } from "@kintsugi/core";
import { imageNamespace } from "../packages/shared/src/publishing.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const platforms = ["linux/amd64", "linux/arm64"];
interface Result { code: number; stdout: string; stderr: string }
interface CommandOptions { cwd?: string; input?: string; allowFailure?: boolean; stream?: boolean }
export type Run = (args: string[], options?: CommandOptions) => Promise<Result>;

const digestSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const manifestSchema = Type.Object({
  digest: digestSchema,
  manifests: Type.Array(Type.Object({
    digest: digestSchema,
    platform: Type.Object({ os: Type.String(), architecture: Type.String() }),
  })),
});
const configSchema = Type.Object({
  os: Type.String(), architecture: Type.String(),
  config: Type.Object({ Labels: Type.Record(Type.String(), Type.String()) }),
});

export async function inspectImage(run: Run, ref: string, optional = false) {
  const result = await run(["docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"], { allowFailure: optional });
  if (result.code !== 0) {
    // Only a registry's explicit absence is a cache miss, never authentication/network failures.
    if (optional && /manifest unknown|: not found\b/i.test(result.stderr)) return undefined;
    throw new Error(`Cannot inspect ${ref}: ${result.stderr}`);
  }
  const manifest = Value.Parse(manifestSchema, JSON.parse(result.stdout));
  for (const platform of platforms) {
    if (manifest.manifests.filter((entry) => `${entry.platform.os}/${entry.platform.architecture}` === platform).length !== 1) {
      throw new Error(`${ref} must contain exactly one ${platform} image`);
    }
  }
  return manifest;
}

export async function inspectPlatform(run: Run, ref: string, platform: string, revision: string) {
  const result = await run(["docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .Image}}"]);
  const config = Value.Parse(configSchema, JSON.parse(result.stdout));
  if (`${config.os}/${config.architecture}` !== platform || config.config.Labels["org.opencontainers.image.revision"] !== revision)
    throw new Error(`${ref}: ${platform} does not match revision ${revision}`);
  return config;
}

export async function authenticateRegistry(run: Run) {
  const token = process.env.GH_PACKAGE_TOKEN?.trim();
  if (!token) throw new Error("GH_PACKAGE_TOKEN is required to publish images to ghcr.io");
  const [registry, account] = imageNamespace.split("/");
  await run(["docker", "login", registry!, "--username", account!, "--password-stdin"], { input: token });
}

export async function ensureBuilders(run: Run, directory: string) {
  const helper = kintsugiEnv("RELEASE_HELPER")?.trim();
  if (!helper || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(helper)) {
    throw new Error("KINTSUGI_RELEASE_HELPER must be an SSH destination: [user@]hostname (SSH aliases are supported)");
  }
  await run(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", helper, "docker info --format '{{.Architecture}}'"]);
  const local = (await run(["docker", "context", "show"])).stdout.trim();
  const remote = `kintsugi-release-${createHash("sha256").update(helper).digest("hex").slice(0, 12)}`;
  const contexts = (await run(["docker", "context", "ls", "--format", "{{.Name}}"])).stdout.split(/\s+/);
  if (!contexts.includes(remote)) await run(["docker", "context", "create", remote, "--docker", `host=ssh://${helper}`]);
  const architecture = async (context: string) => {
    const result = Value.Parse(Type.Object({ OSType: Type.String(), Architecture: Type.String() }), JSON.parse((await run(["docker", "--context", context, "info", "--format", "{{json .}}"])).stdout));
    if (result.OSType !== "linux") throw new Error(`${context}: release requires a Linux Docker daemon`);
    const arch = new Map([["x86_64", "amd64"], ["aarch64", "arm64"], ["amd64", "amd64"], ["arm64", "arm64"]]).get(result.Architecture);
    if (!arch) throw new Error(`${context}: unsupported Docker architecture ${result.Architecture}`);
    const inspection = (await run(["docker", "buildx", "inspect", context])).stdout;
    const driver = /^Driver:\s+(\S+)/m.exec(inspection)?.[1];
    if (driver !== "docker") throw new Error(`${context}: expected integrated docker builder, got ${driver}`);
    return `linux/${arch}`;
  };
  const nativePlatform = await architecture(local);
  const remotePlatform = await architecture(remote);
  if (nativePlatform === remotePlatform) throw new Error(`Helper must have the other architecture; both daemons are ${nativePlatform}`);
  const probe = join(directory, "probe");
  mkdirSync(probe);
  writeFileSync(join(probe, "marker"), "Kintsugi release builder check\n");
  // Exercise COPY, RUN and image export on each daemon, without emulation or registry writes.
  for (const [builder, platform] of [[local, nativePlatform], [remote, remotePlatform]]) {
    const machine = platform === "linux/amd64" ? "x86_64" : "aarch64";
    writeFileSync(join(probe, "Dockerfile"), `FROM ubuntu:26.04\nCOPY marker /marker\nRUN cat /marker && test "$(uname -m)" = "${machine}"\n`);
    await run(["docker", "--context", builder!, "buildx", "build", "--platform", platform!, "--provenance=false", "--progress", "plain", "--no-cache", "--load", "--tag", "kintsugi-release-probe:check", probe], { stream: true });
  }
  return { local, remote, nativePlatform };
}

// Shared command transport; each publisher retains its own orchestration and logs.
export function commandRunner(cwd: string, output: (text: string) => void) {
  let active: ReturnType<typeof Bun.spawn> | undefined;
  const run: Run = async (args, options = {}) => {
    output(`$ ${args.map(arg => JSON.stringify(arg)).join(" ")}\n`);
    const child = Bun.spawn(args, { cwd: options.cwd ?? cwd,
      stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
      stdout: "pipe", stderr: "pipe" });
    active = child;
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      let text = "";
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        output(chunk);
        if (!options.stream) text += chunk;
      }
      return text;
    };
    try {
      const [stdout, stderr, code] = await Promise.all([consume(child.stdout), consume(child.stderr), child.exited]);
      if (code !== 0 && !options.allowFailure) throw new Error(`${args.slice(0, 3).join(" ")} exited ${code}`);
      return { stdout, stderr, code };
    } finally {
      active = undefined;
    }
  };
  return { run, stop: () => active?.kill("SIGTERM") };
}
