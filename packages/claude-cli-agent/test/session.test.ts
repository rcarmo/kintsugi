import { expect, test } from "bun:test";
import { join } from "node:path";

test("marks only Kintsugi MCP alwaysLoad so Claude waits at startup, keeping the credential off the command line", async () => {
  const source = join(import.meta.dir, "../src/server/session.ts");
  const child = Bun.spawn([process.execPath, "-e", `
    import { expect, mock } from "bun:test";
    const workspace = await import("@kintsugi/workspace");
    const calls = [];
    mock.module("@kintsugi/workspace", () => ({ ...workspace, execWorkspaceShell: async (...args) => { calls.push(args); return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 }; } }));
    const { prepareClaudeSession, claudeMcpConfigPath, claudeFileLinkInstructions } = await import(${JSON.stringify(source)});
    const mcp = { url: "http://127.0.0.1:2988/mcp", token: "private-bearer-token" };
    const session = { id: "session", directory: "/session", turnSignalCommand: "/session/signal.sh" };
    const instructions = "Full Kintsugi instructions\\n" + "x".repeat(12000);
    expect(await prepareClaudeSession("workspace", session, { ...mcp, instructions })).toEqual({});
    expect(calls).toHaveLength(1);
    const [workspaceId, command, options] = calls[0];
    expect(workspaceId).toBe("workspace");
    expect(command).toContain("umask 077");
    expect(command).toContain(claudeMcpConfigPath(session));
    expect(command).not.toContain(mcp.token);
    expect(command).toContain("/session/instructions.txt");
    const count = Number(command.match(/count=(\\d+)/)[1]);
    const input = Buffer.from(options.stdin);
    expect(input.subarray(count).toString()).toBe(instructions + "\\n\\n" + claudeFileLinkInstructions);
    expect(JSON.parse(input.subarray(0, count).toString())).toEqual({ mcpServers: { "kintsugi": {
      type: "http", url: mcp.url, headers: { Authorization: "Bearer " + mcp.token }, alwaysLoad: true,
    } } });
  `], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
