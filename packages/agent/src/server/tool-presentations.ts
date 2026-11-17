import type { AgentRenderContext } from "./render-context.ts";
import type { ToolView } from "./transcript.ts";

/** How a feature shows its own tool's calls; `undefined` falls back to the generic row. */
export interface AgentToolPresentation {
  /** Optional human-facing action name; execution and expanded raw details keep the tool identity. */
  displayName?: string;
  summary(tool: ToolView): string | undefined;
  detail(ctx: AgentRenderContext, tool: ToolView): string | undefined;
}

const registered: Array<ReadonlyMap<string, AgentToolPresentation>> = [];

/** Each feature registers its tools' presentations once; resolves to unregistering them. */
export function registerAgentToolPresentations(presentations: ReadonlyMap<string, AgentToolPresentation>): () => void {
  for (const name of presentations.keys()) if (agentToolPresentation(name)) throw new Error(`Tool presentation already registered: ${name}`);
  registered.push(presentations);
  return () => { registered.splice(registered.indexOf(presentations), 1); };
}

export function agentToolPresentation(name: string): AgentToolPresentation | undefined {
  for (const presentations of registered) {
    const presentation = presentations.get(name);
    if (presentation) return presentation;
  }
  return undefined;
}
