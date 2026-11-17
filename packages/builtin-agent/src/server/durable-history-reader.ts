import { readDurableHistoryPage } from "./durable-history-page.ts";
import {readDurableAttachmentBytes} from "./durable-upload-store.ts";
import { durableAttachmentEndpoint } from "./durable-attachments.ts";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { AgentDoc, LiveDoc, InboxDoc, UsageDoc, createRegistry, Harness, type Cursor, type EntryRecord } from "@earendil-works/pi-durable";
import { acquireDurableHistorySnapshot } from "./durable-history-snapshot.ts";
import { WorkspaceAgents, type DurableAgentRecord } from "./durable-workspace.ts";
import { WorkspaceAdmission } from "./durable-lifecycle.ts";
import { durableSqliteName, openReadOnlyDurableStorage } from "./durable-sqlite.ts";
import { durableImageEndpoint } from "./durable-images.ts";

/** Passive reader only: no prompt preparation, scheduler, telemetry registration, migration or writer lease. */
export async function openDurableHistoryReader(directory: string, workspaceId: string) {
  const path = join(directory, durableSqliteName);
  let snapshot:Awaited<ReturnType<typeof acquireDurableHistorySnapshot>>|undefined;
  if (!await Bun.file(path).exists()) {
    try {snapshot=await acquireDurableHistorySnapshot(directory);} catch(error) {
      if (!await Bun.file(path).exists()) throw error;
      // A concurrent owner completed its verified cutover while this read-only snapshot was queued.
    }
  }
  const release = async () => {await snapshot?.release();};
  let harness: Harness;
  try {
    const storage = await openReadOnlyDurableStorage(snapshot?.path ?? path);
    harness = await Harness.open(storage, { models: createModels(), registry: createRegistry(), readOnly: true }, context);
  } catch (error) {await release();throw error;}
  try {
    if ((await harness.snapshot(WorkspaceAgents, context))?.workspaceId !== workspaceId) throw new Error("History workspace identity mismatch");
  } catch (error) {try {await harness.close(context);} finally {await release();}throw error;}
  return {
    async catalog() {return (await harness.snapshot(WorkspaceAgents, context))!.agents;},
    async admission() {return harness.snapshot(WorkspaceAdmission, context);},
    async agent(record: DurableAgentRecord) {
      const catalog = (await harness.snapshot(WorkspaceAgents, context))!.agents;
      const identity = catalog.find(item => item.agentId === record.agentId);
      if (!identity) throw new Error("Agent history not found");
      const conversation = (await harness.conversation(identity.durableId, context))!;
      return {
      async attachment(entryId: string, index: number) {
        if (entryId.startsWith("queued-")) return durableAttachmentEndpoint(conversation,entryId,index,context,id=>readDurableAttachmentBytes(snapshot?.path ?? path,id));
        for (const id of identity.branches ?? [identity.durableId]) {
          const response = await durableAttachmentEndpoint((await harness.conversation(id,context))!,entryId,index,context,id=>readDurableAttachmentBytes(snapshot?.path ?? path,id));
          if (response.status !== 404) return response;
        }
        return new Response("not found",{status:404});
      },
        async image(entry: string, index: number) {
          if (entry.startsWith("queued-")) return durableImageEndpoint(conversation, entry, index, context);
          for (const id of identity.branches ?? [identity.durableId]) {
            const response = await durableImageEndpoint((await harness.conversation(id, context))!, entry, index, context);
            if (response.status !== 404) return response;
          }
          return new Response("not found", { status: 404 });
        },
        async historyView(branchId?: string,before?:number) {
          const id = (identity.branches ?? [identity.durableId]).find(id => branchId === undefined ? id === identity.durableId : String(id) === branchId);
          if (id === undefined) throw new Error("History branch no longer exists.");
          const docs = {
              [AgentDoc.definition.kind]: await harness.snapshot(AgentDoc, id, context) ?? {},
              [LiveDoc.definition.kind]: before ? {} : await harness.snapshot(LiveDoc, id, context) ?? {},
              [InboxDoc.definition.kind]: before ? {} : await harness.snapshot(InboxDoc, id, context) ?? {},
              [UsageDoc.definition.kind]: await harness.snapshot(UsageDoc, id, context) ?? {},
          };
          return harness.commit(async tx => {
            // SAFETY: the HTTP cursor is validated and scoped to this conversation's immutable fork history.
            const maxEntryId = before as import("@earendil-works/pi-durable").EntryId | undefined;
            const page = await readDurableHistoryPage(cursor=>tx.scanEntries({conversationId:id,maxEntryId},1,cursor));
            return { conversation: (await tx.conversation(id))!, entries: page.entries,before:page.before, docs };
          }, context);
        },
      };
    },
    async dispose() {try {await harness.close(context);} finally {await release();}} ,
  };
}
