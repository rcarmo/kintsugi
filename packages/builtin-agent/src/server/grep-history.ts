import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { RE2JS } from "re2js";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import { defineTool, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import { invalidArguments } from "@kintsugi/core";
import { agentDatabase, agentDatabaseName, conversationLineage, type Lineage } from "./agent-database.ts";
import { WorkspaceAgents } from "./durable-workspace.ts";
import { workspaceDurableJournalDirectory } from "./durable-storage.ts";
import { codemodeCallEntry } from "./codemode-call.ts";
import { stripTerminalEscapes } from "./history-search.ts";
import { join } from "node:path";

export const grepHistoryInput = Type.Object({
  pattern: Type.String({ minLength: 1, maxLength: 512 }),
  fixed: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string instead of RE2 regex." })),
  ignoreCase: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  agentId: Type.Optional(Type.String({ maxLength: 200 })),
  branch: Type.Optional(Type.Integer({ minimum: 1 })),
  role: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool")])),
  tool: Type.Optional(Type.String({ maxLength: 128 })),
  scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("history"), Type.Literal("output")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  cursor: Type.Optional(Type.Object({ generation: Type.String(), query: Type.String({pattern:"^[a-f0-9]{64}$"}), documentId: Type.Integer({ minimum: 1 }), line: Type.Integer({ minimum: 1 }) })),
}, { additionalProperties: false });
export type GrepHistoryInput = Static<typeof grepHistoryInput>;
type State = { seq: number; entry: number; fingerprint: string; generation: string };
type Document = { n: number; entry: number; conversation: number; role: string; tool: string; text: string };
const initialized = new WeakSet<Database>();
const selfTools = new Set(["search_history", "grep_history"]);
function initialize(db: Database) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS grep_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),seq INTEGER NOT NULL,entry INTEGER NOT NULL,fingerprint TEXT NOT NULL,generation TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS grep_documents(n INTEGER PRIMARY KEY,entry INTEGER NOT NULL,conversation INTEGER NOT NULL,role TEXT NOT NULL,tool TEXT NOT NULL,text TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS grep_documents_conversation ON grep_documents(conversation,entry,n);
    CREATE INDEX IF NOT EXISTS timeline_entries_commits ON timeline_entries(commit_seq,id);
    CREATE TABLE IF NOT EXISTS grep_calls(conversation INTEGER,callKey TEXT,name TEXT NOT NULL,PRIMARY KEY(conversation,callKey));
    CREATE VIRTUAL TABLE IF NOT EXISTS grep_trigram USING fts5(text,content='grep_documents',content_rowid='n',tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS grep_insert AFTER INSERT ON grep_documents BEGIN INSERT INTO grep_trigram(rowid,text) VALUES(new.n,new.text); END;
    CREATE TRIGGER IF NOT EXISTS grep_delete AFTER DELETE ON grep_documents BEGIN INSERT INTO grep_trigram(grep_trigram,rowid,text) VALUES('delete',old.n,old.text); END;`);
  db.run("INSERT OR IGNORE INTO grep_state VALUES(1,0,0,'',?)", [crypto.randomUUID()]);
  initialized.add(db);
}
const digest = (record: string) => createHash("sha256").update(record).digest("hex");
/** Index only visible text from committed entries; never task progress, thinking, arguments or queued inputs. */
function index(db: Database, signal?: AbortSignal) {
  initialize(db);
  let state = db.query<State, []>("SELECT * FROM grep_state").get()!;
  if (state.entry) {
    const boundary = db.query<{ record: string }, [number, number]>("SELECT record FROM timeline_entries WHERE id=? AND commit_seq=?").get(state.entry, state.seq);
    if (!boundary || digest(boundary.record) !== state.fingerprint) db.transaction(() => {
      db.exec("DELETE FROM grep_documents; DELETE FROM grep_calls;");
      db.run("UPDATE grep_state SET seq=0,entry=0,fingerprint='',generation=?", [crypto.randomUUID()]);
    })();
  }
  state = db.query<State, []>("SELECT * FROM grep_state").get()!;
  const deadline = performance.now() + 1000;let processed = 0;
  while (processed < 10_000 && performance.now() < deadline) {
    signal?.throwIfAborted();
    const page = db.query<{ id: number; commit_seq: number; record: string }, [number, number]>("SELECT id,commit_seq,record FROM timeline_entries WHERE (commit_seq,id)>(?,?) ORDER BY commit_seq,id LIMIT 16").all(state.seq, state.entry);
    if (!page.length) break;
    db.transaction(() => {
      for (const row of page) {
        // SAFETY: canonical records were committed by Pi Durable or its verified importer; IDs/entry shape follow that storage contract.
        const entry = JSON.parse(row.record) as EntryRecord;
        const add = (role: string, tool: string, text: string) => {if (text) db.run("INSERT INTO grep_documents(entry,conversation,role,tool,text) VALUES(?,?,?,?,?)", [Number(entry.id), Number(entry.conversationId), role, tool, stripTerminalEscapes(text)]);};
        for (const message of entry.model ?? []) {
          if (message.role === "user" || message.role === "assistant") add(message.role, "", contentText(message.content));
          else if (message.role === "toolResult" && !selfTools.has(message.toolName)) add("tool", message.toolName, contentText(message.content));
        }
        if (codemodeCallEntry.is(entry)) {
          const key = JSON.stringify([entry.data.callId, entry.data.key]);
          if (entry.data.phase === "start") db.run("INSERT OR REPLACE INTO grep_calls VALUES(?,?,?)", [Number(entry.conversationId), key, entry.data.name]);
          else {
            const tool = db.query<{ name: string }, [number, string]>("SELECT name FROM grep_calls WHERE conversation=? AND callKey=?").get(Number(entry.conversationId), key)?.name ?? "nested tool";
            if (!selfTools.has(tool)) add("tool", tool, entry.data.output ?? entry.data.error ?? "");
          }
        }
        state = { ...state, seq: row.commit_seq, entry: row.id, fingerprint: digest(row.record) };processed++;
      }
      db.run("UPDATE grep_state SET seq=?,entry=?,fingerprint=?", [state.seq, state.entry, state.fingerprint]);
    })();
  }
  const pending = !!db.query("SELECT 1 FROM timeline_entries WHERE (commit_seq,id)>(?,?) LIMIT 1").get(state.seq, state.entry);
  return { processed, pending, state };
}
/** Only ASCII literal patterns are prefiltered: FTS folding and RE2 Unicode semantics must never lose a match. */
export function grepTrigramQuery(input: GrepHistoryInput) {
  if (input.ignoreCase) return undefined;
  let literal: string | undefined;
  if (input.fixed) {if (/^[\x20-\x7e]+$/.test(input.pattern)) literal = input.pattern;}
  else {
    const plain = /^\^?([A-Za-z0-9 _-]+)\$?$/.exec(input.pattern);
    // A literal prefix outside every group stays mandatory before .* or .+ unless alternation is present.
    const prefix = input.pattern.includes("|") ? undefined : /^\^?([A-Za-z0-9 _-]+)\.[*+]/.exec(input.pattern);
    literal = plain?.[1] ?? prefix?.[1];
  }
  return literal && literal.length >= 3 ? `"${literal.replaceAll('"', '""')}"` : undefined;
}
export async function grepCommittedHistory(harness: Harness, directory: string, workspaceId: string, input: GrepHistoryInput, signal?: AbortSignal) {
  if (!Value.Check(grepHistoryInput, input)) throw invalidArguments("Invalid grep pattern, filters or bounds");
  signal?.throwIfAborted();
  const query = digest(JSON.stringify([input.pattern,!!input.fixed,!!input.ignoreCase,input.agentId ?? null,input.branch ?? null,input.role ?? null,input.tool ?? null,input.scope ?? "all"]));
  if (input.cursor && input.cursor.query !== query) throw invalidArguments("Search filters changed; repeat without a cursor.");
  let regex: RE2JS;
  try {regex = RE2JS.compile(input.fixed ? RE2JS.quote(input.pattern) : input.pattern, input.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);} catch {throw invalidArguments("Invalid RE2 regex. Backreferences and lookaround are not supported.");}
  const catalog = await harness.snapshot(WorkspaceAgents, background);
  if (catalog?.workspaceId !== workspaceId) throw new Error("Grep workspace identity mismatch");
  const selected: { agentId: string; branch: number; lineage: Lineage }[] = [];
  for (const agent of catalog.agents) if (!input.agentId || agent.agentId === input.agentId) for (const branch of agent.branches ?? [agent.durableId]) if (!input.branch || Number(branch) === input.branch) selected.push({ agentId: agent.agentId, branch: Number(branch), lineage: await conversationLineage(harness, branch, background) });
  const database = await agentDatabase(async () => join(directory, agentDatabaseName))();
  return database.withSync(db => {
    const coverage = index(db, signal);
    if (input.cursor && input.cursor.generation !== coverage.state.generation) throw invalidArguments("History index changed; repeat the search without a cursor.");
    const constraints = new Map<number, number | null>();
    for (const { lineage } of selected) for (const item of lineage) {
      const previous = constraints.get(item.conversationId);
      constraints.set(item.conversationId, constraints.has(item.conversationId) ? previous === null || item.before === null ? null : Math.max(previous!, item.before) : item.before);
    }
    const visible = JSON.stringify([...constraints]);
    const candidate = grepTrigramQuery(input), matchLimit = input.limit ?? 20, context = input.context ?? 0;
    const results: { agentId: string; branch: number; entryId: number; role: string; tool: string; line: number; startLine: number; lines: string[]; shortened: boolean; reference: { workspaceId: string; agentId: string; branch: number; entryId: number } }[] = [];
    let next = { documentId: input.cursor?.documentId ?? 1, line: input.cursor?.line ?? 1 }, complete = false, outputChars = 0, scannedChars = 0;
    const deadline = performance.now() + 1000;
    scan: while (performance.now() < deadline && scannedChars < 16 * 1024 * 1024) {
      signal?.throwIfAborted();
      const rows = db.query<Document, (string | number)[]>(`SELECT d.* FROM ${candidate ? "grep_trigram JOIN grep_documents d ON d.n=grep_trigram.rowid" : "grep_documents d"} WHERE d.n>=? AND EXISTS (SELECT 1 FROM json_each(?) v WHERE json_extract(v.value,'$[0]')=d.conversation AND (json_extract(v.value,'$[1]') IS NULL OR d.entry<=json_extract(v.value,'$[1]'))) AND (?='' OR d.role=?) AND (?='' OR d.tool=?) AND (?='all' OR (?='history' AND d.role<>'tool') OR (?='output' AND d.role='tool')) ${candidate ? "AND grep_trigram MATCH ?" : ""} ORDER BY d.n LIMIT 8`)
        .all(next.documentId, visible, input.role ?? "", input.role ?? "", input.tool ?? "", input.tool ?? "", input.scope ?? "all", input.scope ?? "all", input.scope ?? "all", ...(candidate ? [candidate] : []));
      if (!rows.length) {complete = true;break;}
      for (const row of rows) {
        const lines = row.text.split("\n"), first = row.n === next.documentId ? next.line - 1 : 0;
        scannedChars += row.text.length;
        if (first >= lines.length) {next = {documentId:row.n+1,line:1};continue;}
        for (let line = first; line < lines.length; line++) {
          if (line % 64 === 0) {
            signal?.throwIfAborted();
            if (performance.now() >= deadline) {next = { documentId: row.n, line: line + 1 };break scan;}
          }
          next = line + 1 < lines.length ? { documentId: row.n, line: line + 2 } : { documentId: row.n + 1, line: 1 };
          if (!regex.matcher(lines[line]!).find()) continue;
          const owner = selected.find(branch => branch.lineage.some(item => item.conversationId === row.conversation && (item.before === null || row.entry <= item.before)))!;
          const start = Math.max(0, line - context), window = lines.slice(start, line + context + 1), lineChars = Math.min(2000, Math.floor(16_000 / window.length) - 4), shown = window.map(text => text.length > lineChars ? text.slice(0, lineChars) + " …" : text);
          const size = shown.reduce((n, text) => n + text.length, 0);
          if (results.length && outputChars + size > 16_000) {next = { documentId: row.n, line: line + 1 };break scan;}
          const reference = { workspaceId, agentId: owner.agentId, branch: owner.branch, entryId: row.entry };
          results.push({ ...reference, role: row.role, tool: row.tool, line: line + 1, startLine: start + 1, lines: shown, shortened: window.some((text, i) => text !== shown[i]), reference });outputChars += size;
          if (results.length >= matchLimit) break scan;
        }
        if (performance.now() >= deadline || scannedChars >= 16 * 1024 * 1024) break scan;
      }
    }
    return { results, nextCursor: complete && !coverage.pending ? null : { generation: coverage.state.generation, query, ...next }, coverage: { indexedEntriesThisCall: coverage.processed, indexingIncomplete: coverage.pending, scanComplete: complete, prefilter: candidate ? "trigram" : "none", note: "Committed visible text only; line-based RE2 matching. No thinking, queued input or partial tasks. Indexing and scanning are bounded; follow nextCursor to continue." } };
  });
}
export function createGrepHistoryTool(workspaceId: string, harness: () => Harness) {
  return defineTool({ name: "grep_history", description: "Search committed workspace timeline text like rg: RE2 regex or fixed strings, case options, line context and Agent/branch/role/tool filters. Returns bounded matches with entry references and a continuation cursor. No hidden thinking or unfinished output. Regex matching is per line; no backreferences/lookaround. Source-file searches still use rg.", parameters: grepHistoryInput, replay: "safe", async execute(input, _api, context) {
    const result = await grepCommittedHistory(harness(), await workspaceDurableJournalDirectory(workspaceId), workspaceId, input, context.abortSignal);
    return { output: [{ type: "text", text: JSON.stringify(result) }] };
  } });
}
