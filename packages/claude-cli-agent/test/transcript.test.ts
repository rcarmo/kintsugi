import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeToolCall, claudeTranscriptRecords, claudeTurnSettled, loadClaudeTranscriptImage } from "../src/server/transcript.ts";

type Image = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
type Content = string | Array<{ type: string; thinking?: string; text?: string; id?: string; name?: string; input?: { command: string } | { file_path: string; old_string: string; new_string: string; replace_all?: boolean }; tool_use_id?: string; content?: string | Array<Image>; is_error?: boolean; source?: Image["source"] }>;
function row(uuid: string, parentUuid: string | null, type: string, content: Content, extras: { isSidechain?: boolean; message?: { content: Content; stop_reason: string } } = {}) {
  return JSON.stringify({ uuid, parentUuid, type, timestamp: "2026-01-01T00:00:00.000Z", message: { content, stop_reason: type === "assistant" ? "end_turn" : undefined }, ...extras });
}

test("projects Claude user, thinking, text, tools and results into transcript records", () => {
  const lines = [
    row("u", null, "user", "Find the file"),
    row("a", "u", "assistant", [{ type: "thinking", thinking: "Search" }, { type: "tool_use", id: "call", name: "Bash", input: { command: "ls" } }], { message: { content: [{ type: "thinking", thinking: "Search" }, { type: "tool_use", id: "call", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" } }),
    row("r", "a", "user", [{ type: "tool_result", tool_use_id: "call", content: "file.ts" }]),
    row("f", "r", "assistant", [{ type: "text", text: "Found it" }]),
  ].join("\n");
  const records = claudeTranscriptRecords(lines);
  expect(records.map((record) => record.kind)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  expect(records[1]).toMatchObject({ parts: [{ type: "thinking", text: "Search" }, { type: "toolCall", callId: "call", name: "bash" }] });
  expect(records[2]).toMatchObject({ callId: "call", text: "file.ts" });
  expect(records[3]).toMatchObject({ stopReason: "stop", parts: [{ type: "text", text: "Found it" }] });
});

test("converts Claude's millisecond Bash timeout to the seconds the bash visualization expects", () => {
  expect(claudeToolCall({ name: "Bash", input: { command: "ls", timeout: 300_000 } })).toEqual({ name: "bash", args: { command: "ls", timeout: 300 } });
  expect(claudeToolCall({ name: "Bash", input: { command: "ls" } })).toEqual({ name: "bash", args: { command: "ls", timeout: 120 } });
});

test("preserves image references and failed tool results", () => {
  const text = [row("u", null, "user", [{ type: "text", text: "What is this?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }]), row("a", "u", "assistant", [{ type: "tool_use", id: "call", name: "Read", input: { command: "file" } }]), row("r", "a", "user", [{ type: "tool_result", tool_use_id: "call", content: "missing", is_error: true }])].join("\n");
  const records = claudeTranscriptRecords(text);
  expect(records[0]).toMatchObject({ kind: "user", images: [{ entryId: "u", contentIndex: 0, mimeType: "image/png" }] });
  expect(records[1]).toMatchObject({ parts: [{ type: "toolCall", name: "read" }] });
  expect(records[2]).toMatchObject({ kind: "toolResult", isError: true });
});

test("connects images in tool results to the Read visualization", () => {
  const text = [row("u", null, "user", "Read the image"), row("a", "u", "assistant", [{ type: "tool_use", id: "call", name: "Read", input: { command: "image.png" } }]), row("r", "a", "user", [{ type: "tool_result", tool_use_id: "call", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] }])].join("\n");
  expect(claudeTranscriptRecords(text)[2]).toMatchObject({ kind: "toolResult", callId: "call", images: [{ entryId: "r", contentIndex: 0, mimeType: "image/png" }] });
});

test("serves a nested tool-result image through the transcript image route's source", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-"));
  const previous = process.env.KINTSUGI_DATA_DIR;
  process.env.KINTSUGI_DATA_DIR = root;
  try {
    const path = join(root, "home/.claude/projects/-work/session.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, row("r", null, "user", [{ type: "tool_result", tool_use_id: "call", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] }]));
    const response = await loadClaudeTranscriptImage("workspace", "session", "r", 0);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("hello");
  } finally {
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("adapts Claude Edit replacements for the existing diff visualization without claiming replace-all is one edit", () => {
  const text = [row("u", null, "user", "Edit"), row("a", "u", "assistant", [
    { type: "tool_use", id: "one", name: "Edit", input: { file_path: "a.ts", old_string: "old", new_string: "new", replace_all: false } },
    { type: "tool_use", id: "all", name: "Edit", input: { file_path: "b.ts", old_string: "old", new_string: "new", replace_all: true } },
  ])].join("\n");
  expect(claudeTranscriptRecords(text)[1]).toMatchObject({ parts: [
    { type: "toolCall", name: "edit", args: { file_path: "a.ts", oldText: "old", newText: "new" } },
    { type: "toolCall", name: "Edit", args: { replace_all: true } },
  ] });
});

test("follows the current branch, ignores sidechains and incomplete final JSONL writes", () => {
  const text = [row("u", null, "user", "Hello"), row("old", "u", "assistant", [{ type: "text", text: "Discarded" }]), row("new", "u", "assistant", [{ type: "text", text: "Current" }]), row("side", "new", "assistant", [{ type: "text", text: "Sidechain" }], { isSidechain: true }), '{"type":"assistant"'].join("\n");
  expect(claudeTranscriptRecords(text).map((record) => record.kind === "assistant" ? record.parts[0] : record.kind)).toEqual(["user", { type: "text", text: "Current" }]);
});

test("a turn has settled once Claude's stop hook summary follows its last message", () => {
  const system = (uuid: string, parentUuid: string, subtype: string) => JSON.stringify({ uuid, parentUuid, type: "system", subtype });
  const prompt = row("u", null, "user", "Write a poem");
  const thinking = row("t", "u", "assistant", [{ type: "thinking", thinking: "Rhymes" }]);
  const answer = row("a", "t", "assistant", [{ type: "text", text: "Fish glide free" }]);
  const summary = system("s", "a", "stop_hook_summary");
  // As written when the Stop hook fires: the answer is still in Claude's write queue.
  expect(claudeTurnSettled([prompt, thinking].join("\n"))).toBe(false);
  expect(claudeTurnSettled([prompt, thinking, answer].join("\n"))).toBe(false);
  expect(claudeTurnSettled([prompt, thinking, answer, summary, system("d", "s", "turn_duration")].join("\n") + "\n")).toBe(true);
  expect(claudeTurnSettled([prompt, thinking, answer, summary, row("n", "s", "user", "Another")].join("\n"))).toBe(false);
  expect(claudeTurnSettled([prompt, answer, summary, row("x", "s", "assistant", [{ type: "text", text: "Subagent" }], { isSidechain: true })].join("\n"))).toBe(true);
  expect(claudeTurnSettled([prompt, answer, `${summary.slice(0, 20)}`].join("\n"))).toBe(false);
});
