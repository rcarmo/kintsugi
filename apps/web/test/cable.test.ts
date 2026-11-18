import { createKintsugiEventBus } from "@kintsugi/core";
import { CableTopics, decodeCableServerMessage, serializeCableIdentifier, type CableChannelAdapter, type CableServerMessage } from "@kintsugi/shared";
import { expect, test } from "bun:test";
import { createCableServer } from "../src/server/cable.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

function socket() {
  const sent: CableServerMessage[] = [];
  const compressed: boolean[] = [];
  return { sent, compressed, send(raw: string, compress = false) { sent.push(decodeCableServerMessage(raw)); compressed.push(compress); return raw.length; } };
}
function server(channels: CableChannelAdapter[] = []) {
  return createCableServer({ registry: createWorkspaceRegistry(), events: createKintsugiEventBus(), channels, logError: () => {} });
}
const identifier = CableTopics.agent("workspace", "conversation");

test("topic identity is canonical and rejects empty scope", () => {
  expect(() => CableTopics.agent("", "conversation")).toThrow();
  expect(serializeCableIdentifier(CableTopics.module("tree", "w", { a: "1", b: "2" }))).toBe(serializeCableIdentifier(CableTopics.module("tree", "w", { b: "2", a: "1" })));
});

test("one subscription confirms first, delivers later messages, and releases once", async () => {
  let publish!: (value: string) => void;
  let releases = 0;
  const cable = server([{ name: "agent", subscribe(_identifier, listener) {
    publish = listener;
    listener("initial");
    return { ready: Promise.resolve(), unsubscribe() { releases++; } };
  } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "mount" }));
  await Bun.sleep(0);
  publish("changed");
  expect(ws.sent.map(message => message.type)).toEqual(["welcome", "confirm_subscription", "turbo_stream"]);
  cable.message(ws, JSON.stringify({ command: "unsubscribe", identifier, subscriptionId: "mount" }));
  publish("obsolete");
  cable.close(ws);
  expect(ws.sent).toHaveLength(3);
  expect(releases).toBe(1);
});

test("late async initialization cannot attach to a superseded mount", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  let releases = 0;
  const cable = server([{ name: "agent", async subscribe(_identifier, listener) {
    if (++calls === 1) await gate.promise;
    listener("current");
    return { ready: Promise.resolve(), unsubscribe() { releases++; } };
  } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  for (const subscriptionId of ["old", "new"]) cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId }));
  await Bun.sleep(0);
  gate.resolve();
  await Bun.sleep(0);
  expect(ws.sent.filter(message => message.type === "confirm_subscription").map(message => message.subscriptionId)).toEqual(["new"]);
  expect(releases).toBe(1);
  cable.message(ws, JSON.stringify({ command: "unsubscribe", identifier, subscriptionId: "old" }));
  expect(releases).toBe(1);
  cable.close(ws);
  expect(releases).toBe(2);
});

test("closing during initialization releases the late upstream", async () => {
  const gate = Promise.withResolvers<void>();
  let releases = 0;
  const cable = server([{ name: "agent", async subscribe(_identifier, listener) {
    await gate.promise;
    listener("late");
    return { ready: Promise.resolve(), unsubscribe() { releases++; } };
  } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "mount" }));
  cable.close(ws);
  gate.resolve();
  await Bun.sleep(0);
  expect(ws.sent).toHaveLength(1);
  expect(releases).toBe(1);
});

test("invalid messages and unavailable channels fail explicitly", async () => {
  const cable = server();
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  cable.message(ws, "not json");
  expect(ws.sent.at(-1)?.type).toBe("error");
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "mount" }));
  await Bun.sleep(0);
  expect(ws.sent.at(-1)?.type).toBe("reject_subscription");
  expect(cable.stats().subscriptions).toEqual({});
  cable.close(ws);
});

test("slow sockets are disconnected rather than accumulating event history", () => {
  const cable = server();
  let closed = false;
  const ws = { send() { throw new Error("must not enqueue"); }, getBufferedAmount() { return 2 * 1024 * 1024; }, close() { closed = true; } };
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  expect(closed).toBe(true);
  cable.close(ws);
});

test("large live snapshots use negotiated WebSocket compression", async () => {
  const cable = server([{ name: "agent", subscribe(_identifier, listener) {
    listener("x".repeat(2048));
    return { ready: Promise.resolve(), unsubscribe() {} };
  } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "mount" }));
  await Bun.sleep(0);
  expect(ws.compressed).toEqual([false, true]);
  cable.close(ws);
});

test("a subscription hands the regions its page shows to the channel", async () => {
  const received: unknown[] = [];
  const cable = server([{ name: "agent", subscribe(_identifier, listener, _events, shown) {
    received.push(shown);
    listener("");
    return { ready: Promise.resolve(), unsubscribe() {} };
  } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "page", shown: { transcript: "digest" } }));
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "reconnect" }));
  await Bun.sleep(0);
  expect(received).toEqual([{ transcript: "digest" }, undefined]);
  cable.close(ws);
});

test("ordered batches preserve replacement and late-initialization cancellation", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  let releases = 0;
  const cable = server([{ name: "agent", async subscribe(_identifier, listener) {
    if (++calls === 1) await gate.promise;
    listener("current");
    return { unsubscribe() { releases++; } };
  } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  cable.message(ws, JSON.stringify([
    { command: "visibility", visibility: { surfaceKeys: [] } },
    { command: "subscribe", identifier, subscriptionId: "old" },
    { command: "subscribe", identifier, subscriptionId: "new" },
    { command: "unsubscribe", identifier, subscriptionId: "old" },
  ]));
  await Bun.sleep(0);
  gate.resolve();
  await Bun.sleep(0);
  expect(ws.sent.filter(message => message.type === "confirm_subscription").map(message => message.subscriptionId)).toEqual(["new"]);
  expect(releases).toBe(1);
  cable.close(ws);
  expect(releases).toBe(2);
});

test("an invalid batch applies no commands before reporting the protocol error", () => {
  let subscriptions = 0;
  const cable = server([{ name: "agent", subscribe() { subscriptions++; return { unsubscribe() {} }; } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  cable.message(ws, JSON.stringify([
    { command: "subscribe", identifier, subscriptionId: "must-not-start" },
    { command: "invalid" },
  ]));
  expect(subscriptions).toBe(0);
  expect(cable.stats().subscriptions).toEqual({});
  expect(ws.sent.map(message => message.type)).toEqual(["welcome", "error"]);
  cable.close(ws);
});

test("a batch stops dispatching when snapshot backpressure closes its connection", () => {
  let subscriptions = 0;
  const cable = server([{ name: "agent", subscribe(_identifier, listener) {
    subscriptions++;
    listener("snapshot");
    return { unsubscribe() {} };
  } }]);
  const ws = { send: () => 1, getBufferedAmount: () => 0, close() { cable.close(ws); } };
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  ws.getBufferedAmount = () => 2 * 1024 * 1024;
  cable.message(ws, JSON.stringify([
    { command: "subscribe", identifier, subscriptionId: "first" },
    { command: "subscribe", identifier, subscriptionId: "must-not-start" },
  ]));
  expect(subscriptions).toBe(1);
  expect(cable.stats().sockets).toBe(0);
});

test("resource meter scope allows global totals but rejects unknown workspaces before collecting", async () => {
  const registry = createWorkspaceRegistry(); registry.add("known");
  const scopes: Array<string | undefined> = [];
  let releases = 0;
  const cable = createCableServer({ registry, events: createKintsugiEventBus(), logError: () => {}, channels: [{ name: "resources", subscribe(identifier, listener) {
    if (identifier.channel !== "resources") throw Error("Wrong resource channel");
    scopes.push(identifier.workspaceId); listener("");
    return { unsubscribe() { releases++; } };
  } }] });
  const ws = socket(); cable.open(ws, { kind: "cable", connectionId: "meter-viewer" });
  for (const workspaceId of [undefined, "known", "missing"]) cable.message(ws, JSON.stringify({ command: "subscribe", identifier: CableTopics.resources(workspaceId), subscriptionId: workspaceId ?? "global" }));
  await Bun.sleep(0);
  expect(scopes).toEqual([undefined, "known"]);
  expect(ws.sent.filter(message => message.type === "confirm_subscription")).toHaveLength(2);
  expect(ws.sent.at(-1)?.type).toBe("reject_subscription");
  expect(serializeCableIdentifier(CableTopics.resources())).not.toBe(serializeCableIdentifier(CableTopics.resources("known")));
  cable.close(ws); expect(releases).toBe(2);
});

test("a dropped frame closes the socket while queued backpressure does not", () => {
  for (const [sendResult, expectedClosed] of [[0, true], [-1, false]] as const) {
    const cable = server();
    const closes: number[] = [];
    const ws = { send() { return sendResult; }, close(code: number) { closes.push(code); cable.close(ws); } };
    cable.open(ws, { kind: "cable", connectionId: "drop-fixture" });
    expect(closes).toEqual(expectedClosed ? [1013] : []);
    cable.close(ws);
  }
});

test("unsubscribe invalidates the attempt before running upstream cleanup", async () => {
  const cable = server([{ name: "agent", subscribe(_identifier, listener) {
    listener("initial");
    return { unsubscribe() { listener("retired view must not publish during cleanup"); } };
  } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "reentrant-unsubscribe" });
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "retired" }));
  await Bun.sleep(0);
  cable.message(ws, JSON.stringify({ command: "unsubscribe", identifier, subscriptionId: "retired" }));
  expect(ws.sent.map(message => message.type)).toEqual(["welcome", "confirm_subscription"]);
  expect(cable.stats().subscriptions).toEqual({});
  cable.close(ws);
});

test("a failed cleanup cannot prevent release of the other views on a closed connection", async () => {
  let released = 0;
  const cable = server([{ name: "agent", subscribe(id, listener) {
    listener("initial");
    return { unsubscribe() {
      if (serializeCableIdentifier(id) === serializeCableIdentifier(identifier)) throw new Error("Synthetic upstream cleanup failure");
      released++;
    } };
  } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "failed-cleanup" });
  cable.message(ws, JSON.stringify([
    { command: "subscribe", identifier, subscriptionId: "broken" },
    { command: "subscribe", identifier: CableTopics.agent("workspace", "healthy"), subscriptionId: "healthy" },
  ]));
  await Bun.sleep(0);
  expect(() => cable.close(ws)).not.toThrow();
  cable.close(ws);
  expect(released).toBe(1);
  expect(cable.stats()).toEqual({ sockets: 0, subscriptions: {} });
});

test("dropping a snapshot stops dispatch before the transport close callback arrives", () => {
  let subscriptions = 0;
  const closeCodes: number[] = [];
  const cable = server([{ name: "agent", subscribe(_id, listener) {
    subscriptions++;
    listener("initial");
    return { unsubscribe() {} };
  } }]);
  const ws = {
    send(raw: string) { return decodeCableServerMessage(raw).type === "confirm_subscription" ? 0 : raw.length; },
    // Native WebSocket close is asynchronous, unlike the local SSE adapter.
    close(code: number) { closeCodes.push(code); },
  };
  cable.open(ws, { kind: "cable", connectionId: "delayed-close" });
  cable.message(ws, JSON.stringify([
    { command: "subscribe", identifier, subscriptionId: "dropped" },
    { command: "subscribe", identifier: CableTopics.agent("workspace", "next"), subscriptionId: "not-admitted" },
  ]));
  expect(subscriptions).toBe(1);
  expect(closeCodes).toEqual([1013]);
  expect(cable.stats()).toEqual({ sockets: 0, subscriptions: {} });
  cable.close(ws);
});

test("a throwing writer disconnects only that client and cannot block the next listener", async () => {
  const listeners = new Set<(html: string) => void>();
  const cable = server([{ name: "agent", subscribe(_id, listener) {
    listeners.add(listener);
    listener("initial");
    return { unsubscribe() { listeners.delete(listener); } };
  } }]);
  const bad = { send(raw: string) {
    if (decodeCableServerMessage(raw).type === "turbo_stream") throw new Error("Synthetic transport write error");
    return raw.length;
  } };
  const good = socket();
  for (const client of [bad, good]) {
    cable.open(client, { kind: "cable", connectionId: crypto.randomUUID() });
    cable.message(client, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "initial" }));
  }
  await Bun.sleep(0);
  expect(() => { for (const listener of listeners) listener("update"); }).not.toThrow();
  expect(good.sent.at(-1)).toMatchObject({ type: "turbo_stream", html: "update" });
  expect(cable.stats().sockets).toBe(1);
  expect(listeners.size).toBe(1);
  cable.close(good);
});
