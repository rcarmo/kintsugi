import { isJsonObject, type JsonObject } from "@kintsugi/core";
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

/** The live plan is not part of canonical history. Move its existing Anthropic
 * breakpoint to the preceding cacheable block, so the next round can reuse that
 * prefix. No added markers/TTL, no content changes, and cacheRetention:none stays off.
 */
export function cacheCanonicalPlanPrefix(api: string, payload: JsonObject): JsonObject | undefined {
  if (api !== "anthropic-messages" || !Array.isArray(payload.messages)) return;
  const messages = payload.messages;
  const last = messages.at(-1);
  if (!isJsonObject(last) || last.role !== "user" || !Array.isArray(last.content)) return;
  const plan = last.content.at(-1);
  if (!isJsonObject(plan) || plan.type !== "text" || !Value.Check(Type.String(), plan.text) || !plan.text.startsWith(planContextPrefix) || !isJsonObject(plan.cache_control)) return;
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m];
    if (!isJsonObject(message)) continue;
    const blocks: import("@kintsugi/core").JsonValue[] = Array.isArray(message.content) ? message.content : Value.Check(Type.String(), message.content) ? [{ type: "text", text: message.content }] : [];
    for (let b = blocks.length - 1 - (m === messages.length - 1 ? 1 : 0); b >= 0; b--) {
      const block = blocks[b];
      if (!isJsonObject(block) || !["text", "image", "tool_result", "tool_use"].includes(String(block.type))) continue;
      const { cache_control, ...uncachedPlan } = plan;
      return { ...payload, messages: messages.map((entry, index) => {
        if (!isJsonObject(entry) || (index !== m && index !== messages.length - 1)) return entry;
        const content = index === m ? blocks : Array.isArray(entry.content) ? entry.content : [];
        return { ...entry, content: content.map((part, blockIndex) => {
          if (index === messages.length - 1 && blockIndex === content.length - 1) return uncachedPlan;
          return index === m && blockIndex === b ? { ...block, cache_control: block.cache_control ?? cache_control } : part;
        }) };
      }) };
    }
  }
}
