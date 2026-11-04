import { defineWorkspaceTool } from "../../agent/src/server/workspace-tool.ts";
import { afterEach, expect, test } from "bun:test";
import { createMcpExtension, createCodemodeExtension, type ExtensionAPI, type McpServerConfig, type ToolInfo, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentMcpServer } from "../../agent/src/server/mcp-server.ts";
import { registerPiKintsugi } from "../src/extension/pi-kintsugi.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type FakeHandler = (...args: any[]) => any;

function fakePi() {
  const handlers = new Map<string, FakeHandler[]>();
  const tools = new Map<string, ToolDefinition<any, any>>();
  const servers = new Map<string, McpServerConfig>();
  const executions: unknown[][] = [];
  const notices: string[] = [];
  let active: string[] = [];
  const partial: Pick<ExtensionAPI, "on" | "registerMcpServer" | "getMcpServers" | "registerCommand" | "registerTool" | "registerToolRenderer" | "getAllTools" | "getActiveTools" | "setActiveTools" | "exec"> = {
    on(name: string, handler: FakeHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => { handlers.set(name, handlers.get(name)!.filter((entry) => entry !== handler)); };
    },
    registerMcpServer(name: string, config: McpServerConfig) { servers.set(name, config); },
    getMcpServers() { return [...servers].map(([name, config]) => ({ name, config, extensionPath: "pi-kintsugi" })); },
    registerCommand() {},
    registerToolRenderer() {},
    registerTool(tool: ToolDefinition<any, any>) { tools.set(tool.name, tool); },
    getAllTools(): ToolInfo[] { return [...tools.values()].map((tool) => ({ ...tool, exposure: tool.exposure ?? "direct", sourceInfo: { source: "extension", path: "pi-kintsugi", scope: "temporary", origin: "top-level" } })); },
    getActiveTools() { return active; },
    setActiveTools(names: string[]) { active = names; },
    async exec(...args: unknown[]) { executions.push(args); return { code: 0, stdout: "", stderr: "", killed: false, truncated: false }; },
  };
  // SAFETY: The protocol integrations under test use only the API members implemented here.
  const pi = partial as ExtensionAPI;
  async function emit(name: string, event: { systemPrompt?: string; systemPromptOptions?: { sections: object }; toolName?: string; input?: object } = { systemPrompt: "Base", systemPromptOptions: { sections: {} } }): Promise<void> {
    for (const handler of handlers.get(name) ?? []) await handler(event, {
      cwd: process.cwd(), ui: { notify: (message: string) => notices.push(message) },
    });
  }
  return { pi, tools, servers, handlers, executions, notices, emit };
}

function fixture() {
  const identity = { workspaceId: "workspace-a", agentId: "agent-a", instructionDelivery: "system-prompt" as const };
  const token = "secret-token";
  const endpoint = createAgentMcpServer({
    authenticate: (candidate) => candidate === token ? identity : undefined,
    instructions: () => "Use present to show interactive work.",
    tools: () => [
      defineWorkspaceTool({
        name: "present", label: "Present", description: "Present work",
        parameters: Type.Object({ kind: Type.String() }),
        execute: async (_id, args: { kind: string }, _signal, update) => {
          update?.({ content: [{ type: "text", text: "Opening" }], details: {} });
          return { content: [{ type: "text", text: `Presented ${args.kind}` }], details: {} };
        },
      }),
      defineWorkspaceTool({
        name: "fail", label: "Fail", description: "Fail visibly", parameters: Type.Object({}),
        execute: async () => { throw new Error("deliberate failure"); },
      }),
    ],
  });
  const server = Bun.serve({ port: 0, fetch: (request) => endpoint.fetch(request) });
  cleanup.push(async () => { await endpoint.revoke({ workspaceId: identity.workspaceId }); server.stop(true); });
  return {
    url: new URL("/mcp", server.url).href, token, turnSignalCommand: "/session/turn-signal.sh", instructions: "Use present to show interactive work.",
  };
}

test("pi-kintsugi registers a native MCP server, and appends full guidance to the native system prompt", async () => {
  const config = { url: "http://localhost:2988/mcp", token: "private", turnSignalCommand: "/session/signal.sh", instructions: "Full guidance\n" + "x".repeat(12000) };
  const f = fakePi();
  registerPiKintsugi(f.pi, config);
  expect(f.servers.get("kintsugi")).toEqual({
    url: config.url, headers: { Authorization: "Bearer private" }, exposure: "codemode", timeout: 3600,
  });
  expect(f.tools.size).toBe(0);
  expect([...f.handlers.keys()]).toEqual(["before_agent_start", "agent_start", "agent_end"]);
  expect(await f.handlers.get("before_agent_start")![0]!({ systemPrompt: "Built-in + user guidance" })).toEqual({ systemPrompt: "Built-in + user guidance\n\n" + config.instructions });
  await f.emit("agent_start");
  await f.emit("agent_end");
  expect(f.executions).toEqual([["sh", [config.turnSignalCommand, "started"]], ["sh", [config.turnSignalCommand, "finished"]]]);
});

test("Pi native MCP discovers Kintsugi tools and does not duplicate native prompt guidance in their namespace", async () => {
  const mcp = fixture();
  const f = fakePi();
  registerPiKintsugi(f.pi, mcp);
  createCodemodeExtension()(f.pi);
  createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) })(f.pi);
  cleanup.push(() => f.emit("session_shutdown"));
  await f.emit("session_start");
  await f.emit("before_agent_start");
  // Pi 0.99.2 connects codemode MCP servers in the background until a script or resource tool needs them.
  await f.emit("tool_call", { toolName: "codemode", input: { code: "searchTools('present')" } });

  expect(f.notices.filter((message) => message.startsWith("MCP failed"))).toEqual([]);
  expect([...f.tools.keys()].filter((name) => name.startsWith("mcp__"))).toEqual(["mcp__kintsugi__present", "mcp__kintsugi__fail"]);
  const present = f.tools.get("mcp__kintsugi__present")!;
  expect(present.exposure).toBe("deferred");
  expect(present.namespace).toEqual({ name: "mcp__kintsugi", aliases: ["kintsugi"] });
  const updates: string[] = [];
  const result = await present.execute("call", { kind: "browser" }, undefined, (update) => {
    updates.push(update.content[0]!.type === "text" ? update.content[0]!.text : "image");
  }, undefined!);
  expect(updates).toEqual(["Opening"]);
  expect(result.content).toEqual([{ type: "text", text: "Presented browser" }]);
  // Native MCP exposes protocol errors as error results, including to codemode scripts.
  const failed = await f.tools.get("mcp__kintsugi__fail")!.execute("call", {}, undefined, undefined, undefined!);
  expect(failed.structuredContent).toMatchObject({ isError: true, content: [{ type: "text", text: "deliberate failure" }] });

});
