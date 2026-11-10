import type { JsonValue } from "@earendil-works/chord/json";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { defineDoc, defineExtension, GenerationTask, hook, UsageDoc, type TaskId, type Tx } from "@earendil-works/pi-durable";

/** Count live owning tool tasks, including calls not yet submitting their first prompt. */
const OneShotAdmissions = defineDoc<{ tasks: TaskId[] }>({ checkpointWhen: () => false,
  kind: "kintsugi.one-shot-admissions", version: 1, scope: "session", initial: () => ({ tasks: [] }),
});
export async function admitOneShotAgent(tx: Tx, taskId: TaskId) {
  const state = await tx.doc(OneShotAdmissions);
  const live: TaskId[] = [];
  for (const id of state.tasks) {
    const task = await tx.task(id);
    if (task && task.state.status !== "terminal") live.push(id);
  }
  if (live.length >= 8) throw new Error("At most eight one-shot agents may run in a workspace at once");
  state.tasks = [...live, taskId];
}

export const OneShotBudget = defineDoc<{ startedAt: number }>({ checkpointWhen: () => false,
  kind: "kintsugi.one-shot-budget", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ startedAt: 0 }),
});
/** Checked between requests; a provider request may cross the output-token threshold. */
export const oneShotLimits = defineExtension({ name: "kintsugi.one-shot-limits", hooks: [hook(GenerationTask, {
  async beforeRequest(_request, api, context) {
    const budget = await api.snapshot(OneShotBudget, api.conversationId, context);
    if (!budget?.startedAt) return;
    const usage = await api.snapshot(UsageDoc, api.conversationId, context);
    const output = Object.values(usage?.models ?? {}).reduce((sum, item) => sum + item.output, 0);
    if (Date.now() - budget.startedAt > 300_000 || output >= 32768) {
      throw new Error("One-shot agent reached its five-minute or 32k output-token budget");
    }
  },
})] });

/** Bound the host validator's work and reject executable-complexity schema features. */
const primitiveJson = Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String()]);
export function assertOneShotJson(value: JsonValue, schema: boolean) {
  const maxChars = schema ? 32768 : 65536;
  if (JSON.stringify(value).length > maxChars) throw new Error(`One-shot ${schema ? "schema" : "answer"} exceeds ${maxChars} characters`);
  let nodes = 0;
  const visit = (value: JsonValue, depth: number, mode: "schema" | "map" | "data") => {
    if (++nodes > (schema ? 1024 : 4096) || depth > 32) throw new Error("One-shot JSON exceeds the nesting or node limit");
    if (Value.Check(primitiveJson, value)) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1, mode); return; }
    for (const [key, child] of Object.entries(value)) {
      if (mode === "schema" && ["pattern", "patternProperties", "$ref", "$dynamicRef", "$recursiveRef"].includes(key)) throw new Error(`One-shot schemas do not support ${key}`);
      const next = mode === "map" ? "schema" : mode === "data" || ["const", "enum", "default", "examples"].includes(key) ? "data" : ["properties", "$defs", "definitions", "dependentSchemas"].includes(key) ? "map" : "schema";
      visit(child, depth + 1, next);
    }
  };
  visit(value, 0, schema ? "schema" : "data");
}
