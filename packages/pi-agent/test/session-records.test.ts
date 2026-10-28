import { describe, expect, test } from "bun:test";
import { recordsFromSessionEntries } from "../src/server/session-records.ts";
import { buildTranscript } from "@kintsugi/agent/server/transcript";

describe("recordsFromSessionEntries", () => {
  test("maps pi session message entries to transcript records", () => {
    const entries = [
      { type: "message", id: "e1", parentId: null, timestamp: "2026-06-10T10:00:00Z", message: { role: "user", content: "hello", timestamp: 1760000000000 } },
      {
        type: "message", id: "e2", parentId: "e1", timestamp: "2026-06-10T10:00:05Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me see" },
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
          ],
          stopReason: "toolUse",
          timestamp: 1760000005000,
        },
      },
      { type: "message", id: "e3", parentId: "e2", timestamp: "2026-06-10T10:00:06Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "out" }, { type: "image", mimeType: "image/png", data: "abc" }], details: { displayAnsi: "\x1b[31mout\x1b[0m" }, isError: false, timestamp: 1760000006000 } },
      { type: "branch_summary", id: "e4", parentId: "e3", timestamp: "2026-06-10T10:00:07Z", summary: "old branch" },
      { type: "model_change", id: "e5", parentId: "e4", timestamp: "2026-06-10T10:00:08Z", provider: "anthropic", modelId: "claude" },
    ];
    const records = recordsFromSessionEntries(entries);
    expect(records.length).toBe(5);
    expect(records.slice(0, 3).map((record) => record.timestamp)).toEqual([
      Date.parse(entries[0].timestamp),
      Date.parse(entries[1].timestamp),
      Date.parse(entries[2].timestamp),
    ]);
    expect(records[0]).toMatchObject({ kind: "user", text: "hello", rewindable: false });
    const assistant = records[1];
    expect(assistant).toMatchObject({ kind: "assistant", stopReason: "toolUse" });
    if (assistant.kind !== "assistant") throw new Error("expected an assistant transcript record");
    expect(assistant.parts).toHaveLength(2);
    expect(records[2]).toMatchObject({ kind: "toolResult", callId: "c1", text: "out", images: [{ entryId: "e3", contentIndex: 1 }], details: { displayAnsi: "\x1b[31mout\x1b[0m" } });
    expect(records[3]).toMatchObject({ kind: "note", tone: "summary" });
    expect(records[4]).toMatchObject({ kind: "note", tone: "system", text: "model → anthropic/claude" });
  });

  test("omits initial model changes and collapses consecutive later changes to the last one", () => {
    const records = recordsFromSessionEntries([
      { type: "model_change", id: "initial-1", provider: "openai", modelId: "first" },
      { type: "model_change", id: "initial-2", provider: "openai", modelId: "second" },
      { type: "message", id: "user", parentId: null, message: { role: "user", content: "hello" } },
      { type: "model_change", id: "later-1", provider: "anthropic", modelId: "first" },
      { type: "model_change", id: "later-2", provider: "anthropic", modelId: "second" },
      { type: "message", id: "assistant", parentId: "user", message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" } },
      { type: "model_change", id: "latest", provider: "openai", modelId: "latest" },
    ]);

    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({ kind: "user", text: "hello" });
    expect(records[1]).toMatchObject({ kind: "note", id: "later-2", text: "model → anthropic/second" });
    expect(records[2]).toMatchObject({ kind: "assistant" });
    expect(records[3]).toMatchObject({ kind: "note", id: "latest", text: "model → openai/latest" });
  });

  test("user entries with a parent are rewindable", () => {
    const records = recordsFromSessionEntries([
      { type: "message", id: "e9", parentId: "e8", timestamp: "2026-06-10T10:00:00Z", message: { role: "user", content: "again", timestamp: 1760000000000 } },
    ]);
    expect(records[0]).toMatchObject({ kind: "user", rewindable: true });
  });

  test("preserves per-text phases and reconstructs commentary inside Working before the final answer", () => {
    const commentarySignature = JSON.stringify({ v: 1, id: "message-1", phase: "commentary" });
    const finalSignature = JSON.stringify({ v: 1, id: "message-1", phase: "final_answer" });
    const records = recordsFromSessionEntries([
      { type: "message", id: "user", parentId: null, message: { role: "user", content: "go", timestamp: 1_000 } },
      {
        type: "message",
        id: "assistant",
        parentId: "user",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I’m checking that now.", textSignature: commentarySignature },
            { type: "text", text: "Everything is ready.", textSignature: finalSignature },
          ],
          stopReason: "stop",
          timestamp: 2_000,
        },
      },
    ]);

    expect(records[1]).toMatchObject({
      kind: "assistant",
      parts: [
        { type: "text", text: "I’m checking that now.", textSignature: commentarySignature },
        { type: "text", text: "Everything is ready.", textSignature: finalSignature },
      ],
    });
    const items = buildTranscript(records);
    const working = items.find((item) => item.type === "working");
    expect(working?.type === "working" && working.items).toMatchObject([
      { type: "text", text: "I’m checking that now.", final: false },
    ]);
    expect(items.at(-1)).toMatchObject({ type: "text", text: "Everything is ready.", final: true });
  });

  test("narrows malformed image metadata before adding it to transcript records", () => {
    const records = recordsFromSessionEntries([
      {
        type: "message",
        id: "e10",
        parentId: null,
        message: {
          role: "user",
          content: [
            { type: "image", mimeType: 42, data: false },
            { type: "image", mimeType: "image/png", data: "not-an-image" },
          ],
        },
      },
    ]);

    expect(records[0]).toMatchObject({
      kind: "user",
      images: [
        { entryId: "e10", contentIndex: 0, mimeType: undefined },
        { entryId: "e10", contentIndex: 1, mimeType: "image/png" },
      ],
    });
  });
});

test("persisted run starts survive reconstruction before and after the summary", () => {
  const entries = [
    { type: "message", id: "start", timestamp: new Date(1000).toISOString(), message: { role: "user", content: "Initial" } },
    { type: "custom", customType: "kintsugi.turn-start", data: { turnEntryId: "start", startedAt: 900 }, timestamp: new Date(1001).toISOString() },
    { type: "message", id: "steer", timestamp: new Date(2000).toISOString(), message: { role: "user", content: "Steer" } },
  ];
  const restored = recordsFromSessionEntries(JSON.parse(JSON.stringify(entries)));
  expect(restored[1]).toEqual({ kind: "runStart", turnEntryId: "start", startedAt: 900, timestamp: 1001 });
  expect(buildTranscript(restored).map((item) => item.type)).toEqual(["user", "user", "working"]);
  expect(buildTranscript(restored)[1]).toMatchObject({ type: "user", key: "steer" });
  expect(buildTranscript(restored)[2]).toMatchObject({ key: "start:working", inputEntryIds: ["start", "steer"] });
  const completed = recordsFromSessionEntries([...entries,
    { type: "custom", customType: "kintsugi.turn-timing", timestamp: new Date(3000).toISOString(), data: { turnEntryId: "start", outcome: "completed", elapsedMs: 2100, toolMs: 0, inferenceMs: 2100, outputTokens: 4, usageComplete: true } },
  ]);
  expect(buildTranscript(completed)[2]).toMatchObject({ key: "start:working", completedAt: 3000, timing: { outputTokens: 4 } });
});

test("validates persisted entry fields and assistant parts before projection", () => {
  const records = recordsFromSessionEntries([
    null,
    { type: "message", id: "invalid", message: { role: "user", content: 42 } },
    { type: "future-entry", id: "future" },
    { type: "message", id: "assistant", message: { role: "assistant", stopReason: "toolUse", content: [
      { type: "text", text: "Checking", textSignature: 42 },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "file.ts" } },
      { type: "toolCall", id: 42, name: "read", arguments: {} },
      { type: "future-part", text: "Ignored" },
    ] } },
  ]);
  expect(records).toEqual([{
    kind: "assistant", id: "assistant", timestamp: 0, stopReason: "toolUse", errorMessage: undefined,
    parts: [{ type: "text", text: "Checking" }, { type: "toolCall", callId: "call", name: "read", args: { path: "file.ts" } }],
  }]);
});

test("projects supported notices without requiring unrelated SDK metadata", () => {
  expect(recordsFromSessionEntries([
    { type: "usage", id: "usage", kind: "cache_warm", note: "prefill", usage: { input: 10, cacheRead: 20, cacheWrite: 30, cost: { total: 0.01 } } },
    { type: "message", id: "bash", message: { role: "bashExecution", command: "pwd", output: "/work" } },
    { type: "custom_message", id: "notice", content: [{ type: "text", text: "Note" }], display: true },
    { type: "message", id: "hidden", message: { role: "custom", content: "Hidden", display: false } },
  ])).toMatchObject([
    { kind: "note", id: "usage", text: "Cache warmed (prefill) · 60 tokens · $0.010", tone: "system" },
    { kind: "note", id: "bash", text: "`$ pwd`\n\n```\n/work\n```", tone: "system" },
    { kind: "note", id: "notice", text: "Note", tone: "summary" },
  ]);
});
