import type { Context } from "@earendil-works/chord/context";
import type { Conversation, EntryId } from "@earendil-works/pi-durable";
import { durableHistoryPageSize, readDurableHistoryPage } from "./durable-history-page.ts";

/** Count/byte-bounded, fork-aware history. Never changes context or starts scheduling. */
export const scrollbackPageSize = durableHistoryPageSize;
export function readScrollbackPage(history: Conversation["entries"], before: EntryId, context: Context) {
  return readDurableHistoryPage(cursor => history({ maxEntryId: before }, 1, cursor, context));
}
