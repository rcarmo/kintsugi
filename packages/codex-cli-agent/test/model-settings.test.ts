import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// Isolate catalogue mocks and saved preferences from the real provider registry.
async function scenario(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "codex-model-settings-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const llm = await import("@kintsugi/llm/server");
      const enabledModels = [
        { provider: "anthropic", id: "claude", label: "Claude" },
        { provider: "openai-codex", id: "first", label: "First" },
        { provider: "openai-codex", id: "second", label: "Second" },
        { provider: "openai-codex", id: "unavailable", label: "Unavailable" },
      ];
      mock.module("@kintsugi/llm/server", () => ({ ...llm,
        getEnabledModels: async () => enabledModels,
        requireProviderSubscription: async () => {},
        createPiModelRuntime: async () => ({ getAvailable: async () => enabledModels.slice(0, 3), checkAuth: async () => true, getProviderAuthStatus: () => ({ configured: true }), getModel: () => ({ thinkingLevelMap: { minimal: "low", off: "none" } }) }),
        modelThinkingLevels: async () => ["off", "minimal", "low", "medium", "high"],
      }));
      const { kintsugiServerModule: { agentType: { launch } } } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/index.ts"))});
      const prepare = async (parameters) => (await launch.prepare(parameters)).agent;
      ${script}
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, KINTSUGI_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("defaults to the first available Codex enabled model, never another provider", () => scenario(`
  expect(await prepare()).toEqual({ model: "openai-codex::first", thinkingLevel: "medium" });
`));

test("accepts a chosen Codex enabled model and supported thinking level", () => scenario(`
  expect(await prepare({ model: "openai-codex::second", thinkingLevel: "high" })).toEqual({ model: "openai-codex::second", thinkingLevel: "high" });
  expect((await prepare({ thinkingLevel: "none" })).thinkingLevel).toBe("none");
`));

test("rejects foreign, unavailable, non-enabled models and invalid thinking levels", () => scenario(`
  for (const model of ["anthropic::claude", "openai-codex::unavailable", "openai-codex::not-enabled", 42]) {
    await expect(prepare({ model })).rejects.toMatchObject({ code: "invalid_arguments" });
  }
  await expect(prepare({ thinkingLevel: "invented" })).rejects.toMatchObject({ code: "invalid_arguments" });
`));

test("offers native Codex efforts rather than Pi aliases", () => scenario(`
  expect((await prepare({ thinkingLevel: "low" })).thinkingLevel).toBe("low");
  await expect(prepare({ thinkingLevel: "minimal" })).rejects.toMatchObject({ code: "invalid_arguments" });
`));
