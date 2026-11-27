import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Pi configuration installation refreshes managed fields atomically and preserves unrelated settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-config-install-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
      const workspace = await import("@kintsugi/workspace");
      const config = await import("@kintsugi/llm/server");
      const directory = process.env.HOME + "/.pi/agent";
      await mkdir(directory, { recursive: true });
      await writeFile(directory + "/settings.json", JSON.stringify({ theme: "light", enabledModels: ["old/model"], transport: "websocket" }));
      const model = { provider: "custom", id: "test", name: "Test", api: "openai-completions", baseUrl: "https://model.example/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 };
      let enabledModels = [{ provider: "custom", id: "test", label: "Enabled model" }];
      mock.module("@kintsugi/llm/server", () => ({ ...config,
        createPiModelRuntime: async () => ({ getProviders: () => [{ id: "custom" }], getAvailable: async () => [model], getAvailableOfType: async () => [], getAuth: async () => ({ auth: { apiKey: "real-secret-never-copy" } }) }),
        getEnabledModels: async () => enabledModels,
      }));
      mock.module("@kintsugi/workspace", () => ({ ...workspace, execWorkspaceShell: async (_id, script, options) => {
        const process = Bun.spawn(["sh", "-c", script], { stdin: new Blob([options.stdin]), stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
        return { exitCode, stdout, stderr, durationMs: 0 };
      } }));
      const { installPiCliConfiguration } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/pi-cli.ts"))});
      await Promise.all([installPiCliConfiguration("one"), installPiCliConfiguration("two")]);
      const settings = JSON.parse(await readFile(directory + "/settings.json", "utf8"));
      expect(settings).toMatchObject({ theme: "light", enabledModels: ["custom/test"], transport: "sse", enableAnalytics: false });
      expect(settings).not.toHaveProperty("enableInstallTelemetry");
      for (const name of ["auth.json", "models.json", "settings.json"]) {
        expect((await stat(directory + "/" + name)).mode & 0o777).toBe(0o600);
        expect(await readFile(directory + "/" + name, "utf8")).not.toContain("real-secret-never-copy");
      }
      enabledModels = [];
      await installPiCliConfiguration("three");
      expect(JSON.parse(await readFile(directory + "/settings.json", "utf8")).enabledModels).toEqual([]);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
