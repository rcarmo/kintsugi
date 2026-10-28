import type { ToolView, TranscriptItem, WorkingTranscriptItem } from "@kintsugi/agent/server/transcript";
import { claudeToolCall } from "@kintsugi/claude-cli-agent/transcript";
import { claudeImageSources, claudeText, claudeUserIntent, type ClaudeBlock } from "./rows.ts";
import type { ClaudeState } from "./state.ts";

function resultText(block: ClaudeBlock): string {
  if (!Array.isArray(block.content)) return block.content ?? "";
  return block.content.filter(part => part.type === "text").map(part => part.text ?? "").filter(Boolean).join("\n");
}

/** Claude retries failed requests itself and records an error only once it gives up, ending the turn. */
interface Turn { prompt?: TranscriptItem; command: boolean; working: WorkingTranscriptItem; endedAt: number; interrupted: boolean; error?: TranscriptItem }

/** Claude rows and the block it is streaming, grouped like every other Agent's turns. `running` is whether Claude's latest turn is still going. */
export function projectClaudeTranscript(state: Pick<ClaudeState, "rows" | "streaming">, running: boolean): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, ToolView>();
  const positions = new Map<string, number>();
  let turn: Turn | undefined;
  /** `steered` ends a turn's block where steering came in: Claude carries on, so its last text is still commentary. */
  const finish = (live = false, steered = false) => {
    if (!turn) return;
    const { working } = turn;
    // The last reply after its final tool call answers the prompt; earlier text was commentary.
    const index = working.items.findLastIndex(item => item.type !== "note");
    const final = !live && !steered && !turn.error && working.items[index]?.type === "text" ? working.items.splice(index, 1)[0] : undefined;
    if (final?.type === "text") final.final = true;
    working.hasFinalAnswer = Boolean(final);
    working.live = live;
    if (!live) {
      if (turn.interrupted || turn.error) working.stoppedAt = turn.endedAt;
      else working.completedAt = turn.endedAt;
    }
    items.push(...turn.prompt ? [turn.prompt] : [], working, ...final ? [final] : [], ...turn.error ? [turn.error] : []);
    turn = undefined;
  };
  const activity = (item: TranscriptItem, timestamp: number) => {
    item.timestamp = timestamp;
    if (!turn) { items.push(item); return; }
    turn.working.items.push(item);
    turn.endedAt = Math.max(turn.endedAt, timestamp);
  };
  const assistantBlock = (block: { type: string; text: string; id?: string; name?: string; input?: unknown }, key: string, timestamp: number, live: boolean) => {
    if (block.type === "thinking") {
      if (block.text.trim()) activity({ type: "thinking", key, text: block.text, live }, timestamp);
    } else if (block.type === "text") {
      if (block.text.trim()) activity({ type: "text", key, text: block.text, final: false, live }, timestamp);
    } else if (block.type === "tool_use" && block.id) {
      const call = claudeToolCall({ name: block.name, input: block.input });
      const tool: ToolView = { callId: block.id, name: call.name, args: call.args ?? {}, status: live ? "streaming" : "running", issuedAt: timestamp };
      tools.set(block.id, tool);
      activity({ type: "tool", key: `tool:${block.id}`, tool }, timestamp);
    }
  };
  const rows = state.rows;
  // Claude records a manual compaction before the /compact command that caused it.
  let compaction: TranscriptItem | undefined;
  // A control command's output, such as "Set model to …", already shows in the footer.
  let controlOutput = false;
  // Claude has yet to end its turn: a background task finishing now is absorbed into it, rather than reported in a turn of its own.
  let answering = false;
  const begin = (prompt: TranscriptItem, uuid: string, timestamp: number, steered = false) => {
    if (turn && steered) turn.endedAt = Math.max(turn.endedAt, timestamp);
    finish(false, steered);
    prompt.timestamp = timestamp;
    turn = { prompt, command: prompt.type === "user" && prompt.text.startsWith("/"), working: { type: "working", key: `${uuid}:working`, startedAt: timestamp, items: compaction ? [compaction] : [] }, endedAt: timestamp, interrupted: false };
    compaction = undefined;
    answering = true;
  };
  rows.forEach((row, index) => {
    if (row.kind === "task") {
      const note: TranscriptItem = { type: "note", key: row.uuid, text: row.summary, tone: "system" };
      if (answering) activity(note, row.timestamp);
      else begin(note, row.uuid, row.timestamp);
    } else if (row.kind === "user") {
      const intent = claudeUserIntent(row);
      if (intent?.kind === "prompt") begin({ type: "user", key: row.uuid, text: intent.text, images: intent.images }, row.uuid, row.timestamp);
      else if (intent?.kind === "control") controlOutput = true;
      else if (intent?.kind === "output" && controlOutput) controlOutput = false;
      else if (intent?.kind === "output") activity({ type: "note", key: `${row.uuid}:output`, text: intent.text, tone: "system" }, row.timestamp);
      else if (intent?.kind === "interrupted") {
        answering = false;
        if (turn) { turn.interrupted = true; turn.endedAt = Math.max(turn.endedAt, row.timestamp); }
      }
      for (const block of row.content) {
        const tool = block.type === "tool_result" && block.tool_use_id ? tools.get(block.tool_use_id) : undefined;
        if (!tool) continue;
        tool.status = block.is_error ? "error" : "ok";
        tool.resultText = resultText(block);
        const images = claudeImageSources([block]);
        if (images.length) {
          const offset = claudeImageSources(row.content.slice(0, row.content.indexOf(block))).length;
          tool.resultImages = images.map((source, imageIndex) => ({ entryId: row.uuid, contentIndex: offset + imageIndex, mimeType: source.media_type }));
        }
        if (tool.issuedAt) tool.durationMs = Math.max(0, row.timestamp - tool.issuedAt);
        if (turn) turn.endedAt = Math.max(turn.endedAt, row.timestamp);
      }
    } else if (row.kind === "assistant") {
      answering = row.content.some(block => block.type === "tool_use");
      if (row.error) {
        const error: TranscriptItem = { type: "error", key: `${row.uuid}:error`, timestamp: row.timestamp, text: claudeText(row.content) || "Claude could not reply." };
        if (!turn) { items.push(error); return; }
        turn.error = error;
        turn.endedAt = Math.max(turn.endedAt, row.timestamp);
        return;
      }
      let position = positions.get(row.messageId) ?? 0;
      for (const block of row.content) assistantBlock({ ...block, text: block.thinking ?? block.text ?? "" }, `${row.messageId}:${position++}`, row.timestamp, false);
      positions.set(row.messageId, position);
    } else if (row.kind === "output") {
      const key = `${row.uuid}:output`;
      if (controlOutput) controlOutput = false;
      else if (row.error) activity({ type: "note", key, text: row.text, tone: "error" }, row.timestamp);
      else if (turn?.command) activity({ type: "text", key, text: row.text, final: false, live: false }, row.timestamp);
      else activity({ type: "note", key, text: row.text, tone: "system" }, row.timestamp);
    } else if (row.kind === "steer") {
      const images = claudeImageSources(row.content).map((source, contentIndex) => ({ entryId: row.uuid, contentIndex, mimeType: source.media_type }));
      begin({ type: "user", key: row.uuid, text: claudeText(row.content), images }, row.uuid, row.timestamp, true);
    } else if (row.kind === "compact") {
      const note: TranscriptItem = { type: "note", key: row.uuid, text: "Claude compacted the conversation.", tone: "summary" };
      const next = rows.slice(index + 1).find(next => next.kind === "assistant" || (next.kind === "user" && claudeUserIntent(next)?.kind === "prompt"));
      if (next?.kind === "user" && claudeUserIntent(next)?.text?.startsWith("/compact")) compaction = note;
      else activity(note, row.timestamp);
    }
  });
  const streaming = state.streaming;
  if (streaming) for (const [index, block] of [...streaming.blocks].sort(([left], [right]) => left - right)) {
    assistantBlock(block, `${streaming.messageId}:${index}`, streaming.startedAt, true);
  }
  finish(running);
  // Tool calls of a finished turn that never reported a result were cut short.
  for (const tool of tools.values()) if ((tool.status === "running" || tool.status === "streaming") && !running) tool.status = "error";
  return items;
}
