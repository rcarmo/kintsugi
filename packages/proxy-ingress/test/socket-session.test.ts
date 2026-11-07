import { expect, test } from "bun:test";
import { createWorkspaceSocketSession } from "../src/ingress/socket-session.ts";
import { maxSocketBufferedBytes } from "../src/ingress/websocket.ts";

test("management-owned display streams buffer the greeting and forward only selected buffer bytes", async () => {
  const received = Promise.withResolvers<Uint8Array>();
  const headers: Headers[] = [];
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { headers.push(request.headers); if (server.upgrade(request)) return; return new Response(null, { status: 400 }); },
    websocket: { open(socket) { socket.send("RFB 003.008\n"); }, message(socket, message) { socket.send(message); } },
  });
  const messages: Array<string | Uint8Array> = [];
  const socket = { send(data: string | Uint8Array) { messages.push(data); if (data instanceof Uint8Array) received.resolve(data); }, close() {} };
  const session = createWorkspaceSocketSession(async () => ({ kind: "http", target: new URL(backend.url) }));
  try {
    // Bun delivers Buffer views, whose .buffer can contain unrelated pooled bytes.
    session.message!(socket, Buffer.from([1, 2, 3, 4]).subarray(1, 3));
    await session.open!(socket);
    expect(await received.promise).toEqual(new Uint8Array([2, 3]));
    expect(messages).toEqual(["RFB 003.008\n", new Uint8Array([2, 3])]);
    expect(headers[0]!.get("cookie")).toBeNull();
    expect(headers[0]!.get("origin")).toBe(`http://localhost:${backend.port}`);
  } finally { session.close?.({ send() {}, close() {} }); backend.stop(true); }
});

test("closing while resolving a display backend never opens an orphan upstream", async () => {
  let connections = 0;
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { connections++; return new Response(); } });
  const ready = Promise.withResolvers<import("@kintsugi/shared").WorkspaceHttpAppBackend>();
  const session = createWorkspaceSocketSession(() => ready.promise);
  try {
    const opening = session.open!({ send() {}, close() {} });
    session.close!({ send() {}, close() {} });
    ready.resolve({ kind: "http", target: new URL(backend.url) });
    await opening;
    expect(connections).toBe(0);
  } finally { backend.stop(true); }
});

test("display input queues are bounded before the upstream is ready", () => {
  const codes: Array<number | undefined> = [];
  const session = createWorkspaceSocketSession(async () => { throw new Error("must not connect"); });
  session.message!({ send() {}, close(code) { codes.push(code); } }, new Uint8Array(maxSocketBufferedBytes + 1));
  expect(codes).toEqual([1013]);
  session.close?.({ send() {}, close() {} });
});

test("display upstream failure rejects setup instead of escaping an asynchronous callback", async () => {
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 403 }) });
  const session = createWorkspaceSocketSession(async () => ({ kind: "http", target: new URL(backend.url) }));
  try { await expect(session.open!({ send() {}, close() {} })).rejects.toThrow("Workspace display WebSocket"); }
  finally { session.close?.({ send() {}, close() {} }); backend.stop(true); }
});

test("display output checks Bun's downstream buffered-byte counter before queueing more data", async () => {
  const closed = Promise.withResolvers<number | undefined>();
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); },
    websocket: { open(socket) { socket.send("RFB 003.008\n"); }, message() {} },
  });
  const socket = { getBufferedAmount: () => maxSocketBufferedBytes, send() { throw new Error("must not enqueue"); }, close(code?: number) { closed.resolve(code); } };
  const session = createWorkspaceSocketSession(async () => ({ kind: "http", target: new URL(backend.url) }));
  try { await session.open!(socket); expect(await closed.promise).toBe(1013); }
  finally { session.close?.(socket); backend.stop(true); }
});
