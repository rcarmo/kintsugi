import type { Context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { type Conversation, type ConversationView, type WatchHandle } from "@earendil-works/pi-durable";
import { StreamingMarkdownRenderer } from "@kintsugi/markdown";
import { createLivePresentation, type LiveRegion, type LiveRegionDigests } from "@kintsugi/shared";
import type { AgentRenderContext } from "@kintsugi/agent/server/render-context";
import { LiveTranscriptRenderer } from "./render-live-transcript.ts";
import { renderModelContextDetailFrame, renderTranscriptItemDetailFrame, type AgentModelContextView } from "@kintsugi/agent/server/render-transcript";
import type { AgentLivePresentationListener, AgentLivePresentationSubscription } from "./runtime-types.ts";
import { findTranscriptItem, type TranscriptItem } from "@kintsugi/agent/server/transcript";
import { activeConversationView, durableViewState, projectDurableTranscript } from "./durable-transcript.ts";
import { onValues } from "./durable-watch.ts";
import { readScrollbackPage } from "./durable-scrollback.ts";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";

/**
 * A window that never drops entries: the transcript shows the whole active context, not only its newest entries.
 * Durable scans one entry more than the window holds, which must stay a safe integer.
 */
const wholeWindow = Number.MAX_SAFE_INTEGER - 1;

/**
 * Server-rendered native transcript adapter. The execution owner outlives this
 * mount: disconnect/dispose only detaches observation, never cancels durable work.
 * No optimistic user rows, provider callbacks, timers or secondary transcript.
 * Runtime chrome (composer settings, notifications, catalog) stays with the host.
 */
export class DurableAgentPresentation {
  private readonly renderer = new LiveTranscriptRenderer();
  private readonly markdown = new Map<string, { source: string; renderer: StreamingMarkdownRenderer; stableHtml: string; tailHtml: string; tailBlocks?: readonly string[] }>();
  private readonly turns = new Map<string, { presentation: ReturnType<typeof createLivePresentation>; subscriptions: Set<AgentLivePresentationSubscription> }>();
  private readonly presentation = createLivePresentation(() => [this.transcriptRegion()], 50);
  private items: TranscriptItem[];
  private modelContext: AgentModelContextView = { systemPrompt: "", tools: [] };
  private frame: ConversationView;
  private disposed = false;
  private readonly ctx: AgentRenderContext;

  private older: EntryRecord[] = [];
  private before?: EntryId;
  private loading?: Promise<void>;

  private constructor(private readonly watch: WatchHandle<ConversationView>, private readonly conversation: Pick<Conversation, "id"> & { history: Conversation["entries"] }, ctx: AgentRenderContext, private readonly onCommit?: (view: ConversationView) => void | Promise<void>) {
    this.frame = watch.value;
    this.before = watch.value.before;
    this.items = projectDurableTranscript(this.frame);
    this.ctx = { ...ctx, streamingText: (key, source) => {
      let cached = this.markdown.get(key);
      if (!cached || !source.startsWith(cached.source)) {
        cached = { source: "", renderer: new StreamingMarkdownRenderer(ctx.workspaceId), stableHtml: "", tailHtml: "" };
        this.markdown.set(key, cached);
      }
      if (source !== cached.source) {
        const update = cached.renderer.render(source);
        cached.source = source;
        cached.stableHtml += update.stableHtmlAddition;
        cached.tailHtml = update.tailHtml;
        cached.tailBlocks = update.tailBlocks;
      }
      return cached;
    } };
    this.update(this.frame);
    watch.start(onValues(async value => {
      if (this.disposed) return;
      this.update(value);
      await this.onCommit?.(activeConversationView(value));
    }));
    // A failed observer must be visible to the production owner, not mistaken
    // for an idle agent. `closed` returns the native terminal reason to callers.
    void watch.closed.then(() => this.release());
  }

  static async attach(conversation: Pick<Conversation, "id" | "watch" | "context"> & { history: Conversation["entries"] }, ctx: AgentRenderContext, context: Context, onCommit?: (view: ConversationView) => void | Promise<void>) {
    // Initially read only the active context. Older history is paged separately;
    // subsequent compactions/reset must not remove messages already on screen.
    const { head } = await conversation.context(context);
    const watch = await conversation.watch(context, { from: head?.head, min: wholeWindow, max: wholeWindow });
    try { return new DurableAgentPresentation(watch, conversation, ctx, onCommit); }
    catch (error) { await watch.stop(); throw error; }
  }

  /** Same exact frame used for transcript, busy state, settings, inbox and usage. */
  get state() { return durableViewState(this.frame); }
  get busy(): boolean { return Boolean(this.state.live.run || this.state.live.compactions?.length); }
  get branchId(): string { return this.ctx.branchId!; }
  get closed() { return this.watch.closed; }

  /** Display history and active model context have independent boundaries. */
  private update(view: ConversationView) {
    this.frame = view;
    const branch = String(view.conversation.id);
    if (branch !== this.ctx.branchId) {
      this.clearTurns();
      this.markdown.clear();
      this.renderer.clear();
      this.ctx.branchId = branch;
    }
    const model = this.state.agent.model;
    this.ctx.model = model ? { provider: model.provider, id: model.modelId } : undefined;
    this.items = projectDurableTranscript({ ...view, entries: [...this.older, ...view.entries] });
    // Display committed system deltas, never re-render a mutable prompt loader
    // while reconstructing history. Honor context overrides for these details.
    const active = activeConversationView(view);
    const edits = new Map(active.entries.flatMap(entry => entry.edits ?? []).map(edit => [edit.target, edit]));
    const messages = active.entries.flatMap(entry => {
      const edit = edits.get(entry.id);
      return edit?.action === "omit" ? [] : edit?.action === "replace" ? edit.messages : entry.model ?? [];
    });
    this.modelContext = { systemPrompt: getCurrentSystemPrompt(messages), tools: getCurrentTools(messages) };
    this.presentation.invalidate();
    for (const channel of this.turns.values()) channel.presentation.invalidate();
    // A finalized partial gets a persisted entry identity. Don't retain every
    // old incremental parser for the lifetime of a long conversation.
    const liveKeys = new Set<string>();
    const collect = (items: TranscriptItem[]) => { for (const item of items) {
      if (item.type === "text" && item.live) liveKeys.add(item.key);
      if (item.type === "working") collect(item.items);
    } };
    collect(this.items);
    for (const key of this.markdown.keys()) if (!liveKeys.has(key)) this.markdown.delete(key);
  }

  private assertOpen() { if (this.disposed) throw new Error("Durable presentation is detached"); }

  transcriptRegion(): LiveRegion {
    this.assertOpen();
    return this.renderer.renderTranscript(this.ctx, this.items, this.modelContext, this.busy, this.before);
  }

  /** View-only expansion, shared by this Agent's viewers; retries cannot consume another page. */
  async loadEarlier(branch: string, before: number, context: Context): Promise<string | null> {
    const current = () => !this.disposed && branch === this.branchId && String(this.conversation.id) === String(this.frame.conversation.id);
    if (!current()) return null;
    while (this.loading) await this.loading;
    if (!current()) return null;
    if (before === this.before) {
      this.loading = (async () => {
        const page = await readScrollbackPage(this.conversation.history, this.before!, context);
        if (!current()) return;
        this.older = [...page.entries, ...this.older];
        this.before = page.before;
        this.update(this.frame);
      })();
      try { await this.loading; } finally { this.loading = undefined; }
    }
    if (!current()) return null;
    // A snapshot also works when live updates are disconnected or beat the HTTP reply.
    let html = "";
    const subscription = this.presentation.subscribe(stream => { html = stream; });
    subscription.unsubscribe();
    return html;
  }

  subscribeLivePresentation(listener: AgentLivePresentationListener, shown?: LiveRegionDigests): AgentLivePresentationSubscription {
    this.assertOpen();
    return this.presentation.subscribe(listener, shown);
  }

  subscribeTurnPresentation(turnId: string, branchId: string, listener: AgentLivePresentationListener): AgentLivePresentationSubscription {
    this.assertOpen();
    if (branchId !== this.branchId) throw new Error("Turn subscription belongs to an obsolete branch");
    if (findTranscriptItem(this.items, turnId)?.type !== "working") throw new Error(`Unknown turn: ${turnId}`);
    let channel = this.turns.get(turnId);
    if (!channel) {
      channel = { subscriptions: new Set(), presentation: createLivePresentation(() => {
        const turn = findTranscriptItem(this.items, turnId);
        return turn?.type === "working" ? [this.renderer.renderTurn(this.ctx, turn)] : [];
      }, 50) };
      this.turns.set(turnId, channel);
    }
    const owned = channel;
    const subscription = owned.presentation.subscribe(listener);
    const handle: AgentLivePresentationSubscription = { unsubscribe: () => {
      subscription.unsubscribe();
      owned.subscriptions.delete(handle);
      if (!owned.subscriptions.size) {
        owned.presentation.dispose();
        if (this.turns.get(turnId) === owned) this.turns.delete(turnId);
      }
    } };
    owned.subscriptions.add(handle);
    return handle;
  }

  detailHtml(key: string, count = 100): string {
    this.assertOpen();
    if (key === "system-prompt" || key === "tool-definitions") return renderModelContextDetailFrame(this.ctx, this.modelContext, key);
    const item = findTranscriptItem(this.items, key);
    return item ? renderTranscriptItemDetailFrame(this.ctx, item, { count }) : "";
  }

  revealTurn(target: string): string | undefined {
    this.assertOpen();
    return this.items.find(item => item.type === "working" && item.items.some(child => child.key === target || child.anchor === target))?.key;
  }

  private clearTurns() {
    for (const channel of this.turns.values()) {
      for (const subscription of [...channel.subscriptions]) subscription.unsubscribe();
      channel.presentation.dispose();
    }
    this.turns.clear();
  }

  private release() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTurns();
    this.presentation.dispose();
    this.markdown.clear();
    this.renderer.clear();
  }

  async dispose(): Promise<void> {
    this.release();
    await this.watch.stop();
  }
}
