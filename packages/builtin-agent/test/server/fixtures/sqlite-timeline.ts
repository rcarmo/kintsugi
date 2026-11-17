import { Database } from "bun:sqlite";
import { join } from "node:path";
import { agentDatabase, agentDatabaseName } from "../../../src/server/agent-database.ts";

/** Stable durable-table contents; derived index updates must not change this snapshot. */
export async function timelineSnapshot(directory: string) {
  const file = join(directory, agentDatabaseName);
  return (await agentDatabase(async () => file)()).withSync(db => {
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'timeline_*' ORDER BY name").all();
    return JSON.stringify(tables.map(({ name }) => [name, db.query(`SELECT * FROM ${name}`).all().map(row => JSON.stringify(row)).sort()]));
  });
}
export function persistedTimelineText(directory: string) {
  const db = new Database(join(directory, agentDatabaseName), { readonly: true });
  try {return ["conversations", "entries", "tasks", "submissions", "documents", "document_revisions"].map(table => db.query<{text:string},[]>(`SELECT ${table === "document_revisions" ? "content" : "record"} AS text FROM timeline_${table}`).all().map(row => row.text).join("\n")).join("\n");} finally {db.close();}
}
