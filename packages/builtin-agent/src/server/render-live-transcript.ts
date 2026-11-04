import { escapeHtml, liveCollection, type LiveRegion } from "@kintsugi/shared";
import { commentaryContext, ids, type AgentRenderContext } from "@kintsugi/agent/server/render-context";
import { renderIdleSeparator, renderModelContextEntries, renderTranscriptItem, renderWorkingSection, workingCommentaryItems, type AgentModelContextView } from "@kintsugi/agent/server/render-transcript";
import type { TranscriptItem, WorkingTranscriptItem } from "@kintsugi/agent/server/transcript";

export class LiveTranscriptRenderer {
  private readonly cache = new Map<string, { fingerprint: string; html: string }>();
  clear(): void { this.cache.clear(); }

  private rows(ctx: AgentRenderContext, items: readonly TranscriptItem[]) {
    return items.map(item => {
      const children: LiveRegion[] = [];
      let commentaryIslands: string | undefined;
      if (item.type === "working") {
        const commentary = commentaryContext(ctx);
        const collection = liveCollection(ids.workingItems(commentary, item.key), this.rows(commentary, workingCommentaryItems(item)));
        commentaryIslands = collection.html;
        children.push(collection);
      }
      const rendering = item.type === "text" && item.live && !(item.final && ctx.jsonFinalAnswers) ? ctx.streamingText!(item.key, item.text) : undefined;
      const key = ids.item(ctx, item.key);
      const fingerprint = item.type === "working" || item.type === "extension" ? undefined : JSON.stringify(rendering ? { ...item, text: "" } : item);
      const cached = this.cache.get(key);
      const html = fingerprint !== undefined && cached?.fingerprint === fingerprint ? cached.html
        : item.type === "working" && commentaryIslands !== undefined ? renderWorkingSection(ctx, item, commentaryIslands)
        : renderTranscriptItem(rendering ? { ...ctx, streamingText: () => ({ stableHtml: "", tailHtml: "" }) } : ctx, item);
      if (fingerprint !== undefined) this.cache.set(key, { fingerprint, html });
      if (rendering) children.push(
        { target: ids.itemTextStable(ctx, item.key), html: rendering.stableHtml, appendOnly: true },
        { target: ids.itemTextTail(ctx, item.key), html: rendering.tailHtml, blocks: rendering.tailBlocks },
      );
      return { id: `${ids.item(ctx, item.key)}_region`, html, children };
    });
  }

  renderTranscript(ctx: AgentRenderContext, items: TranscriptItem[], modelContext: AgentModelContextView, busy = false): LiveRegion {
    const region = liveCollection(ids.transcript(ctx), [{ id: `${ids.transcript(ctx)}_context`, html: renderModelContextEntries(ctx, modelContext) }, ...this.rows(ctx, items), { id: `${ids.transcript(ctx)}_idle`, html: renderIdleSeparator(items, busy) }]);
    // Notices are browser-owned ephemeral messages, never snapshot state.
    region.html += this.noticesMount(ctx);
    return region;
  }

  private noticesMount(ctx: AgentRenderContext): string {
    return `<div id="${escapeHtml(ids.notices(ctx))}" class="agent-notices" data-turbo-permanent></div>`;
  }

  renderTurn(ctx: AgentRenderContext, turn: WorkingTranscriptItem): LiveRegion {
    return liveCollection(ids.workingItems(ctx, turn.key), this.rows(ctx, turn.items));
  }

}
