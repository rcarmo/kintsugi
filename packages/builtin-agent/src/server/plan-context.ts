import { isJsonObject } from "@kintsugi/core";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const planContextPrefix = "Current editable plan for this Agent (revision ";
const legacyPlan = Type.Object({ agentId: Type.String(), revision: Type.Integer({ minimum: 0 }), markdown: Type.String(), plan: Type.Array(Type.Unknown()) });

/** Request-only projection: old journals and raw detail views remain unchanged. */
export function compactLegacyPlanHistory(messages: readonly Message[]): Message[] {
  const compact = (text: string): string => {
    if (!text.trimStart().startsWith("{")) return text;
    let value: unknown;
    try { value = JSON.parse(text); } catch { return text; }
    if (!Value.Check(legacyPlan, value)) return text;
    return `Plan recorded (revision ${value.revision}; ${value.plan.length} steps). Use plan read for the current checklist.`;
  };
  return messages.map(message => {
    if (message.role !== "toolResult" || message.toolName !== "plan" || message.isError) return message;
    return { ...message, content: message.content.map(part => part.type === "text" ? { ...part, text: compact(part.text) } : part) };
  });
}
