import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const id of ["codex-cli", "claude-cli", "pi"]) {
  test(`${id} adapter validates settings, installs credentials and builds its CLI launch`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `${id}-adapter-`));
    const source = join(import.meta.dir, `../../../packages/${id}-agent/src/server`);
    const model = id === "pi" ? "custom::model" : id === "codex-cli" ? "openai-codex::gpt-5.4" : "anthropic::claude-opus-4-6";
    const launchMarker = id === "pi" ? "https://pi.dev/install.sh" : id === "codex-cli" ? "https://chatgpt.com/codex/install.sh" : "@anthropic-ai/claude-code@latest";
    const mcpConfigMarker = id === "codex-cli" ? "codex/mcp.override" : id === "claude-cli" ? "claude-mcp.json" : "/pi-kintsugi";
    try {
      const child = Bun.spawn([process.execPath, "-e", `
        import { expect, mock } from "bun:test";
        const workspace = await import("@kintsugi/workspace");
        const llm = await import("@kintsugi/llm/server");
        const agent = await import("@kintsugi/agent/server");
        const revoked = [];
        mock.module("@kintsugi/agent/server", () => ({ ...agent, prepareCliAgentConnection: async () => ({ url: "http://127.0.0.1:2988/mcp", token: "test-credential", instructions: "Test Kintsugi guidance" }), revokeAgentMcp: async (...args) => revoked.push(args) }));
        const calls = [];
        const credentials = [];
        let authChecks = 0;
        const started = [], released = [];
        mock.module("@kintsugi/workspace", () => ({
          ...workspace,
          execWorkspaceShell: async (...args) => { calls.push(args); return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 }; },
          workspaceTerminalProcesses: () => ({
            async start(options) { started.push(options); },
            async state() { return { state: "running", interactive: true }; },
            async release(id) { released.push(id); },
          }),
        }));
        mock.module("@kintsugi/llm/server", () => ({ ...llm, installSubscriptionCli: async (workspaceId) => credentials.push(workspaceId), requireProviderSubscription: async (_runtime, provider) => { expect(provider).toBe(${JSON.stringify(id === "codex-cli" ? "openai-codex" : "anthropic")}); authChecks++; } }));
        const cliAgent = await import("@kintsugi/cli-agent/server");
        mock.module("@kintsugi/cli-agent/server", () => ({ ...cliAgent, createCliModelSettings: () => ({ prepare: async (settings = {}) => settings, renderFooter: async () => "" }) }));
        if (${JSON.stringify(id)} === "pi") mock.module(${JSON.stringify(join(source, "pi-cli.ts"))}, () => ({ installPiCliConfiguration: async (workspaceId) => credentials.push(workspaceId) }));
        if (${JSON.stringify(id)} === "pi") mock.module(${JSON.stringify(join(source, "auth.ts"))}, () => ({ requirePiModels: async () => { authChecks++; }, piModelSetupRequired: () => new Error("Pi setup required") }));
        const { kintsugiServerModule } = await import(${JSON.stringify(join(source, "index.ts"))});
        const agentType = kintsugiServerModule.agentType;
        expect(agentType.id).toBe(${JSON.stringify(id)});
        const form = new FormData();
        form.set("model", "${model}");
        form.set("thinkingLevel", "high");
        const submitted = await agentType.launch.submit(form);
        const context = await submitted.prepare();
        expect(context.agent).toEqual({ model: form.get("model"), thinkingLevel: "high" });
        await agentType.launch.prepareWorkspace("adapter", context);
        expect(authChecks).toBe(2);
        expect(credentials).toEqual(["adapter"]);
        expect(calls).toHaveLength(2);
        const [tab] = await agentType.tabs.list({ workspaceId: "adapter" });
        expect(started).toHaveLength(1);
        const [launch] = started;
        expect(launch).toMatchObject({ id: tab.id, interactive: true, env: { HOME: "/home/agent" } });
        expect(launch.command).toContain(${JSON.stringify(launchMarker)});
        expect(launch.command).not.toContain("test-credential");
        const mcpSetup = calls.find((call) => call[1].includes(${JSON.stringify(mcpConfigMarker)}));
        expect(mcpSetup).toBeDefined();
        expect(mcpSetup[2].stdin).toContain("test-credential");
        if (${id === "codex-cli"}) expect(launch.command).toContain("sqlite_home=" + JSON.stringify("/home/agent/.local/share/kintsugi-agents/" + tab.id + "/codex"));
        if (${id === "pi"}) expect(launch.command).toContain("/pi-kintsugi/extension.mjs");
        await agentType.launch.prepareWorkspace("adapter", context);
        expect(started).toHaveLength(1);
        await agentType.tabs.close({ workspaceId: "adapter", agentId: tab.id });
        expect(revoked).toEqual([["adapter", tab.id]]);
        expect(released).toEqual([tab.id]);
      `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, KINTSUGI_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
