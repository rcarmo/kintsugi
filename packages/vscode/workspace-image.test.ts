import { afterAll, expect, test } from "bun:test";
import { workspaceVSCodePort } from "@kintsugi/workspace";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "./workspace-image.json";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))); });

for (const [architecture, serverArchitecture] of [["amd64", "x64"], ["arm64", "arm64"]]) {
  test(`VS Code image downloads the matching ${architecture} server without starting a listener`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "kintsugi-vscode-image-"));
    directories.push(directory);
    const bin = join(directory, "bin");
    const archiveRoot = join(directory, "archive", "server");
    await mkdir(bin);
    await mkdir(join(archiveRoot, "bin"), { recursive: true });
    const executable = async (path: string, body: string) => {
      await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
      await chmod(path, 0o755);
    };
    await executable(join(archiveRoot, "bin/code-server"), '[ "$*" = "--server-data-dir /.kintsugi/vscode/server-data --version" ]; echo server-version');
    const archive = join(directory, "server.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", join(directory, "archive"), "server"]).exitCode).toBe(0);
    const commit = "a".repeat(40);
    await executable(join(bin, "code"), `[ "$1" = "--version" ]; printf '1.137.0\\n${commit}\\n${architecture}\\n'`);
    await executable(join(bin, "dpkg"), `echo ${architecture}`);
    await executable(join(bin, "curl"), `printf '%s\\n' "$2" > '${directory}/requested-url'; [ "$3" = "-o" ]; cp '${archive}' "$4"`);
    await executable(join(bin, "su"), '[ "$1" = agent ]; [ "$2" = -c ]; exec sh -c "$3"');
    // Exercise the archive provisioning block, not an editor or browser UI.
    const run = manifest.run[0];
    const script = run.slice(run.indexOf("code_commit="), run.indexOf("chmod -R a+rX"))
      .replaceAll("/opt/kintsugi/", `${directory}/opt/kintsugi/`)
      .replaceAll("/tmp/vscode-server.tar.gz", `${directory}/download.tar.gz`);
    const result = Bun.spawnSync(["sh", "-eu", "-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("server-version");
    expect(await readFile(join(directory, "requested-url"), "utf8")).toBe(`https://update.code.visualstudio.com/commit:${commit}/server-linux-${serverArchitecture}-web/stable\n`);
    expect(await readFile(join(directory, "opt/kintsugi/vscode-server/bin/code-server"), "utf8")).toContain("server-version");
  });
}

test("VS Code startup keeps server state outside home and preserves existing settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-vscode-startup-"));
  directories.push(directory);
  const imageRoot = join(directory, "opt/kintsugi");
  const stateRoot = join(directory, ".kintsugi");
  const home = join(directory, "home/kintsugi");
  const server = join(imageRoot, "vscode-server/bin/code-server");
  await mkdir(join(imageRoot, "vscode-server/bin"), { recursive: true });
  await mkdir(join(imageRoot, "vscode-defaults/Machine"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(server, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  await chmod(server, 0o755);
  await writeFile(join(imageRoot, "vscode-defaults/Machine/settings.json"), '{"default":true}');
  await writeFile(join(imageRoot, "vscode-defaults/Machine/mcp.json"), '{"servers":{}}');
  const startup = (await readFile(new URL("./workspace_tools/kintsugi-start-vscode", import.meta.url), "utf8"))
    .replaceAll("/opt/kintsugi", imageRoot)
    .replaceAll("/.kintsugi", stateRoot);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:KINTSUGI|ATELIER)_VSCODE_/.test(key)));
  const run = (options: Record<string, string> = {}) => Bun.spawnSync(["sh", "-c", startup], { env: { ...env, HOME: home, ...options } });
  const result = run();
  expect(result.exitCode).toBe(0);
  const args = result.stdout.toString().trim().split("\n");
  expect(args[args.indexOf("--port") + 1]).toBe(String(workspaceVSCodePort));
  expect(workspaceVSCodePort).not.toBe(8000);
  expect(args).toContain("--server-data-dir");
  expect(args[args.indexOf("--server-data-dir") + 1]).toBe(join(stateRoot, "vscode/server-data"));
  expect(args[args.indexOf("--extensions-dir") + 1]).toBe(join(imageRoot, "vscode-extensions"));
  expect(args[args.indexOf("--default-folder") + 1]).toBe("/work");
  const settings = join(stateRoot, "vscode/server-data/data/Machine/settings.json");
  expect(await readFile(settings, "utf8")).toBe('{"default":true}');
  expect(await readFile(join(stateRoot, "vscode/server-data/data/Machine/mcp.json"), "utf8")).toBe('{"servers":{}}');
  await writeFile(settings, '{"user":true}');
  const restarted = run({ KINTSUGI_VSCODE_DEFAULT_WORKSPACE: "/work/project.code-workspace" });
  expect(restarted.exitCode).toBe(0);
  expect(restarted.stdout.toString()).toContain("--default-workspace\n/work/project.code-workspace\n");
  const legacy = run({ ATELIER_VSCODE_PORT: "24801", ATELIER_VSCODE_DEFAULT_WORKSPACE: "/work/legacy.code-workspace" });
  expect(legacy.exitCode).toBe(0);
  expect(legacy.stdout.toString()).toContain("--port\n24801\n");
  expect(legacy.stdout.toString()).toContain("--default-workspace\n/work/legacy.code-workspace\n");
  const primary = run({ KINTSUGI_VSCODE_PORT: "24802", ATELIER_VSCODE_PORT: "24801" });
  expect(primary.exitCode).toBe(0);
  expect(primary.stdout.toString()).toContain("--port\n24802\n");
  expect(await readFile(settings, "utf8")).toBe('{"user":true}');
  expect(await readdir(home)).toEqual([]);
});
