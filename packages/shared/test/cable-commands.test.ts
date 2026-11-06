import { expect, test } from "bun:test";
import { CableTopics, cableCommandBatchLimit, cableCommandBodyLimit, decodeCableClientMessage, decodeCableClientMessages, encodeCableClientMessages, type CableClientMessage } from "../src/cable.ts";

const visibility: CableClientMessage = { command: "visibility", visibility: { surfaceKeys: [] } };
const subscribe: CableClientMessage = { command: "subscribe", identifier: CableTopics.shell(), subscriptionId: "mount", shown: { sidebar: "digest" } };
const unsubscribe: CableClientMessage = { command: "unsubscribe", identifier: CableTopics.shell(), subscriptionId: "mount" };

test("single commands retain their existing wire representation", () => {
  expect(encodeCableClientMessages([subscribe])).toEqual([JSON.stringify(subscribe)]);
  expect(decodeCableClientMessage(JSON.stringify(subscribe))).toEqual(subscribe);
  expect(decodeCableClientMessages(JSON.stringify(subscribe))).toEqual([subscribe]);
  expect(encodeCableClientMessages([])).toEqual([]);
});

test("a startup burst is one ordered batch with shown-region digests intact", () => {
  const commands = [visibility, subscribe, unsubscribe];
  const bodies = encodeCableClientMessages(commands);
  expect(bodies).toEqual([JSON.stringify(commands)]);
  expect(decodeCableClientMessages(bodies[0]!)).toEqual(commands);
});

test("batch count limits split requests without losing commands or changing order", () => {
  const commands = Array.from({ length: cableCommandBatchLimit + 1 }, (_, time): CableClientMessage => ({ command: "pong", time }));
  const bodies = encodeCableClientMessages(commands);
  expect(bodies).toHaveLength(2);
  expect(decodeCableClientMessages(bodies[0]!)).toHaveLength(cableCommandBatchLimit);
  expect(bodies.flatMap(decodeCableClientMessages)).toEqual(commands);
});

test("batch byte limits count UTF-8 bytes and JSON framing, not characters", () => {
  const commands = Array.from({ length: 4 }, (_, i): CableClientMessage => ({ command: "visibility", visibility: { surfaceKeys: [`${i}${"界".repeat(10_000)}`] } }));
  const bodies = encodeCableClientMessages(commands);
  expect(bodies).toHaveLength(2);
  for (const body of bodies) expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(cableCommandBodyLimit);
  expect(bodies.flatMap(decodeCableClientMessages)).toEqual(commands);
});

test("a single command at the byte limit stays valid without array brackets", () => {
  const empty: CableClientMessage = { command: "visibility", visibility: { surfaceKeys: [""] } };
  const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
  const exact: CableClientMessage = { command: "visibility", visibility: { surfaceKeys: ["x".repeat(cableCommandBodyLimit - overhead)] } };
  const bodies = encodeCableClientMessages([exact, visibility]);
  expect(bodies).toHaveLength(2);
  expect(new TextEncoder().encode(bodies[0]!).byteLength).toBe(cableCommandBodyLimit);
  expect(bodies.flatMap(decodeCableClientMessages)).toEqual([exact, visibility]);
  const oversized: CableClientMessage = { command: "visibility", visibility: { surfaceKeys: ["x".repeat(cableCommandBodyLimit)] } };
  expect(() => encodeCableClientMessages([oversized])).toThrow("request size limit");
});

test("malformed, empty, nested and oversized batches fail validation", () => {
  for (const encoded of [[], [visibility, { command: "unsupported" }], [[visibility]], Array(cableCommandBatchLimit + 1).fill(visibility)]) {
    expect(() => decodeCableClientMessages(JSON.stringify(encoded))).toThrow("unsupported cable message");
  }
  expect(() => decodeCableClientMessages("not JSON")).toThrow("valid JSON");
});
