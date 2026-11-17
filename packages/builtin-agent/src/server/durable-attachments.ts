import {storedAttachmentSchema} from "./durable-upload-store.ts";
import type { JsonValue } from "@earendil-works/chord/json";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Context } from "@earendil-works/chord/context";
import { InboxDoc, type Conversation, type EntryId, type InboxState } from "@earendil-works/pi-durable";
const inlineSchema = Type.Object({type:Type.Literal("attachment"),filename:Type.String(),mimeType:Type.String(),data:Type.String()});
const filesSchema = Type.Object({files:Type.Array(Type.Union([inlineSchema,storedAttachmentSchema]))});
export function durableAttachmentRefs(data: JsonValue | undefined, entryId: string) {
  return Value.Check(filesSchema, data) ? data.files.map((file, index) => ({ entryId, index, filename: file.filename })) : [];
}
/** Entry visibility, including immutable fork prefixes, is checked before any file bytes are returned. */
export async function durableAttachmentEndpoint(conversation: Conversation, entryId: string, index: number, context: Context,readFile?: (id:string)=>Promise<Uint8Array|undefined>): Promise<Response> {
  const missing = () => new Response("not found", { status: 404 });
  if (!Number.isSafeInteger(index) || index < 0) return missing();
  let data: unknown;
  if (entryId.startsWith("queued-")) {
    const id = entryId.slice(7);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return missing();
    const watch = await conversation.watch(context, { min: 1 });
    try {
      // SAFETY: this built-in document is version-checked by Harness; the queued input is scoped to this conversation.
      const inbox = watch.value.docs[InboxDoc.definition.kind] as InboxState | undefined;
      data = inbox?.items.find(item => String(item.id) === id)?.entry?.data;
    } finally {await watch.stop();}
  } else {
    const number = Number(entryId);
    if (!/^[1-9]\d*$/.test(entryId) || !Number.isSafeInteger(number)) return missing();
    // SAFETY: external ID checked above; the fork-aware scan below establishes visibility, never a global media lookup.
    const id = number as EntryId;
    data = (await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, context)).items[0]?.data;
  }
  if (!Value.Check(filesSchema, data)) return missing();
  const file = data.files[index];if (!file) return missing();
  const bytes = Value.Check(inlineSchema,file) ? Buffer.from(file.data,"base64") : await readFile?.(file.mediaId);
  if (!bytes) return missing();
  return new Response(Buffer.from(bytes), { headers: {
    "content-type": "application/octet-stream", "content-length": String(bytes.byteLength),
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff", "cache-control": "private, no-store",
  } });
}
