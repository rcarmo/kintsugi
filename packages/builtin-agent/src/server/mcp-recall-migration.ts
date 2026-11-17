import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { defineDoc, type ConversationId, type DocumentId, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { BunSqliteDatabase } from "@kintsugi/core/bun-sqlite";
import { openReadOnlyDurableStorage } from "./durable-sqlite.ts";
import { WorkspaceAgents } from "./durable-workspace.ts";
import {recallStorageAllowed} from "@kintsugi/token-economizer/core";
import type { McpRecallRecord } from "./mcp-recall-store.ts";

/** Forward data migration only. Older application binaries are never used to open the converted store. */
export const LegacyMcpRecall = defineDoc<{records:Record<string,McpRecallRecord>}>({kind:"kintsugi.mcp-recall",version:1,scope:"conversation",history:"rewindable",fork:"asOf",initial:()=>({records:{}}),checkpointWhen:()=>false});
const recordSchema=Type.Object({id:Type.String({pattern:"^mcp_[a-f0-9]{64}$"}),owner:Type.String(),grants:Type.Array(Type.Object({connectionId:Type.String(),epoch:Type.String()}),{minItems:1}),tool:Type.String(),kind:Type.Union([Type.Literal("mcp-envelope"),Type.Literal("emitted-text")]),raw:Type.String(),summary:Type.String(),handler:Type.String(),sources:Type.Array(Type.String()),bytes:Type.Integer({minimum:0}),createdAt:Type.Number(),lastSeen:Type.Number(),hits:Type.Integer({minimum:1}),pinned:Type.Boolean(),isError:Type.Boolean()});
const documentSchema=Type.Object({records:Type.Record(Type.String(),recordSchema)});
const imports=new WeakMap<BunSqliteDatabase,Promise<void>>();
const memberships=new WeakMap<BunSqliteDatabase,Map<number,Promise<void>>>();

async function sourceDocuments(db:BunSqliteDatabase,harness:Harness,context:Context,only?:ConversationId) {
  const canonical=!!await db.get("SELECT 1 FROM sqlite_master WHERE name='timeline_documents'");
  if(canonical) {
    const path=await db.withSync(raw=>raw.filename),storage=await openReadOnlyDurableStorage(path);
    return {async *[Symbol.asyncIterator]() {
      try {
        let after=-1;
        for(;;) {
          const page=await db.all<{id:number;owner_id:number}>(`SELECT id,owner_id FROM timeline_documents WHERE id>? AND scope_kind='conversation' AND retired_at IS NULL AND json_extract(record,'$.kind')=? ${only===undefined?"":"AND owner_id=?"} ORDER BY id LIMIT 16`,after,LegacyMcpRecall.definition.kind,...(only===undefined?[]:[Number(only)]));
          if(!page.length)break;
          for(const row of page) {
            // SAFETY: IDs and owners came from canonical document metadata; this reader never schedules or mutates it.
            const document=await storage.document(row.id as DocumentId,"current",context);
            if(document){if(document.version!==1)throw new Error("Unsupported legacy MCP recall document version");yield {conversation:row.owner_id,records:Value.Parse(documentSchema,document.value).records};}
            after=row.id;
          }
        }
      }finally{await storage.close(context);}
    }};
  }
  // Portable Memory/JSONL Harness fixtures use the same schema; production always takes the streamed SQLite path.
  const catalog=await harness.snapshot(WorkspaceAgents,context);
  const ids=only===undefined?[...new Set(catalog?.agents.flatMap(agent=>agent.branches??[agent.durableId])??[])]:[only];
  return {async *[Symbol.asyncIterator]() {for(const id of ids){const document=await harness.snapshot(LegacyMcpRecall,id,context);if(document)yield {conversation:Number(id),records:Value.Parse(documentSchema,document).records};}}};
}
function initialize(db:import("bun:sqlite").Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_recall_legacy_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),complete INTEGER NOT NULL); INSERT OR IGNORE INTO mcp_recall_legacy_state VALUES(1,0);
    CREATE TABLE IF NOT EXISTS mcp_recall_legacy_ids(id TEXT PRIMARY KEY,pinned INTEGER NOT NULL,last_seen REAL NOT NULL,source_conversation INTEGER NOT NULL,imported INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS mcp_recall_legacy_members(conversation INTEGER NOT NULL,id TEXT NOT NULL,PRIMARY KEY(conversation,id));`);
}
/** Caller initialises the current recall table first. Import IDs once; deleted/expired IDs cannot reappear on a later fork. */
export async function migrateLegacyMcpRecall(db:BunSqliteDatabase,harness:Harness,context:Context,prune:(raw:import("bun:sqlite").Database)=>void) {
  let pending=imports.get(db);if(pending)return pending;
  pending=(async()=>{
    await db.withSync(initialize);
    if((await db.get<{complete:number}>("SELECT complete FROM mcp_recall_legacy_state WHERE singleton=1"))?.complete)return;
    // First collect only IDs/retention metadata, so pins and recency from every branch are known before caps apply.
    for await(const source of await sourceDocuments(db,harness,context)) {
      await db.withSync(raw=>raw.transaction(()=>{
        for(const row of Object.values(source.records)) {
          const digest=createHash("sha256").update(JSON.stringify([row.owner,row.grants,row.tool,row.kind,row.raw])).digest("hex");
          if(row.id!==`mcp_${digest}`||Buffer.byteLength(row.raw)>1024*1024)throw new Error("Invalid legacy MCP recall record");
          raw.run("INSERT OR IGNORE INTO mcp_recall_legacy_members VALUES(?,?)",[source.conversation,row.id]);
          raw.run("INSERT INTO mcp_recall_legacy_ids(id,pinned,last_seen,source_conversation) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET pinned=max(pinned,excluded.pinned),source_conversation=CASE WHEN excluded.last_seen>=last_seen THEN excluded.source_conversation ELSE source_conversation END,last_seen=max(last_seen,excluded.last_seen)",[row.id,Number(row.pinned),row.lastSeen,source.conversation]);
        }
      })());await Bun.sleep(0);
    }
    for await(const source of await sourceDocuments(db,harness,context)) {
      await db.withSync(raw=>raw.transaction(()=>{
        for(const row of Object.values(source.records)) {
          const metadata=raw.query<{pinned:number;source_conversation:number;imported:number},[string]>("SELECT * FROM mcp_recall_legacy_ids WHERE id=?").get(row.id);
          if(!metadata||metadata.imported||metadata.source_conversation!==source.conversation)continue;
          if(recallStorageAllowed(row.tool,row.raw))raw.run("INSERT OR IGNORE INTO mcp_recall(id,digest,owner,conversation,after,tool,kind,grants,sources,handler,bytes,createdAt,lastSeen,hits,pinned,isError,summary,legacy,exact_raw,raw) VALUES(?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)",[row.id,row.id.slice(4),row.owner,source.conversation,row.tool,row.kind,JSON.stringify(row.grants),JSON.stringify(row.sources),row.handler,Buffer.byteLength(row.raw),row.createdAt,row.lastSeen,row.hits,metadata.pinned,Number(row.isError),row.summary,/[\uD800-\uDFFF]/u.test(row.raw)?JSON.stringify(row.raw):null,row.raw]);
          raw.run("UPDATE mcp_recall_legacy_ids SET imported=1 WHERE id=?",[row.id]);
        }
        prune(raw);
      })());await Bun.sleep(0);
    }
    await db.withSync(raw=>raw.transaction(()=>{prune(raw);raw.exec("UPDATE mcp_recall_legacy_state SET complete=1");})());
  })();imports.set(db,pending);
  try {await pending;}catch(error){imports.delete(db);throw error;}
}
/** New forks retain only IDs in their original as-of document, never a parent's later captured values. */
export async function legacyMcpMembership(db:BunSqliteDatabase,harness:Harness,id:ConversationId,context:Context) {
  if(!await db.get("SELECT 1 FROM mcp_recall_legacy_ids LIMIT 1"))return [];
  let cache=memberships.get(db);if(!cache){cache=new Map();memberships.set(db,cache);}
  let pending=cache.get(Number(id));
  if(!pending) {
    pending=(async()=>{for await(const source of await sourceDocuments(db,harness,context,id))await db.withSync(raw=>raw.transaction(()=>{for(const key of Object.values(source.records).map(row=>row.id))raw.run("INSERT OR IGNORE INTO mcp_recall_legacy_members VALUES(?,?)",[source.conversation,key]);})());})();
    cache.set(Number(id),pending);
  }
  try {await pending;}catch(error){cache.delete(Number(id));throw error;}
  return (await db.all<{id:string}>("SELECT id FROM mcp_recall_legacy_members WHERE conversation=?",Number(id))).map(row=>row.id);
}
