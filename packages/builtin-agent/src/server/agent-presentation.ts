import type { DescendantUsage } from "./durable-usage.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { durableContextTokens } from "./durable-accounting.ts";
import { renderDurableTree } from "./durable-tree.ts";
import type { TreeFilterMode } from "./session-tree.ts";
import { createPiModelRuntime, type ModelRef } from "@kintsugi/llm/server";
import { createLivePresentation, type LiveRegion, type LiveRegionDigests } from "@kintsugi/shared";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { DurableAgentController } from "./durable-runtime.ts";
import { DurableAgentPresentation } from "./durable-presentation.ts";
import { enabledModelOptionViews } from "@kintsugi/agent/server/model-state";
import { renderWorkspaceCompletionCatalog } from "@kintsugi/agent/server/completion-catalog";
import { renderNotice } from "./render-notice.ts";
import { ids } from "@kintsugi/agent/server/render-context";
import { promptCacheHitPercent } from "@kintsugi/agent/server/prompt-usage";
import { renderAgentPaneComposerFooter, renderPromptActions, type AgentStatsView } from "./render-composer.ts";
import { notificationControlId, renderNotificationControl } from "./render-notification.ts";
import type { WorkspaceAgentInfo } from "./agent-store.ts";
import type { AgentLivePresentationListener } from "./runtime-types.ts";

/** Host chrome wraps committed native views; it never synthesizes transcript events. */
export class AgentPresentation {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly label: string;
  readonly readOnly: boolean;
  readonly jsonFinalAnswers: boolean;
  private presentation!: DurableAgentPresentation;
  private readonly transcriptListeners = new Map<AgentLivePresentationListener, { unsubscribe(): void }>();
  private unsubscribeWork!: () => void;
  private unsubscribeUsage!: () => void;
  private descendantUsage?: DescendantUsage;
  private unsubscribeStatus!: () => void;
  private unsubscribeOptimizer?: () => void;
  private unsubscribeSelection!: () => void;
  model?: { provider: string; id: string };
  private thinkingLevel = "off";
  private models: AgentStatsView["models"] = [];
  private catalog = "";
  private busy = false;
  private contextTokens = 0;
  private disposed = false;
  private failure?: Error;
  private readonly chrome = createLivePresentation(() => this.chromeRegions(), 50);
  private chromeRegions(): LiveRegion[] {
    return [
      { target: ids.actions(this), html: renderPromptActions(this, this.isStreaming, this.controller.hasStoppableWork, "followUp") },
      { target: ids.stats(this), html: renderAgentPaneComposerFooter(this, this.stats()), morph: false },
      { target: ids.completionCatalog(this), html: this.catalog },
      { target: notificationControlId(this), html: renderNotificationControl(this, this.isStreaming), action: "replace" },
      ...(this.failure ? [{ target: ids.notices(this), html: renderNotice("error", "This Agent view disconnected. Reload to reconnect.") }] : []),
    ];
  }

  private constructor(agent: WorkspaceAgentInfo, private readonly controller: DurableAgentController, private readonly modelRuntime: Awaited<ReturnType<typeof createPiModelRuntime>>) {
    this.workspaceId = agent.workspaceId;
    this.agentId = agent.agentId;
    this.label = agent.label;
    this.readOnly = controller.readOnly;
    this.jsonFinalAnswers = Boolean(agent.oneShot);
  }
  static async create(agent: WorkspaceAgentInfo, controller: DurableAgentController) {
    const runtime = new AgentPresentation(agent, controller, await createPiModelRuntime());
    try {
      runtime.presentation = await DurableAgentPresentation.attach(controller, {
        ...agent, branchId: String(controller.id), jsonFinalAnswers: runtime.jsonFinalAnswers,
        // A one-shot agent takes no input but still runs live; only imported histories render as snapshots.
        readOnly: agent.readOnly && !agent.oneShot,
      }, BACKGROUND_CONTEXT, () => runtime.committed());
      runtime.unsubscribeWork = controller.subscribeWork(() => runtime.chrome.invalidate());
      runtime.unsubscribeUsage = controller.subscribeUsage(() => { void runtime.refreshUsage().catch(error => console.error("Could not refresh descendant usage", error)); });
      await runtime.refreshUsage();
      runtime.unsubscribeStatus = controller.subscribeStatus(() => runtime.chrome.invalidate());
      runtime.unsubscribeOptimizer = controller.subscribeOptimizer(() => runtime.chrome.invalidate());
      runtime.unsubscribeSelection = controller.subscribeSelection(() => runtime.attachSelectedBranch());
      await runtime.committed();
      if (!runtime.readOnly) await runtime.refreshModelConfiguration();
      runtime.observePresentation();
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  private observePresentation() {
    const runtime = this;
    const observed = this.presentation;
    void observed.closed.then(result => {
      if (runtime.disposed || runtime.presentation !== observed) return;
      runtime.failure = new Error(`Native conversation observation ended: ${JSON.stringify(result)}`);
      console.error(runtime.failure);
      runtime.publishBusy(false);
    });
  }
  private async attachSelectedBranch() {
    if (this.disposed) return;
    const previous = this.presentation;
    const next = await DurableAgentPresentation.attach(this.controller, { workspaceId: this.workspaceId, agentId: this.agentId, branchId: String(this.controller.id), jsonFinalAnswers: this.jsonFinalAnswers }, BACKGROUND_CONTEXT, () => this.committed());
    if (this.disposed) { await next.dispose(); return; }
    this.presentation = next;
    this.observePresentation();
    for (const [listener, subscription] of this.transcriptListeners) {
      subscription.unsubscribe();
      this.transcriptListeners.set(listener, this.presentation.subscribeLivePresentation(listener));
    }
    await previous.dispose();
    await this.committed();
    await this.refreshModelConfiguration();
  }
  private assertOpen() {
    if (this.failure) throw this.failure;
    if (this.disposed) throw new Error("Agent view is detached");
  }
  private publishBusy(busy: boolean) {
    if (busy === this.busy) return;
    this.busy = busy;
    this.chrome.invalidate();
  }
  private async committed() {
    // attach starts the watch before returning its initial frame.
    if (!this.presentation || this.disposed) return;
    if (this.readOnly) return;
    const { agent } = this.presentation.state;
    this.model = agent.model ? { provider: agent.model.provider, id: agent.model.modelId } : undefined;
    this.thinkingLevel = agent.thinkingLevel ?? "off";
    this.publishBusy(this.presentation.busy);
    this.contextTokens = durableContextTokens(await this.controller.context(BACKGROUND_CONTEXT));
    this.chrome.invalidate();
  }
  get isStreaming() { return this.busy; }
  currentModel() { return this.model; }
  private availableThinkingLevels() {
    const model = this.model && this.modelRuntime.getModel(this.model.provider, this.model.id);
    return model ? getSupportedThinkingLevels(model) : [];
  }
  private async refreshUsage() {
    this.descendantUsage = await this.controller.descendantUsage();
    if (!this.disposed) this.chrome.invalidate();
  }
  private stats(): AgentStatsView {
    const usage = this.presentation.state.usage;
    const buckets = [...Object.values(usage.models), ...Object.values(usage.tools)];
    const model = this.model && this.modelRuntime.getModel(this.model.provider, this.model.id);
    return { nativeBranchUsage: true, descendantCost: this.descendantUsage?.cost, contextPercent: model?.contextWindow ? this.contextTokens / model.contextWindow * 100 : null, compactAvailable: !this.isStreaming && Boolean(this.model),
      inputTokens: buckets.reduce((sum, item) => sum + item.input, 0), outputTokens: buckets.reduce((sum, item) => sum + item.output, 0),
      cacheHitPercent: promptCacheHitPercent(buckets),
      familyCacheHitPercent: this.descendantUsage ? promptCacheHitPercent([...buckets, this.descendantUsage]) : undefined,
      cost: buckets.reduce((sum, item) => sum + item.cost.total, 0), modelName: this.model?.id,
      optimizer: this.controller.optimizerChip(), thinkingLevel: this.thinkingLevel, thinkingLevels: this.availableThinkingLevels(), models: this.models.map(model => ({ ...model, selected: model.provider === this.model?.provider && model.id === this.model.id })) };
  }
  subscribeLivePresentation(listener: AgentLivePresentationListener, shown?: LiveRegionDigests) {
    this.assertOpen();
    this.transcriptListeners.set(listener, this.presentation.subscribeLivePresentation(listener, shown));
    const chrome = this.chrome.subscribe(listener, shown);
    return { unsubscribe: () => { this.transcriptListeners.get(listener)?.unsubscribe(); this.transcriptListeners.delete(listener); chrome.unsubscribe(); } };
  }
  subscribeTurnPresentation(turn: string, branch: string, listener: AgentLivePresentationListener) { this.assertOpen(); return this.presentation.subscribeTurnPresentation(turn, branch, listener); }
  /** The regions the agent channel publishes, for the pane to place. */
  paneState() { this.assertOpen(); return { regions: () => [this.presentation.transcriptRegion(), ...this.chromeRegions()], readOnly: this.readOnly }; }
  private catalogLoad?: Promise<void>;
  /** Skills and templates load from the container once; finished turns refresh them. */
  loadCompletionCatalog() {
    return this.catalogLoad ??= this.refreshCompletionCatalog().catch(error => { this.catalogLoad = undefined; throw error; });
  }
  async refreshCompletionCatalog() { if (this.readOnly) return; this.catalog = await renderWorkspaceCompletionCatalog(this.workspaceId); this.chrome.invalidate(); }
  revealTurn(target: string) { return this.presentation.revealTurn(target); }
  async refreshModelConfiguration(defaultModel?: ModelRef) {
    if (this.readOnly) return;
    if (defaultModel) await this.controller.configureDefaultModel({ provider: defaultModel.provider, modelId: defaultModel.id });
    const settings = await this.controller.settings();
    this.model = settings.model ? { provider: settings.model.provider, id: settings.model.modelId } : undefined;
    this.thinkingLevel = settings.thinkingLevel ?? "off";
    this.models = await enabledModelOptionViews(this.currentModel() ?? null, this.modelRuntime);
    this.chrome.invalidate();
  }
  async detailHtml(key: string, count?: number) { return this.presentation.detailHtml(key, count); }
  async treeHtml(options: { filter: TreeFilterMode; query: string }) { this.assertOpen(); return renderDurableTree(await this.controller.tree(), { ...options, historyPath: `/workspaces/${encodeURIComponent(this.workspaceId)}/agent-history` }); }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.chrome.dispose();
    this.unsubscribeSelection?.();
    this.unsubscribeStatus?.();
    this.unsubscribeOptimizer?.();
    this.unsubscribeUsage?.();
    this.unsubscribeWork?.();
    this.publishBusy(false);
    await this.presentation?.dispose();
  }
}
