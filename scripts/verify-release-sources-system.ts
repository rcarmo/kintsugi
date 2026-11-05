// Real, disposable System/Docker integration. Never targets an existing installation.
// Requires locally built app + System images; creates and cleans its own containers/volume.
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { app: { type: "string", default: "kintsugi-release:local" }, system: { type: "string", default: "kintsugi-system:release-local" }, workspace: { type: "string" }, "release-updates": { type: "boolean", default: false }, "installer-system": { type: "string" } } });
const name = `kintsugi-release-integration-${crypto.randomUUID().slice(0, 8)}`;
const volume = name;
const fixtureApp = `${name}:app`;
const hostPort = 35000 + Math.floor(Math.random() * 4000);
const directory = await mkdtemp(join(tmpdir(), "kintsugi-release-system-"));
async function run(args: string[], input?: string) {
  const child = Bun.spawn(args, { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(`Integration command ${args[0]} ${args[1]} failed (${exit})${args.includes("-e") ? ": details suppressed for credential safety" : `: ${stderr.slice(0, 800)}`}`);
  return stdout.trim();
}
const exec = (...args: string[]) => run(["docker", "exec", name, ...args]);
const containment = ["--memory=4g", "--memory-swap=4g", "--cpus=2", "--pids-limit=4096"];
async function until(check: () => Promise<boolean>, label: string, milliseconds = 180_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (await check()) return;
    if (await run(["docker", "inspect", "--format", "{{.State.Running}}", name]) !== "true") throw new Error(`Disposable System exited while waiting for ${label}`);
    await Bun.sleep(500);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const preloads: unknown = JSON.parse(await run(["docker", "image", "inspect", "--format", '{{index .Config.Labels "eagerly-preload"}}', values.app!]));
  if (!Value.Check(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), preloads)) throw new Error("App image must declare its baked workspace image, or use an image built by this repository");
  const workspaceImage = values.workspace ?? preloads[0]!;
  // Start only dockerd for preloading, as in the existing System bootstrap test.
  await run(["docker", "run", "-d", "--name", name, ...containment, "--privileged", "--cgroupns=host", "--tmpfs", "/run", "--mount", `source=${volume},target=/data`, "--entrypoint", "/usr/local/bin/kintsugi-dockerd", values.system!, "dockerd"]);
  await until(async () => (await exec("docker", "info").then(() => true, () => false)), "inner Docker daemon");
  const save = Bun.spawn(["docker", "save", values.app!, workspaceImage], { stdout: "pipe", stderr: "pipe" });
  const load = Bun.spawn(["docker", "exec", "-i", name, "docker", "load"], { stdin: save.stdout, stdout: "pipe", stderr: "pipe" });
  const outputs = await Promise.all([save.exited, load.exited, new Response(save.stderr).text(), new Response(load.stderr).text(), new Response(load.stdout).text()]);
  assert.equal(outputs[0], 0, "image save"); assert.equal(outputs[1], 0, "inner image load");
  // These are local, preloaded images, not registry releases: suppress eager pulls in this disposable fixture.
  await run(["docker", "exec", "-i", name, "docker", "build", "-t", fixtureApp, "-"], `FROM ${values.app}\nLABEL eagerly-preload="[]"\n`);
  await run(["docker", "stop", "--time", "60", name]); await run(["docker", "rm", name]);
  await run(["docker", "run", "-d", "--name", name, ...containment, "--privileged", "--cgroupns=host", "--tmpfs", "/run", "--publish", `127.0.0.1:${hostPort}:3443`, "--publish", `127.0.0.1:${hostPort + 1}:3080`, "--mount", `source=${volume},target=/data`, values.system!, "--app-image", fixtureApp, "--access-mode", "localhost"]);
  const localPort = Number(await run(["docker", "inspect", "--format", '{{(index (index .HostConfig.PortBindings "3080/tcp") 0).HostPort}}', name]));
  await until(async () => (await exec("bun", "-e", `const r=await fetch("http://127.0.0.1:3001/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mode:"localhost",localPort:${localPort}})});process.exit(r.ok?0:1);`).then(() => true, () => false)), "installer local-port registration");
  await until(async () => {
    const state = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))'));
    if (state.state === "failed") throw new Error(`Packaged System startup failed: ${state.failure ?? "see fixture logs"}`);
    return state.healthy === true;
  }, "real System app health");
  console.log("PASS: packaged System entrypoint and real app /up are healthy without a source-checkout mount");
  const mappingTemplate = '{{range $port, $bindings := .HostConfig.PortBindings}}{{if ne $port "3080/tcp"}}{{range $bindings}}{{.HostIp}}:{{.HostPort}}:{{$port}}{{println}}{{end}}{{end}}{{end}}';
  const mapping = await run(["docker", "inspect", "--format", mappingTemplate, name]);
  async function api(path: string, method = "GET", body = "") {
    const code = `const r=await fetch(${JSON.stringify(`http://127.0.0.1:3001${path}`)},{method:${JSON.stringify(method)},headers:{"content-type":"application/json"},${method === "GET" ? "" : `body:${JSON.stringify(body)},`}});console.log(JSON.stringify({status:r.status,body:await r.json()}));`;
    return JSON.parse(await exec("bun", "-e", code));
  }
  if (values["release-updates"]) {
    assert.equal((await api("/release/source")).status, 200);
    assert.equal((await api("/release/prepare", "POST", JSON.stringify({ reference: "https://bad.example/app" }))).status, 400);
    const credentials = await api("/release/registry", "POST", JSON.stringify({ username: "fixture-user", token: "fixture-token" }));
    assert.deepEqual(credentials.body, { configured: true });
    assert.equal(await exec("stat", "-c", "%a", "/data/supervisor/docker-auth/config.json"), "600");
    assert.equal(await exec("stat", "-c", "%a", "/data/supervisor/docker-auth"), "700");
    assert.equal((await api("/release/registry")).body.configured, true);
    assert.equal((await api("/release/registry", "DELETE", "{}")).body.configured, false);
    const initial = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))')).currentImage;
    const second = `${name}:second`;
    await run(["docker", "exec", "-i", name, "docker", "build", "-t", second, "-"], `FROM ${fixtureApp}\nLABEL org.opencontainers.image.revision="fixture-second"\n`);
    const secondId = await exec("docker", "image", "inspect", "--format", "{{.Id}}", second);
    assert.notEqual(secondId, initial);
    await exec("bun", "-e", `const r=await fetch("http://127.0.0.1:3001/update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({image:${JSON.stringify(secondId)}})});if(r.status!==202)throw new Error("Update rejected");`);
    await until(async () => {
      const state = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))'));
      return state.healthy && !state.busy && state.currentImage === secondId && state.previousImage === initial;
    }, "second app version is healthy with recorded rollback image");
    assert.equal((await api("/rollback", "POST", "{}")).status, 202);
    await until(async () => {
      const state = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))'));
      return state.healthy && !state.busy && state.currentImage === initial && state.previousImage === secondId;
    }, "rollback restores the first app image");
    console.log("PASS: release source validation, private registry credential isolation, two-version pinned app replacement and rollback");
  }
  if (values["installer-system"]) {
    assert.equal((await api("/release/registry", "POST", JSON.stringify({ username: "fixture-user", token: "fixture-token" }))).status, 200);
    const originalSystem = await run(["docker", "inspect", "--format", "{{.Image}}", name]);
    const originalApp = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))')).currentImage;
    const installerApp = `${name}:installer-app`;
    await run(["docker", "exec", "-i", name, "docker", "build", "-t", installerApp, "-"], `FROM ${fixtureApp}\nLABEL org.opencontainers.image.revision="installer-second"\n`);
    const installerAppId = await exec("docker", "image", "inspect", "--format", "{{.Id}}", installerApp);
    await exec("bun", "-e", 'await Bun.write("/data/app/update.json",JSON.stringify({releaseMode:"custom",releaseSource:{appRepository:"ghcr.io/example/fixture-app",systemRepository:"ghcr.io/example/fixture-system"}}));');
    const script = (await Bun.file(new URL("./install.sh", import.meta.url)).text())
      .replace("system_name=kintsugi-system", `system_name=${name}`)
      .replace('{ [ -t 0 ]; } 2>/dev/null <"$prompt_input"', "true")
      .replace('IFS= read -r -t 120 "$1" <"$prompt_input"', 'if [ "$1" = answer ]; then answer=yes; else exit 2; fi')
      .replace("run_root mkdir -p /etc/modules-load.d", "mkdir -p /etc/modules-load.d")
      .replace("run_root tee /etc/modules-load.d", "tee /etc/modules-load.d")
      .replaceAll("/etc/modules-load.d", `${directory}/modules`);
    const path = join(directory, "install.sh"); await Bun.write(path, script);
    await run(["bash", path, "--action", "update", "--system-image", values["installer-system"], "--app-image", installerApp, "--tailscale-hostname", "integration-cloud"]);
    assert.equal(await run(["docker", "inspect", "--format", "{{.Config.Hostname}}", name]), "integration-cloud");
    const updated = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))'));
    assert.equal(updated.currentImage, installerAppId); assert.equal(updated.healthy, true);
    assert.equal((await api("/release/registry")).body.configured, true);
    assert.equal(await exec("stat", "-c", "%a", "/data/supervisor/docker-auth/config.json"), "600");
    const selected = JSON.parse(await exec("bun", "-e", 'console.log(await Bun.file("/data/app/update.json").text())'));
    assert.equal(selected.releaseSource.appRepository, "ghcr.io/example/fixture-app");
    assert.equal(selected.releaseSource.systemRepository, "ghcr.io/example/fixture-system");
    assert.equal(await run(["docker", "inspect", "--format", mappingTemplate, name]), mapping);
    await run(["bash", path, "--action", "rollback"]);
    assert.equal(await run(["docker", "inspect", "--format", "{{.Image}}", name]), originalSystem);
    const restored = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))'));
    assert.equal(restored.currentImage, originalApp); assert.equal(restored.healthy, true);
    console.log("PASS: real host installer pins and replaces System/app, preserves fork source/host publications/hostname, and restores the retained pair without registry pulls");
  }
  await run(["docker", "stop", "--time", "60", name]);
  assert.equal(await run(["docker", "inspect", "--format", mappingTemplate, name]), mapping, "persistent mappings survive stopped System");
  console.log("PASS: real System release operations and stopped-container publication persistence");
} catch (error) {
  const logs = Bun.spawnSync(["docker", "logs", "--tail", "100", name], { timeout: 5000 });
  console.error(logs.stdout.toString() + logs.stderr.toString());
  throw error;
} finally {
  await run(["docker", "rm", "-f", name]).catch(() => {});
  await run(["docker", "volume", "rm", volume]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
