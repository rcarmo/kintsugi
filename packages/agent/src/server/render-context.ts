import type { ModelRef } from "@kintsugi/llm/server";
import { domId } from "@kintsugi/shared";
import type { SessionImageRef } from "./transcript.ts";

export interface AgentRenderContext {
  streamingText?: (key: string, source: string) => { stableHtml: string; tailHtml: string; tailBlocks?: readonly string[] };
  workspaceId: string;
  agentId: string;
  model?: ModelRef;
  revealTarget?: string;
  branchId?: string;
  /** Distinct DOM identities for the collapsed commentary projection. */
  commentary?: boolean;
  /** Read-only external transcripts use their own detail routes. */
  transcriptBasePath?: string;
  /** Preserve read-only native branch selection through lazy detail expansion. */
  transcriptQuery?: string;
  readOnly?: boolean;
  /** Render working items inline instead of subscribing to builtin turn details. */
  inlineWorkingItems?: boolean;
  /** Load completed working items through the transcript detail route when opened. */
  lazyCompletedWorkingItems?: boolean;
  /** Final answers are JSON, as a script's one-shot agent's are, and show as code. */
  jsonFinalAnswers?: boolean;
}

export function commentaryContext(ctx: AgentRenderContext): AgentRenderContext {
  return { ...ctx, commentary: true };
}

export function agentKey(agentId: string): string {
  return `agent:${agentId}`;
}

function prefix(ctx: AgentRenderContext): string {
  return domId("ag", ctx.workspaceId, ctx.agentId, ...(ctx.commentary ? ["commentary"] : []));
}

export const ids = {
  pane: (ctx: AgentRenderContext) => `${prefix(ctx)}_pane`,
  transcript: (ctx: AgentRenderContext) => `${prefix(ctx)}_transcript`,
  systemPrompt: (ctx: AgentRenderContext) => `${prefix(ctx)}_system_prompt`,
  item: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_item`, key),
  workingItems: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_working_items`, key),
  itemText: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_itemtext`, key),
  itemTextStable: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_itemtext_stable`, key),
  itemTextTail: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_itemtext_tail`, key),
  itemSummaryContent: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_summary_content`, key),
  itemSummaryStatus: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_summary_status`, key),
  detailFrame: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_detail`, key),
  completionCatalog: (ctx: AgentRenderContext) => `${prefix(ctx)}_completion_catalog`,
  stats: (ctx: AgentRenderContext) => `${prefix(ctx)}_stats`,
  actions: (ctx: AgentRenderContext) => `${prefix(ctx)}_actions`,
  abortForm: (ctx: AgentRenderContext) => `${prefix(ctx)}_abort_form`,
  attachRow: (ctx: AgentRenderContext) => `${prefix(ctx)}_attach`,
  input: (ctx: AgentRenderContext) => `${prefix(ctx)}_input`,
  draftAttachRow: (draftId: string) => domId("agent_draft_attach", draftId),
  notices: (ctx: AgentRenderContext) => `${prefix(ctx)}_notices`,
  background: (ctx: AgentRenderContext) => `${prefix(ctx)}_background`,
  backgroundList: (ctx: AgentRenderContext) => `${prefix(ctx)}_background_list`,
  backgroundDetail: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_background_detail`, key),
  backgroundPage: (ctx: AgentRenderContext) => `${prefix(ctx)}_background_page`,
};

export function agentPath(ctx: AgentRenderContext, suffix: string): string {
  return `${ctx.transcriptBasePath ?? `/workspaces/${encodeURIComponent(ctx.workspaceId)}/agents/${encodeURIComponent(ctx.agentId)}`}${suffix}`;
}

export function backgroundActivityPath(ctx: AgentRenderContext, key: string, suffix = ""): string {
  return agentPath(ctx, `/background/${encodeURIComponent(key)}${suffix}`);
}

export function transcriptItemPath(ctx: AgentRenderContext, key: string, query = ""): string {
  const params = [query.replace(/^\?/, ""), ctx.transcriptQuery].filter(Boolean).join("&");
  return `${agentPath(ctx, `/transcript-items/${encodeURIComponent(key)}`)}${params ? `?${params}` : ""}`;
}

export function sessionImageUrl(ctx: AgentRenderContext, image: SessionImageRef): string {
  return `${agentPath(ctx, "")}/session-images/${encodeURIComponent(image.entryId)}/${image.contentIndex}`;
}
