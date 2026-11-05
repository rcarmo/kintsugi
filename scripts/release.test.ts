import { inspectImage, type Run } from "./release-support.ts";
import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseReleaseArgs, promoteChannels, release, verifyRevision, type ReleaseStatus } from "./release.ts";

const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const architectures = ["amd64", "arm64"];
const manifest = {
  digest,
  manifests: architectures.map((architecture, index) => ({ digest: `sha256:${String(index + 1).repeat(64)}`, platform: { os: "linux", architecture } })),
};
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
function status(stable = false): ReleaseStatus {
  return { state: "running", phase: "Starting", startedAt: "", updatedAt: "", elapsedSeconds: 0, check: false, commit, digest, channels: stable ? { latest: "pending", stable: "pending" } : { latest: "pending" } };
}

test("release only supports latest or both, plus non-publishing checks", () => {
  expect(parseReleaseArgs([])).toEqual({ stable: false, check: false, help: false, prepare: false });
  expect(parseReleaseArgs(["--stable", "--check"])).toEqual({ stable: true, check: true, help: false, prepare: false });
  expect(() => parseReleaseArgs(["--channel", "stable"])).toThrow("Unknown release option");
});

test("registry absence is distinct from authentication or network failure", async () => {
  expect(await inspectImage(async () => ({ code: 1, stdout: "", stderr: "ERROR: example: not found" }), "example", true)).toBeUndefined();
  for (const stderr of ["unauthorized", "connection refused", "TLS handshake timeout"]) {
    await expect(inspectImage(async () => ({ code: 1, stdout: "", stderr }), "example", true)).rejects.toThrow("Cannot inspect");
  }
});

test("verification requires both architectures and matching revision labels", async () => {
  await expect(inspectImage(async () => ok(JSON.stringify({ ...manifest, manifests: manifest.manifests.slice(0, 1) })), "ref")).rejects.toThrow("linux/arm64");
  const run: Run = async (args) => {
    if (args.includes("{{json .Manifest}}")) return ok(JSON.stringify(manifest));
    const index = manifest.manifests.findIndex((entry) => args.some((arg) => arg.endsWith(entry.digest)));
    return ok(JSON.stringify({ os: "linux", architecture: architectures[index], config: { Labels: { "org.opencontainers.image.revision": commit, "org.kintsugi.required-system-version": "0", "org.kintsugi.system-version": "0", "eagerly-preload": JSON.stringify([`ghcr.io/rcarmo/kintsugi-workspace:signature@${digest}`]) } } }));
  };
  expect(await verifyRevision(run, "ref", commit)).toBe(digest);
  await expect(verifyRevision(run, "ref", "wrong-sha")).rejects.toThrow("does not match revision");
});

test("promotion uses the verified digest and reports partial success", async () => {
  const current = status(true);
  const calls: string[][] = [];
  const saves: string[] = [];
  await expect(promoteChannels(async (args) => {
    calls.push(args);
    if (args.includes("create") && args.some((arg) => arg.endsWith(":stable"))) throw new Error("push failed");
    return ok(JSON.stringify(manifest));
  }, current, () => saves.push(JSON.stringify(current.channels)))).rejects.toThrow("push failed");
  expect(current.channels).toEqual({ latest: "published", stable: "failed" });
  expect(calls.filter((args) => args.includes("create")).every((args) => args.at(-1) === `ghcr.io/rcarmo/kintsugi@${digest}`)).toBe(true);
  expect(saves.length).toBe(4);
});

test("both channels are promoted in order on success", async () => {
  const current = status(true);
  const channels: string[] = [];
  await promoteChannels(async (args) => {
    if (args.includes("create")) channels.push(args[args.indexOf("--tag") + 1]!);
    return ok(JSON.stringify(manifest));
  }, current, () => {});
  expect(channels).toEqual(["ghcr.io/rcarmo/kintsugi:latest", "ghcr.io/rcarmo/kintsugi:stable"]);
  expect(current.channels).toEqual({ latest: "published", stable: "published" });
});

test("promotion fails if registry readback differs", async () => {
  const current = status();
  await expect(promoteChannels(async () => ok(JSON.stringify({ ...manifest, digest: `sha256:${"c".repeat(64)}` })), current, () => {})).rejects.toThrow("digest differs");
  expect(current.channels.latest).toBe("failed");
});

async function scenario(options: { appRequirement?: string; systemVersion?: string; check?: boolean; exists?: boolean; rewritten?: boolean; advanced?: boolean; prepare?: boolean; revision?: string; buildFailure?: boolean; sameArch?: boolean; localArm?: boolean; badDriver?: boolean; missingHelper?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), "kintsugi-release-test-"));
  const calls: { args: string[]; cwd?: string }[] = [];
  let uploaded = options.exists ?? false;
  const current = status();
  current.digest = undefined;
  current.check = options.check ?? false;
  const oldHelper = process.env.KINTSUGI_RELEASE_HELPER;
  if (options.missingHelper) delete process.env.KINTSUGI_RELEASE_HELPER;
  else process.env.KINTSUGI_RELEASE_HELPER = "builder@helper";
  const oldToken = process.env.GH_PACKAGE_TOKEN;
  process.env.GH_PACKAGE_TOKEN = "test-not-a-real-credential";
  try {
    const run: Run = async (args, command) => {
      calls.push({ args, cwd: command?.cwd });
      if (args[0] === "git" && args[1] === "rev-parse") return ok(options.advanced ? "c".repeat(40) : commit);
      if (args[0] === "git" && args[1] === "merge-base") return {code:options.rewritten ? 1 : 0,stdout:"",stderr:""};
      if (args.includes("context") && args.includes("show")) return ok("default");
      if (args.includes("{{json .}}")) {
        const local = args[args.indexOf("--context") + 1] === "default";
        const arm = options.sameArch ? false : (options.localArm ? local : !local);
        return ok(JSON.stringify({ OSType: "linux", Architecture: arm ? "aarch64" : "x86_64" }));
      }
      if (args[1] === "buildx" && args[2] === "inspect") return ok(`Driver: ${options.badDriver ? "docker-container" : "docker"}`);
      if (args.includes("imagetools") && args.includes("{{json .Manifest}}")) {
        if (!uploaded) return { code: 1, stdout: "", stderr: "ERROR: image: not found" };
        return ok(JSON.stringify(manifest));
      }
      if (args.includes("{{json .Image}}")) {
        const index = manifest.manifests.findIndex((entry) => args.some((arg) => arg.endsWith(entry.digest)));
        return ok(JSON.stringify({ os: "linux", architecture: architectures[index], config: { Labels: { "org.opencontainers.image.revision": commit, "org.kintsugi.required-system-version": options.appRequirement ?? "0", "org.kintsugi.system-version": options.systemVersion ?? "0", "eagerly-preload": JSON.stringify([`ghcr.io/rcarmo/kintsugi-workspace:signature@${digest}`]) } } }));
      }
      if (args[0] === "bun") {
        if (options.buildFailure) throw new Error("build failed");
        uploaded = true;
      }
      return ok();
    };
    let error: unknown;
    try { await release(parseReleaseArgs([...(current.check ? ["--check"] : []), ...(options.prepare ? ["--prepare"] : []), ...(options.revision ? ["--revision",options.revision] : [])]), run, current, () => {}, directory); }
    catch (caught) { error = caught; }
    return { calls, current, error };
  } finally {
    if (oldHelper === undefined) delete process.env.KINTSUGI_RELEASE_HELPER;
    else process.env.KINTSUGI_RELEASE_HELPER = oldHelper;
    if (oldToken === undefined) delete process.env.GH_PACKAGE_TOKEN;
    else process.env.GH_PACKAGE_TOKEN = oldToken;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("check exercises both platforms without registry writes or worktree creation", async () => {
  const { calls, current, error } = await scenario({ check: true });
  expect(error).toBeUndefined();
  expect(current.state).toBe("checked");
  expect(calls[0]!.args).toEqual(["git", "fetch", "origin", "refs/heads/main"]);
  const probes = calls.filter(({ args }) => args.includes("--load"));
  expect(probes).toHaveLength(2);
  expect(probes[0]!.args.slice(0, 5)).toEqual(["docker", "--context", "default", "buildx", "build"]);
  expect(probes[1]!.args[1]).toBe("--context");
  expect(probes[1]!.args[2]).toStartWith("kintsugi-release-");
  for (const { args } of probes) expect(args).not.toContain("--builder");
  expect(probes.map(({ args }) => args[args.indexOf("--platform") + 1])).toEqual(["linux/amd64", "linux/arm64"]);
  expect(calls.some(({ args }) => args.includes("login") || args.includes("--push") || args.includes("imagetools") || args.includes("worktree"))).toBe(false);
});

test("a same-architecture helper stops the release before publishing", async () => {
  const { calls, error } = await scenario({ sameArch: true });
  expect(String(error)).toContain("other architecture");
  expect(calls.some(({ args }) => args.includes("login"))).toBe(false);
});

test("new commit is built in an isolated checkout with no latest tag before verification", async () => {
  const { calls, current, error } = await scenario({});
  expect(error).toBeUndefined();
  expect(current.state).toBe("published");
  expect(calls.some(({args})=>args.join(" ")===`git merge-base --is-ancestor ${commit} FETCH_HEAD`)).toBe(true);
  expect(calls.flatMap(({ args }) => args).some(arg => /^ghcr\.io\/lucasmeijer\/atelier(?=[:@])/.test(arg) || arg === "ghcr.io/rcarmo/kintsugi:stable")).toBe(false);
  const build = calls.find(({ args }) => args[0] === "bun")!;
  expect(build.cwd).toEndWith("/source");
  expect(build.args).toContain("--no-latest");
  expect(build.args).toContain(`sha-${commit}`);
  expect(build.args).toContain("--builder");
  expect(calls.some(({ args }) => args.includes("--stable"))).toBe(false);
  expect(calls.findIndex(({ args }) => args.includes("{{json .Image}}"))).toBeLessThan(calls.findIndex(({ args }) => args.includes("--tag") && args.includes("ghcr.io/rcarmo/kintsugi:latest")));
});

test("retry reuses uploaded commit instead of rebuilding", async () => {
  const { calls, error } = await scenario({ exists: true });
  expect(error).toBeUndefined();
  expect(calls.some(({ args }) => args[0] === "bun" || args.includes("worktree"))).toBe(false);
});

test("rewritten main history prevents all channel updates", async () => {
  const { calls, error } = await scenario({ exists: true, rewritten: true });
  expect(String(error)).toContain("no longer contains");
  expect(calls.some(({ args }) => args.includes("imagetools") && args.includes("create"))).toBe(false);
});

test("failed build removes checkout and does not promote", async () => {
  const { calls, error } = await scenario({ buildFailure: true });
  expect(String(error)).toContain("build failed");
  expect(calls.some(({ args }) => args[0] === "git" && args.includes("remove"))).toBe(true);
  expect(calls.some(({ args }) => args.includes("imagetools") && args.includes("create"))).toBe(false);
});

for (const split of [false, true]) {
test(`image build CLI pairs images from its working checkout, not its tooling checkout (split=${split})`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "kintsugi-release-cli-test-"));
  const log = join(directory, "docker.jsonl");
  const docker = join(directory, "docker");
  writeFileSync(docker, `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nif (args.includes('{{json .Manifest}}')) { console.log(JSON.stringify({digest: '${digest}'})); process.exit(0); }\nif (args.includes('inspect')) process.exit(1);\n`);
  chmodSync(docker, 0o755);
  const go = join(directory, "go");
  const goLog = join(directory, "go.jsonl");
  writeFileSync(go, `#!/usr/bin/env bun\nimport {appendFileSync, mkdirSync, writeFileSync} from "node:fs";\nimport {dirname} from "node:path";\nconst args=process.argv.slice(2);\nappendFileSync(${JSON.stringify(goLog)}, JSON.stringify({cwd:process.cwd(),args})+"\\n");\nconst output=args[args.indexOf("-o")+1]; mkdirSync(dirname(output),{recursive:true}); writeFileSync(output,"helper fixture");\n`);
  chmodSync(go, 0o755);
  try {
    const checkout = join(directory, "source");
    cpSync(join(import.meta.dir, "../packages"), join(checkout, "packages"), {
      recursive: true, filter: path => basename(path) !== "node_modules",
    });
    writeFileSync(join(checkout, "packages/workspace-image/runtime-image"), "example.com/release-runtime:regression-test\n");
    const compatibilityPath = join(checkout, "packages/shared/src/system-version.ts");
    writeFileSync(compatibilityPath, readFileSync(compatibilityPath, "utf8").replace("requiredSystemVersion = 0", "requiredSystemVersion = 3"));
    const publishingPath = join(checkout, "packages/shared/src/publishing.ts");
    writeFileSync(publishingPath, readFileSync(publishingPath, "utf8").replace('githubRepository = "rcarmo/kintsugi"', 'githubRepository = "example/portable-fork"'));
    const expectedContext = join(directory, "expected-context");
    const generated = Bun.spawnSync(["bun", join(checkout, "packages/workspace-image/scripts/build-context.mjs"), expectedContext], { cwd: checkout });
    expect(generated.exitCode).toBe(0);
    const expectedSignature = JSON.parse(readFileSync(join(expectedContext, "metadata.json"), "utf8")).tag.split(":")[1];
    const process = Bun.spawn(["bun", join(import.meta.dir, "build-kintsugi-image.ts"), "--push", "--no-latest", "--tag", "sha-test", "--builder", "test-builder", "--platform", "linux/amd64,linux/arm64", ...(split ? ["--helper-context", "test-helper", "--native-platform", "linux/amd64"] : [])], {
      cwd: checkout, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, PATH: `${directory}:${Bun.env.PATH}`, GH_PACKAGE_TOKEN: "test-not-a-real-credential" },
    });
    const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text(), new Response(process.stdout).text()]);
    expect(stderr).not.toContain("error:");
    expect(code).toBe(0);
    const helperBuilds = readFileSync(goLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(helperBuilds.map(call => call.cwd)).toEqual([join(checkout, "packages/workspace-helper/helper"), join(checkout, "packages/workspace-helper/helper")]);
    expect(helperBuilds.map(call => call.args[call.args.indexOf("-o") + 1])).toEqual(["linux-amd64", "linux-arm64"].map(platform => join(checkout, "packages/workspace-helper/dist", platform, "kintsugi-workspace-helper")));
    const commands: string[][] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const builds = commands.filter((args) => args.includes("buildx") && args.includes("build"));
    expect(builds).toHaveLength(split ? 4 : 2);
    for (const args of builds) {
      if (split) {
        expect(args.slice(0, 4)).toEqual(["--context", args.includes("linux/arm64") ? "test-helper" : "test-builder", "buildx", "build"]);
        expect(args).not.toContain("--builder");
      } else {
        expect(args[args.indexOf("--builder") + 1]).toBe("test-builder");
        expect(args).not.toContain("--context");
      }
      expect(args).toContain("--push");
      expect(args[args.indexOf("--platform") + 1]).toBe(split ? (builds.indexOf(args) % 2 === 0 ? "linux/amd64" : "linux/arm64") : "linux/amd64,linux/arm64");
      expect(args.some((arg) => arg.endsWith(":latest") || arg.endsWith(":stable"))).toBe(false);
    }
    const appBuild = builds[split ? 2 : 1]!;
    expect(appBuild).toContain(`ghcr.io/rcarmo/kintsugi:sha-test${split ? "-amd64" : ""}`);
    expect(appBuild).toContain("org.kintsugi.required-system-version=3");
    expect(appBuild).toContain("org.opencontainers.image.source=https://github.com/example/portable-fork");
    expect(readFileSync(join(expectedContext, "Dockerfile"), "utf8")).toContain('org.opencontainers.image.source="https://github.com/example/portable-fork"');
    const workspaceArg = appBuild.find(arg => arg.startsWith("KINTSUGI_DEFAULT_WORKSPACE_IMAGE="))!;
    expect(workspaceArg).toBe(`KINTSUGI_DEFAULT_WORKSPACE_IMAGE=ghcr.io/rcarmo/kintsugi-workspace:${expectedSignature}@${digest}`);
    expect(builds[0]).toContain(`ghcr.io/rcarmo/kintsugi-workspace:${expectedSignature}${split ? "-amd64" : ""}`);
    expect(appBuild).toContain(`KINTSUGI_EAGERLY_PRELOAD=${JSON.stringify([workspaceArg.split("=")[1]])}`);
    if (split) {
      const merges = commands.filter(args => args.includes("imagetools") && args.includes("create"));
      expect(merges).toHaveLength(2);
      expect(merges[1]).toContain("ghcr.io/rcarmo/kintsugi:sha-test");
      for (const merge of merges) {
        expect(merge.slice(-2).every(ref => ref.endsWith(`@${digest}`))).toBe(true);
      }
      expect(commands.indexOf(merges[0]!)).toBeLessThan(commands.indexOf(appBuild));
      expect(builds[3]).toContain(workspaceArg);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
}

for (const preload of [undefined, "[]", "null", "{}", "[42]", JSON.stringify(["workspace:tag"])]) {
  test(`release rejects missing or unpinned workspace: ${preload}`, async () => {
    const run: Run = async args => args.includes("{{json .Manifest}}") ? ok(JSON.stringify(manifest)) : ok(JSON.stringify({os:"linux", architecture:"amd64", config:{Labels:{"org.opencontainers.image.revision":commit, "eagerly-preload":preload}}}));
    await expect(verifyRevision(run, "ref", commit)).rejects.toThrow("digest-pinned workspace");
  });
}

test("ARM local daemon uses an amd64 helper", async () => {
  const { calls, error } = await scenario({ localArm: true });
  expect(error).toBeUndefined();
  const build = calls.find(({ args }) => args[0] === "bun")!;
  expect(build.args[build.args.indexOf("--native-platform") + 1]).toBe("linux/arm64");
  expect(build.args).toContain("--helper-context");
});

for (const options of [{ missingHelper: true }, { badDriver: true }]) {
  test(`invalid builder setup fails before login: ${JSON.stringify(options)}`, async () => {
    const { calls, error } = await scenario(options);
    expect(error).toBeDefined();
    expect(calls.some(({ args }) => args.includes("login") || args.includes("--push"))).toBe(false);
  });
}

test("local app publication refuses an incompatible System channel before promotion", async () => {
  const { calls, error } = await scenario({ exists: true, appRequirement: "2", systemVersion: "1" });
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("needs installation compatibility version 2");
  expect(calls.some(({ args }) => args.includes("create") && args.some(arg => arg.endsWith(":latest") || arg.endsWith(":stable")))).toBe(false);
});

test("preparation verifies immutable images without promoting channels or publishing notes", async () => {
  const {calls,current,error}=await scenario({prepare:true});
  expect(error).toBeUndefined();expect(current.state).toBe("prepared");expect(current.digest).toBe(digest);expect(current.channels).toEqual({});
  expect(calls.some(({args})=>args.includes("create")&&args.some(arg=>arg.endsWith(":latest")||arg.endsWith(":stable")))).toBe(false);
  expect(calls.some(({args})=>args[0]==="gh")).toBe(false);
});
test("pinned preparation uses the approved SHA even after main advances", async () => {
  const {calls,current,error}=await scenario({prepare:true,advanced:true,revision:commit});
  expect(error).toBeUndefined();expect(current.commit).toBe(commit);
  expect(calls.some(({args})=>args.join(" ")===`git merge-base --is-ancestor ${commit} FETCH_HEAD`)).toBe(true);
  expect(calls.find(({args})=>args.includes("worktree")&&args.includes("add"))?.args.at(-1)).toBe(commit);
});
test("pinned publication tolerates a fast-forward but never changes its code revision", async () => {
  const {current,error}=await scenario({exists:true,advanced:true,revision:commit});
  expect(error).toBeUndefined();expect(current.state).toBe("published");expect(current.commit).toBe(commit);
});
test("prepare/revision parsing rejects ambiguous channels and malformed or duplicate SHAs", () => {
  expect(()=>parseReleaseArgs(["--prepare","--stable"])).toThrow();expect(()=>parseReleaseArgs(["--prepare","--check"])).toThrow();
  expect(()=>parseReleaseArgs(["--revision"])).toThrow("full Git commit");expect(()=>parseReleaseArgs(["--revision","main"])).toThrow("full Git commit");
  expect(()=>parseReleaseArgs(["--revision",commit,"--revision",commit])).toThrow("only once");
});

test("a pinned revision outside main is rejected before authentication or builder work", async () => {
  const {calls,error}=await scenario({prepare:true,revision:commit,rewritten:true});
  expect(String(error)).toContain("not on origin/main");
  expect(calls.some(({args})=>args[0]==="docker"||args[0]==="ssh"||args[0]==="bun")).toBe(false);
});
