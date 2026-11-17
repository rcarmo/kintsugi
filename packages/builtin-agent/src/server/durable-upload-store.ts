import { createHash } from "node:crypto";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { openBunSqliteDatabase } from "@kintsugi/core/bun-sqlite";
import { agentDatabase, agentDatabaseName } from "./agent-database.ts";
import type { DurableAttachment } from "./durable-input.ts";

export const storedAttachmentSchema = Type.Object({type:Type.Literal("attachment"),filename:Type.String(),mimeType:Type.String(),mediaId:Type.String({pattern:"^[a-f0-9]{64}$"}),bytes:Type.Integer({minimum:0})});
export type StagedAttachments = {files:StoredAttachment[];release:()=>Promise<void>};
export type StoredAttachment = Static<typeof storedAttachmentSchema>;
/** Stage durable bytes before admission; only small immutable references enter Harness/task/document state. */
export async function storeDurableAttachments(directory: string, files: readonly DurableAttachment[]): Promise<StagedAttachments> {
  const prepared = files.map(file=>{
    const bytes = Buffer.from(file.data,"base64"),mediaId = createHash("sha256").update(bytes).digest("hex");
    return {reference:{type:"attachment" as const,filename:file.filename,mimeType:file.mimeType,mediaId,bytes:bytes.byteLength},bytes};
  });
  const database = await agentDatabase(async()=>join(directory,agentDatabaseName))();
  const tokens = prepared.map(()=>crypto.randomUUID());
  await database.withSync(db=>db.transaction(()=>{
    for (const [index,{reference,bytes}] of prepared.entries()) {db.run("INSERT OR IGNORE INTO media(id,filename,content_type,bytes,created_at,metadata,data) VALUES(?,?,?,?,?,?,?)",[reference.mediaId,reference.filename,reference.mimeType,reference.bytes,Date.now(),"{}",bytes]);
      db.run("INSERT INTO media_staging(token,media_id) VALUES(?,?)",[tokens[index]!,reference.mediaId]);
    }
  })());
  let released = false;
  return {files:prepared.map(item=>item.reference),async release() {
    if (released) return;
    await database.withSync(db=>db.transaction(()=>{
      db.run("DELETE FROM media_staging WHERE token IN (SELECT value FROM json_each(?))",[JSON.stringify(tokens)]);
      db.run("DELETE FROM media WHERE id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM media_links l WHERE l.media_id=media.id) AND NOT EXISTS(SELECT 1 FROM media_staging s WHERE s.media_id=media.id)",[JSON.stringify(prepared.map(item=>item.reference.mediaId))]);
    })());released = true;
  }};
}
/** Called only after the conversation's entry/inbox metadata has established visibility. Never a public hash lookup. */
export async function readDurableAttachmentBytes(path: string, id: string) {
  const db = await openBunSqliteDatabase(path,{mode:"read-only"});
  try {return (await db.get<{data:Uint8Array}>("SELECT data FROM media WHERE id=?",id))?.data;} finally {await db.close();}
}
