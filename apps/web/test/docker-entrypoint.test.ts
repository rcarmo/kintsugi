import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entrypoint = await Bun.file(new URL("../docker-entrypoint.sh", import.meta.url)).text();
const defaultCommand = ["bun", "run", "apps/web/src/server/main.ts"];

function run(args: string[], settings: Record<string, string> = {}, inspectEnvironment = false) {
  const directory = mkdtempSync(join(tmpdir(), "kintsugi-entrypoint-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const command = (name: string, body: string) => {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
      return path;
    };
    command("getent", `case "$1" in
      group) echo 'agent:x:1000:' ;;
      passwd) echo 'agent:x:1000:1000:Kintsugi:/home/agent:/bin/sh' ;;
      *) exit 1 ;;
    esac`);
    for (const name of ["chown", "usermod"]) command(name, ":");
    command("gosu", `${inspectEnvironment ? 'printf "DATA=%s\\nNAMESPACE=%s\\n" "$KINTSUGI_DATA_DIR" "$KINTSUGI_NAMESPACE";' : ""} printf "APP\\n"; printf "<%s>\\n" "$@"`);
    const script = join(directory, "entrypoint.sh");
    writeFileSync(script, entrypoint
      .replaceAll("/var/run/docker.sock", join(directory, "docker.sock"))
      .replaceAll("/run/containerd/containerd.sock", join(directory, "containerd.sock"))
      .replaceAll("/data/app", join(directory, "data"))
      .replaceAll("/etc/sudoers.d/kintsugi-tailscale-serve", join(directory, "sudoers")));
    const result = Bun.spawnSync(["sh", script, ...args], {
      stdin: "ignore",
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:KINTSUGI|ATELIER)_/.test(key))),
        ...Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, key.endsWith("DATA_DIR") ? join(directory, value) : value])),
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), directory };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const args of [[], defaultCommand, ["custom-app", "argument with spaces"]]) {
  test(`app entrypoint runs command without starting infrastructure: ${JSON.stringify(args)}`, () => {
    const result = run(args);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`APP\n${["agent", ...(args.length ? args : defaultCommand)].map((arg) => `<${arg}>\n`).join("")}`);
  });
}

for (const primary of [false, true]) {
  test(`app entrypoint preserves legacy settings${primary ? " with Kintsugi overrides" : ""}`, () => {
    const settings = { ATELIER_DATA_DIR: "legacy-data", ATELIER_NAMESPACE: "existing-namespace" };
    if (primary) Object.assign(settings, { KINTSUGI_DATA_DIR: "primary-data", KINTSUGI_NAMESPACE: "selected-namespace" });
    const result = run([], settings, true);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`DATA=${join(result.directory, primary ? "primary-data" : "legacy-data")}\n`);
    expect(result.stdout).toContain(`NAMESPACE=${primary ? "selected-namespace" : "existing-namespace"}\n`);
  });
}
