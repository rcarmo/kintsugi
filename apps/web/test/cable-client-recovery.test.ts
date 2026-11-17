// Transport protocol tests only: fake sockets/timers and lifecycle signals; no DOM, markup or UI rendering.
import { afterEach, expect, spyOn, test } from "bun:test";
import { decodeCableClientMessages, type CableServerMessage } from "@kintsugi/shared";
import { createKintsugiCableClient } from "../src/client/cable.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(holdFirstAck = false) {
  let now = 0, nextTimer = 0, opens = 0, throwOpen = false;
  let heldAck: (() => void) | undefined;
  const timers = new Map<number, { at: number; every: number; fn: () => void }>();
  const sockets: Socket[] = [];
  const document = Object.assign(new EventTarget(), { hidden: false, cookie: "" });
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

  class Socket {
    static OPEN = 1;
    readyState = 0;
    frames: string[] = [];
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      opens++;
      if (throwOpen) throw new Error("Synthetic socket rejection");
      sockets.push(this);
    }
    send(frame: string) {
      if (this.readyState !== Socket.OPEN) throw new Error("Not open");
      this.frames.push(frame);
    }
    close() { this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
    receive(message: CableServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }

  install("window", window);
  install("document", document);
  install("navigator", navigator);
  install("location", { protocol: "http:", host: "localhost:3168" });
  install("WebSocket", Socket);
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
  async function tick(ms: number) {
    const end = now + ms;
    for (let i = 0; i < 10_000; i++) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) { now = end; await Promise.resolve(); return; }
      const [id, timer] = due;
      now = timer.at;
      if (timer.every) timer.at += timer.every;
      else timers.delete(id);
      timer.fn();
      await Promise.resolve();
    }
    throw new Error("Synthetic clock exceeded its bounded timer budget");
  }
  async function welcome(socket = sockets.at(-1)!) {
    socket.readyState = Socket.OPEN;
    socket.receive({ type: "welcome", connectionId: `connection-${opens}`, heartbeatIntervalMs: 10_000 });
    await Promise.resolve();
    const subscribe = socket.frames.flatMap(frame => decodeCableClientMessages(frame)).find(message => message.command === "subscribe");
    if (!subscribe || subscribe.command !== "subscribe") throw new Error("No subscribe frame");
    return subscribe;
  }
  async function handshake(socket = sockets.at(-1)!) {
    const subscribe = await welcome(socket);
    socket.receive({ type: "confirm_subscription", identifier: subscribe.identifier, subscriptionId: subscribe.subscriptionId, html: "opaque protocol snapshot" });
    await Promise.resolve();
    return subscribe;
  }
  async function heartbeatFor(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 5000) {
      sockets.at(-1)!.receive({ type: "ping", time: Date.now() });
      await tick(5000);
    }
  }
  return {
    client, document, window, navigator, sockets, tick, welcome, handshake, heartbeatFor,
    applyHeld() { heldAck?.(); },
    get opens() { return opens; },
    set throwOpen(value: boolean) { throwOpen = value; },
  };
}

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
  f.sockets[0]!.onerror?.();
  await f.tick(6000);
  expect(f.opens).toBeGreaterThan(1);
  await f.handshake();
  expect(f.client.ready()).toBe(true);
});

test("an offline event during backoff does not lose the retry", async () => {
  const f = fixture();
  f.client.subscribe({ channel: "shell" });
  await f.handshake();
  f.sockets[0]!.onerror?.();
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

test("synchronous socket rejection retains bounded backoff", async () => {
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
  const messages = f.sockets[0]!.frames.flatMap(frame => decodeCableClientMessages(frame));
  expect(messages.find(message => message.command === "subscribe")).not.toHaveProperty("shown");
  expect(f.opens).toBe(1);
});

test("no subscriptions or hidden pages do not start background socket probes", async () => {
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
  f.sockets[0]!.receive({ type: "reject_subscription", identifier: subscribe.identifier, subscriptionId: subscribe.subscriptionId, reason: "Synthetic rejection" });
  await f.heartbeatFor(30_000);
  f.applyHeld();
  expect(f.opens).toBe(1);
  expect(rejected).toBe(1);
  expect(ready).toBe(0);
  expect(f.client.ready()).toBe(true);
});
