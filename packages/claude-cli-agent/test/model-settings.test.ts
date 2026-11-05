import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// Isolate catalogue mocks and saved preferences from the real provider registry.
async function scenario(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "claude-model-settings-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const llm = await import("@kintsugi/llm/server");
      const enabledModels = [
        { provider: "openai-codex", id: "codex", label: "Codex" },
        { provider: "anthropic", id: "first", label: "First" },
        { provider: "anthropic", id: "second", label: "Second" },
        { provider: "anthropic", id: "unavailable", label: "Unavailable" },
      ];
      mock.module("@kintsugi/llm/server", () => ({ ...llm,
        getEnabledModels: async () => enabledModels,
        requireProviderSubscription: async () => {},
        createPiModelRuntime: async () => ({ getAvailable: async () => enabledModels.slice(0, 3), checkAuth: async () => true, getProviderAuthStatus: () => ({ configured: true }), getModel: () => ({ thinkingLevelMap: { minimal: "low", off: null, xhigh: "max" } }) }),
        modelThinkingLevels: async () => ["off", "minimal", "low", "medium", "high", "xhigh"],
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

test("defaults to the first available Claude enabled model, never another provider", () => scenario(`
  expect(await prepare()).toEqual({ model: "anthropic::first", thinkingLevel: "medium" });
`));

test("accepts a chosen Claude enabled model and supported thinking level", () => scenario(`
  expect(await prepare({ model: "anthropic::second", thinkingLevel: "high" })).toEqual({ model: "anthropic::second", thinkingLevel: "high" });
  expect((await prepare({ thinkingLevel: "max" })).thinkingLevel).toBe("max");
`));

test("rejects foreign, unavailable, non-enabled models and invalid thinking levels", () => scenario(`
  for (const model of ["openai-codex::codex", "anthropic::unavailable", "anthropic::not-enabled", 42]) {
    await expect(prepare({ model })).rejects.toMatchObject({ code: "invalid_arguments" });
  }
  await expect(prepare({ thinkingLevel: "invented" })).rejects.toMatchObject({ code: "invalid_arguments" });
`));

test("offers native Claude efforts rather than Pi aliases", () => scenario(`
  expect((await prepare({ thinkingLevel: "low" })).thinkingLevel).toBe("low");
  for (const thinkingLevel of ["minimal", "off", "none", "xhigh"]) {
    await expect(prepare({ thinkingLevel })).rejects.toMatchObject({ code: "invalid_arguments" });
  }
`));
