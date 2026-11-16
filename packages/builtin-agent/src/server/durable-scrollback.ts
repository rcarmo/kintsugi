import type { Context } from "@earendil-works/chord/context";
import type { Conversation, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";

/** A bounded, fork-aware history read. Never changes the active context or starts scheduling. */
export const scrollbackPageSize = 200;
export async function readScrollbackPage(history: Conversation["entries"], before: EntryId, context: Context) {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await history({ maxEntryId: before }, scrollbackPageSize + 1 - entries.length, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined && entries.length <= scrollbackPageSize);
  const next = entries.length > scrollbackPageSize ? entries.pop()!.id : undefined;
  return { entries: entries.reverse(), before: next };
}
