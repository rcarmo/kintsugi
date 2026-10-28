import { describe, expect, test } from "bun:test";
import { buildTranscript, finalAssistantText, findTranscriptItem, formatDuration, formatTokens, isFinalAssistantMessage, isToolViewDetails, toolDetailsIndicateError, toolOutcomeLabel, type TranscriptRecord } from "../../src/server/transcript.ts";

describe("transcript", () => {
  test("preserves record order, joins tool results, and ends Working when the final answer completes", () => {
    const records: TranscriptRecord[] = [
      { kind: "user", id: "u1", text: "go", images: [], timestamp: 1000 },
      { kind: "assistant", id: "a1", parts: [{ type: "thinking", text: "hmm" }, { type: "toolCall", callId: "c1", name: "bash", args: { command: "ls" } }], stopReason: "toolUse", timestamp: 2000 },
      { kind: "toolResult", callId: "c1", text: "file.txt", images: [], isError: false, timestamp: 3000, details: { exitCode: 0, displayAnsi: "file.txt" } },
      { kind: "assistant", id: "a2", parts: [{ type: "text", text: "Done." }], stopReason: "stop", timestamp: 4000 },
    ];
    const items = buildTranscript(records);
    expect(items.map((item) => item.type)).toEqual(["user", "working", "text"]);
    const working = items.find((item) => item.type === "working");
    expect(working?.type === "working" && working.items.map((item) => item.type)).toEqual(["thinking", "tool"]);
    const tool = findTranscriptItem(items, "tool:c1");
    expect(tool?.type === "tool" && tool.tool.resultText).toBe("file.txt");
    expect(tool?.type === "tool" && tool.tool.durationMs).toBe(1000);
    expect(working?.type === "working" && working.completedAt).toBe(4000);
    expect(working?.type === "working" && working.hasFinalAnswer).toBe(true);
    const text = items.at(-1);
    expect(text?.type === "text" && text.final).toBe(true);
  });

  test("keeps the last turn open when reading an active CLI transcript", () => {
    const records: TranscriptRecord[] = [
      { kind: "user", id: "u", text: "Run this", images: [], timestamp: 1000 },
      { kind: "assistant", id: "a", parts: [{ type: "toolCall", callId: "c", name: "bash", args: { command: "sleep 10" } }], stopReason: "toolUse", timestamp: 2000 },
    ];
    expect(buildTranscript(records)[1]).toMatchObject({ type: "working", stoppedAt: 2000 });
    expect(buildTranscript(records, { openEnded: true })[1]).toMatchObject({ type: "working", startedAt: 1000 });
    expect(buildTranscript(records, { openEnded: true })[1]).not.toHaveProperty("stoppedAt");
    const finished = [...records, { kind: "assistant" as const, id: "done", parts: [{ type: "text" as const, text: "Done" }], stopReason: "stop" as const, timestamp: 3000 }];
    expect(buildTranscript(finished, { openEnded: true })[1]).toMatchObject({ type: "working", completedAt: 3000 });
  });

  test("only first rendered part carries an assistant rewind boundary", () => {
    const items = buildTranscript([{ kind: "assistant", id: "a", parts: [{ type: "thinking", text: "one" }, { type: "text", text: "two" }], stopReason: "stop", timestamp: 1 }]);
    expect(items[0]?.rewindEntryId).toBe("a");
    expect(items[1]?.rewindEntryId).toBeUndefined();
  });

  test("reconstructs completed and interrupted historical working sections", () => {
    const items = buildTranscript([
      { kind: "user", id: "u1", text: "finish", images: [], timestamp: 1000 },
      { kind: "assistant", id: "a1", parts: [{ type: "thinking", text: "working" }, { type: "text", text: "Done" }], stopReason: "stop", timestamp: 4000 },
      { kind: "user", id: "u2", text: "cancel", images: [], timestamp: 5000 },
      { kind: "assistant", id: "a2", parts: [{ type: "text", text: "partial" }], stopReason: "aborted", timestamp: 7000 },
    ]);
    const sections = items.filter((item) => item.type === "working");
    expect(sections).toHaveLength(2);
    expect(sections[0]?.completedAt).toBe(4000);
    expect(sections[0]?.items.map((item) => item.type)).toEqual(["thinking"]);
    expect(sections[0]?.hasFinalAnswer).toBe(true);
    expect(sections[1]?.hasFinalAnswer).toBeUndefined();
    expect(sections[1]?.completedAt).toBeUndefined();
    expect(sections[1]?.stoppedAt).toBe(7000);
    expect(sections[1]?.items.map((item) => item.type)).toEqual(["text"]);
  });

  test("classifies final messages from content and pi stop reason", () => {
    const text = [{ type: "text", text: "done" }];
    expect(isFinalAssistantMessage(text, "stop")).toBe(true);
    expect(isFinalAssistantMessage(text, "length")).toBe(true);
    expect(isFinalAssistantMessage(text, "deferred")).toBe(true);
    expect(isFinalAssistantMessage(text, "toolUse")).toBe(false);
    expect(isFinalAssistantMessage(text, "pending")).toBe(false);
    expect(isFinalAssistantMessage(text, "error")).toBe(false);
    expect(isFinalAssistantMessage(text, "aborted")).toBe(false);
    expect(isFinalAssistantMessage([...text, { type: "toolCall" }], "stop")).toBe(false);
    expect(isFinalAssistantMessage([{ type: "text", text: " " }], "stop")).toBe(false);

    const commentary = { type: "text", text: "Progress", textSignature: JSON.stringify({ v: 1, phase: "commentary" }) };
    const final = { type: "text", text: "Done", textSignature: JSON.stringify({ v: 1, phase: "final_answer" }) };
    expect(isFinalAssistantMessage([commentary], "stop")).toBe(false);
    expect(isFinalAssistantMessage([commentary, final], "stop")).toBe(true);
    expect(finalAssistantText([commentary, final])).toBe("Done");
  });

  test("keeps session notices outside working with stable distinct keys", () => {
    const items = buildTranscript([
      { kind: "user", id: "u", text: "go", images: [], timestamp: 1000 },
      { kind: "note", text: "one", tone: "system", timestamp: 2000 },
      { kind: "note", text: "two", tone: "warning", timestamp: 3000 },
    ]);
    expect(items.filter((item) => item.type === "note").map((item) => item.key)).toEqual(["note:1", "note:2"]);
  });

  test("errors derive from result details", () => {
    expect(isToolViewDetails({ exitCode: 1, providerMetadata: { trace: "abc" } })).toBe(true);
    expect(isToolViewDetails({ exitCode: 1, optionalProducerField: undefined })).toBe(true);
    expect(isToolViewDetails({ exitCode: "1" })).toBe(false);
    expect(isToolViewDetails({ extensionCallback() {} })).toBe(false);
    expect(toolDetailsIndicateError({ exitCode: 1 })).toBe(true);
    expect(toolDetailsIndicateError({ timedOut: true })).toBe(true);
    expect(toolDetailsIndicateError({ exitCode: 0 })).toBe(false);
  });

  test("compact formatting is stable", () => {
    expect(formatDuration(1_023_000)).toBe("17m3s");
    expect(formatDuration(600_000)).toBe("10m");
    expect(formatTokens(4600)).toBe("4.6k");
    expect(formatTokens(1000)).toBe("1k");
  });
});

test("empty provider failures retain their detail and stop Working without a final response", () => {
  const items = buildTranscript([
    { kind: "user", id: "u", text: "go", images: [], timestamp: 1000 },
    { kind: "assistant", id: "a", parts: [], stopReason: "error", errorMessage: "Expected a provider request object.", timestamp: 1100 },
  ]);
  expect(items.map((item) => item.type)).toEqual(["user", "working", "error"]);
  const working = items[1];
  expect(working?.type).toBe("working");
  if (working?.type !== "working") throw new Error("Missing working section");
  expect(working.stoppedAt).toBe(1100);
  expect(working.completedAt).toBeUndefined();
  expect(working.items).toEqual([]);
  expect(items.at(-1)).toEqual({ type: "error", key: "a:error", text: "Expected a provider request object.", timestamp: 1100 });
});


test("older unmarked history retains its original per-user boundaries", () => {
  const items = buildTranscript([
    { kind: "user", id: "u1", text: "go", images: [], timestamp: 100 },
    { kind: "assistant", id: "a1", parts: [{ type: "thinking", text: "before steering" }], stopReason: "toolUse", timestamp: 200 },
    { kind: "user", id: "u2", text: "instead", images: [], timestamp: 300 },
    { kind: "assistant", id: "a2", parts: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 400 },
  ]);
  const blocks = items.filter(item => item.type === "working");
  expect(blocks.map(block => [block.key, block.completedAt])).toEqual([["u1:working", 300], ["u2:working", 400]]);
  expect(blocks[0]?.items.map(item => item.key)).toEqual(["a1:thinking:0"]);
  expect(items.filter(item => item.type === "text")).toHaveLength(1);
});

test("automatic retries keep their recoverable errors and subsequent tools inside one turn", () => {
  const items = buildTranscript([
    { kind: "user", id: "u", text: "go", images: [], timestamp: 100 },
    { kind: "assistant", id: "retry", parts: [], stopReason: "error", errorMessage: "busy", timestamp: 200 },
    { kind: "assistant", id: "a", parts: [{ type: "toolCall", callId: "tool", name: "bash", args: {} }], stopReason: "toolUse", timestamp: 300 },
    { kind: "toolResult", callId: "tool", text: "failed normally", images: [], isError: true, timestamp: 400 },
    { kind: "assistant", id: "final", parts: [{ type: "thinking", text: "resolved" }, { type: "text", text: "done" }], stopReason: "stop", timestamp: 500 },
  ]);
  expect(items.map(item => item.type)).toEqual(["user", "working", "text"]);
  const block = items[1];
  if (block?.type !== "working") throw new Error("Missing turn");
  expect(block.completedAt).toBe(500);
  expect(block.items.map(item => item.type)).toEqual(["error", "tool", "thinking"]);
  expect(findTranscriptItem(items, "tool:tool")).toMatchObject({ tool: { status: "error" } });
});

test("a restart-interrupted attempt folds into the run that recovered it, without a Run aborted error", () => {
  const items = buildTranscript([
    { kind: "user", id: "u", text: "go", images: [], timestamp: 1000 },
    { kind: "runStart", turnEntryId: "u", startedAt: 1000, timestamp: 1001 },
    { kind: "assistant", id: "a1", parts: [{ type: "toolCall", callId: "c1", name: "bash", args: {} }], stopReason: "toolUse", timestamp: 2000 },
    { kind: "toolResult", callId: "c1", text: "ok", images: [], isError: false, timestamp: 3000 },
    { kind: "assistant", id: "a2", parts: [{ type: "text", text: "partial" }], stopReason: "aborted", timestamp: 4000 },
    { kind: "assistant", id: "a3", parts: [{ type: "toolCall", callId: "c2", name: "bash", args: {} }], stopReason: "toolUse", timestamp: 5000 },
    { kind: "toolResult", callId: "c2", text: "recovered", images: [], isError: false, timestamp: 6000 },
    { kind: "assistant", id: "a4", parts: [{ type: "text", text: "Done" }], stopReason: "stop", timestamp: 7000 },
    { kind: "timing", turnEntryId: "u", outcome: "completed", timestamp: 7001,
      timing: { elapsedMs: 6001, toolMs: 3000, inferenceMs: 3001, outputTokens: 2, usageComplete: true } },
  ]);
  expect(items.map((item) => item.type)).toEqual(["user", "working", "text"]);
  const block = items[1];
  if (block?.type !== "working") throw new Error("Missing turn");
  expect(block.completedAt).toBe(7001);
  expect(block.stoppedAt).toBeUndefined();
  expect(block.items.map((item) => item.type)).toEqual(["tool", "text", "note", "tool"]);
  expect(findTranscriptItem(items, "a2:interrupted")).toMatchObject({
    type: "note", tone: "system", text: "Interrupted by a restart — continued automatically", timestamp: 4000,
  });
  expect(items.some((item) => item.type === "error")).toBe(false);
});

test("a stopped run keeps its Run aborted error and closes the turn", () => {
  const items = buildTranscript([
    { kind: "user", id: "u1", text: "go", images: [], timestamp: 1000 },
    { kind: "runStart", turnEntryId: "u1", startedAt: 1000, timestamp: 1001 },
    { kind: "assistant", id: "a1", parts: [{ type: "text", text: "partial" }], stopReason: "aborted", timestamp: 2000 },
    { kind: "user", id: "u2", text: "again", images: [], timestamp: 3000 },
    { kind: "runStart", turnEntryId: "u2", startedAt: 3000, timestamp: 3001 },
    { kind: "assistant", id: "a2", parts: [{ type: "text", text: "Done" }], stopReason: "stop", timestamp: 4000 },
    { kind: "timing", turnEntryId: "u2", outcome: "completed", timestamp: 4001,
      timing: { elapsedMs: 1001, toolMs: 0, inferenceMs: 1001, outputTokens: 2, usageComplete: true } },
  ]);
  expect(items.map((item) => item.type)).toEqual(["user", "working", "error", "user", "working", "text"]);
  expect(items[2]).toMatchObject({ type: "error", key: "a1:aborted", text: "Run aborted", timestamp: 2000 });
  const blocks = items.filter((item) => item.type === "working");
  expect(blocks[0]).toMatchObject({ key: "u1:working", stoppedAt: 2000 });
  expect(blocks[1]).toMatchObject({ key: "u2:working", completedAt: 4001 });
});

test("selected branch paths retain the start identity without mixing continuations", () => {
  const start: TranscriptRecord = { kind: "user", id: "shared", text: "go", images: [], timestamp: 100 };
  const branch = (id: string) => buildTranscript([start,
    { kind: "assistant", id, parts: [{ type: "thinking", text: id }, { type: "text", text: "done" }], stopReason: "stop", timestamp: 200 },
  ]);
  expect(branch("left")[1]?.key).toBe("shared:working");
  expect(branch("right")[1]?.key).toBe("shared:working");
  expect(findTranscriptItem(branch("left"), "right:thinking:0")).toBeUndefined();
  expect(findTranscriptItem(branch("right"), "left:thinking:0")).toBeUndefined();
});

describe("persisted run boundaries", () => {
  const initial: TranscriptRecord[] = [
    { kind: "user", id: "initial", text: "Start", images: [], timestamp: 1000 },
    { kind: "runStart", turnEntryId: "initial", startedAt: 900, timestamp: 1001 },
    { kind: "assistant", id: "progress", parts: [{ type: "thinking", text: "Before steering" }], stopReason: "toolUse", timestamp: 2000 },
    { kind: "user", id: "steer", text: "Focus here", images: [], timestamp: 3000 },
  ];

  test("steering ends the block it interrupted and starts its own", () => {
    const items = buildTranscript([...initial,
      { kind: "assistant", id: "after", parts: [{ type: "thinking", text: "After steering" }, { type: "text", text: "Final answer" }], stopReason: "stop", timestamp: 5000 },
    ], { openEnded: true });
    expect(items.map((item) => item.type)).toEqual(["user", "working", "user", "working", "text"]);
    expect(items[1]).toMatchObject({ key: "initial:working", startedAt: 900, completedAt: 3000, items: [{ text: "Before steering" }] });
    expect(items[2]).toEqual({ type: "user", key: "steer", text: "Focus here", images: [], rewindEntryId: "steer", timestamp: 3000 });
    expect(items[3]).toMatchObject({ key: "steer:working", inputEntryIds: ["steer"], startedAt: 3000, hasFinalAnswer: true, items: [{ text: "After steering" }] });
    // Only the run's end, not an answer, finishes the block.
    expect(items[3]).not.toHaveProperty("completedAt");
    expect(items[4]).toMatchObject({ text: "Final answer", final: true });
  });

  test("unfinished history stops only the block steering started", () => {
    const items = buildTranscript(initial);
    expect(items.map((item) => item.type)).toEqual(["user", "working", "user", "working"]);
    expect(items[1]).toMatchObject({ key: "initial:working", completedAt: 3000 });
    expect(items[3]).toMatchObject({ key: "steer:working", stoppedAt: 3000 });
  });

  test("input read together shares one block", () => {
    const items = buildTranscript([...initial,
      { kind: "user", id: "steer2", text: "One more thing", images: [], timestamp: 3000 },
      { kind: "assistant", id: "answer", parts: [{ type: "text", text: "Last answer" }], stopReason: "stop", timestamp: 5000 },
      { kind: "user", id: "next", text: "Next run", images: [], timestamp: 7000 },
      { kind: "runStart", turnEntryId: "next", startedAt: 7000, timestamp: 7001 },
    ], { openEnded: true });
    expect(items.map((item) => item.key)).toEqual(["initial", "initial:working", "steer", "steer2", "steer:working", "answer:text:0", "next", "next:working"]);
    expect(items[4]).toMatchObject({ inputEntryIds: ["steer", "steer2"], stoppedAt: 7000 });
  });

  test("a retry followed by steering stays inside the same run", () => {
    const items = buildTranscript([initial[0]!, initial[1]!,
      { kind: "assistant", id: "retry", parts: [], stopReason: "error", errorMessage: "Retryable", timestamp: 2000 }, initial[3]!,
      { kind: "assistant", id: "answer", parts: [{ type: "text", text: "Recovered" }], stopReason: "stop", timestamp: 5000 },
    ]);
    expect(items.map((item) => item.type)).toEqual(["user", "working", "user", "working", "text"]);
    expect(items[1]).toMatchObject({ items: [{ type: "error", text: "Retryable" }], completedAt: 3000 });
  });
});

test("a new persisted run after an interrupted run stops the old block rather than completing it", () => {
  const items = buildTranscript([
    { kind: "user", id: "old", text: "Interrupted request", images: [], timestamp: 1000 },
    { kind: "runStart", turnEntryId: "old", startedAt: 1000, timestamp: 1001 },
    { kind: "assistant", id: "a", parts: [{ type: "thinking", text: "Working on it" }], stopReason: "toolUse", timestamp: 1500 },
    { kind: "user", id: "steer", text: "Steering before interruption", images: [], timestamp: 2000 },
    { kind: "user", id: "new", text: "Restart recovery", images: [], timestamp: 5000 },
    { kind: "runStart", turnEntryId: "new", startedAt: 5000, timestamp: 5001 },
    { kind: "assistant", id: "final", parts: [{ type: "text", text: "Recovered" }], stopReason: "stop", timestamp: 6000 },
    { kind: "timing", turnEntryId: "new", outcome: "completed", timestamp: 6001,
      timing: { elapsedMs: 1001, toolMs: 0, inferenceMs: 1001, outputTokens: 2, usageComplete: true } },
  ]);
  expect(items.map((item) => item.type)).toEqual(["user", "working", "user", "working", "user", "working", "text"]);
  const blocks = items.filter((item) => item.type === "working");
  expect(blocks[0]).toMatchObject({ key: "old:working", completedAt: 2000 });
  expect(blocks[1]).toMatchObject({ key: "steer:working", inputEntryIds: ["steer"], stoppedAt: 5000 });
  expect(blocks[2]).toMatchObject({ key: "new:working", inputEntryIds: ["new"], completedAt: 6001 });
});

test("a finished tool call's outcome reads the same for every tool row", () => {
  expect(toolOutcomeLabel({ exitCode: 0 }, false)).toBe("");
  expect(toolOutcomeLabel({ exitCode: 2 }, false)).toBe("exitcode 2");
  // A timed-out or stopped command is not an error result, but it did not succeed.
  expect(toolOutcomeLabel({ timedOut: true, exitCode: 0 }, false)).toBe("timed out");
  expect(toolOutcomeLabel({ aborted: true }, true)).toBe("aborted");
  expect(toolOutcomeLabel(undefined, true)).toBe("failed");
});
