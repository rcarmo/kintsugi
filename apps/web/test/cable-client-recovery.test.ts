// Transport protocol tests only: fake event streams/timers and lifecycle signals; no DOM, markup or UI rendering.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { decodeCableClientMessages, type CableServerMessage } from "@kintsugi/shared";
import { createKintsugiCableClient } from "../src/client/cable.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function createFixture(transport: "websocket" | "sse", holdFirstAck = false) {
  let now = 0, nextTimer = 0, opens = 0, throwOpen = false;
  let heldAck: (() => void) | undefined;
  let nextPost: Promise<Response> | undefined;
  const timers = new Map<number, { at: number; every: number; fn: () => void }>();
  const streams: Stream[] = [];
  const animationFrames: FrameRequestCallback[] = [];
  const document = Object.assign(new EventTarget(), { hidden: false, cookie: `kintsugi-live-transport=${transport}` });
  const window = new EventTarget(), navigator = { onLine: true };

  function install<T>(key: string, value: T) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    cleanups.push(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  cleanups.push(() => clock.mockRestore());
  const errors = spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => errors.mockRestore());

  class Stream {
    readonly id = `connection-${opens}`;
    frames: string[] = [];
    private output!: ReadableStreamDefaultController<Uint8Array>;
    private ended = false;
    readonly body = new ReadableStream<Uint8Array>({
      start: output => { this.output = output; },
      cancel: () => { this.ended = true; },
    });
    close() { if (!this.ended) { this.ended = true; this.output.close(); } }
    receive(message: CableServerMessage) {
      if (this.ended) return;
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify(message)}\r\n\r\n`);
      this.output.enqueue(bytes.subarray(0, bytes.length - 1));
      this.output.enqueue(bytes.subarray(bytes.length - 1));
    }
  }

  class Socket extends Stream {
    static OPEN = 1;
    readyState = Socket.OPEN;
    bufferedAmount = 0;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    constructor() {
      opens++;
      super();
      if (throwOpen) throw new Error("Synthetic WebSocket setup failure");
      streams.push(this);
    }
    override close() {
      if (this.readyState !== Socket.OPEN) return;
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code: 1006 }));
    }
    override receive(message: CableServerMessage) {
      if (this.readyState === Socket.OPEN) this.onmessage?.({ data: JSON.stringify(message) });
    }
    send(body: string) { this.frames.push(body); }
  }
  install("WebSocket", Socket);
  install("location", { protocol: "http:", host: "localhost:3168" });
  install("window", window);
  install("document", document);
  install("navigator", navigator);
  install("requestAnimationFrame", (callback: FrameRequestCallback) => animationFrames.push(callback));
  install("fetch", async (url: string, init: RequestInit) => {
    if (init.method !== "POST") throw new Error("Unexpected non-POST Cable request");
    if (url === "/cable") {
      opens++;
      if (throwOpen) throw new Error("Synthetic stream failure");
      const stream = new Stream();
      streams.push(stream);
      init.signal?.addEventListener("abort", () => stream.close(), { once: true });
      return new Response(stream.body, { headers: { "content-type": "text/event-stream" } });
    }
    const stream = streams.find(item => url === `/cable/${item.id}`);
    if (!stream) throw new Error("Unrecognised Cable command request");
    // The production sender passes JSON text, not a streamed request body.
    stream.frames.push(String(init.body));
    const held = nextPost;
    nextPost = undefined;
    return held ?? new Response(null, { status: 204 });
  });
  install("setTimeout", (fn: () => void, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { fn, at: now + delay, every: 0 });
    return id;
  });
  install("setInterval", (fn: () => void, delay: number) => {
    const id = ++nextTimer;
    timers.set(id, { fn, at: now + delay, every: delay });
    return id;
  });
  install("clearTimeout", (id: number | undefined) => { if (id !== undefined) timers.delete(id); });
  install("clearInterval", (id: number | undefined) => { if (id !== undefined) timers.delete(id); });

  const client = createKintsugiCableClient((_html, current, applied) => {
    if (holdFirstAck && !heldAck) { heldAck = applied; return; }
    if (current()) applied();
  });
  async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
  async function tick(ms: number) {
    const end = now + ms;
    for (let i = 0; i < 10_000; i++) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) { now = end; await flush(); return; }
      const [id, timer] = due;
      now = timer.at;
      if (timer.every) timer.at += timer.every;
      else timers.delete(id);
      timer.fn();
      await flush();
    }
    throw new Error("Synthetic clock exceeded its bounded timer budget");
  }
  async function welcome(socket = streams.at(-1)!) {
    await flush();
    socket.receive({ type: "welcome", connectionId: socket.id, heartbeatIntervalMs: 10_000 });
    await flush();
    const subscribe = socket.frames.flatMap(frame => decodeCableClientMessages(frame)).find(message => message.command === "subscribe");
    if (!subscribe || subscribe.command !== "subscribe") throw new Error("No subscribe frame");
    return subscribe;
  }
  async function handshake(socket = streams.at(-1)!) {
    const subscribe = await welcome(socket);
    socket.receive({ type: "confirm_subscription", identifier: subscribe.identifier, subscriptionId: subscribe.subscriptionId, html: "opaque protocol snapshot" });
    await flush();
    return subscribe;
  }
  async function heartbeatFor(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 5000) {
      streams.at(-1)!.receive({ type: "ping", time: Date.now() });
      await tick(5000);
    }
  }
  return {
    client, document, window, navigator, streams, tick, welcome, handshake, heartbeatFor,
    applyHeld() { heldAck?.(); },
    runAnimationFrames() { for (const callback of animationFrames.splice(0)) callback(now); },
    holdNextPost(post: Promise<Response>) { nextPost = post; },
    setBufferedAmount(amount: number) {
      const stream = streams.at(-1);
      if (!(stream instanceof Socket)) throw new Error("Expected a WebSocket in this test");
      stream.bufferedAmount = amount;
    },
    get opens() { return opens; },
    set throwOpen(value: boolean) { throwOpen = value; },
  };
}

for (const transport of ["websocket", "sse"] as const) describe(transport, () => {
  const fixture = (holdFirstAck = false) => createFixture(transport, holdFirstAck);
  test("a visible connection recovers after a missed wake event without background reconnection", async () => {
    const f = fixture();
    f.client.subscribe({ channel: "shell" });
    await f.handshake();
    expect(f.client.ready()).toBe(true);
    f.document.hidden = true;
    f.window.dispatchEvent(new Event("pagehide"));
    await f.tick(30_000);
    expect(f.opens).toBe(1);
    f.document.hidden = false; // Model a missed pageshow/focus/visibility event, without claiming physical Safari coverage.
    await f.tick(6000);
    expect(f.opens).toBeGreaterThan(1);
    await f.handshake();
    expect(f.client.ready()).toBe(true);
  });

  test("an offline hint cannot permanently suppress retries to a reachable local app", async () => {
    const f = fixture();
    f.client.subscribe({ channel: "shell" });
    await f.handshake();
    f.navigator.onLine = false;
    f.streams[0]!.close();
    await f.tick(6000);
    expect(f.opens).toBeGreaterThan(1);
    await f.handshake();
    expect(f.client.ready()).toBe(true);
  });

  test("an offline event during backoff does not lose the retry", async () => {
    const f = fixture();
    f.client.subscribe({ channel: "shell" });
    await f.handshake();
    f.streams[0]!.close();
    await f.tick(0);
    f.navigator.onLine = false;
    f.window.dispatchEvent(new Event("offline"));
    await f.tick(6000);
    expect(f.opens).toBeGreaterThan(1);
    await f.handshake();
    expect(f.client.ready()).toBe(true);
  });

  test("snapshot application acknowledgement remains bounded even while heartbeats arrive", async () => {
    const f = fixture(true);
    f.client.subscribe({ channel: "shell" });
    await f.handshake();
    expect(f.client.ready()).toBe(false);
    await f.heartbeatFor(25_000);
    expect(f.opens).toBeGreaterThan(1);
    await f.handshake();
    expect(f.client.ready()).toBe(true);
  });

  test("transport setup failure retains bounded backoff", async () => {
    const f = fixture();
    f.throwOpen = true;
    f.client.subscribe({ channel: "shell" });
    await f.tick(60_000);
    expect(f.opens).toBeGreaterThan(5);
    expect(f.opens).toBeLessThan(30);
    expect(f.client.ready()).toBe(false);
  });

  test("explicit retry can recover a visible page paused by a missed wake event", async () => {
    const f = fixture();
    f.client.subscribe({ channel: "shell" });
    await f.handshake();
    f.window.dispatchEvent(new Event("pagehide"));
    f.client.reconnect();
    await f.tick(1000);
    expect(f.opens).toBe(2);
    await f.handshake();
    expect(f.client.ready()).toBe(true);
  });

  test("invalid retained cache hints request a fresh snapshot instead of reconnecting forever", async () => {
    const f = fixture();
    let hint: string | null = "not-json";
    // SAFETY: This controlled cache-hint stub implements the only Element methods used by the transport; no DOM is rendered.
    const shown = { getAttribute: (_name: string) => hint, removeAttribute: (_name: string) => { hint = null; } } as Element;
    f.client.subscribe({ channel: "shell" }, { shownIn: shown });
    await f.handshake();
    expect(f.client.ready()).toBe(true);
    expect(hint).toBeNull();
    const messages = f.streams[0]!.frames.flatMap(frame => decodeCableClientMessages(frame));
    expect(messages.find(message => message.command === "subscribe")).not.toHaveProperty("shown");
    expect(f.opens).toBe(1);
  });

  test("no subscriptions or hidden pages do not start background connection probes", async () => {
    const f = fixture();
    await f.tick(60_000);
    expect(f.opens).toBe(0);
    f.document.hidden = true;
    f.client.subscribe({ channel: "shell" });
    await f.tick(60_000);
    expect(f.opens).toBe(0);
    f.document.hidden = false;
    await f.tick(6000);
    expect(f.opens).toBe(1);
  });

  test("an applied snapshot clears its deadline and remains connected through heartbeats", async () => {
    const f = fixture();
    f.client.subscribe({ channel: "shell" });
    await f.handshake();
    await f.heartbeatFor(30_000);
    expect(f.opens).toBe(1);
    expect(f.client.ready()).toBe(true);
  });

  test("missing initial confirmation still expires independently of heartbeats", async () => {
    const f = fixture();
    f.client.subscribe({ channel: "shell" });
    await f.welcome();
    await f.heartbeatFor(25_000);
    expect(f.opens).toBeGreaterThan(1);
    await f.handshake();
    expect(f.client.ready()).toBe(true);
  });

  test("an obsolete snapshot acknowledgement cannot reapply readiness after reconnect", async () => {
    const f = fixture(true);
    let ready = 0;
    f.client.subscribe({ channel: "shell" }, { onReady() { ready++; } });
    await f.handshake();
    f.client.reconnect();
    await f.tick(1000);
    await f.handshake();
    expect(ready).toBe(1);
    f.applyHeld();
    expect(ready).toBe(1);
    expect(f.client.ready()).toBe(true);
  });

  test("releasing the last pending lease clears its deadline and invalidates a late acknowledgement", async () => {
    const f = fixture(true);
    let ready = 0;
    const lease = f.client.subscribe({ channel: "shell" }, { onReady() { ready++; } });
    await f.handshake();
    lease.unsubscribe();
    await f.heartbeatFor(30_000);
    f.applyHeld();
    expect(f.opens).toBe(1);
    expect(ready).toBe(0);
  });

  test("rejection clears the pending application deadline and ignores its late acknowledgement", async () => {
    const f = fixture(true);
    let ready = 0, rejected = 0;
    f.client.subscribe({ channel: "shell" }, { onReady() { ready++; }, onRejected() { rejected++; } });
    const subscribe = await f.handshake();
    f.streams[0]!.receive({ type: "reject_subscription", identifier: subscribe.identifier, subscriptionId: subscribe.subscriptionId, reason: "Synthetic rejection" });
    await f.heartbeatFor(30_000);
    f.applyHeld();
    expect(f.opens).toBe(1);
    expect(rejected).toBe(1);
    expect(ready).toBe(0);
    expect(f.client.ready()).toBe(false);
  });

  test("a stalled workspace subscription does not reconnect a healthy shell or sibling", async () => {
    const f = fixture();
    const errors: string[] = [];
    f.client.subscribe({ channel: "shell" });
    f.client.subscribe({ channel: "module", name: "surface", workspaceId: "stalled", params: { kind: "workspace" } }, { onRejected: reason => errors.push(reason) });
    await f.handshake(); // Only the shell confirms.
    expect(f.client.ready()).toBe(true);
    await f.heartbeatFor(25_000);
    expect(f.opens).toBe(1);
    expect(f.client.ready()).toBe(true);
    expect(errors).toEqual(["Live updates timed out while waiting for this view. Retry the view to reconnect."]);
    expect(f.streams[0]!.frames.flatMap(decodeCableClientMessages).some(command => command.command === "unsubscribe" && command.identifier.channel === "module")).toBe(true);
  });

  test("an oversized but well-formed cache hint cannot poison the next workspace subscribe", async () => {
    const f = fixture();
    let hint: string | null = JSON.stringify({ region: "x".repeat(70_000) });
    // This protocol fixture supplies only the attribute methods used by Cable.
    const shown: Pick<Element, "getAttribute" | "removeAttribute"> = {
      getAttribute: () => hint,
      removeAttribute: () => { hint = null; },
    };
    // SAFETY: Cable reads and removes the cache attribute using only the two methods supplied above.
    f.client.subscribe({ channel: "shell" }, { shownIn: shown as Element });
    const subscribe = await f.handshake();
    expect(subscribe).not.toHaveProperty("shown");
    expect(f.client.ready()).toBe(true);
  });

  test("a bad view render reports its own failure instead of reconnecting the shell", async () => {
    const f = fixture();
    const client = createKintsugiCableClient((html, current, applied, failed) => {
      if (html === "bad view") failed(new Error("Synthetic render problem"));
      else if (current()) applied();
    });
    const errors: string[] = [];
    client.subscribe({ channel: "shell" });
    client.subscribe({ channel: "module", name: "surface", workspaceId: "broken", params: {} }, { onRejected: reason => errors.push(reason) });
    await f.handshake();
    const socket = f.streams[0]!;
    const command = socket.frames.flatMap(decodeCableClientMessages).find(message => message.command === "subscribe" && message.identifier.channel === "module");
    if (!command || command.command !== "subscribe") throw new Error("Missing view subscription");
    socket.receive({ type: "confirm_subscription", identifier: command.identifier, subscriptionId: command.subscriptionId, html: "bad view" });
    await f.heartbeatFor(25_000);
    expect(f.opens).toBe(1);
    expect(client.ready()).toBe(true);
    expect(errors).toEqual(["Live updates could not be applied to this view. Retry the view to reconnect."]);
  });
  test("subscribing to a different workspace during backoff does not start an immediate probe", async () => {
    const f = fixture();
    f.client.subscribe({ channel: "shell" });
    await f.handshake();
    f.streams[0]!.close();
    await f.tick(0);
    for (const workspaceId of ["one", "two", "three"]) {
      f.client.subscribe({ channel: "module", name: "surface", workspaceId, params: { kind: "workspace" } });
    }
    expect(f.opens).toBe(1);
    await f.tick(100);
    expect(f.opens).toBe(2);
    await f.handshake();
    expect(f.client.ready()).toBe(true);
  });

  test("an old animation-frame callback cannot re-notify a lease after reconnect", async () => {
    const f = fixture();
    f.client.subscribe({ channel: "shell" });
    await f.handshake();
    let ready = 0;
    f.client.subscribe({ channel: "shell" }, { onReady: () => { ready++; } });
    f.client.reconnect();
    await f.handshake();
    expect(ready).toBe(1);
    f.runAnimationFrames();
    expect(ready).toBe(1);
  });

  test("a failing disconnect listener cannot leave other leases on the old connection", async () => {
    const f = fixture();
    let disconnected = 0;
    f.client.subscribe({ channel: "shell" }, { onDisconnected() { throw new Error("Synthetic view teardown failure"); } });
    f.client.subscribe({ channel: "shell" }, { onDisconnected() { disconnected++; } });
    await f.handshake();
    expect(() => f.client.reconnect()).not.toThrow();
    expect(disconnected).toBe(1);
    await f.handshake();
    expect(f.client.ready()).toBe(true);
  });

  test("superseded visibility reports are coalesced without crossing subscription commands", async () => {
    const f = fixture();
    f.client.subscribe({ channel: "shell" });
    await f.handshake();
    const stream = f.streams[0]!;
    const start = stream.frames.length;
    for (let i = 0; i < 32; i++) f.client.reportVisibility({ workspaceId: `before-${i}`, surfaceKeys: [] });
    f.client.subscribe({ channel: "module", name: "surface", workspaceId: "view", params: { kind: "workspace" } });
    for (let i = 0; i < 32; i++) f.client.reportVisibility({ workspaceId: `after-${i}`, surfaceKeys: [] });
    await f.tick(0);
    const commands = stream.frames.slice(start).flatMap(decodeCableClientMessages);
    expect(commands.map(command => command.command)).toEqual(["visibility", "subscribe", "visibility"]);
    expect(commands[0]).toMatchObject({ visibility: { workspaceId: "before-31" } });
    expect(commands[2]).toMatchObject({ visibility: { workspaceId: "after-31" } });
  });

  test("another tab changing the preference cannot switch this page during reconnect", async () => {
    const f = fixture();
    f.client.subscribe({ channel: "shell" });
    await f.handshake();
    f.document.cookie = `kintsugi-live-transport=${transport === "sse" ? "websocket" : "sse"}`;
    f.client.reconnect();
    expect(f.streams[1]!.constructor).toBe(f.streams[0]!.constructor);
    await f.handshake();
    expect(f.client.ready()).toBe(true);
  });

  test("a repeated welcome cannot replace live subscriptions or report false readiness", async () => {
    const f = fixture();
    f.client.subscribe({ channel: "shell" });
    await f.handshake();
    const stream = f.streams[0]!;
    const sent = stream.frames.length;
    stream.receive({ type: "welcome", connectionId: "duplicate-welcome" });
    await f.tick(0);
    expect(f.client.ready()).toBe(true);
    expect(stream.frames).toHaveLength(sent);
  });
});

test("SSE does not replay every stale visibility report queued behind a slow command POST", async () => {
  const f = createFixture("sse");
  f.client.subscribe({ channel: "shell" });
  await f.handshake();
  const stream = f.streams[0]!;
  const start = stream.frames.length;
  const held = Promise.withResolvers<Response>();
  f.holdNextPost(held.promise);
  f.client.reportVisibility({ workspaceId: "in-flight", surfaceKeys: [] });
  await f.tick(0);
  try {
    for (let i = 0; i < 64; i++) {
      f.client.reportVisibility({ workspaceId: `queued-${i}`, surfaceKeys: [] });
      await f.tick(0);
    }
    expect(stream.frames).toHaveLength(start + 1);
  } finally { held.resolve(new Response(null, { status: 204 })); }
  await f.tick(0);
  expect(stream.frames.slice(start).flatMap(decodeCableClientMessages)).toEqual([
    { command: "visibility", visibility: { workspaceId: "in-flight", surfaceKeys: [] } },
    { command: "visibility", visibility: { workspaceId: "queued-63", surfaceKeys: [] } },
  ]);
  expect(f.client.ready()).toBe(true);
});

test("WebSocket reconnects instead of adding commands to an already saturated send buffer", async () => {
  const f = createFixture("websocket");
  f.client.subscribe({ channel: "shell" });
  await f.handshake();
  const stream = f.streams[0]!;
  const sent = stream.frames.length;
  f.setBufferedAmount(1024 * 1024);
  f.client.reportVisibility({ workspaceId: "changed", surfaceKeys: [] });
  await f.tick(0);
  expect(stream.frames).toHaveLength(sent);
  expect(f.client.ready()).toBe(false);
  await f.tick(1000);
  await f.handshake();
  expect(f.client.ready()).toBe(true);
});
