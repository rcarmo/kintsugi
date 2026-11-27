import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { transcriptRowContent, transcriptRow } from "@kintsugi/agent/server/render-markup";
import { type AgentTranscriptAnchor, type AgentTranscriptSnapshot } from "@kintsugi/agent/server/transcript-contributions";
import { escapeHtml } from "@kintsugi/shared";
import type { ConversationView } from "@earendil-works/pi-durable";
import { inheritedBoundaryEntry, communicationEntry, communicationStateEntry, type Receipt } from "./native-state.ts";
import { communicationBodyHtml, communicationCardHtml, communicationTraceHtml } from "./render-markup.ts";

export function nativeDelegationTranscript(view: ConversationView): AgentTranscriptSnapshot {
  const incoming = new Map<string, Receipt>();
  const sent: Receipt[] = [];
  for (const entry of view.entries) {
    if (communicationEntry.is(entry)) {
      if (entry.data.direction === "incoming") incoming.set(entry.data.receipt.id, structuredClone(entry.data.receipt));
      else sent.push(entry.data.receipt);
    }
    if (communicationStateEntry.is(entry) && incoming.has(entry.data.id)) Object.assign(incoming.get(entry.data.id)!, entry.data.change);
  }
  const inherited = view.entries.find(inheritedBoundaryEntry.is);
  return { inheritedContext: inherited ? { boundaryEntryId: String(inherited.id), source: inherited.data.source } : undefined, anchors: sent.flatMap<AgentTranscriptAnchor>(receipt => receipt.callId ? [{ anchor: receipt.id, target: { toolCallId: receipt.callId } }]  : receipt.sourceEntry === undefined ? [] : [{ anchor: receipt.id, target: { entryId: String(receipt.sourceEntry) } }]), rows: [...incoming.values()].map(receipt => ({
    type: "extension", key: receipt.id, anchor: receipt.id, timestamp: receipt.timestamp,
    render(ctx) {
      const state = receipt.prepared ? `Prepared as ${receipt.prepared.format} · not a read receipt` : receipt.context === "failed" ? receipt.error! : "Pending model context";
      const body = communicationCardHtml([
        { label: "Type", html: escapeHtml(receipt.kind) },
        { label: "Source", html: communicationTraceHtml(ctx, receipt.from, receipt.id, `Sent from ${receipt.author} here`) },
        { label: "Body", html: communicationBodyHtml(ctx, receipt.text) },
        { label: "Handling", html: escapeHtml(receipt.handling === "idle-task" ? "Starts a turn" : receipt.handling === "idle-message" ? "Waits for the next turn" : receipt.handling === "waiting" ? "Wakes the agent’s wait" : "Queued for the next model boundary") },
        { label: "Context", html: escapeHtml(state) },
      ]);
      return transcriptRow(`<div class="agent-communication">${disclosureHtml({ element: { attributesHtml: `data-transcript-anchor="${escapeHtml(receipt.id)}" data-controller="agent-communication" data-agent-communication-key-value="${escapeHtml(receipt.id)}" data-action="toggle->agent-communication#remember"` }, summary: transcriptRowContent({ kind: "text", text: `Incoming ${receipt.kind} from ${receipt.author}` }), bodyHtml: body })}</div>`);
    },
  })) };
}
