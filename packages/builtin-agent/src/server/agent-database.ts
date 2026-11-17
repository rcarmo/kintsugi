import type { Database } from "bun:sqlite";
import { openBunSqliteDatabase, truncateBunSqliteWal, type BunSqliteDatabase } from "@kintsugi/core/bun-sqlite";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { workspaceDurableJournalDirectory } from "./durable-storage.ts";

/** One file and one transaction queue for durable state, search and expiring copies. */
export const agentDatabaseName = "agent.sqlite";
const handles = new Map<string, Promise<BunSqliteDatabase>>();
const closing = new Map<string, Promise<void>>();
export type AgentDatabase = () => Promise<BunSqliteDatabase>;
/** The next access after a completed close opens a fresh handle; acquisition waits for an in-flight close. */
export function agentDatabase(path: () => Promise<string>): AgentDatabase {
  return async () => {
    const file = await path();
    for (;;) {
      const shutdown = closing.get(file);
      if (shutdown) {await shutdown;continue;}
      let handle = handles.get(file);
      if (!handle) {
        handle = openBunSqliteDatabase(file).then(async db => {
          try {await db.exec("PRAGMA secure_delete=ON");return db;} catch (error) {await db.close();throw error;}
        });
        handles.set(file,handle);
        void handle.catch(()=>{if (handles.get(file) === handle) handles.delete(file);});
      }
      const database = await handle;
      if (closing.has(file) || handles.get(file) !== handle) continue;
      return database;
    }
  };
}
export const agentDatabasePath = async (workspaceId: string) => join(await workspaceDurableJournalDirectory(workspaceId), agentDatabaseName);
export const workspaceAgentDatabase = (workspaceId: string) => agentDatabase(() => agentDatabasePath(workspaceId));
export function closeAgentDatabaseFile(file: string): Promise<void> {
  const previous = closing.get(file);if (previous) return previous;
  const handle = handles.get(file);
  if (!handle) return Promise.resolve();
  const close = handle.then(db => db.close()).finally(() => {
    if (handles.get(file) === handle) handles.delete(file);
    closing.delete(file);
  });
  closing.set(file, close);return close;
}
export async function closeAgentDatabase(workspaceId: string) {await closeAgentDatabaseFile(await agentDatabasePath(workspaceId));}
/** Removes retained copies when a workspace is deleted; its journal and search index remain. */
export async function forgetAgentCopies(database: AgentDatabase) {
  await (await database()).withSync(db => {
  db.transaction(() => {
    for (const table of ["tool_output_chunks", "tool_outputs", "mcp_recall"]) if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.run(`DELETE FROM ${table}`);
  })();
  checkpointDeletes(db);
  });
}
/**
 * Deleted pages are overwritten (secure_delete); this also moves them out of the write-ahead log. It is housekeeping:
 * a busy or locked log is logged and checkpointed by a later write, never failing the read or write that pruned.
 */
export function checkpointDeletes(db: Database) {
  try {truncateBunSqliteWal(db);} catch (error) {console.warn("Could not checkpoint the Agent database after deleting copies", error);}
}

/**
 * What a conversation can see: its own copies, and copies made in each ancestor before that branch forked.
 * Copies record the latest entry when they were made, so a fork taken before a capture never sees it.
 */
export type Lineage = readonly { conversationId: number; before: number | null }[];
export async function conversationLineage(harness: Harness, conversationId: ConversationId, context: Context): Promise<Lineage> {
  return harness.commit(async tx => {
    const chain: { conversationId: number; before: number | null }[] = [];
    let current = await tx.conversation(conversationId), before: number | null = null;
    while (current) {
      chain.push({ conversationId: Number(current.id), before });
      before = current.parent ? Math.min(before ?? Number.MAX_SAFE_INTEGER, Number(current.parent.at)) : null;
      current = current.parent ? await tx.conversation(current.parent.conversationId) : undefined;
    }
    return chain;
  }, context);
}
export async function captureMark(harness: Harness, conversationId: ConversationId, context: Context) {
  return Number(await harness.commit(tx => tx.latestEntryId(conversationId), context) ?? 0);
}
/** A SQL condition over `conversation` and `after` columns; values are bound, never interpolated. */
export function lineageCondition(alias: string, lineage: Lineage, columns: {conversation?:"conversation"|"conversation_id";mark?:"after"|"id";inclusive?:boolean} = {}) {
  if (!lineage.length) return {sql:"0",params:[]};
  const conversation = columns.conversation ?? "conversation",mark = columns.mark ?? "after",comparison = columns.inclusive ? "<=" : "<";
  return {sql:`EXISTS (SELECT 1 FROM json_each(?) lineage WHERE json_extract(lineage.value,'$[0]')=${alias}.${conversation} AND (json_extract(lineage.value,'$[1]') IS NULL OR ${alias}.${mark}${comparison}json_extract(lineage.value,'$[1]')))`,params:[JSON.stringify(lineage.map(item=>[item.conversationId,item.before]))]};
}
