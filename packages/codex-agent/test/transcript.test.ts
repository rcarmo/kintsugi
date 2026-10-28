import { expect, test } from "bun:test";
import { projectCodexTurns } from "../src/server/transcript.ts";
import type { Turn } from "../src/protocol.ts";

test("steering Codex read mid-turn ends the block it interrupted and starts its own, timed only where live notifications timed it", () => {
  const turn: Turn = { id: "turn", itemsView: "full", status: "completed", error: null, startedAt: 10, completedAt: 40, durationMs: 30_000, items: [
    { type: "userMessage", id: "prompt", clientId: "prompt", content: [{ type: "text", text: "Start", text_elements: [] }] },
    { type: "reasoning", id: "command", summary: ["Looking around"], content: [] },
    { type: "userMessage", id: "steer", clientId: "steer", content: [{ type: "text", text: "Instead", text_elements: [] }] },
    { type: "reasoning", id: "thought", summary: ["Changing course"], content: [] },
    { type: "agentMessage", id: "answer", text: "Done", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
  ] };
  const keys = (items: ReturnType<typeof projectCodexTurns>) => items.map(item => item.key);
  const history = projectCodexTurns([turn], new Set());
  expect(keys(history)).toEqual(["prompt", "turn", "steer", "turn:steer", "answer"]);
  expect(history[1]).toMatchObject({ startedAt: 10_000, completedAt: 10_000, durationUnavailable: true, hasFinalAnswer: false, items: [{ key: "command" }] });
  expect(history[3]).toMatchObject({ completedAt: 40_000, durationUnavailable: true, hasFinalAnswer: true, items: [{ key: "thought" }] });
  const live = projectCodexTurns([turn], new Set(), new Map([["command", 11_000], ["thought", 25_000]]));
  expect(live[1]).toMatchObject({ startedAt: 10_000, completedAt: 25_000 });
  expect(live[1]).not.toHaveProperty("durationUnavailable", true);
  expect(live[3]).toMatchObject({ startedAt: 25_000, completedAt: 40_000 });
  expect(live[3]).not.toHaveProperty("durationUnavailable", true);
});
