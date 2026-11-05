import { expect, test } from "bun:test";
import { cacheCanonicalPlanPrefix, compactLegacyPlanHistory, planContextPrefix } from "../../src/server/plan-context.ts";
import type { Message } from "@earendil-works/pi-ai";
import type { JsonObject } from "@kintsugi/core";

test("move the existing breakpoint ahead of the transient plan without mutating content or TTL", () => {
  const payload: JsonObject = { messages: [{ role: "user", content: [{ type: "text", text: "Stable task" }, { type: "text", text: `${planContextPrefix}1).\nChecklist`, cache_control: { type: "ephemeral" } }] }] };
  const before = JSON.stringify(payload);
  expect(cacheCanonicalPlanPrefix("anthropic-messages", payload)).toEqual({ messages: [{ role: "user", content: [{ type: "text", text: "Stable task", cache_control: { type: "ephemeral" } }, { type: "text", text: `${planContextPrefix}1).\nChecklist` }] }] });
  expect(JSON.stringify(payload)).toBe(before);
});
test("cache retention disabled, other providers and unsupported payloads are left alone", () => {
  const content = [{ type: "text", text: "Stable" }, { type: "text", text: `${planContextPrefix}1).\nChecklist` }];
  expect(cacheCanonicalPlanPrefix("anthropic-messages", { messages: [{ role: "user", content }] })).toBeUndefined();
  expect(cacheCanonicalPlanPrefix("openai-codex-responses", { messages: [] })).toBeUndefined();
  expect(cacheCanonicalPlanPrefix("anthropic-messages", { messages: "not an array" })).toBeUndefined();
});
test("a previous tool-result block gets the boundary; signed thinking and tool arguments stay unchanged", () => {
  const payload: JsonObject = { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "reasoning", signature: "signed" }, { type: "tool_use", id: "call", name: "plan", input: { action: "read" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "Plan updated" }] }, { role: "user", content: [{ type: "text", text: `${planContextPrefix}2).\nPlan`, cache_control: { type: "ephemeral" } }] }] };
  const result = cacheCanonicalPlanPrefix("anthropic-messages", payload);
  expect(result).toMatchObject({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "reasoning", signature: "signed" }, { type: "tool_use", id: "call", name: "plan", input: { action: "read" } }] }, { role: "user", content: [{ type: "tool_result", cache_control: { type: "ephemeral" } }] }, { role: "user", content: [{ type: "text", text: `${planContextPrefix}2).\nPlan` }] }] });
});
test("legacy full-plan JSON is compact only in model context, never rewritten in the journal", () => {
  const raw = JSON.stringify({ agentId: "own", revision: 10, markdown: "- [ ] Large old plan", plan: [{ step: "Large old plan", status: "pending" }] });
  const messages: Message[] = [{ role: "toolResult", toolCallId: "call", toolName: "plan", timestamp: 0, isError: false, content: [{ type: "text", text: raw }, { type: "text", text: "diagnostic retained" }] }];
  const projected = compactLegacyPlanHistory(messages);
  expect(projected[0]).toMatchObject({ content: [{ type: "text", text: "Plan recorded (revision 10; 1 steps). Use plan read for the current checklist." }, { type: "text", text: "diagnostic retained" }] });
  expect(messages[0]).toMatchObject({ content: [{ text: raw }, { text: "diagnostic retained" }] });
  const failed: Message = { role: "toolResult", toolCallId: "call", toolName: "plan", timestamp: 0, isError: true, content: [{ type: "text", text: raw }] };
  expect(compactLegacyPlanHistory([failed])[0]).toBe(failed);
});
