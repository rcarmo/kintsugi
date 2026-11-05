import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CLI model preferences persist across processes, remain Agent-type-specific, and validate availability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cli-model-preferences-"));
  async function run(script: string) {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const llm = await import("@kintsugi/llm/server");
      let enabledModels = [{ provider: "example", id: "first", label: "First" }, { provider: "example", id: "second", label: "Second" }];
      let available = new Set(["first", "second"]);
      let levels = ["low", "medium", "high"];
      mock.module("@kintsugi/llm/server", () => ({
        ...llm,
        createPiModelRuntime: async () => ({ getModel: () => ({}), getProviderAuthStatus: () => ({ configured: true }) }),
        getEnabledModels: async () => enabledModels,
        providerAvailability: async () => new Map([["example", { modelIds: available, connection: "connected" }]]),
        modelThinkingLevels: async () => levels,
        hasConnectedModelProvider: () => true,
      }));
      const { createCliModelSettings } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/model-settings.ts"))});
      const settings = (agentTypeId = "pi") => createCliModelSettings({ agentTypeId, label: agentTypeId, mapThinkingLevel: level => level });
      ${script}
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, KINTSUGI_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  }
  try {
    await run(`
      expect(await settings().prepare()).toEqual({ model: "example::first", thinkingLevel: "medium" });
      expect(await settings().prepare({ model: "example::second", thinkingLevel: "high" })).toEqual({ model: "example::second", thinkingLevel: "high" });
    `);
    await run(`
      expect(await settings().prepare()).toEqual({ model: "example::second", thinkingLevel: "high" });
      expect(await settings("codex-cli").prepare()).toEqual({ model: "example::first", thinkingLevel: "medium" });
      expect(await settings().prepare({ model: "example::first", thinkingLevel: "low" })).toEqual({ model: "example::first", thinkingLevel: "low" });
      expect(await settings().prepare({ model: "example::second" })).toEqual({ model: "example::second", thinkingLevel: "high" });
      await expect(settings().prepare({ model: "example::missing" })).rejects.toThrow("Choose an available enabled");
      await expect(settings().prepare({ thinkingLevel: "invalid" })).rejects.toThrow("Unsupported");
      expect(await settings().prepare()).toEqual({ model: "example::second", thinkingLevel: "high" });
      levels = ["low", "medium"];
      expect(await settings().prepare()).toEqual({ model: "example::second", thinkingLevel: "medium" });
      available = new Set(["first"]);
      expect(await settings().prepare()).toEqual({ model: "example::first", thinkingLevel: "low" });
      available = new Set();
      expect(await settings().prepare()).toEqual({ model: undefined, thinkingLevel: undefined });
    `);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
