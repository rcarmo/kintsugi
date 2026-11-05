import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshWorkspaceHelper } from "../src/helper.ts";

test("a running workspace restarts the app-mounted helper before workspace preparation", async () => {
  const data = await mkdtemp(join(tmpdir(), "workspace-helper-refresh-"));
  await mkdir(join(data, "workspaces", "01234567"), {recursive: true});
  await writeFile(join(data, "workspaces", "01234567", "gateway-token"), crypto.randomUUID() + crypto.randomUUID(), {mode: 0o600});
  const previous = process.env.KINTSUGI_DATA_DIR;
  process.env.KINTSUGI_DATA_DIR = data;
  const calls: string[][] = [];
  try {
    await refreshWorkspaceHelper("01234567", "kintsugi-01234567", async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: args[0] === "inspect" ? "true\n" : "", stderr: "" };
    });
    expect(calls.slice(-2)).toEqual([
      ["inspect", "--format", `{{range .Mounts}}{{if eq .Destination "/run/kintsugi-helper"}}{{.RW}}{{end}}{{end}}`, "kintsugi-01234567"],
      ["exec", "--user", "root", "kintsugi-01234567", "sh", "-c", expect.stringContaining("while ! test -S /run/systemd/private")],
    ]);
    expect(calls.at(-1)?.at(-1)).toContain("exec systemctl restart kintsugi-helper.service");
  } finally {
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(data, { recursive: true, force: true });
  }
});

test("a workspace without the helper unit replaces its manually launched helper", async () => {
  const data = await mkdtemp(join(tmpdir(), "workspace-helper-refresh-"));
  await mkdir(join(data, "workspaces", "01234567"), {recursive: true});
  await writeFile(join(data, "workspaces", "01234567", "gateway-token"), crypto.randomUUID() + crypto.randomUUID(), {mode: 0o600});
  const previous = process.env.KINTSUGI_DATA_DIR;
  process.env.KINTSUGI_DATA_DIR = data;
  const commands: string[][] = [];
  try {
    await mkdir(join(data, "workspace-sockets", "01234567"), { recursive: true });
    await refreshWorkspaceHelper(
      "01234567",
      "kintsugi-01234567",
      async () => ({ exitCode: 0, stdout: "false\n", stderr: "" }),
      async (args) => {
        commands.push(args);
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      },
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(0, 7)).toEqual(["docker", "exec", "--detach", "--user", "root", "kintsugi-01234567", "sh"]);
    expect(commands[0]?.at(-1)).toContain("pkill -TERM -f '^/opt/kintsugi/bin/kintsugi-workspace-helper( |$)'");
    expect(commands[0]?.at(-1)).toContain("exec /opt/kintsugi/bin/kintsugi-workspace-helper");
  } finally {
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(data, { recursive: true, force: true });
  }
});
