import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallationUpdater, updaterHandler, type UpdaterCommand, type UpdaterOptions } from "./service.ts";
const old = `sha256:${"a".repeat(64)}`, appDigest = `sha256:${"b".repeat(64)}`, systemDigest = `sha256:${"c".repeat(64)}`;
async function fixture(action: (updater: InstallationUpdater, directory: string, calls: string[][], options: UpdaterOptions) => Promise<void>, override?: UpdaterCommand) {
  const directory = await mkdtemp(join(tmpdir(), "installation-updater-")); await mkdir(join(directory, "app"));
  await writeFile(join(directory, "app/update.json"), JSON.stringify({ releaseMode: "custom", releaseSelection: "latest", releaseSource: { appRepository: "ghcr.io/example/app", systemRepository: "ghcr.io/example/system", appVersion: "latest", systemVersion: "latest" } }));
  const calls: string[][] = [];
  const command: UpdaterCommand = async args => {
    calls.push(args);
    if (override) { const response = await override(args); if (response.code !== 75) return response; }
    let stdout = "";
    if (args[1] === "inspect") stdout = args[3]?.includes(".Mounts") ? directory : args[3] === "{{.State.Status}}" ? "running" : old;
    if (args.includes("image") && args.includes("inspect")) stdout = JSON.stringify([{ Id: old, Config: { Labels: { "org.opencontainers.image.revision": "old", "kintsugi.installer-config": "1", "kintsugi.host-updater": "1", "kintsugi.deployment-config": "1" } } }]);
    if (args[1] === "exec" && args[3] === "docker" && args[4] === "inspect") stdout = old;
    return { code: 0, stdout };
  };
  const options: UpdaterOptions = { directory: join(directory, "state"), installer: "/root/installed-updater/install.sh", command, resolve: async reference => ({ reference: reference.split(":")[0] + "@" + (reference.includes("/system:") ? systemDigest : appDigest), revision: "new", layers: [], dependencies: [] }) };
  const updater = new InstallationUpdater(options); await updater.initialize();
  try { await action(updater, directory, calls, options); } finally { await updater.wait(); await rm(directory, { recursive: true, force: true }); }
}

test("host updater resolves and downloads both immutable components, then uses the trusted installer", () => fixture(async (updater, directory, calls) => {
  const checked = await updater.check(); expect(checked.phase).toBe("available"); expect(checked.plan?.app).toBe(`ghcr.io/example/app@${appDigest}`); expect(checked.plan?.system).toBe(`ghcr.io/example/system@${systemDigest}`);
  expect((await updater.prepare(checked.plan!.id)).phase).toBe("preparing"); await updater.wait(); expect(updater.snapshot().phase).toBe("ready");
  expect(calls.some(args => args.includes("pull") && args.includes(checked.plan!.system))).toBe(true);
  expect(calls.some(args => args.includes(checked.plan!.app) && args.some(arg => arg.includes("release/prepare")))).toBe(true);
  expect((await stat(join(directory, "state/state.json"))).mode & 0o777).toBe(0o600);
  expect((await updater.apply(checked.plan!.id)).phase).toBe("updating"); await updater.wait(); expect(updater.snapshot().phase).toBe("succeeded");
  const apply = calls.find(args => args[0] === "bash")!; expect(apply[1]).toBe("/root/installed-updater/install.sh"); expect(apply).toContain("--preserve-release-selection"); expect(apply).toContain(checked.plan!.app); expect(apply).toContain(checked.plan!.system);
}));

test("the private protocol rejects unknown fields, arbitrary operations and stale plan IDs", () => fixture(async (updater, _directory, calls) => {
  const handle = updaterHandler(updater); const plan = (await updater.check()).plan!;
  for (const [path, body] of [["/prepare", { id: plan.id, command: "rm -rf /" }], ["/prepare", { id: crypto.randomUUID() }], ["/apply", { id: plan.id }], ["/check", { repository: "ghcr.io/attacker/app" }], ["/execute", { id: plan.id }]] as const) {
    const response = await handle(new Request("http://updater" + path, { method: "POST", body: JSON.stringify(body) })); expect([404, 409]).toContain(response.status);
  }
  expect(calls.some(args => args[0] === "bash")).toBe(false);
}));

test("a changed selection invalidates preparation and does not stop any container", () => fixture(async (updater, directory, calls) => {
  const plan = (await updater.check()).plan!; await writeFile(join(directory, "app/update.json"), JSON.stringify({ releaseChannel: "stable" }));
  await updater.prepare(plan.id); await updater.wait(); expect(updater.snapshot().phase).toBe("failed"); expect(calls.some(args => args.includes("stop") || args[0] === "bash")).toBe(false);
}));

test("changed settings also discard a previously prepared plan on recheck", () => fixture(async (updater, directory) => {
  const plan = (await updater.check()).plan!; await updater.prepare(plan.id); await updater.wait();
  await writeFile(join(directory, "app/update.json"), JSON.stringify({ releaseChannel: "stable" }));
  expect((await updater.check()).plan!.id).not.toBe(plan.id); await expect(updater.apply(plan.id)).rejects.toThrow("not ready");
}));

test("prepared state survives daemon restart; interrupted work requires attention", () => fixture(async (updater, directory, _calls, options) => {
  const plan = (await updater.check()).plan!; await updater.prepare(plan.id); await updater.wait();
  const restarted = new InstallationUpdater(options); await restarted.initialize(); expect(restarted.snapshot().phase).toBe("ready");
  await writeFile(join(directory, "state/state.json"), JSON.stringify({ ...restarted.snapshot(), phase: "updating" }));
  const interrupted = new InstallationUpdater(options); await interrupted.initialize(); expect(interrupted.snapshot().phase).toBe("failed"); expect(interrupted.snapshot().message).toContain("interrupted");
}));

test("host update failures stay visible and do not expose subprocess output", () => fixture(async (updater) => {
  const plan = (await updater.check()).plan!; await updater.prepare(plan.id); await updater.wait(); await updater.apply(plan.id); await updater.wait();
  expect(updater.snapshot().phase).toBe("failed"); expect(JSON.stringify(updater.snapshot())).not.toContain("SECRET");
}, async args => args[0] === "bash" ? { code: 1, stdout: "SECRET private registry token" } : { code: 75, stdout: "" }));


for (const mode of ["automatic", "explicit", "incompatible", "missing-image", "engine-exits"] as const) {
  test(`${mode} rollback from a stopped replacement validates the retained pair and keeps diagnostics private`, async () => {
    let replaced = false, running = true, probes = 0, restored = false;
    await fixture(async (updater, directory, calls) => {
      await mkdir(join(directory, "supervisor"));
      await writeFile(join(directory, "supervisor/installer.json"), JSON.stringify({ previousSystemImage: old, previousAppImage: old }));
      await writeFile(join(directory, "app/keep.txt"), "persisted");
      const plan = (await updater.check()).plan!;
      const releaseSelection = await readFile(join(directory, "app/update.json"), "utf8");
      await updater.prepare(plan.id); await updater.wait();
      await updater.apply(plan.id); await updater.wait();
      if (mode === "explicit") {
        running = false;
        expect((await updater.rollback()).phase).toBe("updating"); await updater.wait();
      }
      const start = calls.findIndex(args => args[1] === "start");
      const ready = calls.findLastIndex(args => args.join(" ") === "docker exec kintsugi-system docker info");
      const inspect = calls.findLastIndex(args => args.join(" ") === `docker exec kintsugi-system docker image inspect ${old}`);
      const rollback = calls.findIndex(args => args[0] === "bash" && args.includes("rollback"));
      expect(start).toBeGreaterThan(-1); expect(ready).toBeGreaterThan(start);
      if (mode === "incompatible" || mode === "missing-image" || mode === "engine-exits") {
        expect(rollback).toBe(-1); expect(updater.snapshot().phase).toBe("failed"); expect(running).toBe(false);
        const diagnostics = await readFile(join(directory, "state/diagnostics.log"), "utf8");
        expect(diagnostics).toContain("candidate health failure");
        expect(diagnostics).toContain("Automatic image recovery failed");
        const reason = { incompatible: "needs installation compatibility version 999", "missing-image": "No such image", "engine-exits": "nested Docker is unavailable for rollback" };
        expect(diagnostics).toContain(reason[mode]);
        expect(JSON.stringify(updater.snapshot())).not.toContain("candidate health failure");
      } else {
        expect(inspect).toBeGreaterThan(ready); expect(rollback).toBeGreaterThan(inspect);
        expect(updater.snapshot().phase).toBe("rolled-back"); expect(restored).toBe(true);
        if (mode === "automatic") expect(probes).toBe(2);
      }
      expect(await readFile(join(directory, "app/keep.txt"), "utf8")).toBe("persisted");
      expect(await readFile(join(directory, "app/update.json"), "utf8")).toBe(releaseSelection);
      expect(calls.some(args => args.includes("volume") || args.includes("prune"))).toBe(false);
    }, async args => {
      if (args[0] === "bash" && args.includes("update")) {
        replaced = true;
        if (mode === "explicit") return { code: 0, stdout: "" };
        running = false;
        return { code: 1, stdout: "candidate health failure" };
      }
      if (args[0] === "bash" && args.includes("rollback")) { restored = true; return { code: 0, stdout: "" }; }
      // The failed update replaced the container even if it used the same System image.
      if (args[1] === "inspect" && args[3] === "{{.Id}}") return { code: 0, stdout: replaced ? "candidate-container" : "original-container" };
      if (args[1] === "inspect" && args[3] === "{{.State.Status}}") return { code: 0, stdout: running ? "running" : "exited" };
      if (args[1] === "start") { running = true; return { code: 0, stdout: "" }; }
      if (args[1] === "stop") { running = false; return { code: 0, stdout: "" }; }
      if (args[1] === "exec" && !running) return { code: 1, stdout: "", stderr: "container is not running" };
      if (args[1] === "exec" && args[4] === "info") {
        probes++;
        if (mode === "engine-exits") running = false;
        return { code: !running || mode === "automatic" && probes === 1 ? 1 : 0, stdout: "", stderr: "engine not ready" };
      }
      if (replaced && args[1] === "exec" && args[4] === "image" && args.at(-1) === old) {
        if (mode === "incompatible") return { code: 0, stdout: JSON.stringify([{ Id: old, Config: { Labels: { "org.kintsugi.required-system-version": "999" } } }]) };
        if (mode === "missing-image") return { code: 1, stdout: "", stderr: `No such image: ${old}` };
      }
      return { code: 75, stdout: "" };
    });
  });
}

test("the successful retained pair survives subsequent checks and can be rolled back", () => fixture(async (updater, directory) => {
  await mkdir(join(directory, "supervisor")); await writeFile(join(directory, "supervisor/installer.json"), JSON.stringify({ previousSystemImage: old, previousAppImage: old }));
  const plan = (await updater.check()).plan!; await updater.prepare(plan.id); await updater.wait(); await updater.apply(plan.id); await updater.wait();
  await updater.check(); expect(updater.snapshot().retainedPlan?.id).toBe(plan.id); await updater.rollback(); await updater.wait(); expect(updater.snapshot().phase).toBe("rolled-back"); expect(updater.snapshot().retainedPlan).toBeUndefined();
}));

test("rollback refuses an unrelated retained image pair", () => fixture(async (updater, directory, calls) => {
  await mkdir(join(directory, "supervisor")); await writeFile(join(directory, "supervisor/installer.json"), JSON.stringify({ previousSystemImage: "other", previousAppImage: old }));
  const plan = (await updater.check()).plan!; await updater.prepare(plan.id); await updater.wait(); await updater.apply(plan.id); await updater.wait();
  await expect(updater.rollback()).rejects.toThrow("no longer matches"); expect(calls.filter(args => args[0] === "bash").length).toBe(1);
}));


test("apply reserves the operation before asynchronous deployment validation", async () => {
  let hold = false; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await fixture(async (updater, _directory, calls) => {
    const plan = (await updater.check()).plan!; await updater.prepare(plan.id); await updater.wait(); hold = true;
    const first = updater.apply(plan.id); await Bun.sleep(0); await expect(updater.apply(plan.id)).rejects.toThrow("not ready"); expect((await updater.check()).phase).toBe("ready");
    hold = false; release(); await first; await updater.wait(); expect(calls.filter(args => args[0] === "bash").length).toBe(1);
  }, async args => { if (hold && args[1] === "inspect" && args[3]?.includes(".Mounts")) await gate; return { code: 75, stdout: "" }; });
});

test("failed replacement recovers only the installer-recorded prior pair", async () => {
  let changed = false;
  await fixture(async (updater, directory, calls) => {
    await mkdir(join(directory, "supervisor")); await writeFile(join(directory, "supervisor/installer.json"), JSON.stringify({ previousSystemImage: old, previousAppImage: old }));
    const plan = (await updater.check()).plan!; await updater.prepare(plan.id); await updater.wait(); await updater.apply(plan.id); await updater.wait();
    expect(updater.snapshot().phase).toBe("rolled-back"); expect(calls.some(args => args[0] === "bash" && args.includes("rollback"))).toBe(true);
  }, async args => {
    if (args[0] === "bash" && args.includes("update")) { changed = true; return { code: 1, stdout: "failed" }; }
    if (changed && args[1] === "inspect" && args[3] === "{{.Id}}") return { code: 0, stdout: systemDigest };
    return { code: 75, stdout: "" };
  });
});

test("an incompatible selected pair fails discovery before pulling or stopping containers", () => fixture(async (updater, _directory, calls, options) => {
  const resolve = options.resolve!;
  options.resolve = async (reference, directory) => ({ ...await resolve(reference, directory), requiredSystemVersion: reference.includes("/app") ? 2 : 0, systemVersion: reference.includes("/system") ? 1 : 0 });
  await expect(updater.check()).rejects.toThrow("needs installation compatibility version 2");
  expect(updater.snapshot()).toMatchObject({ phase: "failed" });
  expect(updater.snapshot().plan).toBeUndefined();
  expect(calls.some(args => args.includes("pull") || args.includes("stop") || args[0] === "bash")).toBe(false);
}));

test("downloaded labels are checked against each other before a pair becomes ready", () => fixture(async (updater, _directory, calls) => {
  const plan = (await updater.check()).plan!;
  await updater.prepare(plan.id); await updater.wait();
  expect(updater.snapshot().phase).toBe("failed");
  expect(calls.some(args => args[0] === "bash")).toBe(false);
}, async args => args[1] === "exec" && args.includes("image") ? { code: 0, stdout: JSON.stringify([{ Id: old, Config: { Labels: { "kintsugi.deployment-config": "1", "org.kintsugi.required-system-version": "2" } } }]) } : { code: 75, stdout: "" }));

test("apply revalidates ready images, including ready state loaded from an older updater", async () => {
  let incompatible = false;
  await fixture(async (updater, _directory, calls) => {
    const plan = (await updater.check()).plan!; await updater.prepare(plan.id); await updater.wait();
    expect(updater.snapshot().phase).toBe("ready"); incompatible = true;
    await expect(updater.apply(plan.id)).rejects.toThrow("compatibility could not be verified");
    expect(updater.snapshot().phase).toBe("failed");
    expect(calls.some(args => args[0] === "bash")).toBe(false);
  }, async args => incompatible && args[1] === "exec" && args.includes("image") ? { code: 0, stdout: JSON.stringify([{ Id: old, Config: { Labels: { "org.kintsugi.required-system-version": "2" } } }]) } : { code: 75, stdout: "" });
});

test("rollback validates the retained pair without changing its recorded IDs", async () => {
  let incompatible = false;
  await fixture(async (updater, directory, calls) => {
    await mkdir(join(directory, "supervisor"));
    await writeFile(join(directory, "supervisor/installer.json"), JSON.stringify({ previousSystemImage: old, previousAppImage: old }));
    const plan = (await updater.check()).plan!; await updater.prepare(plan.id); await updater.wait(); await updater.apply(plan.id); await updater.wait();
    incompatible = true;
    await expect(updater.rollback()).rejects.toThrow("needs installation compatibility version 2");
    expect(updater.snapshot().retainedPlan?.id).toBe(plan.id);
    expect(calls.filter(args => args[0] === "bash")).toHaveLength(1);
  }, async args => incompatible && args[1] === "exec" && args.includes("image") ? { code: 0, stdout: JSON.stringify([{ Id: old, Config: { Labels: { "org.kintsugi.required-system-version": "2" } } }]) } : { code: 75, stdout: "" });
});

test("a cached ready plan is revalidated before being offered after restart", async () => {
  let incompatible = false;
  await fixture(async (updater, _directory, calls, options) => {
    const plan = (await updater.check()).plan!; await updater.prepare(plan.id); await updater.wait();
    const restarted = new InstallationUpdater(options); await restarted.initialize();
    incompatible = true;
    await expect(restarted.check()).rejects.toThrow("needs installation compatibility version 2");
    expect(restarted.snapshot().phase).toBe("failed");
    expect(restarted.snapshot().plan).toBeUndefined();
    expect(calls.some(args => args[0] === "bash")).toBe(false);
  }, async args => incompatible && args[1] === "exec" && args.includes("image") ? { code: 0, stdout: JSON.stringify([{ Id: old, Config: { Labels: { "org.kintsugi.required-system-version": "2" } } }]) } : { code: 75, stdout: "" });
});

test("paired planning refuses legacy images while listed-host data remains", () => fixture(async (updater, directory, calls) => {
  const metadata = join(directory, "app/workspaces/listed-one/metadata"); await mkdir(metadata, { recursive: true });
  await writeFile(join(metadata, "network.json"), JSON.stringify({ mode: "hosts" }));
  await expect(updater.check()).rejects.toThrow("before downgrading");
  expect(calls.some(args => args.includes("pull") || args[0] === "bash")).toBe(false);
}));

test("a newly copied updater installs the early boot rule even when the previous installer predates it", async () => {
  const { ensureUpdaterBootDirectory } = await import("./service.ts");
  const directory = await mkdtemp(join(tmpdir(), "updater-boot-rule-"));const rule=join(directory,"tmpfiles.d/kintsugi-updater.conf");const calls:string[][]=[];
  try {
    const command:UpdaterCommand=async args=>{calls.push(args);return {code:0,stdout:""};};
    await ensureUpdaterBootDirectory(rule,command);await ensureUpdaterBootDirectory(rule,command);
    expect(await readFile(rule,"utf8")).toBe("d /run/kintsugi-updater 0700 root root -\n");expect((await stat(rule)).mode&0o777).toBe(0o644);
    expect(calls).toEqual([["systemd-tmpfiles","--create",rule],["systemd-tmpfiles","--create",rule]]);
    await expect(ensureUpdaterBootDirectory(rule,async()=>({code:1,stdout:""}))).rejects.toThrow("boot directory");
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("paired discovery refuses images that cannot honour configured resource allocations before pull or installer execution", () => fixture(async (updater,directory,calls)=>{
  await mkdir(join(directory,"app/workspaces/fixture/metadata"),{recursive:true});await writeFile(join(directory,"app/workspaces/fixture/metadata/resource-policy.json"),JSON.stringify({version:1}));
  await expect(updater.check()).rejects.toThrow("resource-aware");expect(calls.some(args=>args.includes("pull")||args[0]==="bash"||args.includes("stop"))).toBe(false);
}));
