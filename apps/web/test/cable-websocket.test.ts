import { createKintsugiEventBus } from "@kintsugi/core";
import { CableTopics, cableCommandBodyLimit, decodeCableServerMessage, type CableChannelAdapter, type CableClientMessage, type CableServerMessage } from "@kintsugi/shared";
import { managementOriginRejection } from "@kintsugi/proxy-ingress";
import { expect, test } from "bun:test";
import { startProxyIngress } from "../../../images/system/src/local-ingress.ts";
import { createCableServer, type CableSocketData } from "../src/server/cable.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

function fixture(channels: CableChannelAdapter[] = []) {
  const cable = createCableServer({ registry: createWorkspaceRegistry(), events: createKintsugiEventBus(), channels, logError: () => {} });
  const server = Bun.serve<CableSocketData>({ hostname: "127.0.0.1", port: 0, idleTimeout: 255,
    fetch(request, server) {
      const rejected = managementOriginRejection(request, server.requestIP(request)?.address);
      if (rejected) return rejected;
      if (new URL(request.url).pathname !== "/cable") return new Response("Not found", { status: 404 });
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket"
        && server.upgrade(request, { data: { kind: "cable", connectionId: crypto.randomUUID() } })) return;
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      perMessageDeflate: true,
      open(socket) { cable.open(socket, socket.data); },
      message(socket, message) { cable.message(socket, message); },
      close(socket) { cable.close(socket); },
    },
  });
  return { cable, server, url: `http://127.0.0.1:${server.port}` };
}

async function open(url: string, headers: Record<string, string> = { origin: url }) {
  // SAFETY: Protocol tests run in Bun, whose WebSocket constructor accepts headers.
  const Client = WebSocket as typeof WebSocket & (new (url: string, options: Bun.WebSocketOptions) => WebSocket);
  const socket = new Client(url.replace(/^http/, "ws") + "/cable", { headers, proxy: "" });
  const queued: CableServerMessage[] = [];
  let notify: (() => void) | undefined;
  const closed = Promise.withResolvers<CloseEvent>();
  socket.addEventListener("close", event => closed.resolve(event));
  socket.addEventListener("message", event => {
    queued.push(decodeCableServerMessage(event.data));
    notify?.();
    notify = undefined;
  });
  const next = async () => {
    if (!queued.length) await new Promise<void>(resolve => { notify = resolve; });
    return queued.shift()!;
  };
  const welcome = await next();
  if (welcome.type !== "welcome") throw new Error("Missing welcome");
  return { socket, next, closed: closed.promise, id: welcome.connectionId,
    command(message: CableClientMessage | CableClientMessage[]) { socket.send(JSON.stringify(message)); },
  };
}

async function waitClosed(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 100 && f.cable.stats().sockets > 0; i++) await Bun.sleep(10);
  expect(f.cable.stats().sockets).toBe(0);
}

test("WebSocket commands preserve ordered snapshots, deltas and cancellation", async () => {
  let publish!: (value: string) => void;
  let released = 0;
  const f = fixture([{ name: "shell", subscribe(_identifier, listener) {
    publish = listener;
    listener("initial λ\nstate");
    return { unsubscribe() { released++; } };
  } }]);
  try {
    const stream = await open(f.url);
    const identifier = CableTopics.shell();
    stream.command({ command: "subscribe", identifier, subscriptionId: "first" });
    expect(await stream.next()).toEqual({ type: "confirm_subscription", identifier, subscriptionId: "first", html: "initial λ\nstate" });
    publish("delta");
    expect(await stream.next()).toEqual({ type: "turbo_stream", identifier, subscriptionId: "first", html: "delta" });
    stream.command({ command: "unsubscribe", identifier, subscriptionId: "first" });
    stream.command({ command: "subscribe", identifier, subscriptionId: "second" });
    expect(await stream.next()).toMatchObject({ type: "confirm_subscription", subscriptionId: "second" });
    expect(released).toBe(1);
    stream.socket.close();
    await waitClosed(f);
    expect(released).toBe(2);
  } finally { f.server.stop(true); }
});

test("WebSocket disconnect releases subscriptions; reconnect obtains fresh snapshots and preserves shown digests", async () => {
  const received: Array<{ channel: string; shown: unknown }> = [];
  let released = 0;
  let revision = 1;
  const channels = ["shell", "agent"].map<CableChannelAdapter>(name => ({ name, subscribe(_identifier, listener, _events, shown) {
    received.push({ channel: name, shown });
    listener(`${name}-${revision}`);
    return { unsubscribe() { released++; } };
  } }));
  const f = fixture(channels);
  const batch: CableClientMessage[] = [
    { command: "visibility", visibility: { surfaceKeys: [] } },
    { command: "subscribe", identifier: CableTopics.shell(), subscriptionId: "shell", shown: { sidebar: "digest" } },
    { command: "subscribe", identifier: CableTopics.agent("workspace", "conversation"), subscriptionId: "agent" },
  ];
  try {
    const first = await open(f.url);
    first.command(batch);
    expect(await first.next()).toMatchObject({ type: "confirm_subscription", subscriptionId: "shell", html: "shell-1" });
    expect(await first.next()).toMatchObject({ type: "confirm_subscription", subscriptionId: "agent", html: "agent-1" });
    expect(received).toEqual([{ channel: "shell", shown: { sidebar: "digest" } }, { channel: "agent", shown: undefined }]);
    first.socket.close();
    await waitClosed(f);
    expect(released).toBe(2);
    revision++;
    const second = await open(f.url);
    expect(second.id).not.toBe(first.id);
    second.command(batch.map(message => message.command === "subscribe" ? { ...message, shown: undefined } : message));
    expect(await second.next()).toMatchObject({ type: "confirm_subscription", subscriptionId: "shell", html: "shell-2" });
    expect(await second.next()).toMatchObject({ type: "confirm_subscription", subscriptionId: "agent", html: "agent-2" });
    expect(received.slice(2)).toEqual([{ channel: "shell", shown: undefined }, { channel: "agent", shown: undefined }]);
    second.socket.close();
    await waitClosed(f);
    expect(released).toBe(4);
  } finally { f.server.stop(true); }
});

test("WebSocket upgrades reject missing, null, foreign and wrong-scheme origins", async () => {
  const f = fixture();
  try {
    for (const origin of [undefined, "https://untrusted.example", "null", f.url.replace("http:", "https:")]) {
      const headers = new Headers({ upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" });
      if (origin !== undefined) headers.set("origin", origin);
      expect((await fetch(`${f.url}/cable`, { headers })).status).toBe(403);
    }
    expect(f.cable.stats().sockets).toBe(0);
  } finally { f.server.stop(true); }
});

test("WebSocket accepts HTTPS terminated by a trusted loopback proxy", async () => {
  const f = fixture();
  try {
    const stream = await open(f.url, { origin: f.url.replace("http:", "https:"), "x-forwarded-proto": "https" });
    stream.command({ command: "subscribe", identifier: CableTopics.shell(), subscriptionId: "missing" });
    expect(await stream.next()).toMatchObject({ type: "reject_subscription", subscriptionId: "missing" });
    stream.socket.close();
    await waitClosed(f);
  } finally { f.server.stop(true); }
});

test("Cable has no SSE or HTTP command transport", async () => {
  const f = fixture();
  try {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${f.url}/cable`, { method, headers: { origin: f.url, accept: "text/event-stream" } });
      expect(response.status).toBe(426);
      expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    }
    expect((await fetch(`${f.url}/cable/expired`, { method: "POST", headers: { origin: f.url } })).status).toBe(404);
  } finally { f.server.stop(true); }
});

test("WebSocket malformed commands fail explicitly and oversized commands close before execution", async () => {
  const f = fixture();
  try {
    const stream = await open(f.url);
    stream.socket.send("not json");
    expect((await stream.next()).type).toBe("error");
    stream.socket.send(JSON.stringify({ command: "subscribe", identifier: CableTopics.shell(), subscriptionId: "large", padding: "λ".repeat(cableCommandBodyLimit / 2) }));
    expect((await stream.closed).code).toBe(1009);
    await waitClosed(f);
    expect(f.cable.stats().subscriptions).toEqual({});
  } finally { f.server.stop(true); }
});

test("Cable traverses System proxy ingress with HTTPS origin checks and immediate welcome intact", async () => {
  const f = fixture([{ name: "shell", subscribe(_identifier, listener) { listener("proxy snapshot"); return { unsubscribe() {} }; } }]);
  const config = { origin: "https://cable-host.local", previewPorts: { start: 41000, end: 41009 } };
  const proxy = startProxyIngress(() => f.server.port!, () => config, 0);
  try {
    const stream = await open(`http://127.0.0.1:${proxy.port}`, { host: "cable-host.local", origin: config.origin });
    stream.command({ command: "subscribe", identifier: CableTopics.shell(), subscriptionId: "proxy" });
    expect(await stream.next()).toMatchObject({ type: "confirm_subscription", subscriptionId: "proxy", html: "proxy snapshot" });
    stream.socket.close();
    await waitClosed(f);
    for (const origin of ["null", "https://foreign.example", "http://cable-host.local", ""]) {
      const headers = new Headers({ host: "cable-host.local", upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" });
      if (origin) headers.set("origin", origin);
      const response = await fetch(`http://127.0.0.1:${proxy.port}/cable`, { headers });
      expect(response.status).toBe(502); // Proxy refuses a rejected upstream upgrade.
      expect(f.cable.stats().sockets).toBe(0);
    }
  } finally { proxy.stop(true); f.server.stop(true); }
});
