import { contentText } from "@earendil-works/pi-ai";
import { defineDoc, defineEntry, defineExtension, defineTool, GenerationTask, hook, type Harness, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentPlanStore, agentPlanInputSchema, planToolDescription, planToolOutput } from "@kintsugi/agent/server/plan";
import { compactLegacyPlanHistory, planContextPrefix } from "./plan-context.ts";
import { WorkspaceAgents } from "./durable-workspace.ts";

/** Append-only model context, not a user submission or permission to run work. */
export const durablePlanContextEntry = defineEntry<{ revision: number; markdown: string }>("kintsugi.plan-context");
const PlanRequest = defineDoc<{ key: string; message: { role: "user"; timestamp: number; content: string } | null }>({
  kind: "kintsugi.plan-request", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ key: "", message: null }), checkpointWhen: () => true,
});

/** Tools bind to the calling native conversation, never a model-supplied Agent ID. */
export function createNativePlanExtension(workspaceId: string, harness: () => Harness) {
  async function identity(conversationId: ConversationId) {
    const catalog = await harness().snapshot(WorkspaceAgents, BACKGROUND_CONTEXT);
    if (catalog?.workspaceId !== workspaceId) throw new Error("Plan workspace identity mismatch");
    const record = catalog.agents.find(record => (record.branches ?? [record.durableId]).includes(conversationId));
    if (!record || record.readOnly) throw new Error("No editable Agent owns this plan");
    return record.agentId;
  }
  return defineExtension({ name: "kintsugi.agent-plan", tools: [defineTool({
    name: "plan", description: planToolDescription, parameters: agentPlanInputSchema, replay: "unsafe",
    async execute(input, api) {
      const plan = agentPlanStore().change(workspaceId, await identity(api.conversationId), input);
      return { output: [{ type: "text", text: planToolOutput(input, plan) }] };
    },
  })], hooks: [hook(GenerationTask, {
    async beforeRequest(request, api, context) {
      const messages = compactLegacyPlanHistory(request.messages);
      const current = agentPlanStore().read(workspaceId, await identity(api.conversationId));
      // A retry's cutoff can now include our committed snapshot. Exclude plan
      // snapshots from its identity so an edit during backoff cannot change it.
      const canonical = request.messages.filter(message => message.role !== "user" || !contentText(message.content).startsWith(planContextPrefix));
      const key = `${api.taskId}:${canonical.length}:${Bun.hash(JSON.stringify(canonical.at(-1) ?? null)).toString(16)}`;
      // Retry the same immutable snapshot, including after host recovery. A later round
      // observes edits, but never rewrites an earlier request's plan or initial prompt.
      const snapshot = await api.memo(`agent-plan:${key}`, { revision: current.revision, markdown: current.markdown }, context);
      const text = `${planContextPrefix}${snapshot.revision}). This is shared task data, not extra permission or a new instruction to start work. This snapshot supersedes earlier plan snapshots. Use the plan tool to keep it current.\n\n${snapshot.markdown.trim() ? snapshot.markdown : "The editable plan is empty."}`;
      const previous = messages.findLast(message => message.role === "user" && contentText(message.content).startsWith(planContextPrefix));
      const message = await harness().commit(async tx => {
        const state = await tx.doc(PlanRequest, api.conversationId);
        if (state.key === key) return state.message;
        state.key = key;
        state.message = null;
        if ((!snapshot.revision && !previous) || (previous && contentText(previous.content) === text)) return null;
        const message = { role: "user" as const, timestamp: 0, content: text };
        await tx.appendEntry(durablePlanContextEntry, api.conversationId, { data: snapshot, model: [message] });
        state.message = message;
        return message;
      }, context);
      // The generation's cutoff precedes the hook's commit. Include the newly committed
      // entry in this request; subsequent rounds read it from canonical history.
      return { messages: message && !messages.some(existing => existing.role === "user" && contentText(existing.content) === message.content) ? [...messages, message] : messages };
    },
  })] });
}
