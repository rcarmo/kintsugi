import type { JsonRepresentation } from "@earendil-works/chord/json";
import { defineDoc, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Canonical pi.usage.tools groups by tool name, not model. Preserve the model at the actual model-call boundary. */
export const ModelToolUsage = defineDoc<{ models: Record<string, JsonRepresentation<Usage>>; calls: Record<string, true> }>({ checkpointWhen: () => false,
  kind: "kintsugi.model-tool-usage", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ models: {}, calls: {} }),
});
const modelArguments = Type.Object({ model: Type.Object({ provider: Type.String(), id: Type.String() }) });
const modelToolNames = new Set(["pi.codemode.models.classify", "pi.codemode.models.generateImages"]);
const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const costFields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/** Adds accounting only: no tool-schema/prompt changes, provider options or response mutation. */
export function attributeModelToolUsage(tool: ToolRegistration): ToolRegistration {
  if (!modelToolNames.has(tool.name)) return tool;
  return { ...tool, async execute(args, api, context) {
    const result = await tool.execute(args, api, context);
    if (!result.usage) return result;
    // The native model tool has already resolved exactly these fields through its model registry.
    Value.Assert(modelArguments, args);
    const { provider, id } = args.model, usage = result.usage;
    await api.commit(async tx => {
      const state = await tx.doc(ModelToolUsage, api.conversationId), call = String(api.taskId);
      if (Object.hasOwn(state.calls, call)) return;
      const key = `${provider}/${id}`;
      const previous = state.models[key];
      const total = previous ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      for (const field of fields) total[field] += usage[field];
      for (const field of costFields) total.cost[field] += usage.cost[field];
      if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
      if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
      if (!previous) state.models[key] = total;
      state.calls[call] = true;
    }, context);
    return result;
  } };
}
