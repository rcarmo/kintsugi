import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep dependency mocks and runtime configuration isolated from other test files.
async function homeScenario(script: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-home-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      const directory = process.env.KINTSUGI_DATA_DIR;
      const home = join(directory, "home");
      const core = await import("@kintsugi/core");
      const commands = [];
      let failCopy = false;
      mock.module("@kintsugi/core", () => ({ ...core, requireDocker: async (args) => {
        commands.push(args);
        if (args[0] === "cp") {
          expect(args[1]).toEndWith(":/opt/kintsugi/home-defaults/.");
          expect(await readdir(directory)).not.toContain("home");
          await writeFile(join(args[2], ".bashrc"), "default");
          if (failCopy) throw new Error("interrupted copy");
          await writeFile(join(args[2], ".profile"), "default");
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      } }));
      mock.module("@kintsugi/workspace-image", () => ({ ensureDefaultWorkspaceImage: async () => "default-image" }));
      const { ensureSharedHome, workspaceHomeMounts } = await import(${JSON.stringify(join(import.meta.dir, "home.ts"))});
      ${script}
    `], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, KINTSUGI_DATA_DIR: directory, KINTSUGI_DOCKER_HOST_DATA_DIR: "/host/kintsugi-data" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("home is seeded once, preserving user edits and deliberate deletions", () => homeScenario(`
  await ensureSharedHome();
  expect((await stat(home)).mode & 0o777).toBe(0o700);
  await writeFile(join(home, ".bashrc"), "personal settings");
  await rm(join(home, ".profile"));
  await ensureSharedHome();
  expect(commands.map(args => args[0])).toEqual(["create", "cp", "rm"]);
  expect(await readFile(join(home, ".bashrc"), "utf8")).toBe("personal settings");
  expect(await readdir(home)).toEqual([".bashrc"]);
`));

test("failed seeding removes the container and partial home, and can be retried", () => homeScenario(`
  failCopy = true;
  await expect(ensureSharedHome()).rejects.toThrow("interrupted copy");
  expect(commands.map(args => args[0])).toEqual(["create", "cp", "rm"]);
  expect(await readdir(directory)).toEqual([]);
  failCopy = false;
  await ensureSharedHome();
  expect(await readFile(join(home, ".bashrc"), "utf8")).toBe("default");
`));

test("workspaces share home but isolate application state with Docker-host paths", () => homeScenario(`
  const [first, second] = await Promise.all([workspaceHomeMounts("first"), workspaceHomeMounts("second")]);
  expect(first[0]).toEqual({ type: "bind", source: "/host/kintsugi-data/home", target: "/home/agent" });
  expect(second[0]).toEqual(first[0]);
  for (const [index, path] of [".local/share", ".local/state", ".cache"].entries()) {
    expect(first[index + 1]).toEqual({ type: "bind", source: "/host/kintsugi-data/workspaces/first/home-local/" + path, target: "/home/agent/" + path });
    expect(second[index + 1].source).toBe("/host/kintsugi-data/workspaces/second/home-local/" + path);
    expect((await stat(join(directory, "workspaces/first/home-local", path))).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, path))).isDirectory()).toBe(true);
  }
  await writeFile(join(home, ".personal"), "keep");
  await rm(join(directory, "workspaces/first"), { recursive: true });
  expect(await readFile(join(home, ".personal"), "utf8")).toBe("keep");
  expect((await stat(join(directory, "workspaces/second/home-local/.cache"))).isDirectory()).toBe(true);
`));

test("concurrent initializers publish only one seeded home", () => homeScenario(`
  await Promise.all(Array.from({ length: 5 }, () => ensureSharedHome()));
  expect(commands.map(args => args[0])).toEqual(["create", "cp", "rm"]);
  expect(await readdir(directory)).toEqual(["home"]);
`));
