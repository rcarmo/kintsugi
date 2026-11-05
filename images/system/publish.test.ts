import { imageSource } from "../../packages/shared/src/publishing.ts";
import { systemVersion, systemVersionLabel } from "../../packages/shared/src/system-version.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Run } from "../../scripts/release-support.ts";
import { publishSystem } from "./publish.ts";

const revision = "a".repeat(40);
const digest = (arch: string) => `sha256:${(arch === "amd64" ? "1" : "2").repeat(64)}`;
async function scenario(options: { local?: string; sameArch?: boolean; missingHelper?: boolean; check?: boolean; wrongRevision?: boolean; buildFails?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "system-publish-test-"));
  const helper = process.env.KINTSUGI_RELEASE_HELPER;
  const token = process.env.GH_PACKAGE_TOKEN;
  process.env.KINTSUGI_RELEASE_HELPER = options.missingHelper ? "" : "builder@test-helper";
  process.env.GH_PACKAGE_TOKEN = "test-package-token";
  const calls: { args: string[]; input?: string }[] = [];
  const run: Run = async (args, settings = {}) => {
    calls.push({ args, input: settings.input });
    let stdout = "";
    if (args[0] === "git" && args.includes("rev-parse")) stdout = revision;
    if (args[1] === "context" && args[2] === "show") stdout = "local";
    if (args.includes("{{json .}}")) {
      const local = options.local ?? "amd64";
      stdout = JSON.stringify({ OSType: "linux", Architecture: args[2] === "local" || options.sameArch ? local : local === "amd64" ? "arm64" : "amd64" });
    }
    if (args[1] === "buildx" && args[2] === "inspect") stdout = "Driver: docker\n";
    if (args.includes("--push") && options.buildFails) throw new Error("native build failed");
    if (args.includes("{{json .Manifest}}")) {
      const ref = args[4]!;
      stdout = JSON.stringify(ref.endsWith("-amd64") || ref.endsWith("-arm64")
        ? { digest: digest(ref.endsWith("-amd64") ? "amd64" : "arm64") }
        : { digest: `sha256:${"3".repeat(64)}`, manifests: ["amd64", "arm64"].map(architecture => ({ digest: digest(architecture), platform: { os: "linux", architecture } })) });
    }
    if (args.includes("{{json .Image}}")) stdout = JSON.stringify({ os: "linux", architecture: args[4]!.endsWith(digest("amd64")) ? "amd64" : "arm64", config: { Labels: { "org.opencontainers.image.source": imageSource, [systemVersionLabel]: String(systemVersion), "org.opencontainers.image.revision": options.wrongRevision ? "wrong" : revision } } });
    return { stdout, stderr: "", code: 0 };
  };
  let error: unknown;
  try { await publishSystem(run, directory, options.check); }
  catch (caught) { error = caught; }
  finally {
    if (helper === undefined) delete process.env.KINTSUGI_RELEASE_HELPER; else process.env.KINTSUGI_RELEASE_HELPER = helper;
    if (token === undefined) delete process.env.GH_PACKAGE_TOKEN; else process.env.GH_PACKAGE_TOKEN = token;
    rmSync(directory, { recursive: true, force: true });
  }
  return { calls, error };
}

for (const local of ["amd64", "arm64"]) {
  test(`publishes native slices with a ${local} local daemon and combines verified digests`, async () => {
    const { calls, error } = await scenario({ local });
    expect(error).toBeUndefined();
    const builds = calls.filter(({ args }) => args.includes("--push"));
    expect(builds).toHaveLength(2);
    for (const { args } of builds) {
      const platform = args[args.indexOf("--platform") + 1];
      expect(args[2] === "local").toBe(platform === `linux/${local}`);
      expect(args).not.toContain("linux/arm64,linux/amd64");
      expect(args).not.toContain("--builder");
      expect(args).toContain(`org.opencontainers.image.source=${imageSource}`);
    }
    const merge = calls.find(({ args }) => args.includes("imagetools") && args.includes("create"))!;
    expect(merge.args.slice(-2)).toEqual(["amd64", "arm64"].map(arch => `ghcr.io/rcarmo/kintsugi-system@${digest(arch)}`));
    const promote = calls.findLast(({ args }) => args.includes("imagetools") && args.includes("create"))!;
    expect(promote.args.slice(-3)).toEqual(["--tag", "ghcr.io/rcarmo/kintsugi-system:latest", `ghcr.io/rcarmo/kintsugi-system@sha256:${"3".repeat(64)}`]);
    expect(calls.some(({ args }) => args.some(arg => /binfmt|qemu|:stable/.test(arg)))).toBe(false);
    expect(calls.find(({ args }) => args.includes("login"))?.input).toBe("test-package-token");
    expect(calls.flatMap(call => call.args)).not.toContain("test-package-token");
  });
}

test("check probes both native builders without registry authentication or writes", async () => {
  const { calls, error } = await scenario({ check: true });
  expect(error).toBeUndefined();
  expect(calls.filter(({ args }) => args.includes("--load"))).toHaveLength(2);
  expect(calls.some(({ args }) => args.includes("login") || args.includes("--push") || args.includes("imagetools"))).toBe(false);
});

for (const options of [{ missingHelper: true }, { sameArch: true }]) {
  test(`invalid helper fails before registry writes: ${JSON.stringify(options)}`, async () => {
    const { calls, error } = await scenario(options);
    expect(error).toBeDefined();
    expect(calls.some(({ args }) => args.includes("login") || args.includes("--push"))).toBe(false);
  });
}

for (const options of [{ wrongRevision: true }, { buildFails: true }]) {
  test(`failed slice prevents combined manifest: ${JSON.stringify(options)}`, async () => {
    const { calls, error } = await scenario(options);
    expect(error).toBeDefined();
    expect(calls.some(({ args }) => args.includes("imagetools") && args.includes("create"))).toBe(false);
  });
}
