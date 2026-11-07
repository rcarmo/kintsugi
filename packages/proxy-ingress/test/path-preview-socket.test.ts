import { expect, test } from "bun:test";
import { createWorkspacePathPreviews } from "../src/ingress/path-preview.ts";

test("scoped preview WebSockets preserve subprotocols, greeting order and binary slices without management credentials", async () => {
  const seen: Headers[] = [];
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
    seen.push(request.headers);
    if (server.upgrade(request, { headers: { "sec-websocket-protocol": "fixture-hmr" } })) return;
    return new Response(null, { status: 400 });
  }, websocket: { open(socket) { socket.send("greeting"); }, message(socket, value) { socket.send(value); } } });
  const previews = createWorkspacePathPreviews({ publicOrigin: () => "https://dynamic.example", resolveWorkspace() {}, resolveApp() {}, resolvePort: () => ({ kind: "http", target: new URL(backend.url) }) });
  const entry = await previews.entry(new Request("https://dynamic.example/"), { workspaceId: "one", appKey: "port-3152" }, "/");
  const capability = (await entry.text()).match(/\/~preview\/[a-zA-Z0-9_-]{43}\//)![0];
  const request = new Request(`https://dynamic.example${capability}port-3152/socket`, { headers: { origin: "null", cookie: "management=private", authorization: "Bearer private", "sec-websocket-protocol": "fixture-hmr" } });
  const prepared = await previews.websocket(request);
  if (!prepared || prepared instanceof Response) throw new Error("Expected an authorized preview socket");
  const received = Promise.withResolvers<void>();
  const messages: Array<string | Uint8Array> = [];
  const socket = { send(value: string | Uint8Array) { messages.push(value); if (value instanceof Uint8Array) received.resolve(); }, close() {} };
  try {
    expect(prepared.headers.get("sec-websocket-protocol")).toBe("fixture-hmr");
    await prepared.session.open?.(socket);
    prepared.session.message?.(socket, Buffer.from([1, 2, 3, 4]).subarray(1, 3));
    await received.promise;
    expect(messages).toEqual(["greeting", new Uint8Array([2, 3])]);
    expect(seen[0]!.get("cookie")).toBeNull();
    expect(seen[0]!.get("authorization")).toBeNull();
    expect(seen[0]!.get("origin")).toBe(`http://localhost:${backend.port}`);
    previews.removeWorkspace("one");
    expect((await previews.websocket(request)) instanceof Response).toBe(true);
  } finally { prepared.cancel(); backend.stop(true); }
});
