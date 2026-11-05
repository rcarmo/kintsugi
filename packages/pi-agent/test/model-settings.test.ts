import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// Isolate catalogue mocks and saved preferences from the real provider registry.
async function scenario(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-settings-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const llm = await import("@kintsugi/llm/server");
      let runtimeCreations = 0;
      let runtime;
      let availabilityChecks = 0;
      let enabledModels = [
        { provider: "anthropic", id: "claude", label: "Claude" },
        { provider: "openai-codex", id: "gpt", label: "GPT" },
        { provider: "custom", id: "model", label: "Custom" },
        { provider: "custom", id: "unavailable", label: "Unavailable" },
        { provider: "amazon-bedrock", id: "ambient", label: "AWS profile" },
      ];
      mock.module("@kintsugi/llm/server", () => ({ ...llm,
        getEnabledModels: async () => enabledModels,
        createPiModelRuntime: async () => {
          runtimeCreations++;
          return runtime = { getAvailable: async () => enabledModels.filter(m => m.id !== "unavailable"), checkAuth: async () => true, getModel: () => ({ thinkingLevelMap: { minimal: "low", off: "none" } }) };
        },
        hasConnectedModelProvider: () => true,
        modelThinkingLevels: async () => ["off", "minimal", "low", "medium", "high"],
      }));
      mock.module(${JSON.stringify(join(import.meta.dir, "../src/server/pi-cli-bridge.ts"))}, () => ({ piCliModelUnavailableReason: async (actualRuntime, model) => {
        expect(actualRuntime).toBe(runtime);
        availabilityChecks++;
        return model.id === "ambient" ? "Requires a bearer token" : undefined;
      } }));
      const { piModelSettings: { prepare: preparePiModelSettings } } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/model-settings.ts"))});
      ${script}
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, KINTSUGI_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("uses Kintsugi enabled models across providers, including custom providers", () => scenario(`
  expect(await preparePiModelSettings()).toEqual({ model: "anthropic::claude", thinkingLevel: "medium" });
  for (const model of ["anthropic::claude", "openai-codex::gpt", "custom::model"]) {
    expect(await preparePiModelSettings({ model, thinkingLevel: "minimal" })).toEqual({ model, thinkingLevel: "minimal" });
  }
`));

test("rejects unavailable, unsupported, non-enabled models and non-Pi thinking levels", () => scenario(`
  for (const model of ["custom::unavailable", "custom::unknown", "amazon-bedrock::ambient", 42]) {
    await expect(preparePiModelSettings({ model })).rejects.toMatchObject({ code: "invalid_arguments" });
  }
  for (const thinkingLevel of ["none", "invented", 42]) {
    await expect(preparePiModelSettings({ thinkingLevel })).rejects.toMatchObject({ code: "invalid_arguments" });
  }
`));

test("requires model setup rather than starting with independent Pi defaults", () => scenario(`
  enabledModels = [];
  await expect(preparePiModelSettings()).rejects.toMatchObject({ code: "agent_setup_required" });
`));

test("shares one runtime across model availability checks", () => scenario(`
  await preparePiModelSettings();
  expect(runtimeCreations).toBe(1);
  expect(availabilityChecks).toBe(4);
`));
