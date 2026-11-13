import type { ScriptFileView, ToolView, TranscriptItem } from "./transcript.ts";

export type AgentTranscriptAnchor = {
  anchor: string;
  target: { toolCallId: string } | { entryId: string };
};

/** Declarative data only. The adapter never receives or rewrites host transcript items.
 * Anchors are resolved by the host for snapshots, lazy details and reveal requests;
 * they do not replace live tool/text DOM while it is streaming. */
export interface AgentTranscriptSnapshot {
  rows: (Extract<TranscriptItem, { type: "extension" }> & { afterInputEntryId?: string })[];
  anchors: AgentTranscriptAnchor[];
  /**
   * Calls tools made to other tools, such as a script's, by the calling tool's call ID. An unfinished call is
   * `running`: the host shows its live progress, or that it was cut off when the calling tool ended first.
   */
  nested?: { toolCallId: string; calls: ToolView[] }[];
  /** The script files code mode calls ran, by the call's ID. */
  scriptFiles?: { toolCallId: string; file: ScriptFileView }[];
  /** Entries before this persisted marker are copied context; entries after it are local activity. */
  inheritedContext?: { boundaryEntryId: string; source: string };
}

export function applyTranscriptContributions(items: TranscriptItem[], snapshot: AgentTranscriptSnapshot): TranscriptItem[] {
  const annotate = (items: TranscriptItem[]): TranscriptItem[] => items.map((item) => {
    if (item.type === "working") return { ...item, items: annotate(item.items) };
    const anchor = snapshot.anchors.find(({ target }) => "toolCallId" in target
      ? item.type === "tool" && item.tool.callId === target.toolCallId
      : item.type === "text" && item.final && item.key.startsWith(`${target.entryId}:text:`))?.anchor;
    return anchor ? { ...item, anchor } : item;
  });
  const time = (item: TranscriptItem) => item.timestamp ?? (item.type === "working" ? item.startedAt : 0);
  const result = annotate(items);
  for (const item of snapshot.rows) {
    const inputEntryId = item.afterInputEntryId;
    if (inputEntryId !== undefined) {
      const turn = result.find(candidate => candidate.type === "working" && candidate.inputEntryIds?.includes(inputEntryId));
      if (turn?.type === "working") {
        const next = turn.items.findIndex(candidate => time(candidate) > time(item));
        turn.items.splice(next < 0 ? turn.items.length : next, 0, item);
      }
      continue;
    }
    const next = result.findIndex(candidate => time(candidate) > time(item));
    result.splice(next < 0 ? result.length : next, 0, item);
  }
  return result;
}
