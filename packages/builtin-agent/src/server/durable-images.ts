import type { TextContent, ImageContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { InboxDoc, type InboxState, type Conversation, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { sessionImageResponse } from "./session-images.ts";

/** Stable image addressing across all model messages of an immutable entry. */
export function durableEntryContent(entry: EntryRecord) {
  return (entry.model ?? []).flatMap<TextContent | ImageContent | ThinkingContent | ToolCall>((message) => Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }]);
}

/**
 * Read through the conversation's fork-aware history, not the workspace-global
 * entry table: knowing an entry ID must not expose another root's images.
 * Pure read; does not start scheduling or rewrite the journal.
 */
export async function durableImageEndpoint(conversation: Conversation, entryId: string, contentIndex: number, context: Context): Promise<Response> {
  if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) return new Response("not found", { status: 404 });
  if (entryId.startsWith("queued-")) {
    const id = entryId.slice("queued-".length);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return new Response("not found", { status: 404 });
    // Queue images have not acquired an entry ID yet. Read the same scoped
    // committed inbox used by the transcript; never look up global submissions.
    const watch = await conversation.watch(context, { min: 1 });
    try {
      // SAFETY: Harness owns/version-checks pi.inbox before mounting this view.
      const inbox = watch.value.docs[InboxDoc.definition.kind] as InboxState | undefined;
      const input = inbox?.items.find(item => String(item.id) === id);
      const part = input && input.mode !== "write" && Array.isArray(input.content) ? input.content[contentIndex] : undefined;
      return sessionImageResponse(part?.type === "image" ? part : undefined);
    } finally { await watch.stop(); }
  }
  const numericId = Number(entryId);
  if (!/^\d+$/.test(entryId) || !Number.isSafeInteger(numericId) || numericId < 1) return new Response("not found", { status: 404 });
  // SAFETY: external ID validated as a positive safe integer; the scoped scan
  // below establishes visibility instead of trusting this nominal type cast.
  const id = numericId as EntryId;
  const entry = (await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, context)).items[0];
  if (!entry) return new Response("not found", { status: 404 });
  const part = durableEntryContent(entry)[contentIndex];
  return sessionImageResponse(part?.type === "image" ? part : undefined);
}
