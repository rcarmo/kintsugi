import { parseModelRef } from "@kintsugi/llm/server";
import { renderLazyTranscriptEntry, renderTranscript } from "@kintsugi/agent/server/render-transcript";
import { ids, type AgentRenderContext } from "@kintsugi/agent/server/render-context";
import type { TranscriptItem } from "@kintsugi/agent/server/transcript";
import { renderBackgroundActivities, type BackgroundActivity } from "@kintsugi/agent/server/background-activity";
import { renderAgentPane, renderAgentPaneComposerFooter, renderPromptActions, type AgentStatsView } from "@kintsugi/builtin-agent/server/render-composer";
import { type LiveRegion } from "@kintsugi/shared";
import type { NativeAgentRuntime } from "./agents.ts";

/** A native Agent's pane: its projected transcript, then notices and a lost connection. */
export function createNativeAgentRendering<Runtime extends NativeAgentRuntime>(options: {
  channelName: string;
  /** Path segment under the workspace for this Agent type's routes, such as `codex-agents`. */
  routeSegment: string;
  transcript(runtime: Runtime): TranscriptItem[];
  stats(runtime: Runtime): AgentStatsView;
  /** Work the harness runs beside the conversation, shown in a bar above it. */
  background?: {
    activities(runtime: Runtime): BackgroundActivity[];
    /** An activity's own detail, such as command output or a subagent's transcript, beneath its facts. */
    detail(runtime: Runtime, activity: BackgroundActivity, ctx: AgentRenderContext): Promise<string>;
    /** Anything else under the activity's path, such as lazy frames inside its detail. */
    route?(runtime: Runtime, activity: BackgroundActivity, path: string, url: URL, ctx: AgentRenderContext): Promise<Response | undefined>;
    /** For Agents whose activities can be stopped one by one. */
    stop?(runtime: Runtime, activity: BackgroundActivity): Promise<void>;
  };
}) {
  function renderContext(runtime: Runtime): AgentRenderContext {
    return { workspaceId: runtime.workspaceId, agentId: runtime.agentId, inlineWorkingItems: true, lazyCompletedWorkingItems: true, model: runtime.record.model ? parseModelRef(runtime.record.model) : undefined, transcriptBasePath: `/workspaces/${encodeURIComponent(runtime.workspaceId)}/${options.routeSegment}/${encodeURIComponent(runtime.agentId)}` };
  }
  function transcriptItems(runtime: Runtime): TranscriptItem[] {
    return [
      ...options.transcript(runtime),
      ...runtime.state.notices.map((text, index) => ({ type: "note" as const, key: `notice:${index}`, text, tone: "warning" as const })),
      ...runtime.failure ? [{ type: "error" as const, key: "connection-error", text: runtime.failure.message }] : [],
    ];
  }
  function transcriptHtml(runtime: Runtime) {
    const ctx = renderContext(runtime);
    // A harness may still be connecting; its prompt loads when the entry opens, so connecting doesn't change the transcript.
    return renderLazyTranscriptEntry(ctx, "system-prompt", "System prompt") + renderTranscript(ctx, transcriptItems(runtime), { systemPrompt: "", tools: [] }, runtime.isBusy);
  }
  function liveRegions(runtime: Runtime): LiveRegion[] {
    const ctx = renderContext(runtime);
    return [
      { target: ids.transcript(ctx), html: transcriptHtml(runtime) },
      { target: ids.background(ctx), html: renderBackgroundActivities(ctx, options.background?.activities(runtime) ?? []) },
      { target: ids.actions(ctx), html: renderPromptActions(ctx, runtime.isTurnRunning, runtime.isBusy) },
      { target: ids.stats(ctx), html: renderAgentPaneComposerFooter(ctx, options.stats(runtime)) },
      { target: ids.completionCatalog(ctx), html: runtime.completionCatalog },
    ];
  }
  async function paneHtml(runtime: Runtime) {
    await runtime.refreshCompletionCatalog();
    return renderAgentPane(renderContext(runtime), { agentId: runtime.agentId }, { regions: () => liveRegions(runtime) }, { moduleChannel: options.channelName, notifications: false, background: false, initialPromptDraft: false });
  }
  return { channelName: options.channelName, routeSegment: options.routeSegment, background: options.background, renderContext, transcriptItems, liveRegions, paneHtml };
}
export type NativeAgentRendering<Runtime extends NativeAgentRuntime> = ReturnType<typeof createNativeAgentRendering<Runtime>>;
