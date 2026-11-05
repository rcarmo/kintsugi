import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { createWorkspaceMetadataState } from "@kintsugi/workspace";
import { getKintsugiRuntimeContext, invalidArguments, KintsugiCoreError } from "@kintsugi/core";
import { defineWorkspaceTool } from "./workspace-tool.ts";
import { agentPlanAction, agentPlanInputSchema, changeAgentPlan, defaultAgentPlan, normalizeAgentPlan, parseAgentPlan, type AgentPlanInput } from "./plan-model.ts";
export { agentPlanInputSchema, agentPlanAction, agentPlanSubmission, type AgentPlanInput } from "./plan-model.ts";
const savedSchema = Type.Object({ agentId: Type.String(), markdown: Type.String(), revision: Type.Integer({ minimum: 1 }), updatedAt: Type.String() });
const storeSchema = Type.Object({ plans: Type.Array(savedSchema) });
type SavedPlan = Static<typeof savedSchema>;
export type AgentPlan = Omit<SavedPlan, "revision" | "updatedAt"> & { revision: number; updatedAt: string | null; explanation: string | null; plan: ReturnType<typeof parseAgentPlan>["plan"] };
export interface PlanAgent { id: string; title: string; readOnly?: boolean }
const resolvers = new Map<string, (workspaceId: string, agentId: string) => Promise<PlanAgent | undefined>>();
export function registerPlanAgentResolver(kind: string, resolve: (workspaceId: string, agentId: string) => Promise<PlanAgent | undefined>): void { resolvers.set(kind, resolve); }
export async function requirePlanAgent(workspaceId: string, agentId: string): Promise<PlanAgent> {
  validateIdentity(workspaceId, agentId);
  if (!existsSync(join(getKintsugiRuntimeContext().kintsugiDataDir, "workspaces", workspaceId, "metadata"))) throw new KintsugiCoreError("workspace_not_found", "Workspace not found");
  for (const resolve of resolvers.values()) { const agent = await resolve(workspaceId, agentId); if (agent) return agent; }
  throw new KintsugiCoreError("agent_not_found", "Agent not found in this workspace");
}
function validateIdentity(workspaceId: string, agentId: string) {
  if (![workspaceId, agentId].every(value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value))) throw invalidArguments("Invalid workspace or agent identifier");
}
export class AgentPlanConflict extends Error {}
export function createAgentPlanStore(dataDir = getKintsugiRuntimeContext().kintsugiDataDir) {
  const storage = createWorkspaceMetadataState("agent-plans.json", value => Value.Parse(storeSchema, value), () => ({ plans: [] }), { dataDir });
  const listeners = new Set<(workspaceId: string, agentId: string) => void>();
  function read(workspaceId: string, agentId: string): AgentPlan {
    validateIdentity(workspaceId, agentId);
    const saved = storage.read(workspaceId).plans.find(plan => plan.agentId === agentId);
    const markdown = saved?.markdown ?? defaultAgentPlan;
    return { agentId, markdown, revision: saved?.revision ?? 0, updatedAt: saved?.updatedAt ?? null, ...parseAgentPlan(markdown) };
  }
  return {
    read,
    change(workspaceId: string, agentId: string, input: AgentPlanInput): AgentPlan {
      if (!Value.Check(agentPlanInputSchema, input)) throw invalidArguments("Invalid plan action or fields");
      const current = read(workspaceId, agentId);
      if (agentPlanAction(input) === "read") return current;
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) throw new AgentPlanConflict("The plan changed elsewhere. Your draft is kept; refresh before replacing it.");
      const markdown = normalizeAgentPlan(changeAgentPlan(current.markdown, input));
      const next = { agentId, markdown, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      const plans = storage.read(workspaceId).plans.filter(plan => plan.agentId !== agentId);
      storage.write(workspaceId, { plans: [...plans, next] });
      for (const listener of listeners) listener(workspaceId, agentId);
      return read(workspaceId, agentId);
    },
    subscribe(listener: (workspaceId: string, agentId: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    delete(workspaceId: string) { validateIdentity(workspaceId, "plan"); storage.delete(workspaceId); },
  };
}
let active: { directory: string; store: ReturnType<typeof createAgentPlanStore> } | undefined;
export function agentPlanStore() {
  const directory = getKintsugiRuntimeContext().kintsugiDataDir;
  if (!active || active.directory !== directory) active = { directory, store: createAgentPlanStore(directory) };
  return active.store;
}
export const planToolDescription = "Read or update your own persistent, user-editable plan. Prefer action=patch with add/update/remove items; action=update replaces the structured plan. Statuses: pending, in_progress, completed; at most one in_progress. read returns Markdown and revision; mutations return a compact acknowledgement without repeating the checklist. write replaces Markdown; edit applies nonoverlapping exact edits (replace/delete/insert_before/insert_after/append/prepend); reset restores the default checklist. Use expectedRevision from read when replacing a plan to avoid overwriting user changes. Saving a plan never starts work. Plans belong to this Agent, not the workspace, and survive new sessions and compaction.";
export function planToolOutput(input: AgentPlanInput, plan: AgentPlan): string {
  if (agentPlanAction(input) === "read") return `Plan (revision ${plan.revision})\n\n${plan.markdown}`;
  const done = plan.plan.filter(item => item.status === "completed").length;
  const active = plan.plan.find(item => item.status === "in_progress")?.step;
  return `Plan updated (revision ${plan.revision}; ${done}/${plan.plan.length} complete).${active ? ` Current: ${active.slice(0, 160)}` : ""}`;
}
export function createAgentPlanTool(workspaceId: string, agentId: string) {
  return defineWorkspaceTool({ name: "plan", label: "Plan", description: planToolDescription, parameters: agentPlanInputSchema,
    async execute(_id, input) {
      const plan = agentPlanStore().change(workspaceId, agentId, input);
      return { content: [{ type: "text" as const, text: planToolOutput(input, plan) }], details: { revision: plan.revision } };
    },
  });
}
