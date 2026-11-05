// Real daemon/network/cache regression test, no UI. Requires a built System image
// and a local Debian-based image containing Bun (the System test-app image works).
// bun packages/workspace-image/scripts/test-repository-builder.ts SYSTEM_IMAGE BASE_IMAGE
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceImage } from "../src/index.ts";
import { buildRepositoryImage } from "../src/repository-builder.ts";
import { initializeResources } from "../../../images/system/src/resources.ts";
import { installWorkspaceFirewall, resolverAddresses } from "../../../images/system/src/firewall.ts";
import { runCommand, withCommandSignal, shellQuote } from "@kintsugi/core";

async function command(args: string[]) {
  const result = await runCommand(args);
  assert.equal(result.exitCode, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout.toString().trim();
}

async function inside(base: string) {
  const resources = await initializeResources();
  // The real app receives this path as a bind mount; the harness runs in System.
  await symlink(resources.buildClientsCgroup, "/run/kintsugi-system/build-client-processes");
  await installWorkspaceFirewall(resources.buildClientsCgroupParent, resolverAddresses(await readFile("/etc/resolv.conf", "utf8")));
  const received: string[] = [];
  const fixture = Bun.serve({ hostname: "::", port: 38080, fetch(request) {
    const path = new URL(request.url).pathname;
    received.push(path);
    return new Response("management-only-marker", { status: path.startsWith("/auth-") ? 403 : 200 });
  } });
  const root = await mkdtemp("/tmp/repository-builds-");
  let number = 0;
  async function build(dockerfile: string, extra: string[] = [], unprotectedClient = false) {
    const context = join(root, `ephemeral-workspace-${++number}`);
    await mkdir(context);
    await writeFile(join(context, "Dockerfile"), `FROM kintsugi-workspace\n${dockerfile}\n`);
    const tag = `repository-builder-test:build-${number}`;
    let output = "";
    await buildRepositoryImage(base, tag, async (prefix) => {
      const client = unprotectedClient ? prefix.slice(prefix.indexOf("docker")) : prefix;
      const result = await runCommand([...client, "build", "--builder", "default", "--progress=plain", "--label", "com.kintsugi.workspace-image.kind=repository", ...extra, "-t", tag, context], { env: { ...process.env, DOCKER_BUILDKIT: "1" } });
      output = result.stderr + result.stdout.toString();
      if (result.exitCode !== 0) throw new Error(output);
    });
    await rm(context, { recursive: true });
    return { tag, output };
  }
  const imageFile = (tag: string, path: string) => command(["docker", "run", "--rm", "--network=none", "--entrypoint", "cat", tag, path]);
  async function builderName() {
    return command(["docker", "ps", "-aq", "--filter", "label=com.kintsugi.role=repository-builder"]);
  }
  try {
    // Positive control: the old integrated System builder can read the fixture.
    await command(["docker", "tag", base, "kintsugi-workspace"]);
    const control = join(root, "old-builder");
    await mkdir(control);
    await writeFile(join(control, "Dockerfile"), "FROM kintsugi-workspace\nADD http://127.0.0.1:38080/old-builder /marker\nRUN grep management-only-marker /marker\n");
    await command(["docker", "build", "--builder", "default", "--no-cache", control]);
    assert(received.includes("/old-builder"));

    const source = 'RUN apt-get update && apt-get install -y --no-install-recommends jq\nADD http://11.201.0.2:8080/public /public-marker\nRUN jq --version && bun -e \'if(await(await fetch("http://11.201.0.2:8080/run")).text()!=="public-marker")throw Error("egress failed")\'\nRUN cat /proc/sys/kernel/random/uuid > /cache-marker';
    const first = await build(source);
    const marker = await imageFile(first.tag, "/cache-marker");
    assert.equal(await imageFile(first.tag, "/public-marker"), "public-marker");
    const second = await build(source);
    assert(second.output.includes("CACHED"));
    assert.equal(await imageFile(second.tag, "/cache-marker"), marker);
    console.log("PASS package installation, public RUN/ADD, published runnable images and layer cache across deleted workspace contexts");

    const cacheSource = 'ARG STEP\nRUN --mount=type=cache,target=/build-cache sh -ec \'echo "$STEP"; test -f /build-cache/marker || cat /proc/sys/kernel/random/uuid > /build-cache/marker; cp /build-cache/marker /mount-marker\'';
    const warm = await build(cacheSource, ["--build-arg", "STEP=warm"]);
    const mountMarker = await imageFile(warm.tag, "/mount-marker");
    // Recreate the daemon container, not its persistent volume: mimics runtime replacement.
    await command(["docker", "stop", "--time", "120", await builderName()]);
    await command(["docker", "rm", await builderName()]);
    const restored = await build(cacheSource, ["--build-arg", "STEP=restored"]);
    assert.equal(await imageFile(restored.tag, "/mount-marker"), mountMarker);
    const third = await build(source);
    assert.equal(await imageFile(third.tag, "/cache-marker"), marker);
    console.log("PASS layer cache and package cache mounts survive builder recreation");

    // A registry challenge is fetched by the CLI session, not the private daemon.
    // HTTP registry is deliberately enabled only in this disposable test daemon.
    const authBuilder = await builderName();
    const authInspect = JSON.parse(await command(["docker", "inspect", authBuilder]))[0];
    const daemonFile = authInspect.Mounts.find((mount: { Destination: string }) => mount.Destination === "/etc/docker/daemon.json").Source;
    const config = JSON.parse(await readFile(daemonFile, "utf8"));
    config["insecure-registries"] = ["11.201.0.2:8080"];
    await writeFile(daemonFile, JSON.stringify(config));
    await command(["docker", "restart", authBuilder]);
    const authDockerfile = "FROM 11.201.0.2:8080/attacker/image:latest";
    async function setRealm(realm: string) {
      const response = await fetch(`http://11.201.0.2:8080/set-realm?value=${encodeURIComponent(realm)}`);
      assert(response.ok);
    }
    const authBuild = (unprotectedClient = false) => withCommandSignal(AbortSignal.timeout(12_000), () => build(authDockerfile, ["--no-cache"], unprotectedClient));
    await setRealm("http://127.0.0.1:38080/auth-control");
    await assert.rejects(authBuild(true), /management-only-marker/);
    assert(received.includes("/auth-control"), "unprotected CLI must reproduce the auth SSRF");
    assert.equal(await (await fetch("http://[::1]:38080/ipv6-control")).text(), "management-only-marker");
    const authBefore = received.length;
    for (const realm of [
      "http://127.0.0.1:38080/auth-loopback", "http://[::1]:38080/auth-ipv6",
      "http://11.201.0.3:38080/auth-local-public", "http://10.201.0.2:8080/auth-private",
      "http://169.254.169.254:8080/auth-metadata", "http://11.201.0.2:8080/auth-redirect",
    ]) {
      await setRealm(realm);
      await assert.rejects(authBuild(), (error: Error) => {
        assert(!error.message.includes("management-only-marker"), "auth response leaked into build output");
        return true;
      }, `registry auth unexpectedly succeeded: ${realm}`);
      assert.equal(received.length, authBefore, `CLI auth reached host fixture: ${realm}`);
    }
    const authHits = await (await fetch("http://11.201.0.2:8080/auth-hits")).json();
    assert(!authHits.includes("/auth-private") && !authHits.includes("/auth-metadata"), "CLI reached a non-public realm");
    // Public token fetch must still work (403 is returned deliberately so its
    // response marker proves the client fetched the realm and propagated errors).
    await setRealm("http://11.201.0.2:8080/auth-public");
    await assert.rejects(authBuild(), /public-auth-marker/);
    console.log("PASS CLI registry Bearer auth blocks host/private/metadata realms and redirects; public auth fetch remains available");

    const name = await builderName();
    const inspect = JSON.parse(await command(["docker", "inspect", name]))[0];
    assert.notEqual(inspect.HostConfig.NetworkMode, "host");
    assert.equal(inspect.HostConfig.PortBindings && Object.keys(inspect.HostConfig.PortBindings).length, 0);
    assert(!inspect.Mounts.some((mount: { Destination: string }) => mount.Destination === "/var/run/docker.sock" || mount.Destination === "/run/containerd"));
    const networks: Record<string, { Gateway: string }> = inspect.NetworkSettings.Networks;
    const gateway = Object.values(networks)[0]!;
    for (const url of ["http://10.201.0.2:8080/private", "http://169.254.169.254:8080/metadata"]) {
      assert.equal(await (await fetch(url)).text(), "public-marker", "private fixture must be reachable from the System as a positive control");
    }
    const before = received.length;
    const denied = [
      "http://127.0.0.1:38080/loopback", `http://${gateway.Gateway}:38080/gateway`,
      "http://11.201.0.3:38080/system-public", "http://10.201.0.2:8080/private",
      "http://169.254.169.254:8080/metadata", "http://11.201.0.2:8080/redirect",
    ];
    const probe = `for (const url of ${JSON.stringify(denied)}) { let blocked = false; try { await fetch(url, {headers:{Origin:new URL(url).origin},signal:AbortSignal.timeout(1200)}); } catch { blocked = true; } if (!blocked) throw Error("RUN reached " + url); }`;
    await build(`RUN bun -e ${shellQuote(probe)}`, ["--no-cache"]);
    assert.equal(received.length, before);
    for (const url of denied) {
      await assert.rejects(withCommandSignal(AbortSignal.timeout(12_000), () => build(`ADD ${url} /stolen`, ["--no-cache"])), `remote ADD reached ${url}`);
      assert.equal(received.length, before, "isolated build reached management fixture");
    }
    await assert.rejects(build("RUN --network=host true", ["--no-cache"]), /network.host is not allowed/);
    // Failed requests and cancellations must not make subsequent builds fall back.
    const final = await build("RUN echo isolated > /marker");
    assert.equal(await imageFile(final.tag, "/marker"), "isolated");
    // Exercise the application's resolver too, not just the builder module.
    // The bundled resolver's repoRoot is /; this is only the disposable fixture.
    await writeFile("/.kintsugi-default-workspace-image", base);
    const repository = join(root, "actual-repository");
    await mkdir(join(repository, ".kintsugi"), { recursive: true });
    const dockerfile = join(repository, ".kintsugi", "Dockerfile");
    await writeFile(dockerfile, "FROM kintsugi-workspace\nRUN echo resolver-ok > /marker\n");
    const resolved = await resolveWorkspaceImage({ sourcePath: repository, buildOutput: "inherit" });
    assert.equal(await imageFile(resolved, "/marker"), "resolver-ok");
    await writeFile(dockerfile, "FROM kintsugi-workspace\nRUN echo observable-ok > /marker\n");
    const observable = await resolveWorkspaceImage({ sourcePath: repository });
    assert.equal(await imageFile(observable, "/marker"), "observable-ok");
    await writeFile(dockerfile, "FROM kintsugi-workspace\nADD http://127.0.0.1:38080/resolver-leak /stolen\n");
    await assert.rejects(withCommandSignal(AbortSignal.timeout(12_000), () => resolveWorkspaceImage({ sourcePath: repository, buildOutput: "inherit" })));
    assert.equal(received.length, before);
    console.log("PASS actual repository image resolver publishes builds and rejects daemon-local ADD");
    console.log("PASS RUN and daemon-side ADD cannot reach loopback, gateway, System public IP, private/metadata addresses or redirects; host entitlement rejected");
  } finally {
    fixture.stop(true);
    await rm(root, { recursive: true });
  }
}

function serveEndpoint() {
  let realm = "http://127.0.0.1:38080/auth-loopback";
  const hits: string[] = [];
  Bun.serve({ hostname: "0.0.0.0", port: 8080, fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/auth-hits") return Response.json(hits);
    if (path === "/set-realm") {
      realm = url.searchParams.get("value")!;
      return new Response("ok");
    }
    if (path.startsWith("/v2/")) return new Response("unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer realm="${realm}",service="test",scope="repository:attacker/image:pull"` },
    });
    if (path.startsWith("/auth-")) hits.push(path);
    if (path === "/auth-public") return new Response("public-auth-marker", { status: 403 });
    if (path === "/auth-redirect" || path === "/redirect") return Response.redirect("http://11.201.0.3:38080/auth-redirected");
    return new Response("public-marker");
  } });
}

async function outside(systemImage: string, base: string) {
  const name = `repository-builder-test-${crypto.randomUUID().slice(0, 8)}`;
  const endpoint = `${name}-endpoint`;
  const directory = await mkdtemp(join(tmpdir(), "repository-builder-test-"));
  const docker = (...args: string[]) => command(["docker", ...args]);
  try {
    const bundled = await Bun.build({ entrypoints: [import.meta.path], target: "bun", outdir: directory, naming: "test.js" });
    assert(bundled.success, JSON.stringify(bundled.logs));
    await docker("network", "create", "--subnet", "11.201.0.0/24", name);
    await docker("create", "--name", endpoint, "--network", name, "--ip", "11.201.0.2", "--cap-add", "NET_ADMIN", "--entrypoint", "bun", systemImage, "/test.js", "--endpoint");
    await docker("cp", join(directory, "test.js"), `${endpoint}:/test.js`);
    await docker("start", endpoint);
    for (const address of ["10.201.0.2/32", "169.254.169.254/32"]) await docker("exec", endpoint, "ip", "addr", "add", address, "dev", "eth0");
    await docker("run", "-d", "--name", name, "--privileged", "--cgroupns=host", "--tmpfs", "/run", "--volume", "/data", "--network", name, "--ip", "11.201.0.3", "--entrypoint", "/usr/local/bin/kintsugi-dockerd", systemImage, "dockerd");
    await docker("exec", name, "sh", "-ec", 'for n in $(seq 1 120); do if docker info >/dev/null 2>&1; then exit 0; fi; sleep 0.5; done; exit 1');
    for (const address of ["10.201.0.2/32", "169.254.169.254/32"]) await docker("exec", name, "ip", "route", "add", address, "via", "11.201.0.2");
    await docker("exec", name, "mkdir", "/audit");
    await docker("cp", join(directory, "test.js"), `${name}:/audit/test.js`);
    // Bundling relocates repository-builder.ts's relative runtime-image URL.
    await docker("cp", new URL("../runtime-image", import.meta.url).pathname, `${name}:/runtime-image`);
    await command(["bash", "-o", "pipefail", "-c", `docker save ${shellQuote(base)} | docker exec -i ${shellQuote(name)} docker load`]);
    // Run visibly: package output remains captured by the build, PASS lines stream.
    const child = Bun.spawn(["docker", "exec", "-e", "KINTSUGI_DATA_DIR=/data/app", name, "bun", "/audit/test.js", "--inside", base], { stdout: "inherit", stderr: "inherit" });
    assert.equal(await child.exited, 0);
  } finally {
    await docker("rm", "-fv", name, endpoint);
    await docker("network", "rm", name);
    await rm(directory, { recursive: true });
  }
}

if (process.argv[2] === "--endpoint") serveEndpoint();
else if (process.argv[2] === "--inside") await inside(process.argv[3]!);
else {
  assert(process.argv.length === 4, "Pass SYSTEM_IMAGE BASE_IMAGE");
  await outside(process.argv[2]!, process.argv[3]!);
}
