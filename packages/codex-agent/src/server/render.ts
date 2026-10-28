import { parseModelRef } from "@kintsugi/llm/server";
import { createNativeAgentRendering } from "@kintsugi/native-agent/server";
import { projectCodexTurns } from "./transcript.ts";
import type { CodexRuntime } from "./runtime.ts";

export const rendering = createNativeAgentRendering<CodexRuntime>({
  channelName: "codex-agent",
  routeSegment: "codex-agents",
  transcript: runtime => projectCodexTurns(runtime.state.turns, runtime.state.completedItems, runtime.state.itemStarts),
  stats(runtime) {
    const usage = runtime.state.usage;
    const selection = runtime.selection;
    return { contextPercent: usage?.modelContextWindow ? usage.last.totalTokens / usage.modelContextWindow * 100 : null, compactAvailable: !runtime.isBusy, inputTokens: usage?.total.inputTokens ?? null, outputTokens: usage?.total.outputTokens ?? null, cost: null, modelName: runtime.record.model ? parseModelRef(runtime.record.model)?.id : undefined, thinkingLevel: runtime.record.thinkingLevel ?? "", thinkingLevels: selection.thinkingLevels, models: selection.models, connectedProvider: true };
  },
});
export const liveRegions = (runtime: CodexRuntime) => rendering.liveRegions(runtime);
