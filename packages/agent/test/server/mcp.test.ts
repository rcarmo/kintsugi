import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineWorkspaceTool } from "../../src/server/workspace-tool.ts";
import { Type } from "typebox";
import { createAgentMcpCredentials } from "../../src/server/mcp-credentials.ts";
import { createAgentMcpServer } from "../../src/server/mcp-server.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-mcp-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const credentials = createAgentMcpCredentials(directory);
  const identity = { workspaceId: "workspace-a", agentId: crypto.randomUUID() };
  const token = credentials.issue(identity);
  const invocations: string[] = [];
  let cancelled = false;
  let instructionPreparations = 0;
  const endpoint = createAgentMcpServer({
    authenticate: credentials.authenticate,
    instructions: (agent) => { instructionPreparations++; return `Instructions for ${agent.workspaceId}`; },
    tools: (agent) => [defineWorkspaceTool({
      name: "present", label: "Present", description: "Present work",
      parameters: Type.Object({ kind: Type.Literal("browser") }, { additionalProperties: false }),
      requiresAgentIdentity: true,
      execute: async (_id, _input, _signal, _update, caller) => { expect(caller).toEqual({ agentId: agent.agentId }); invocations.push(caller!.agentId); return { content: [{ type: "text", text: agent.workspaceId }], details: {} }; },
    }), ...(agent.workspaceId === "workspace-b" ? [defineWorkspaceTool({
      name: "scoped_probe", label: "Probe", description: "Scoped test capability", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "settings" }], details: {} }),
    })] : []), defineWorkspaceTool({
      name: "wait_for_user", label: "Wait", description: "Wait for human input", parameters: Type.Object({}),
      execute: async (_id, _args, signal, update) => {
        update?.({ content: [{ type: "text", text: "Waiting" }], details: {} });
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
        return { content: [{ type: "text", text: "Cancelled" }], details: {} };
      },
    })],
  });
  const server = Bun.serve({ port: 0, fetch: (request) => endpoint.fetch(request) });
  cleanup.push(async () => { await endpoint.revoke({ workspaceId: identity.workspaceId }); await endpoint.revoke({ workspaceId: "workspace-b" }); server.stop(true); });
  const url = new URL("/mcp", server.url);
  async function connect(bearer = token) {
    const client = new Client({ name: "test", version: "1.0" });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } });
    await client.connect(transport);
    cleanup.push(() => client.close());
    return { client, transport };
  }
  return { directory, credentials, identity, token, invocations, endpoint, url, connect, cancelled: () => cancelled, instructionPreparations: () => instructionPreparations };
}

test("credentials persist only hashes, resume after restart, and are revocable per agent", async () => {
  const f = await fixture();
  const second = { ...f.identity, agentId: crypto.randomUUID() };
  const secondToken = f.credentials.issue(second);
  const forged = `${Buffer.from(JSON.stringify(second)).toString("base64url")}.${f.token.split(".")[1]}`;
  expect(f.credentials.authenticate(forged)).toBeUndefined();
  const disk = await readFile(join(f.directory, "workspaces", f.identity.workspaceId, "metadata", "agent-mcp.json"), "utf8");
  expect(disk).not.toContain(f.token);
  expect(createAgentMcpCredentials(f.directory).authenticate(f.token)).toEqual(f.identity);
  f.credentials.revoke(f.identity);
  expect(f.credentials.authenticate(f.token)).toBeUndefined();
  expect(f.credentials.authenticate(secondToken)).toEqual(second);
  f.credentials.revokeWorkspace(f.identity.workspaceId);
  expect(f.credentials.authenticate(secondToken)).toBeUndefined();
  for (const token of ["", "garbage", "../x", `${Buffer.from('{"workspaceId":"../../escape","agentId":"abc"}').toString("base64url")}.${"a".repeat(43)}`]) expect(f.credentials.authenticate(token)).toBeUndefined();
});

test("Streamable HTTP initialization carries guidance; tools are scoped and validated", async () => {
  const f = await fixture();
  const { client } = await f.connect();
  expect(client.getInstructions()).toBe("Instructions for workspace-a");
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["present", "wait_for_user"]);
  expect(await client.callTool({ name: "present", arguments: { kind: "browser" } })).toMatchObject({ content: [{ type: "text", text: "workspace-a" }] });
  expect(f.invocations).toEqual([f.identity.agentId]);
  await expect(client.callTool({ name: "scoped_probe" })).rejects.toThrow("Unknown tool");
  await expect(client.callTool({ name: "present", arguments: { kind: "browser", workspaceId: "someone-else" } })).rejects.toThrow("Invalid tool arguments");
  const other = await f.connect(f.credentials.issue({ workspaceId: "workspace-b", agentId: crypto.randomUUID() }));
  expect((await other.client.listTools()).tools.map((tool) => tool.name)).toContain("scoped_probe");
});

test("bearer authorization applies on every request; a session ID cannot impersonate an agent", async () => {
  const f = await fixture();
  const { client, transport } = await f.connect();
  expect((await fetch(f.url)).status).toBe(401);
  const otherToken = f.credentials.issue({ ...f.identity, agentId: crypto.randomUUID() });
  expect((await fetch(f.url, { headers: { Authorization: `Bearer ${otherToken}`, "mcp-session-id": transport.sessionId! } })).status).toBe(404);
  expect((await fetch(f.url, { headers: { Authorization: `Bearer ${f.token}`, Origin: "http://attacker.test" } })).status).toBe(403);
  expect((await f.endpoint.fetch(new Request(f.url, { headers: { Authorization: `Bearer ${f.token}` } }), "workspace-b")).status).toBe(401);
  f.credentials.revoke(f.identity);
  await expect(client.listTools()).rejects.toThrow();
});

test("progress and cancellation cross the HTTP transport", async () => {
  const f = await fixture();
  const { client } = await f.connect();
  const abort = new AbortController();
  const progress: string[] = [];
  const call = client.callTool({ name: "wait_for_user", arguments: {} }, undefined, { signal: abort.signal, onprogress: (update) => { progress.push(update.message!); abort.abort(); } });
  await expect(call).rejects.toThrow();
  for (let attempt = 0; attempt < 50 && !f.cancelled(); attempt++) await Bun.sleep(10);
  expect(progress).toEqual(["Waiting"]);
  expect(f.cancelled()).toBe(true);
});

test("native-prompt credentials omit MCP guidance while preserving tools and surviving credential-store reload", async () => {
  const f = await fixture();
  const identity = { ...f.identity, agentId: crypto.randomUUID(), instructionDelivery: "system-prompt" as const };
  const token = f.credentials.issue(identity);
  expect(createAgentMcpCredentials(f.directory).authenticate(token)).toEqual(identity);
  const { client } = await f.connect(token);
  expect(client.getInstructions()).toBeUndefined();
  expect(f.instructionPreparations()).toBe(0);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["present", "wait_for_user"]);
  expect(await client.callTool({ name: "present", arguments: { kind: "browser" } })).toMatchObject({ content: [{ type: "text", text: "workspace-a" }] });
  const forged = `${Buffer.from(JSON.stringify({ ...identity, instructionDelivery: undefined })).toString("base64url")}.${token.split(".")[1]}`;
  expect(f.credentials.authenticate(forged)).toBeUndefined();
});

test("plan tools use authenticated MCP Agent identity and reject cross-Agent target fields", async () => {
  const previous = process.env.KINTSUGI_DATA_DIR;
  const f = await fixture(); process.env.KINTSUGI_DATA_DIR = f.directory;
  const { createAgentPlanTool, agentPlanStore } = await import("../../src/server/plan.ts");
  const endpoint = createAgentMcpServer({ authenticate: f.credentials.authenticate, instructions: () => "Plan fixture", tools: identity => [createAgentPlanTool(identity.workspaceId, identity.agentId)] });
  const server = Bun.serve({ port: 0, fetch: request => endpoint.fetch(request) });
  const clients: Client[] = [];
  try {
    async function connect(token: string) {
      const client = new Client({ name: "plan-fixture", version: "1.0" }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    }
    const first = await connect(f.token);
    const secondIdentity = { ...f.identity, agentId: crypto.randomUUID() };
    const second = await connect(f.credentials.issue(secondIdentity));
    await first.callTool({ name: "plan", arguments: { action: "write", markdown: "- [-] Agent A only" } });
    await second.callTool({ name: "plan", arguments: { action: "write", markdown: "- [x] Agent B only" } });
    expect(agentPlanStore().read(f.identity.workspaceId, f.identity.agentId).markdown).toBe("- [-] Agent A only");
    expect(agentPlanStore().read(secondIdentity.workspaceId, secondIdentity.agentId).markdown).toBe("- [x] Agent B only");
    await expect(first.callTool({ name: "plan", arguments: { action: "reset", agentId: secondIdentity.agentId } })).rejects.toThrow("Invalid tool arguments");
    f.credentials.revoke(f.identity);
    await expect(first.callTool({ name: "plan", arguments: { action: "reset" } })).rejects.toThrow();
    expect(agentPlanStore().read(f.identity.workspaceId, f.identity.agentId).markdown).toBe("- [-] Agent A only");
  } finally {
    await Promise.all(clients.map(client => client.close())); await endpoint.revoke({ workspaceId: f.identity.workspaceId }); server.stop(true);
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous;
  }
});
