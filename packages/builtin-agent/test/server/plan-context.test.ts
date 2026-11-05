import { expect, test } from "bun:test";
import { compactLegacyPlanHistory } from "../../src/server/plan-context.ts";
import type { Message } from "@earendil-works/pi-ai";

test("legacy full-plan JSON is compact only in model context, never rewritten in the journal", () => {
  const raw = JSON.stringify({ agentId: "own", revision: 10, markdown: "- [ ] Large old plan", plan: [{ step: "Large old plan", status: "pending" }] });
  const messages: Message[] = [{ role: "toolResult", toolCallId: "call", toolName: "plan", timestamp: 0, isError: false, content: [{ type: "text", text: raw }, { type: "text", text: "diagnostic retained" }] }];
  const projected = compactLegacyPlanHistory(messages);
  expect(projected[0]).toMatchObject({ content: [{ type: "text", text: "Plan recorded (revision 10; 1 steps). Use plan read for the current checklist." }, { type: "text", text: "diagnostic retained" }] });
  expect(messages[0]).toMatchObject({ content: [{ text: raw }, { text: "diagnostic retained" }] });
  const failed: Message = { role: "toolResult", toolCallId: "call", toolName: "plan", timestamp: 0, isError: true, content: [{ type: "text", text: raw }] };
  expect(compactLegacyPlanHistory([failed])[0]).toBe(failed);
});
