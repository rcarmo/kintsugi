import { expect, test } from "bun:test";
import { PreviewFlushChannel, type PreviewFlushRequest } from "../src/preview-persistence-protocol.ts";

test("flush acknowledgements match only their own private request and reject invalid envelopes", async () => {
  const sent: PreviewFlushRequest[] = [], channel = new PreviewFlushChannel(message => sent.push(message));
  const one = channel.flush(), two = channel.flush();
  expect(channel.receive({ type: "flushed", id: crypto.randomUUID(), saved: true })).toBe(false);
  expect(channel.receive({ type: "flushed", id: sent[0]!.id, saved: true, scope: "other" })).toBe(false);
  expect(channel.receive({ type: "flushed", id: sent[1]!.id, saved: true })).toBe(true);
  await two;
  expect(channel.receive({ type: "flushed", id: sent[0]!.id, saved: true })).toBe(true);
  await one;
  expect(channel.receive({ type: "flushed", id: sent[0]!.id, saved: true })).toBe(false);
  channel.close();
});

test("failed commits and document changes never acknowledge successful preservation", async () => {
  let sent: PreviewFlushRequest | undefined;
  const channel = new PreviewFlushChannel(message => { sent = message; });
  const failed = channel.flush();
  channel.receive({ type: "flushed", id: sent!.id, saved: false });
  await expect(failed).rejects.toThrow("could not commit");
  const changed = channel.flush(); channel.close();
  await expect(changed).rejects.toThrow("document changed");
  expect(channel.receive({ type: "flushed", id: sent!.id, saved: true })).toBe(false);
});

test("a missing transport rejects flush immediately and releases its pending timer", async () => {
  const channel = new PreviewFlushChannel(() => { throw Error("No private port"); });
  await expect(channel.flush()).rejects.toThrow("No private port"); channel.close();
});
