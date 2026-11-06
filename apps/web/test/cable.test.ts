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
