import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piResumePath, loadPiTranscript, loadPiTranscriptImage, piTranscriptRecords } from "../src/server/transcript.ts";

function row(id: string, parentId: string | null, type: string, extra: { message?: { role: string; content: object[]; stopReason?: string; toolCallId?: string; isError?: boolean }; summary?: string }) {
  return JSON.stringify({ type, id, parentId, timestamp: "2026-01-01T00:00:00.000Z", ...extra });
}

test("projects the active Pi branch into the shared readonly transcript", () => {
  const text = [
    row("u", null, "message", { message: { role: "user", content: [{ type: "text", text: "Find it" }] } }),
    row("old", "u", "message", { message: { role: "assistant", content: [{ type: "text", text: "Discarded" }], stopReason: "stop" } }),
    row("a", "u", "message", { message: { role: "assistant", content: [{ type: "thinking", thinking: "Searching" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "file.ts" } }], stopReason: "toolUse" } }),
    row("r", "a", "message", { message: { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "Found" }], isError: false } }),
    row("f", "r", "message", { message: { role: "assistant", content: [{ type: "text", text: "Here it is" }], stopReason: "stop" } }),
    row("c", "f", "compaction", { summary: "Summary" }),
    '{"type":"message"',
  ].join("\n");
  expect(piTranscriptRecords(text)).toMatchObject([
    { kind: "user", text: "Find it" },
    { kind: "assistant", parts: [{ type: "thinking", text: "Searching" }, { type: "toolCall", callId: "call", name: "read" }] },
    { kind: "toolResult", callId: "call", text: "Found" },
    { kind: "assistant", parts: [{ type: "text", text: "Here it is" }] },
    { kind: "note", text: "Context compacted" },
  ]);
});

test("loads native session files and serves only supported embedded images", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-transcript-"));
  const previous = process.env.KINTSUGI_DATA_DIR;
  process.env.KINTSUGI_DATA_DIR = root;
  try {
    const directory = join(root, "workspaces/ws/home-local/.local/share/pi/sessions/tab");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "2026_session.jsonl"), [
      row("u", null, "message", { message: { role: "user", content: [{ type: "text", text: "Look" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] } }),
      row("r", "u", "message", { message: { role: "toolResult", toolCallId: "call", content: [{ type: "image", mimeType: "image/svg+xml", data: "aGVsbG8=" }] } }),
    ].join("\n"));
    expect(await loadPiTranscript("ws", "tab")).toMatchObject([
      { kind: "user", images: [{ entryId: "u", contentIndex: 1, mimeType: "image/png" }] },
      { kind: "toolResult", images: [] },
    ]);
    expect(await piResumePath("ws", "tab")).toBe("/home/agent/.local/share/pi/sessions/tab/2026_session.jsonl");
    expect(await piResumePath("ws", "other-tab")).toBeUndefined();
    const image = await loadPiTranscriptImage("ws", "tab", "u", 1);
    expect(image.status).toBe(200);
    expect(await image.text()).toBe("hello");
    expect((await loadPiTranscriptImage("ws", "tab", "r", 0)).status).toBe(404);
  } finally {
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
