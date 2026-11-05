import { expect, spyOn, test } from "bun:test";
import type { WorkspaceServerSocketSession } from "@kintsugi/shared";
import { openWorkspaceSocket } from "../src/server/workspace-socket.ts";

test.each(["synchronous", "asynchronous"] as const)("%s terminal-open failure closes only its WebSocket and leaves HTTP healthy", async (kind) => {
  const failure = new Error("Unexpected terminal process state: exited  1 0");
  const log = spyOn(console, "error").mockImplementation(() => {});
  const session: WorkspaceServerSocketSession = {
    open: kind === "synchronous" ? () => { throw failure; } : async () => { throw failure; },
  };
  const server = Bun.serve<WorkspaceServerSocketSession>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (request.headers.get("upgrade") === "websocket") {
        if (server.upgrade(request, { data: session })) return;
        return new Response("Upgrade failed", { status: 400 });
      }
      return new Response("healthy");
    },
    websocket: { open(socket) { void openWorkspaceSocket(socket.data, socket); }, message() {} },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/terminal`);
  try {
    const closed = await new Promise<{ code: number; reason: string }>(resolve => {
      socket.addEventListener("close", event => resolve({ code: event.code, reason: event.reason }), { once: true });
    });
    expect(closed).toEqual({ code: 1011, reason: "Workspace connection failed" });
    expect(log).toHaveBeenCalledWith("Workspace WebSocket initialization failed", failure);
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("healthy");
  } finally {
    socket.close();
    await server.stop(true);
    log.mockRestore();
  }
});

test("successful asynchronous socket initialization remains open", async () => {
  let opened = false;
  const closes: number[] = [];
  const socket = { send() {}, close(code?: number) { closes.push(code ?? 1000); } };
  await openWorkspaceSocket({ async open(connected) { await Bun.sleep(0); expect(connected).toBe(socket); opened = true; } }, socket);
  expect(opened).toBe(true);
  expect(closes).toEqual([]);
});
