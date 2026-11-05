import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the workspace shell mock and the module's credential and turn state.
async function scenario(script: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-turn-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const workspace = await import("@kintsugi/workspace");
      const idle = async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 });
      mock.module("@kintsugi/workspace", () => ({ ...workspace, execWorkspaceShell: idle, execWorkspaceCommand: idle }));
      const { configureAgentMcp, handleAgentMcpRequest, prepareCliAgentConnection, revokeAgentMcp } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/mcp.ts"))});
      const { registerAgentTurnSettler } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/turn-lifecycle.ts"))});
      const { subscribeWorkspaceAgentBusy } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/workspace-agent-busy.ts"))});
      const log = [];
      configureAgentMcp({ on() {}, emit: async (name, payload) => { log.push(name + ":" + payload.agentId); } });
      subscribeWorkspaceAgentBusy(({ agentKey, busy }) => log.push((busy ? "busy:" : "idle:") + agentKey.replace("agent:", "")));
      const agentId = crypto.randomUUID();
      const settles = [];
      registerAgentTurnSettler(async (workspaceId, id, signal, reason) => {
        expect([workspaceId, id]).toEqual(["workspace", agentId]);
        const settled = Promise.withResolvers();
        settles.push({ signal, reason, settle: settled.resolve });
        await settled.promise;
      });
      const { token } = await prepareCliAgentConnection("workspace", agentId);
      log.length = 0;
      const signal = (boundary) => handleAgentMcpRequest(new Request("http://127.0.0.1:2988/agent-turn-" + boundary, { method: "POST", headers: { Authorization: "Bearer " + token } }), "workspace");
      const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
      ${script}
    `], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, KINTSUGI_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("a finished turn is answered at once but only ends once the agent's history has settled", () => scenario(`
  expect((await signal("started")).status).toBe(204);
  // Claude writes its final history only after the finished hook returns.
  expect((await signal("finished")).status).toBe(204);
  await tick();
  expect(log).toEqual(["busy:" + agentId]);
  settles[0].settle();
  await tick();
  expect(log).toEqual(["busy:" + agentId, "idle:" + agentId, "workspace_agent_turn_finished:" + agentId]);
`));

test("a new turn or closing the agent abandons a turn that is still settling", () => scenario(`
  await signal("finished");
  await signal("started");
  expect(settles[0].signal.aborted).toBe(true);
  settles[0].settle();
  await signal("finished");
  await revokeAgentMcp("workspace", agentId);
  expect(settles[1].signal.aborted).toBe(true);
  settles[1].settle();
  await tick();
  expect(log).toEqual(["busy:" + agentId]);
`));

test("a failed turn propagates its reason and waits for settlement before ending", () => scenario(`
  await signal("started");
  expect((await signal("failed")).status).toBe(204);
  expect(settles[0].reason).toBe("stopFailure");
  expect(log).toEqual(["busy:" + agentId]);
  settles[0].settle();
  await tick();
  expect(log).toEqual(["busy:" + agentId, "idle:" + agentId, "workspace_agent_turn_finished:" + agentId]);
`));
