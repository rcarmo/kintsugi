import { expect, test } from "bun:test";
import { claudeRows } from "../src/server/rows.ts";
import { ClaudeState } from "../src/server/state.ts";
import { projectClaudeTranscript } from "../src/server/transcript.ts";

const timestamp = "2026-10-20T12:00:00Z";
const text = "<task-notification><summary>Suite passed</summary></task-notification>";

test("queued task delivery needs native run provenance; a user can steer with literal notification XML", () => {
  const row = { type: "attachment", uuid: "delivery", timestamp, attachment: { type: "queued_command", prompt: text, source_uuid: "steering" } };
  expect(claudeRows(JSON.stringify(row))).toMatchObject([{ kind: "steer", uuid: "steering", content: [{ type: "text", text }] }]);
  expect(claudeRows(JSON.stringify({ ...row, attachment: { ...row.attachment, runId: "run-1" } }))).toMatchObject([{ kind: "task", runId: "run-1", summary: "Suite passed" }]);
});

test("steering retains image blocks and their session references", () => {
  const content = [{ type: "text", text: "Review this image" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture-image" } }];
  const state = new ClaudeState();
  state.hydrate(claudeRows(JSON.stringify({ type: "attachment", uuid: "image-delivery", timestamp, attachment: { type: "queued_command", prompt: content, source_uuid: "steering" } })));
  expect(state.rows[0]).toMatchObject({ kind: "steer", content });
  expect(projectClaudeTranscript(state, true)).toMatchObject([
    { type: "user", text: "Review this image", images: [{ entryId: "steering", contentIndex: 0, mimeType: "image/png" }] },
    { type: "working", key: "steering:working", live: true },
  ]);
});

test("canonical local command output replaces its streamed synthetic reply and cannot answer the next turn", () => {
  const command = { type: "user", uuid: "command", timestamp, message: { content: "/code-review" } };
  const output = { type: "system", subtype: "local_command", uuid: "00000000-0000-0000-0000-000000000001", timestamp, content: "<local-command-stdout>Review complete</local-command-stdout>" };
  const state = new ClaudeState();
  state.hydrate(claudeRows(JSON.stringify(command)));
  state.receive({ type: "assistant", uuid: "00000000-0000-0000-0000-000000000001", parent_tool_use_id: null, session_id: "fixture", message: {
    id: "synthetic", type: "message", role: "assistant", model: "<synthetic>",
    container: null, context_management: null, diagnostics: null, stop_reason: "end_turn", stop_sequence: null, stop_details: null,
    content: [{ type: "text", text: "Review complete", citations: null }],
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, cache_creation: null, server_tool_use: null, service_tier: null, inference_geo: null, fallback_credit: null, iterations: null, output_tokens_details: null, speed: null },
  } });
  expect(state.rows.at(-1)).toMatchObject({ kind: "output", uuid: "00000000-0000-0000-0000-000000000001", text: "Review complete" });
  state.merge(claudeRows([command, output, { type: "user", uuid: "next", timestamp, message: { content: "Next task" } }].map(row => JSON.stringify(row)).join("\n")));
  expect(state.rows.filter(row => row.uuid === "00000000-0000-0000-0000-000000000001")).toHaveLength(1);
  const items = projectClaudeTranscript(state, false);
  expect(items.filter(item => item.type === "text")).toMatchObject([{ text: "Review complete", final: true }]);
  expect(items.at(-1)).toMatchObject({ type: "working", items: [], hasFinalAnswer: false });
});
