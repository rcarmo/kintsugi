import { kintsugiEnv } from "./environment.ts";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

export interface KintsugiRuntimeContext {
  /** Path as seen by the Kintsugi process itself. Use this for normal Kintsugi file IO. */
  kintsugiDataDir: string;
  /** Same directory as seen by the Docker daemon. Use this for Docker bind mount sources. */
  dockerHostKintsugiDataDir: string;
  /** Host-side Docker bridge IP used for Kintsugi/workspace traffic. */
  dockerBridgeHost: string;
}

let cachedRuntimeContext: KintsugiRuntimeContext | undefined;
let cachedRuntimeContextKey: string | undefined;

export function kintsugiDataPath(context: KintsugiRuntimeContext, ...segments: string[]): string {
  return join(context.kintsugiDataDir, ...segments);
}

export function dockerHostKintsugiDataPath(context: KintsugiRuntimeContext, ...segments: string[]): string {
  return join(context.dockerHostKintsugiDataDir, ...segments);
}

export function getKintsugiRuntimeContext(): KintsugiRuntimeContext {
  const paths = runtimePathsFromEnv();
  const key = `${paths.kintsugiDataDir}\0${paths.dockerHostKintsugiDataDir}`;
  if (!cachedRuntimeContext || cachedRuntimeContextKey !== key) {
    cachedRuntimeContext = createRuntimeContext(paths);
    cachedRuntimeContextKey = key;
  }
  return cachedRuntimeContext;
}

export function resetKintsugiRuntimeContextForTests(): void {
  cachedRuntimeContext = undefined;
  cachedRuntimeContextKey = undefined;
}

function createRuntimeContext(paths: Pick<KintsugiRuntimeContext, "kintsugiDataDir" | "dockerHostKintsugiDataDir">): KintsugiRuntimeContext {
  let dockerBridgeHost: string | undefined;
  return {
    ...paths,
    get dockerBridgeHost() {
      return dockerBridgeHost ??= inspectDockerBridgeHost();
    },
  };
}

function runtimePathsFromEnv(): Pick<KintsugiRuntimeContext, "kintsugiDataDir" | "dockerHostKintsugiDataDir"> {
  const kintsugiDataDir = envString("DATA_DIR") ?? defaultDataDir();
  return {
    kintsugiDataDir,
    dockerHostKintsugiDataDir: envString("DOCKER_HOST_DATA_DIR") ?? kintsugiDataDir,
  };
}

function xdgDataHome(): string {
  const configured = process.env.XDG_DATA_HOME;
  if (configured && isAbsolute(configured)) return configured;
  return join(homedir(), ".local", "share");
}

function defaultDataDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "kintsugi-host");
  if (platform() === "linux") return join(xdgDataHome(), "kintsugi-host");
  return "/var/lib/kintsugi-host";
}

function envString(name: string): string | undefined {
  const value = kintsugiEnv(name)?.trim();
  return value ? value : undefined;
}

function inspectDockerBridgeHost(): string {
  // Docker Desktop's bridge gateway lives inside its Linux VM and cannot route
  // back to a server listening on the macOS host.
  if (platform() === "darwin") return "host.docker.internal";
  const result = Bun.spawnSync(["docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`could not inspect Docker bridge gateway: ${new TextDecoder().decode(result.stderr).trim()}`);
  const host = new TextDecoder().decode(result.stdout).trim();
  if (!host) throw new Error("Docker bridge gateway is empty");
  return host;
}
