import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKintsugiEventBus } from "@kintsugi/core";
import { getAgentType, defaultAgentType, orderedAgentTypes, rememberAgentType } from "../src/server/agent-types.ts";

let directory: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.KINTSUGI_DATA_DIR;
  directory = await mkdtemp(join(tmpdir(), "kintsugi-agent-types-"));
  process.env.KINTSUGI_DATA_DIR = directory;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = previous;
  await rm(directory, { recursive: true, force: true });
});

test("builtin is the initial default and successful choices persist", async () => {
  expect((await defaultAgentType()).id).toBe("builtin");
  await rememberAgentType("codex");
  expect(JSON.parse(await Bun.file(join(directory, "default-agent-type.json")).text())).toBe("codex");
  expect((await orderedAgentTypes()).map(({ id }) => id)).toEqual(["codex", "builtin", "claude", "claude-cli", "codex-cli", "pi"]);
  await rememberAgentType("claude");
  expect((await defaultAgentType()).id).toBe("claude");
  expect((await orderedAgentTypes()).map(({ id }) => id)).toEqual(["claude", "builtin", "claude-cli", "codex", "codex-cli", "pi"]);
  await rememberAgentType("pi");
  expect((await defaultAgentType()).id).toBe("pi");
  expect((await orderedAgentTypes()).map(({ id }) => id)).toEqual(["pi", "builtin", "claude", "claude-cli", "codex", "codex-cli"]);
  await rememberAgentType("codex-cli");
  expect((await defaultAgentType()).id).toBe("codex-cli");
  await rememberAgentType("builtin");
  expect((await defaultAgentType()).id).toBe("builtin");
});

test("an unavailable saved default resolves to builtin without rewriting the saved preference", async () => {
  await writeFile(join(directory, "default-agent-type.json"), JSON.stringify("uninstalled"));
  expect((await defaultAgentType()).id).toBe("builtin");
  expect(JSON.parse(await Bun.file(join(directory, "default-agent-type.json")).text())).toBe("uninstalled");
});

test("unknown Agent types cannot overwrite the default", async () => {
  await rememberAgentType("codex");
  expect(() => getAgentType("unknown")).toThrow("Unknown agent type");
  await expect(rememberAgentType("unknown")).rejects.toMatchObject({ code: "invalid_arguments" });
  expect((await defaultAgentType()).id).toBe("codex");
});

test("default-change events observe the already-persisted preference", async () => {
  const events = createKintsugiEventBus();
  const observed: string[] = [];
  events.on("agent_type_default_changed", async ({ agentTypeId }) => {
    expect((await defaultAgentType()).id).toBe(agentTypeId);
    observed.push(agentTypeId);
  });
  await rememberAgentType("codex", events);
  expect(observed).toEqual(["codex"]);
});

test("defaults to Claude Code when an Anthropic subscription is the only way to run an agent", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    import { expect, mock } from "bun:test";
    const agent = await import("@kintsugi/builtin-agent/server");
    const llm = await import("@kintsugi/llm/server");
    let builtinHasModel = false;
    let credentials = [{ providerId: "anthropic", type: "oauth" }];
    mock.module("@kintsugi/builtin-agent/server", () => ({ ...agent, hasAvailableBuiltinAgentModel: async () => builtinHasModel }));
    mock.module("@kintsugi/llm/server", () => ({ ...llm, createPiModelRuntime: async () => ({ listCredentials: async () => credentials }) }));
    const { defaultAgentType, orderedAgentTypes, rememberAgentType } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/agent-types.ts"))});
    expect((await orderedAgentTypes())[0].id).toBe("claude");
    await rememberAgentType("builtin");
    expect((await defaultAgentType()).id).toBe("claude");
    await rememberAgentType("codex");
    expect((await defaultAgentType()).id).toBe("codex");
    await rememberAgentType("builtin");
    builtinHasModel = true;
    expect((await defaultAgentType()).id).toBe("builtin");
    builtinHasModel = false;
    credentials = [{ providerId: "anthropic", type: "api_key" }];
    expect((await defaultAgentType()).id).toBe("builtin");
  `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, KINTSUGI_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});


test("previous Agent type preference remains readable and new choices use the renamed file", async () => {
  await writeFile(join(directory, "default-agent-provider.json"), JSON.stringify("pi"));
  expect((await defaultAgentType()).id).toBe("pi");
  await rememberAgentType("codex");
  expect(JSON.parse(await Bun.file(join(directory, "default-agent-type.json")).text())).toBe("codex");
  expect((await defaultAgentType()).id).toBe("codex");
});


test("Codex and Codex CLI resolve to distinct implementations without old aliases", async () => {
  const { kintsugiServerModule: codex } = await import("@kintsugi/codex-agent/server");
  const { kintsugiServerModule: codexCli } = await import("@kintsugi/codex-cli-agent/server");
  expect(getAgentType("codex")).toBe(codex.agentType!);
  expect(getAgentType("codex-cli")).toBe(codexCli.agentType!);
  expect(codex.id).toBe("codex-agent");
  expect(codexCli.id).toBe("codex-cli-agent");
  expect(() => getAgentType("codex-app-server")).toThrow("Unknown agent type");
});
