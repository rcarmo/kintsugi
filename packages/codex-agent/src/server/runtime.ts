import { createHash } from "node:crypto";
import { createKeyedOperationQueue, invalidArguments, type KintsugiEventBus } from "@kintsugi/core";
import { workspaceRoot } from "@kintsugi/workspace";
import { createLivePresentation, type WorkspaceAgentInput } from "@kintsugi/shared";
import { parseModelRef, setAgentModelPreference } from "@kintsugi/llm/server";
import { publishWorkspaceAgentBusy } from "@kintsugi/agent/server";
import { createNativeAgents } from "@kintsugi/native-agent/server";
import { renderWorkspaceCompletionCatalog } from "@kintsugi/agent/server/completion-catalog";
import type {
  UserInput,
  TurnStartParams,
  Model,
  ModelListResponse,
  Thread,
  ReasoningEffort,
  SkillMetadata,
  McpServerStatus,
  AppInfo,
  AppsListResponse,
  ListMcpServerStatusResponse,
} from "../protocol.ts";
import type { Requests, CodexNotification } from "./protocol.ts";
import { codexCommandMutates, codexSlashCommands, type CodexCommand, type CodexCommandResult } from "./commands.ts";
import { CodexRpcError, type CodexRpc } from "./rpc.ts";
import { CodexState } from "./state.ts";
import { openCodexTransport } from "./transport.ts";
import { agentTypeId, label, codexHome, prepareCodex, settings } from "./setup.ts";
import { createCodexStore, type CodexAgentRecord } from "./store.ts";
import { liveRegions } from "./render.ts";

export class CodexRuntime {
  readonly state = new CodexState();
  instructions = "";
  private catalog: Model[] = [];
  /** Slash commands and prompt templates; turns can add templates, so each finished turn reloads them. */
  completionCatalog = "";
  failure?: Error;
  private transport!: Awaited<ReturnType<typeof openCodexTransport>>;
  private disposed = false;
  private closing = false;
  private threadId!: string;
  private busy = false;
  private turnPending = false;
  private readonly serialize = createKeyedOperationQueue();
  readonly presentation = createLivePresentation(() => liveRegions(this), 50);
  private constructor(readonly workspaceId: string, readonly record: CodexAgentRecord, private readonly save: () => void, private readonly events: KintsugiEventBus) {}
  get agentId() { return this.record.id; }
  get isBusy() { return !this.failure && Boolean(this.state.activeTurn || this.turnPending); }
  get isTurnRunning() { return this.isBusy; }
  private changed() {
    if (this.disposed) return;
    const busy = this.isBusy;
    if (busy !== this.busy) {
      this.busy = busy;
      publishWorkspaceAgentBusy({ workspaceId: this.workspaceId, agentKey: `agent:${this.agentId}`, busy });
      if (!busy) {
        void this.events.emit("workspace_agent_turn_finished", { workspaceId: this.workspaceId, agentId: this.agentId }).catch(error => console.error("Could not publish Codex turn completion", error));
        void this.refreshCompletionCatalog().catch(error => console.error("Could not refresh Codex completions", error));
      }
    }
    this.presentation.invalidate();
  }
  async systemPrompt() { return this.instructions; }
  async refreshCompletionCatalog() {
    this.completionCatalog = await renderWorkspaceCompletionCatalog(this.workspaceId, "cli", codexSlashCommands);
    this.presentation.invalidate();
  }
  static async open(workspaceId: string, record: CodexAgentRecord, save: () => void, events: KintsugiEventBus) {
    const runtime = new CodexRuntime(workspaceId, record, save, events);
    try { await runtime.connect(); return runtime; }
    catch (error) { await runtime.dispose(); throw error; }
  }
  async reconnect() {
    return this.serialize(this.agentId, async () => {
      if (!this.failure) return;
      if (this.disposed || this.closing) throw new Error("Codex Agent is closed");
      await this.transport.close();
      this.failure = undefined;
      await this.connect();
    });
  }
  private async connect() {
    this.turnPending = false;
    const queued: CodexNotification[] = [];
    let ready = false;
    try {
      const prepared = await prepareCodex(this.workspaceId, this.agentId);
      this.instructions = prepared.instructions;
      this.transport = await openCodexTransport(this.workspaceId, codexHome(this.agentId), notification => {
        if (!ready) queued.push(notification);
        else {
          this.receive(notification);
        }
      }, error => { this.failure = error; this.changed(); }, prepared.mcp);
      const { rpc } = this.transport;
      await rpc.request("initialize", { clientInfo: { name: "kintsugi", title: "Kintsugi", version: "1.0.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
      rpc.notify("initialized");
      const common = this.threadParameters;
      const resume = Boolean(this.record.threadId);
      const response = resume
        ? await rpc.request("thread/resume", { threadId: this.record.threadId!, ...common })
        : await rpc.request("thread/start", common);
      this.threadId = response.thread.id;
      this.catalog = [];
      this.record.model = `openai-codex::${response.model}`;
      this.record.thinkingLevel ??= response.reasoningEffort ?? undefined;
      let modelCursor: string | null = null;
      do {
        const page: ModelListResponse = await rpc.request("model/list", { cursor: modelCursor, includeHidden: true });
        this.catalog.push(...page.data);
        modelCursor = page.nextCursor;
      } while (modelCursor);
      this.record.thinkingLevel ??= this.selectedModel?.defaultReasoningEffort;
      this.save();
      // The pinned server uses legacy history. Its stable resume/read operations
      // hydrate native turns; experimental item pagination is not supported.
      this.state.hydrate(response.thread.turns);
      for (const notification of queued) this.receive(notification);
      ready = true;
      this.changed();
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.changed();
      await this.transport?.close();
      throw error;
    }
  }
  async send(input: WorkspaceAgentInput, requestId: string, skill?: Pick<SkillMetadata, "name" | "path">) {
    return this.serialize(this.agentId, async () => {
      this.assertOpen();
      const parts: UserInput[] = [{ type: "text", text: [input.text, ...input.attachmentNotes].filter(Boolean).join("\n\n"), text_elements: [] }, ...input.images.map(image => ({ type: "image" as const, url: `data:${image.mimeType};base64,${image.data}` }))];
      if (skill) parts.push({ type: "skill", name: skill.name, path: skill.path });
      const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
      if (this.record.commandSubmissions?.some(entry => entry.id === requestId)) throw invalidArguments("This request ID was already used for a command");
      const previous = this.record.submissions.find(entry => entry.id === requestId);
      if (previous) {
        if (previous.digest !== digest) throw invalidArguments("This request ID was already used for a different prompt");
        if (previous.accepted || this.state.turns.some(turn => turn.items.some(item => item.type === "userMessage" && item.clientId === requestId))) return;
        throw invalidArguments("The previous send has an uncertain outcome. Reload to inspect the conversation before sending again.");
      }
      const submission = { id: requestId, digest, accepted: false };
      this.record.submissions.push(submission);
      this.record.threadId = this.threadId;
      this.save();
      const active = this.state.activeTurn;
      try {
        if (active) await this.transport.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: active.id, clientUserMessageId: requestId, input: parts });
        else {
          // SAFETY: The launch picker or native catalog validates the stored reasoning effort.
          const params: TurnStartParams = { threadId: this.threadId, clientUserMessageId: requestId, input: parts, model: this.record.model ? parseModelRef(this.record.model)!.id : undefined, effort: this.record.thinkingLevel as TurnStartParams["effort"] };
          const response = await this.transport.rpc.request("turn/start", params);
          if (!this.state.turns.some(turn => turn.id === response.turn.id)) this.state.receive({ method: "turn/started", params: { threadId: this.threadId, turn: response.turn } });
        }
      } catch (error) {
        // A server rejection did not admit the prompt. A lost connection is
        // uncertain and keeps the durable claim so retries cannot duplicate it.
        if (error instanceof CodexRpcError) {
          this.record.submissions = this.record.submissions.filter(entry => entry !== submission);
          this.save();
        }
        throw error;
      }
      submission.accepted = true;
      this.save();
      this.changed();
    });
  }
  async command(command: CodexCommand, requestId: string): Promise<CodexCommandResult> {
    if (command.kind === "skills" && command.name && command.enabled === undefined) {
      this.assertOpen();
      const inventory = await this.transport.rpc.request("skills/list", { cwds: [workspaceRoot], forceReload: true });
      const matches = inventory.data.flatMap(entry => entry.skills).filter(skill => skill.enabled && skill.name === command.name && (!command.path || skill.path === command.path));
      if (matches.length !== 1) throw invalidArguments(matches.length ? "More than one enabled skill has that name" : "Choose an enabled Codex skill");
      const skill = matches[0]!;
      await this.send({ text: `Use the ${skill.name} skill.`, images: [], attachmentNotes: [] }, requestId, skill);
      return { kind: "done", message: `Using ${skill.name}.` };
    }
    return this.serialize(this.agentId, async () => {
      this.assertOpen();
      const request = this.transport.rpc.request.bind(this.transport.rpc);
      if (!codexCommandMutates(command)) return this.runCommand(command, requestId, request);
      if (this.record.submissions.some(entry => entry.id === requestId)) throw invalidArguments("This request ID was already used for a prompt");
      const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
      const submissions = this.record.commandSubmissions ??= [];
      const previous = submissions.find(entry => entry.id === requestId);
      if (previous) {
        if (previous.digest !== digest) throw invalidArguments("This request ID was already used for a different command");
        if (previous.result !== undefined) {
          // SAFETY: Results are serialized by this runtime into app-owned workspace metadata.
          return JSON.parse(previous.result) as CodexCommandResult;
        }
        throw invalidArguments("The previous command has an uncertain outcome. Reload to inspect the conversation before trying a new request.");
      }
      const submission: NonNullable<CodexAgentRecord["commandSubmissions"]>[number] = { id: requestId, digest };
      submissions.push(submission);
      this.save();
      let attempted = false;
      let accepted = false;
      let rejected = false;
      const mutate = async <M extends keyof Requests>(method: M, params: Requests[M][0]): Promise<Requests[M][1]> => {
        attempted = true;
        try {
          const result = await request(method, params);
          accepted = true;
          return result;
        } catch (error) {
          if (error instanceof CodexRpcError && !accepted) rejected = true;
          throw error;
        }
      };
      try {
        const result = await this.runCommand(command, requestId, mutate);
        submission.result = JSON.stringify(result);
        this.save();
        return result;
      } catch (error) {
        // Preflight failures and explicit mutation rejections are safe to retry.
        // A lost reply or a failure after admission must not repeat the mutation.
        if (!attempted || rejected) {
          this.record.commandSubmissions = submissions.filter(entry => entry !== submission);
          this.save();
        }
        throw error;
      }
    });
  }
  private async runCommand(command: CodexCommand, requestId: string, mutate: CodexRpc["request"]): Promise<CodexCommandResult> {
    const { rpc } = this.transport;
    switch (command.kind) {
      case "new":
        await this.startFreshThread(mutate);
        return { kind: "done", message: "New Codex conversation started." };
      case "compact":
        this.requireIdle("compacting the conversation");
        this.record.threadId = this.threadId;
        this.save();
        this.turnPending = true;
        this.changed();
        try { await mutate("thread/compact/start", { threadId: this.threadId }); }
        catch (error) { this.turnPending = false; this.changed(); throw error; }
        return { kind: "done", message: "Compaction started." };
      case "review": {
        this.requireIdle("starting a review");
        if (!command.target) return { kind: "review" };
        this.record.threadId = this.threadId;
        this.save();
        // review/start returns an operation ID, not the canonical turn ID.
        // Only native turn notifications may materialize the review transcript.
        this.turnPending = true;
        this.changed();
        try { await mutate("review/start", { threadId: this.threadId, target: command.target, delivery: "inline" }); }
        catch (error) { this.turnPending = false; this.changed(); throw error; }
        return { kind: "done", message: "Review started." };
      }
      case "fork": {
        this.requireIdle("forking the conversation");
        const response = await mutate("thread/fork", { threadId: this.threadId, ...this.threadParameters });
        this.adoptThread(response);
        this.state.notices.push("Continuing in a fork. The original conversation is available through /resume.");
        this.changed();
        return { kind: "done", message: "Conversation forked." };
      }
      case "resume": {
        this.requireIdle("switching conversations");
        if (!command.threadId) return { kind: "resume", threads: await rpc.request("thread/list", { cwd: workspaceRoot, cursor: command.cursor, limit: 50, sortKey: "updated_at" }) };
        const response = await mutate("thread/resume", { threadId: command.threadId, ...this.threadParameters });
        this.adoptThread(response);
        return { kind: "done", message: "Conversation resumed." };
      }
      case "goal": {
        if (command.clear) await mutate("thread/goal/clear", { threadId: this.threadId });
        else if (command.objective || command.status) {
          await mutate("thread/goal/set", { threadId: this.threadId, objective: command.objective, status: command.status ?? "active" });
          this.record.threadId = this.threadId;
          this.save();
        }
        return { kind: "goal", goal: (await rpc.request("thread/goal/get", { threadId: this.threadId })).goal };
      }
      case "skills": {
        if (command.enabled !== undefined) {
          this.requireIdle("changing skill settings");
          const inventory = await rpc.request("skills/list", { cwds: [workspaceRoot], forceReload: true });
          const matches = inventory.data.flatMap(entry => entry.skills).filter(skill => skill.name === command.name && (!command.path || skill.path === command.path));
          if (matches.length !== 1) throw invalidArguments("Choose a skill from the native Codex catalog");
          await mutate("skills/config/write", { path: matches[0]!.path, enabled: command.enabled });
        }
        return { kind: "skills", skills: await rpc.request("skills/list", { cwds: [workspaceRoot], forceReload: true }) };
      }
      case "hooks": return { kind: "hooks", hooks: await rpc.request("hooks/list", { cwds: [workspaceRoot] }) };
      case "plugins": {
        let notice: string | undefined;
        if (command.action) {
          this.requireIdle("changing plugins");
          const catalog = await rpc.request("plugin/list", { cwds: [workspaceRoot] });
          const match = catalog.marketplaces.flatMap(marketplace => marketplace.plugins.map(plugin => ({ marketplace, plugin }))).find(entry => entry.plugin.id === command.id);
          if (!match) throw invalidArguments("Choose a plugin from the native Codex catalog");
          if (command.action === "install") {
            const response = await mutate("plugin/install", { pluginName: match.plugin.name, marketplacePath: match.marketplace.path, remoteMarketplaceName: match.marketplace.path ? null : match.marketplace.name, installAttemptId: requestId });
            notice = response.appsNeedingAuth.length ? `Plugin installed. Connect ${response.appsNeedingAuth.map(app => app.name).join(", ")} through /apps.` : "Plugin installed.";
          } else {
            await mutate("plugin/uninstall", { pluginId: match.plugin.id });
            notice = "Plugin removed.";
          }
        }
        return { kind: "plugins", plugins: await rpc.request("plugin/list", { cwds: [workspaceRoot] }), notice };
      }
      case "mcp": {
        const servers: McpServerStatus[] = [];
        let cursor: string | null = null;
        do {
          const page: ListMcpServerStatusResponse = await rpc.request("mcpServerStatus/list", { threadId: this.threadId, cursor, limit: 100 });
          servers.push(...page.data);
          cursor = page.nextCursor;
        } while (cursor);
        return { kind: "mcp", servers, verbose: command.verbose };
      }
      case "apps": {
        let notice: string | undefined;
        if (command.enabled !== undefined) {
          this.requireIdle("changing app settings");
          const apps = await this.listApps();
          if (!apps.some(app => app.id === command.id)) throw invalidArguments("Choose an app from the native Codex catalog");
          const response = await mutate("config/value/write", { keyPath: `apps.${JSON.stringify(command.id!)}.enabled`, value: command.enabled, mergeStrategy: "replace" });
          notice = response.status === "okOverridden" ? "Saved, but a higher-priority Codex setting overrides this change." : "Changes apply to new Codex turns.";
        }
        return { kind: "apps", apps: await this.listApps(), notice };
      }
    }
  }
  private async listApps(): Promise<AppInfo[]> {
    const apps: AppInfo[] = [];
    let cursor: string | null = null;
    do {
      const page: AppsListResponse = await this.transport.rpc.request("app/list", { threadId: this.threadId, cursor, limit: 100 });
      apps.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return apps;
  }
  private requireIdle(action: string) {
    if (this.isBusy) throw invalidArguments(`Stop Codex before ${action}`);
  }
  private adoptThread(response: { thread: Thread; model: string; reasoningEffort: ReasoningEffort | null }) {
    this.threadId = response.thread.id;
    this.record.threadId = this.threadId;
    this.record.model = `openai-codex::${response.model}`;
    this.record.thinkingLevel = response.reasoningEffort ?? this.selectedModel?.defaultReasoningEffort;
    this.state.hydrate(response.thread.turns);
    this.state.usage = undefined;
    this.state.notices.length = 0;
    this.save();
    this.changed();
  }
  async stop() { this.assertOpen(); const turn = this.state.activeTurn; if (turn || this.turnPending) await this.transport.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: turn?.id ?? "" }); }
  async configure(parameters: { model?: string; thinkingLevel?: string }) {
    return this.serialize(this.agentId, async () => {
      this.assertOpen();
      if (this.isBusy) throw invalidArguments("Stop Codex before changing its model or thinking level");
      const modelId = parameters.model ? parseModelRef(parameters.model) : parseModelRef(this.record.model!);
      const model = modelId?.provider === "openai-codex" && this.catalog.find(model => model.model === modelId.id);
      if (!model) throw invalidArguments("Choose an available Codex model");
      const effort = parameters.thinkingLevel ?? (parameters.model ? model.defaultReasoningEffort : this.record.thinkingLevel ?? model.defaultReasoningEffort);
      const supported = model.supportedReasoningEfforts.find(option => option.reasoningEffort === effort);
      if (!supported) throw invalidArguments("Unsupported Codex thinking level");
      await this.transport.rpc.request("thread/settings/update", { threadId: this.threadId, model: model.model, effort: supported.reasoningEffort });
      this.record.model = `openai-codex::${model.model}`;
      this.record.thinkingLevel = effort;
      await setAgentModelPreference(agentTypeId, { provider: "openai-codex", id: model.model }, effort);
      this.save();
      this.changed();
      await this.events.emit("workspace_agent_view_invalidated", { workspaceId: this.workspaceId, agentId: this.agentId });
    });
  }
  async reset() {
    return this.serialize(this.agentId, async () => {
      this.assertOpen();
      await this.startFreshThread(this.transport.rpc.request.bind(this.transport.rpc));
    });
  }
  private async startFreshThread(mutate: CodexRpc["request"]) {
    if (this.isBusy) throw invalidArguments("Stop Codex before starting a fresh session");
    const response = await mutate("thread/start", this.threadParameters);
    this.threadId = response.thread.id;
    delete this.record.threadId;
    this.state.hydrate([]);
    this.state.usage = undefined;
    this.state.notices.length = 0;
    this.save();
    this.changed();
  }
  async rename(title: string) {
    this.record.title = title;
    this.save();
    await this.events.emit("workspace_agent_title_changed", { workspaceId: this.workspaceId, agentId: this.agentId, title });
  }
  async close() {
    this.closing = true;
    await this.serialize(this.agentId, async () => {
      const turn = this.state.activeTurn;
      if (turn && !this.failure) await this.transport.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: turn.id });
      await this.dispose();
    });
  }
  private receive(notification: CodexNotification) {
    if (this.disposed) return;
    // Codex can publish native subagent activity too. Only this root owns this pane.
    if ("threadId" in notification.params && notification.params.threadId !== this.threadId) return;
    if ((notification.method === "item/started" || notification.method === "item/completed") && notification.params.item.type === "enteredReviewMode") this.turnPending = false;
    if (notification.method === "turn/started" || notification.method === "turn/completed") this.turnPending = false;
    this.state.receive(notification);
    this.changed();
    if (notification.method === "turn/completed") void this.refreshTurnItems(notification.params.turn.id, true).catch(error => { console.error("Could not hydrate Codex turn", error); this.failure = error; this.changed(); });
  }
  private get threadParameters() {
    return { model: this.record.model ? parseModelRef(this.record.model)!.id : undefined, config: this.record.thinkingLevel ? { model_reasoning_effort: this.record.thinkingLevel } : undefined, cwd: workspaceRoot, approvalPolicy: "never" as const, sandbox: "danger-full-access" as const, developerInstructions: this.instructions };
  }
  private get selectedModel() {
    const id = this.record.model ? parseModelRef(this.record.model)?.id : undefined;
    return this.catalog.find(model => model.model === id);
  }
  get selection() {
    const selected = this.selectedModel;
    return {
      models: this.catalog.filter(model => !model.hidden || model === selected).map(model => ({ provider: "openai-codex", id: model.model, name: model.displayName, selected: model === selected, available: true })),
      thinkingLevels: selected?.supportedReasoningEfforts.map(option => option.reasoningEffort) ?? [],
    };
  }
  private async refreshTurnItems(turnId: string, completed: boolean) {
    const threadId = this.threadId;
    const response = await this.transport.rpc.request("thread/read", { threadId, includeTurns: true });
    // A fresh-session command can replace the thread while this read is in flight.
    if (threadId !== this.threadId) return;
    const turn = response.thread.turns.find(turn => turn.id === turnId);
    if (!turn) throw new Error(`Codex history is missing turn ${turnId}`);
    this.state.hydrateItems(turnId, turn.items, completed);
    this.changed();
  }
  private assertOpen() { if (this.failure) throw this.failure; if (this.disposed || this.closing) throw new Error("Codex Agent is closed"); }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.transport?.close();
    if (this.busy) publishWorkspaceAgentBusy({ workspaceId: this.workspaceId, agentKey: `agent:${this.agentId}`, busy: false });
    this.presentation.dispose();
  }
}

export function createCodexAgents(getEvents: () => KintsugiEventBus) {
  return createNativeAgents({
    store: createCodexStore, settings, open: CodexRuntime.open,
    newRecord: (selected): CodexAgentRecord => ({ id: crypto.randomUUID(), title: label, ...selected, submissions: [] }),
  }, getEvents);
}
