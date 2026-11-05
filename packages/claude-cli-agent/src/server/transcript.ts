import { nativeJsonlRows, nativeImageTypes, nativeImageResponse, nativeTimestamp } from "@kintsugi/cli-agent/server";
import { join } from "node:path";
import { getKintsugiRuntimeContext, readTextIfExists } from "@kintsugi/core";
import type { TranscriptRecord } from "@kintsugi/agent/server/transcript";
import { workspaceRoot } from "@kintsugi/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const imageSourceSchema = Type.Object({ type: Type.Literal("base64"), media_type: Type.String(), data: Type.String() });
const resultBlockSchema = Type.Object({ type: Type.String(), text: Type.Optional(Type.String()), source: Type.Optional(imageSourceSchema) });
const bashInputSchema = Type.Object({ timeout: Type.Optional(Type.Number()) });
const editInputSchema = Type.Object({ file_path: Type.String(), old_string: Type.String(), new_string: Type.String(), replace_all: Type.Optional(Type.Boolean()) });
const blockSchema = Type.Object({
  type: Type.String(), text: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()),
  source: Type.Optional(imageSourceSchema),
  id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), input: Type.Optional(Type.Unknown()),
  tool_use_id: Type.Optional(Type.String()), is_error: Type.Optional(Type.Boolean()),
  content: Type.Optional(Type.Union([Type.String(), Type.Array(resultBlockSchema)])),
});
const messageSchema = Type.Object({
  content: Type.Union([Type.String(), Type.Array(blockSchema)]),
  stop_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const rowSchema = Type.Object({
  type: Type.String(), uuid: Type.Optional(Type.String()), parentUuid: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  timestamp: Type.Optional(Type.String()), isSidechain: Type.Optional(Type.Boolean()), isMeta: Type.Optional(Type.Boolean()),
  subtype: Type.Optional(Type.String()), message: Type.Optional(messageSchema),
});
type ClaudeBlock = Static<typeof blockSchema>;

type ProjectedToolCall = { name: string; args: unknown };
/** Claude's file and shell tools render like Kintsugi's own. */
export function claudeToolCall(block: Pick<ClaudeBlock, "name" | "input">): ProjectedToolCall {
  // Claude's Bash timeout is in milliseconds and defaults to two minutes; Kintsugi's is in seconds.
  if (block.name === "Bash") return { name: "bash", args: Value.Check(bashInputSchema, block.input) ? { ...block.input, timeout: (block.input.timeout ?? 120_000) / 1000 } : block.input };
  if (block.name === "Read") return { name: "read", args: block.input };
  if (block.name === "Write") return { name: "write", args: block.input };
  if (block.name === "Edit" && Value.Check(editInputSchema, block.input) && block.input.replace_all !== true) {
    const { old_string, new_string, ...args } = block.input;
    return { name: "edit", args: { ...args, oldText: old_string, newText: new_string } };
  }
  return { name: block.name ?? "", args: block.input };
}
function imageSources(blocks: ClaudeBlock[]): Array<Static<typeof imageSourceSchema>> {
  return blocks.flatMap((block) => {
    if (block.type === "image" && block.source && nativeImageTypes.has(block.source.media_type)) return [block.source];
    if (block.type === "tool_result" && Array.isArray(block.content)) return block.content.flatMap((part) => part.type === "image" && part.source && nativeImageTypes.has(part.source.media_type) ? [part.source] : []);
    return [];
  });
}
function resultText(value: ClaudeBlock["content"]): string {
  if (!Array.isArray(value)) return value ?? "";
  return value.filter((block) => block.type === "text").map((block) => block.text ?? "").filter(Boolean).join("\n");
}

/** Claude Code's native JSONL is untrusted, append-only input; never turn it into a Pi session. */
export function claudeTranscriptRecords(jsonl: string): TranscriptRecord[] {
  const rows = Array.from(nativeJsonlRows(jsonl, rowSchema));
  // Claude can rewind and fork. Display the ancestry of the last mainline message,
  // not abandoned alternatives or independent subagents.
  const byId = new Map(rows.flatMap((row) => row.uuid ? [[row.uuid, row] as const] : []));
  const leaf = rows.findLast((row) => (row.type === "user" || row.type === "assistant") && row.isSidechain !== true && row.uuid);
  const lineage = new Set<string>();
  let current = leaf;
  while (current?.uuid && !lineage.has(current.uuid)) {
    lineage.add(current.uuid);
    current = byId.get(current.parentUuid ?? "");
  }
  const records: TranscriptRecord[] = [];
  for (const row of rows) {
    const id = row.uuid;
    if (!id || !lineage.has(id)) continue;
    const message = row.message;
    const time = nativeTimestamp(row.timestamp);
    if (row.type === "user" && message) {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const images: Extract<TranscriptRecord, { kind: "user" }>["images"] = [];
      let imageIndex = 0;
      for (const block of blocks) {
        const refs = imageSources([block]).map((source) => ({ entryId: id, contentIndex: imageIndex++, mimeType: source.media_type }));
        if (block.type === "image") images.push(...refs);
        if (block.type === "tool_result" && block.tool_use_id) {
          records.push({ kind: "toolResult", callId: block.tool_use_id, text: resultText(block.content), images: refs, isError: block.is_error === true, timestamp: time });
        }
      }
      const text = Array.isArray(message.content) ? blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n") : message.content;
      if ((text || images.length) && row.isMeta !== true) records.push({ kind: "user", id, text, images, timestamp: time, rewindable: false });
    } else if (row.type === "assistant" && message) {
      const content: Extract<TranscriptRecord, { kind: "assistant" }>["parts"] = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === "thinking") content.push({ type: "thinking", text: block.thinking ?? "" });
        else if (block.type === "text") content.push({ type: "text", text: block.text ?? "" });
        else if (block.type === "tool_use" && block.id && block.name) content.push({ type: "toolCall", callId: block.id, ...claudeToolCall(block) });
      }
      if (content.length) records.push({ kind: "assistant", id, parts: content, stopReason: message.stop_reason === "end_turn" ? "stop" : "toolUse", timestamp: time });
    } else if (row.type === "system" && row.subtype === "compact_boundary") {
      records.push({ kind: "note", id, text: "Context compacted", tone: "system", timestamp: time });
    }
  }
  return records;
}

/**
 * Claude's Stop hook fires before the turn's final messages leave its batched write queue.
 * After the Stop hooks finish it queues a stop_hook_summary behind them, so the turn is
 * complete on disk once that summary follows the last message.
 */
export function claudeTurnSettled(jsonl: string): boolean {
  let settled = false;
  for (const row of nativeJsonlRows(jsonl, rowSchema)) {
    if (row.isSidechain === true) continue;
    if (row.type === "user" || row.type === "assistant") settled = false;
    else if (row.type === "system" && row.subtype === "stop_hook_summary") settled = true;
  }
  return settled;
}

function nativeSessionPath(sessionId: string): string {
  return join(getKintsugiRuntimeContext().kintsugiDataDir, "home", ".claude", "projects", workspaceRoot.replaceAll("/", "-"), `${sessionId}.jsonl`);
}
export async function loadClaudeTranscript(_workspaceId: string, sessionId: string): Promise<TranscriptRecord[] | undefined> {
  const text = await readTextIfExists(nativeSessionPath(sessionId));
  return text === undefined ? undefined : claudeTranscriptRecords(text);
}

export async function hasClaudeTurnSettled(_workspaceId: string, sessionId: string): Promise<boolean> {
  const text = await readTextIfExists(nativeSessionPath(sessionId));
  return text !== undefined && claudeTurnSettled(text);
}

export async function loadClaudeTranscriptImage(_workspaceId: string, sessionId: string, entryId: string, contentIndex: number): Promise<Response> {
  const text = await readTextIfExists(nativeSessionPath(sessionId));
  if (text === undefined) return new Response("Not found", { status: 404 });
  for (const row of nativeJsonlRows(text, rowSchema)) {
    if (row.uuid !== entryId || !row.message || !Array.isArray(row.message.content)) continue;
    const source = imageSources(row.message.content)[contentIndex];
    if (!source) break;
    return nativeImageResponse(source.data, source.media_type);
  }
  return new Response("Not found", { status: 404 });
}

export async function claudeHistoryFiles(_workspaceId: string, sessionId: string): Promise<string[]> {
  const path = nativeSessionPath(sessionId);
  return await Bun.file(path).exists() ? [path] : [];
}

export async function hasClaudeSession(sessionId: string): Promise<boolean> {
  return Bun.file(nativeSessionPath(sessionId)).exists();
}
