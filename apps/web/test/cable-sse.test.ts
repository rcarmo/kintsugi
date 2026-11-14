import { createKintsugiEventBus } from "@kintsugi/core";
import { CableTopics, decodeCableServerMessage, type CableChannelAdapter, type CableClientMessage, type CableServerMessage } from "@kintsugi/shared";
import { managementOriginRejection } from "@kintsugi/proxy-ingress";
import { expect, test } from "bun:test";
import { createCableServer } from "../src/server/cable.ts";
import { createCableSseTransport } from "../src/server/cable-sse.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

function fixture(channels: CableChannelAdapter[] = []) {
  const cable = createCableServer({ registry: createWorkspaceRegistry(), events: createKintsugiEventBus(), channels, logError: () => {} });
  const handle = createCableSseTransport(cable);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255,
    async fetch(request, server) {
      return managementOriginRejection(request, server.requestIP(request)?.address)
        ?? await handle(request) ?? new Response("Not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const command = (id: string, message: CableClientMessage | CableClientMessage[] | { padding: string }) => fetch(`${url}/cable/${id}`, {
    method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(message),
  });
  return { cable, handle, server, url, command };
}

function messages(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let pending = "";
  return async (): Promise<CableServerMessage> => {
    for (;;) {
      const boundary = pending.indexOf("\n\n");
      if (boundary !== -1) {
        const data = pending.slice(0, boundary).slice("data: ".length);
        pending = pending.slice(boundary + 2);
        return decodeCableServerMessage(data);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("Stream ended before a message");
      pending += decoder.decode(value, { stream: true });
    }
  };
}

async function open(f: ReturnType<typeof fixture>) {
  const abort = new AbortController();
  const response = await fetch(`${f.url}/cable`, { method: "POST", headers: { origin: f.url, accept: "text/event-stream" }, signal: abort.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("text/event-stream");
  expect(response.headers.get("cache-control")).toContain("no-transform");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  const reader = response.body!.getReader();
  const next = messages(reader);
  const welcome = await next();
  if (welcome.type !== "welcome") throw new Error("Missing welcome");
  return { abort, reader, next, id: welcome.connectionId };
}

async function waitClosed(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 100 && f.cable.stats().sockets > 0; i++) await Bun.sleep(10);
  expect(f.cable.stats().sockets).toBe(0);
}

test("SSE and HTTP commands preserve ordered snapshots, deltas and cancellation", async () => {
  let publish!: (value: string) => void;
  let released = 0;
  const f = fixture([{ name: "shell", subscribe(_identifier, listener) {
    publish = listener;
    listener("initial λ\nstate");
    return { unsubscribe() { released++; } };
  } }]);
  try {
    const stream = await open(f);
    const identifier = CableTopics.shell();
    expect((await f.command(stream.id, { command: "subscribe", identifier, subscriptionId: "first" })).status).toBe(204);
    expect(await stream.next()).toEqual({ type: "confirm_subscription", identifier, subscriptionId: "first", html: "initial λ\nstate" });
    publish("delta");
    expect(await stream.next()).toEqual({ type: "turbo_stream", identifier, subscriptionId: "first", html: "delta" });
    expect((await f.command(stream.id, { command: "unsubscribe", identifier, subscriptionId: "first" })).status).toBe(204);
    expect(released).toBe(1);
    stream.abort.abort();
    await waitClosed(f);
    expect(released).toBe(1);
    expect((await f.command(stream.id, { command: "pong" })).status).toBe(410);
  } finally { f.server.stop(true); }
});

test("SSE abort releases subscriptions; reconnect obtains a fresh authoritative snapshot", async () => {
  let revision = 1;
  let released = 0;
  const f = fixture([{ name: "shell", subscribe(_identifier, listener) {
    listener(`revision-${revision}`);
    return { unsubscribe() { released++; } };
  } }]);
  try {
    const first = await open(f);
    await f.command(first.id, { command: "subscribe", identifier: CableTopics.shell(), subscriptionId: "old" });
    expect((await first.next()).type).toBe("confirm_subscription");
    first.abort.abort();
    await waitClosed(f);
    expect(released).toBe(1);
    revision++;
    const second = await open(f);
    expect(second.id).not.toBe(first.id);
    await f.command(second.id, { command: "subscribe", identifier: CableTopics.shell(), subscriptionId: "new" });
    expect(await second.next()).toMatchObject({ type: "confirm_subscription", subscriptionId: "new", html: "revision-2" });
    second.abort.abort();
    await waitClosed(f);
    expect(released).toBe(2);
  } finally { f.server.stop(true); }
});

test("SSE setup and commands reject missing and foreign origins", async () => {
  const f = fixture();
  try {
    for (const origin of [undefined, "https://untrusted.example", "null"]) {
      const headers = new Headers();
      if (origin !== undefined) headers.set("origin", origin);
      expect((await fetch(`${f.url}/cable`, { method: "POST", headers })).status).toBe(403);
    }
    expect(f.cable.stats().sockets).toBe(0);
    const stream = await open(f);
    expect((await fetch(`${f.url}/cable/${stream.id}`, {
      method: "POST", headers: { origin: "https://untrusted.example", "content-type": "application/json" },
      body: JSON.stringify({ command: "subscribe", identifier: CableTopics.shell(), subscriptionId: "forged" }),
    })).status).toBe(403);
    expect(f.cable.stats().subscriptions).toEqual({});
    stream.abort.abort();
    await waitClosed(f);
  } finally { f.server.stop(true); }
});

test("SSE accepts HTTPS terminated by a trusted loopback proxy", async () => {
  const f = fixture();
  try {
    const abort = new AbortController();
    const response = await fetch(`${f.url}/cable`, {
      method: "POST", signal: abort.signal,
      headers: { origin: f.url.replace("http:", "https:"), "x-forwarded-proto": "https" },
    });
    expect(response.status).toBe(200);
    expect((await messages(response.body!.getReader())()).type).toBe("welcome");
    abort.abort();
    await waitClosed(f);
  } finally { f.server.stop(true); }
});

test("SSE controls reject unsupported methods, media types, large bodies and expired IDs", async () => {
  const f = fixture();
  try {
    expect((await fetch(`${f.url}/cable`)).status).toBe(405);
    expect((await f.command("expired", { command: "pong" })).status).toBe(410);
    const stream = await open(f);
    expect((await fetch(`${f.url}/cable/${stream.id}`, { method: "POST", headers: { origin: f.url }, body: "bad" })).status).toBe(415);
    expect((await f.command(stream.id, { padding: "x".repeat(65 * 1024) })).status).toBe(413);
    expect((await f.command(stream.id, { command: "pong" })).status).toBe(204);
    stream.abort.abort();
    await waitClosed(f);
  } finally { f.server.stop(true); }
});

test("slow SSE consumers are closed instead of accumulating event history", async () => {
  let publish!: (value: string) => void;
  let released = 0;
  const f = fixture([{ name: "shell", subscribe(_identifier, listener) {
    publish = listener; listener("initial");
    return { unsubscribe() { released++; } };
  } }]);
  try {
    // Keep the response in-process so a network reader cannot drain its queue.
    const response = (await f.handle(new Request(`${f.url}/cable`, { method: "POST" })))!;
    const reader = response.body!.getReader();
    const next = messages(reader);
    const welcome = await next();
    if (welcome.type !== "welcome") throw new Error("Missing welcome");
    await f.handle(new Request(`${f.url}/cable/${welcome.connectionId}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "subscribe", identifier: CableTopics.shell(), subscriptionId: "first" }),
    }));
    await next();
    publish("x".repeat(1024 * 1024));
    publish("would overflow");
    expect(f.cable.stats().sockets).toBe(0);
    expect(released).toBe(1);
    expect((await next()).type).toBe("turbo_stream");
    expect((await reader.read()).done).toBe(true);
  } finally { f.server.stop(true); }
});

test("one HTTP batch restores ordered subscriptions, with fresh snapshots after reconnect", async () => {
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
    const first = await open(f);
    expect((await f.command(first.id, batch)).status).toBe(204);
    expect(await first.next()).toMatchObject({ type: "confirm_subscription", subscriptionId: "shell", html: "shell-1" });
    expect(await first.next()).toMatchObject({ type: "confirm_subscription", subscriptionId: "agent", html: "agent-1" });
    expect(received).toEqual([{ channel: "shell", shown: { sidebar: "digest" } }, { channel: "agent", shown: undefined }]);
    first.abort.abort();
    await waitClosed(f);
    expect(released).toBe(2);
    revision++;
    const second = await open(f);
    expect((await f.command(first.id, batch)).status).toBe(410);
    expect((await fetch(`${f.url}/cable/${second.id}`, {
      method: "POST", headers: { origin: "https://untrusted.example", "content-type": "application/json" }, body: JSON.stringify(batch),
    })).status).toBe(403);
    expect(received).toHaveLength(2);
    expect((await f.command(second.id, batch)).status).toBe(204);
    expect(await second.next()).toMatchObject({ type: "confirm_subscription", subscriptionId: "shell", html: "shell-2" });
    expect(await second.next()).toMatchObject({ type: "confirm_subscription", subscriptionId: "agent", html: "agent-2" });
    second.abort.abort();
    await waitClosed(f);
    expect(released).toBe(4);
  } finally { f.server.stop(true); }
});

test("idle SSE streams receive a foreground heartbeat within twelve seconds",async()=>{
  const f=fixture();try{const stream=await open(f),began=Date.now();const heartbeat=await stream.next();expect(heartbeat.type).toBe("ping");expect(Date.now()-began).toBeLessThan(12000);stream.abort.abort();await waitClosed(f);}finally{f.server.stop(true);}
},15000);
