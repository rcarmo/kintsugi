import { collectDescendantUsage } from "./durable-usage.ts";
import { registerDurableTelemetry } from "./durable-telemetry.ts";
import { enabledModelOptionViews } from "@kintsugi/agent/server/model-state";
import { getAgentModelThinkingLevel } from "@kintsugi/llm/server";
import { publishWorkspaceAgentBusy } from "@kintsugi/agent/server";
import { startNotificationTurn, finishNotificationTurn } from "./turn-notifications.ts";
import { sendTurnNotification } from "./web-push.ts";
import { durableTimingEntry } from "./durable-timing.ts";
import { KintsugiCoreError } from "@kintsugi/core";
import { prepareWorkspaceRuntime } from "@kintsugi/workspace";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, getSupportedThinkingLevels, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { UserEntry, LiveDoc, InboxDoc, AgentDoc, UsageDoc, ProviderDoc, defineDoc, type Cursor, type EntryId, type EntryRecord, type EntryDraft, type AgentChange, type Conversation, type ConversationId, type ConversationView, type HarnessOptions, type LiveState } from "@earendil-works/pi-durable";
import { createDurableHarnessOptions, prepareDurableAgent, type DurableHarnessOptions } from "./durable-assembly.ts";
import { durableQueueResumeEntry, durableStopScope, commitDurableStop, markGatedDurableWork, settleStoppedDurableWork, WorkspaceAdmission, WorkspaceStops } from "./durable-lifecycle.ts";
import { durableImageEndpoint } from "./durable-images.ts";
import { submitDurableInput, type DurableInput } from "./durable-input.ts";
import { openDurableWorkspace, WorkspaceAgents, type DurableAgentRecord } from "./durable-workspace.ts";
import { expandWorkspaceSkillCommand } from "@kintsugi/agent/server/skills";
import type { WorkspaceAgentToolOptions } from "@kintsugi/agent/server/tools";
import { onValues } from "./durable-watch.ts";

const context = BACKGROUND_CONTEXT;
const DurableHistoryLabels = defineDoc<{ labels: Record<string, string[]> }>({
  kind: "kintsugi.history-labels", version: 1, scope: "session", initial: () => ({ labels: {} }), checkpointWhen: () => false,
});
type AgentIdentity = Omit<DurableAgentRecord, "durableId">;
type SettingsChange = Pick<AgentChange, "model"> & { thinkingLevel?: string };

const dependencies = {
  harness: createDurableHarnessOptions,
  prepare: prepareDurableAgent,
  expand: expandWorkspaceSkillCommand,
  ready: prepareWorkspaceRuntime,
  async validateModel(ref: AgentChange["model"]) {
    const selected = ref && { provider: ref.provider, id: ref.modelId };
    const model = selected && (await enabledModelOptionViews(selected)).find(item => item.provider === selected.provider && item.id === selected.id);
    if (!model?.available) throw new KintsugiCoreError("invalid_arguments", model?.unavailableReason ?? "Choose a connected model in Models");
  },
};

/**
 * Native execution owner, not an AgentSession adapter. One instance per workspace.
 * Reads/attachment are passive; execution checks workspace readiness first.
 * Close/delete gates are durable; production must persist them before removing
 * tabs or disposing execution workspaces.
 */
export async function openDurableAgentRuntime(
  directory: string,
  workspaceId: string,
  options: WorkspaceAgentToolOptions = {},
  load: typeof dependencies = dependencies,
) {
  const harnessOptions: DurableHarnessOptions = await load.harness(workspaceId, options, async (id, entry, context) => {
    await workspace.harness.commit(async tx => { await tx.appendEntry(durableTimingEntry, id, entry); }, context);
  }, () => workspace.harness);
  const workspace = await openDurableWorkspace(directory, workspaceId, harnessOptions);
  const { harness } = workspace;
  const tokenOptimizer = harnessOptions.tokenOptimizer;
  await tokenOptimizer?.attach();
  const agents = new Map<string, Promise<Awaited<ReturnType<typeof controller>>>>();
  const observers = new Set<() => Promise<void>>();
  observers.add(await registerDurableTelemetry(harness, workspaceId));
  const commandDrains = new Set<() => Promise<void>>();
  const usageListeners = new Set<() => void>();
  const workListeners = new Set<() => void>();
  const taskWatch = await harness.watchTaskGraph(context);
  taskWatch.start(async () => { for (const listener of workListeners) listener(); });
  observers.add(() => taskWatch.stop().then(() => {}));
  let suspended = false;
  const gates = await harness.snapshot(WorkspaceAdmission, context);
  let deleted = gates?.deleted ?? false;
  const closed = new Set(gates?.closed ?? []);
  let deleting: Promise<void> | undefined;
  let readiness: Promise<void> | undefined;

  // Share concurrent probes, not a permanent ready flag: a workspace can have
  // stopped since the previous command. A failed probe rejects before admission
  // and a later command can retry after the host repairs the workspace.
  async function checkReady() {
    assertOpen();
    readiness ??= load.ready(workspaceId).finally(() => { readiness = undefined; });
    await readiness;
    assertOpen();
  }

  async function readyForExecution() {
    await checkReady();
    // A close/delete may have fenced another root while readiness was pending.
    // Mark its work before any command enables this workspace-wide scheduler.
    await persistGates();
    // Native abort ends its run without admitting a new inbox boundary. Join
    // saved Stop cleanup before admitting later genuine input into that root.
    await settleStoppedDurableWork(harness);
    assertOpen();
  }

  async function settleTasks(conversationId?: ConversationId) {
    const inspection = await harness.inspect(context);
    const tasks = inspection.tasks.filter(({ record }) => conversationId === undefined || record.conversationId === conversationId);
    if (!tasks.length) return;
    await readyForExecution();
    await Promise.all(tasks.map(({ record }) => harness.waitForTask(record.id, context)));
  }

  async function persistGates() {
    await harness.commit(async (tx) => {
      const admission = await tx.doc(WorkspaceAdmission);
      admission.deleted = deleted;
      const records = (await tx.doc(WorkspaceAgents)).agents;
      const closedRoots = new Set(records.filter(record => (record.branches ?? [record.durableId]).some(id => closed.has(id))).map(record => record.agentId));
      for (const record of records) if (record.rootId && closedRoots.has(record.rootId)) for (const id of record.branches ?? [record.durableId]) closed.add(id);
      admission.closed = [...closed];
    }, context);
    await markGatedDurableWork(harness);
  }

  function assertOpen() {
    if (suspended) throw new Error("Durable agent runtime is suspended");
  }

  async function controller(conversation: Conversation, identity: AgentIdentity) {
    await tokenOptimizer?.start(conversation,identity);
    // Only host commands queue here, never generation/tool execution. Different
    // roots prepare independently, while model changes cannot race image sizing
    // and skill expansion for this root's next admission.
    let tail: Promise<void> = Promise.resolve();
    let closing: Promise<void> | undefined;
    const selectionListeners = new Set<() => Promise<void>>();
    const statusListeners = new Set<() => void>();
    const renderContext = { workspaceId, agentId: identity.agentId };
    let busy = false;
    let observation: Awaited<ReturnType<Conversation["watch"]>> | undefined;
    function statusChanged() { for (const listener of statusListeners) listener(); }
    function publishBusy(value: boolean) {
      busy = value;
      publishWorkspaceAgentBusy({ workspaceId, agentKey: `agent:${identity.agentId}`, busy });
      statusChanged();
    }
    async function committed(view: ConversationView) {
      for (const listener of usageListeners) listener();
      // SAFETY: Harness owns and versions the LiveDoc in this committed view.
      const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
      const nextBusy = Boolean(live?.run || live?.compactions?.length);
      if (nextBusy === busy) return;
      if (nextBusy) startNotificationTurn(renderContext, statusChanged);
      publishBusy(nextBusy);
      if (!nextBusy) {
        const subscription = finishNotificationTurn(renderContext);
        if (subscription) void sendTurnNotification(renderContext, subscription).catch(error => console.error("Could not send Agent notification", error));
        // Completion consumers (Changes refresh, catalog loading, etc.) do not own
        // execution observation. Report their failure without terminating the watch.
        await options.events?.emit("workspace_agent_turn_finished", renderContext)
          .catch(error => console.error("Could not publish Agent turn completion", error));
      }
    }
    async function observe() {
      if (identity.readOnly) return;
      const previous = observation;
      observation = undefined;
      await previous?.stop();
      assertOpen();
      // Only the documents matter here, not the transcript.
      const watch = await conversation.watch(context, { min: 1 });
      if (suspended) { await watch.stop(); assertOpen(); }
      observation = watch;
      await committed(watch.value);
      watch.start(onValues(committed));
      void watch.closed.then(result => {
        if (observation !== watch || suspended) return;
        console.error("Agent execution observation ended", result);
        finishNotificationTurn(renderContext);
        publishBusy(false);
      });
    }
    observers.add(async () => {
      const watch = observation;
      observation = undefined;
      await watch?.stop();
      finishNotificationTurn(renderContext);
      if (busy) publishBusy(false);
    });
    async function record() {
      return (await harness.snapshot(WorkspaceAgents, context))!.agents.find(item => item.agentId === identity.agentId)!;
    }
    async function branches() {
      const current = await record();
      return current.branches ?? [current.durableId];
    }
    async function tree() {
      assertOpen();
      const nodes = new Map<EntryId, { entry: EntryRecord; parentId?: EntryId; branch: ConversationId }>();
      for (const id of await branches()) {
        const branch = (await harness.conversation(id, context))!;
        const entries: EntryRecord[] = [];
        let cursor: Cursor | undefined;
        do {
          const page = await branch.entries({}, 500, cursor, context);
          entries.push(...page.items);
          cursor = page.next;
        } while (cursor);
        entries.reverse();
        entries.forEach((entry, index) => {
          if (!nodes.has(entry.id)) nodes.set(entry.id, { entry, parentId: entries[index - 1]?.id, branch: id });
        });
      }
      const active = (await conversation.entries({}, 1, undefined, context)).items[0]?.id;
      const labels = (await harness.snapshot(DurableHistoryLabels, context))?.labels ?? {};
      return { nodes: [...nodes.values()].sort((a, b) => a.entry.id - b.entry.id), active, labels: Object.fromEntries([...nodes.keys()].flatMap(id => labels[String(id)] ? [[String(id), labels[String(id)]!]] : [])) };
    }
    async function assertIdle() {
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
      const records = (await harness.snapshot(WorkspaceAgents, context))!.agents;
      const scope = new Set(durableStopScope(records, conversation.id, !identity.parentId));
      const tasks = (await harness.inspect(context)).tasks;
      if (live?.run || live?.compactions?.length || inbox?.items.length || tasks.some(item => scope.has(item.record.conversationId) && item.record.kind !== "kintsugi.delegation-anchor")) {
        throw new Error("Stop the agent and wait for its work to finish before navigating history.");
      }
    }
    async function navigate(entryId: string, before: boolean) {
      await assertIdle();
      const history = await tree();
      const selected = history.nodes.find(node => String(node.entry.id) === entryId);
      if (!selected) throw new Error("History entry no longer exists.");
      const target = before ? history.nodes.find(node => node.entry.id === selected.parentId) : selected;
      if (!target) throw new Error("Cannot rewind past the first history entry.");
      const next = await harness.commit(async tx => {
        assertAdmission();
        const catalog = await tx.doc(WorkspaceAgents);
        const current = catalog.agents.find(item => item.agentId === identity.agentId)!;
        const fork = await tx.forkConversation(target.branch, target.entry.id, { ownership: { kind: "ownerless" } });
        current.branches = [...(current.branches ?? [current.durableId]), fork.id];
        current.durableId = fork.id;
        return fork.id;
      }, context);
      const group = tokenOptimizer?.lookup(conversation.id)?.classificationGroup;
      await tokenOptimizer?.end(conversation.id);
      conversation = (await harness.conversation(next, context))!;
      await tokenOptimizer?.start(conversation,identity,"fork",group);
      await observe();
      await Promise.all([...selectionListeners].map(listener => listener()));
    }
    function stopScope() {
      return new Set(durableStopScope(catalogWatch!.value.agents, conversation.id, !identity.parentId));
    }
    function assertAdmission() {
      assertOpen();
      if (deleted) throw new Error("Durable workspace is deleted");
      if (closed.has(conversation.id)) throw new Error("Durable conversation is closed");
    }
    function command<T>(run: () => Promise<T>, metadataOnly = false): Promise<T> {
      const result = tail.then(() => {
        assertAdmission();
        if (identity.readOnly && !metadataOnly) throw new KintsugiCoreError("invalid_arguments", "This conversation is read-only. Start a new Agent to continue.");
        return run();
      });
      // The caller receives the rejection; a rejected command must not poison
      // the command line and prevent a later correction or Stop.
      tail = result.then(() => {}, () => {});
      return result;
    }

    async function known(requestId: string) {
      for (const id of await branches()) {
        const found = await harness.commit(tx => tx.submissionByRequest(id, requestId), context);
        if (found) return found;
      }
      return undefined;
    }
    async function configure(change: SettingsChange) {
      const current = await conversation.agent(context);
      const ref = change.model === undefined ? current.model : change.model;
      const model = ref ? harnessOptions.models.getModel(ref.provider, ref.modelId) : undefined;
      if (ref && !model) throw new KintsugiCoreError("invalid_arguments", `Model not found: ${ref.provider}/${ref.modelId}`);
      if (change.model !== undefined) await load.validateModel(ref);
      const levels = model ? getSupportedThinkingLevels(model) : [];
      const requested = change.thinkingLevel ?? (change.model ? await getAgentModelThinkingLevel("builtin", { provider: change.model.provider, id: change.model.modelId }) : undefined);
      const thinkingLevel = levels.find(level => level === requested);
      if (change.thinkingLevel !== undefined && !thinkingLevel) throw new KintsugiCoreError("invalid_arguments", `Unsupported thinking level: ${change.thinkingLevel}`);
      await conversation.configure({ ...change, thinkingLevel }, context);
    }
    commandDrains.add(() => tail);
    await observe();
    return {
      subscribeSelection(listener: () => Promise<void>) { selectionListeners.add(listener); return () => { selectionListeners.delete(listener); }; },
      subscribeStatus(listener: () => void) { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
      settings: () => conversation.agent(context),
      get hasStoppableWork() {
        const scope = stopScope();
        return Object.values(taskWatch.value.tasks).some(task => scope.has(task.conversationId) && task.kind !== "kintsugi.delegation-anchor");
      },
      subscribeWork(listener: () => void) { workListeners.add(listener); return () => { workListeners.delete(listener); }; },
      subscribeUsage(listener: () => void) { usageListeners.add(listener); return () => { usageListeners.delete(listener); }; },
      async descendantUsage() {
        const records = (await harness.snapshot(WorkspaceAgents, context))!.agents;
        return collectDescendantUsage(records, identity.agentId, id => harness.snapshot(UsageDoc, id, context));
      },
      async descendantCost() {
        const records = (await harness.snapshot(WorkspaceAgents, context))!.agents;
        return (await collectDescendantUsage(records, identity.agentId, id => harness.snapshot(UsageDoc, id, context)))?.cost;
      },
      async userMessages() {
        const { entries } = await conversation.context(context);
        return entries.filter(UserEntry.is).flatMap(entry => (entry.model ?? []).flatMap(message => message.role === "user" ? [contentText(message.content)] : []));
      },
      get id() { return conversation.id; },
      readOnly: Boolean(identity.readOnly),
      tree,
      async historyView(branchId?: string) {
        const ids = await branches();
        const id = branchId === undefined ? conversation.id : ids.find(id => String(id) === branchId);
        if (id === undefined) throw new Error("History branch no longer exists.");
        return harness.commit(async tx => {
          const entries: EntryRecord[] = [];
          let cursor: Cursor | undefined;
          do {
            const page = await tx.scanEntries({ conversationId: id }, 500, cursor);
            entries.push(...page.items);
            cursor = page.next;
          } while (cursor);
          // SAFETY: These native JSON documents are typed by Harness. Detach transaction
          // overlays before commit settles; returning their proxies would invalidate the view.
          return JSON.parse(JSON.stringify({
            conversation: (await tx.conversation(id))!, entries: entries.reverse(),
            docs: {
              [AgentDoc.definition.kind]: await tx.doc(AgentDoc, id),
              [LiveDoc.definition.kind]: await tx.doc(LiveDoc, id),
              [InboxDoc.definition.kind]: await tx.doc(InboxDoc, id),
              [UsageDoc.definition.kind]: await tx.doc(UsageDoc, id),
            },
          })) as ConversationView;
        }, context);
      },
      navigate(entryId: string, before = false) { return command(() => navigate(entryId, before)); },
      label(entryId: string, label: string, operation: "add" | "remove") {
        return command(async () => {
          const node = (await tree()).nodes.find(node => String(node.entry.id) === entryId);
          if (!node) throw new Error("History entry no longer exists.");
          await harness.commit(async tx => {
            const doc = await tx.doc(DurableHistoryLabels);
            const existing = doc.labels[entryId] ?? [];
            doc.labels[entryId] = operation === "add" ? [...new Set([...existing, label.trim()])] : existing.filter(value => value !== label.trim());
          }, context);
        });
      },
      /** Fence immediately, persist before cancellation, retain passive history. */
      close() {
        assertOpen();
        closed.add(conversation.id);
        return closing ??= (async () => {
          await tail;
          await tokenOptimizer?.end(conversation.id);
          for (const id of await branches()) closed.add(id);
          await persistGates();
          for (const id of closed) await settleTasks(id);
        })().catch((error) => {
          closing = undefined;
          throw error;
        });
      },
      /** Canonical committed state, including partials and queued input. No scheduling. */
      watch: (...args: Parameters<Conversation["watch"]>) => conversation.watch(...args),
      history: (...args: Parameters<Conversation["entries"]>) => conversation.entries(...args),
      context: (...args: Parameters<Conversation["context"]>) => conversation.context(...args),
      image(entryId: string, contentIndex: number) {
        return (async () => {
          if (entryId.startsWith("queued-")) return durableImageEndpoint(conversation, entryId, contentIndex, context);
          for (const id of await branches()) {
            const response = await durableImageEndpoint((await harness.conversation(id, context))!, entryId, contentIndex, context);
            if (response.status !== 404) return response;
          }
          return new Response("not found", { status: 404 });
        })();
      },
      /** Commit searchable metadata without creating a second history file. */
      setTitle(title: string) {
        return command(() => harness.commit(async (tx) => {
          const catalog = await tx.doc(WorkspaceAgents);
          const record = catalog.agents.find((item) => item.durableId === conversation.id)!;
          record.title = title;
          const result = { ...record };
          if (record.branches) result.branches = [...record.branches];
          return result;
        }, context), true);
      },
      knownRequest(requestId: string) {
        return command(async () => Boolean(await known(requestId)));
      },
      submit(input: DurableInput) {
        return command(async () => {
          if (!input.requestId.trim()) throw new Error("A request ID is required for durable input");
          const existing = await known(input.requestId);
          // The original admission wins even if the skill or model has gone
          // away, or a retry arrives with different text/attachments/settings.
          if (existing) return (await harness.submission(existing.id, context))!;
          await load.validateModel((await conversation.agent(context)).model);
          await readyForExecution();
          assertAdmission();
          if (!identity.readOnly) await tokenOptimizer?.preparePrompt(conversation.id, input.text);
          assertAdmission();
          return submitDurableInput(conversation, workspaceId, harnessOptions.models, input, context, async (id, text) => {
            const expanded = await load.expand(id, text);
            assertAdmission();
            return expanded;
          }, assertAdmission);
        });
      },
      configure(change: SettingsChange) {
        return command(() => configure(change));
      },
      /** Setup may fill an empty selection, but must never replace a user's choice. */
      configureDefaultModel(model: NonNullable<AgentChange["model"]>) {
        return command(async () => {
          if ((await conversation.agent(context)).model) return;
          await configure({ model });
        });
      },
      /** Withdraw only this inbox input; consumption and cancellation race atomically. */
      cancelQueuedInput(submissionId: string) {
        return command(async () => {
          const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
          const input = inbox?.items.find(item => String(item.id) === submissionId && item.mode !== "write");
          return input ? await harness.abortSubmission(input.id, context, conversation.id) === "aborted" : false;
        });
      },
      /**
       * Promote a queued follow-up to steering in place, keeping its submission and queue position. A turn that ends in
       * an error leaves its queue behind on an idle agent; there, this resumes the queue from its start instead.
       */
      steerQueuedInput(submissionId: string) {
        return command(async () => {
          const outcome = await harness.commit(async tx => {
            const input = (await tx.doc(InboxDoc, conversation.id)).items.find(item => String(item.id) === submissionId);
            if (!input || input.mode === "write") return "gone";
            // Steering on an idle agent would place this input ahead of older follow-ups.
            if (!(await tx.doc(LiveDoc, conversation.id)).run) return "stranded";
            if (input.mode !== "followUp") return "gone";
            input.mode = "steer";
            return "steered";
          }, context);
          if (outcome === "gone") return false;
          if (outcome === "stranded") {
            await load.validateModel((await conversation.agent(context)).model);
            await readyForExecution();
            assertAdmission();
            // An idle conversation with queued items runs a boundary for the next submission, placing queued input in order.
            await conversation.submit({ type: "write", entry: { kind: durableQueueResumeEntry.kind, model: [] } }, context);
          }
          return true;
        });
      },
      /** Cancel one live tool and its owned work, without withdrawing the turn or queued input. */
      async abortTool(callId: string, note?: string) {
        // Cancellation must not queue behind admission or depend on Docker/image
        // readiness. The native abort mark owns cleanup and survives recovery.
        assertOpen();
        assertAdmission();
        if (identity.readOnly && !identity.oneShotCallId) throw new KintsugiCoreError("invalid_arguments", "This conversation is read-only. Start a new Agent to continue.");
        const selected = conversation.id;
        const taskId = await harness.commit(async tx => {
          assertAdmission();
          const slot = (await tx.doc(LiveDoc, selected)).tools?.find(tool => tool.callId === callId);
          if (!slot?.taskId || slot.status === "done") return;
          const task = await tx.task(slot.taskId);
          if (!task || task.conversationId !== selected || task.state.status === "terminal") return;
          const message = note?.trim();
          if (message) {
            slot.diagnostics ??= [];
            slot.diagnostics.push({ severity: "error", code: "cancelled_by_user", message: `The user manually cancelled this tool with the following note:\n${message}` });
          }
          return slot.taskId;
        }, context);
        if (taskId === undefined) return false;
        await harness.abortTask(taskId, context);
        return true;
      },
      /** Explicit Stop withdraws queued input and cancels owned work. */
      stop() {
        return command(async () => {
          // Persist before probing Docker/providers. Recovery applies this exact
          // scope before any progress; later genuine admissions remain allowed.
          await harness.commit(tx => commitDurableStop(tx, conversation.id, !identity.parentId), context);
          await markGatedDurableWork(harness);
          try {
            const stopped = new Set(Object.values((await harness.snapshot(WorkspaceStops, context))?.tasks ?? {}).flat());
            if ((await harness.inspect(context)).tasks.some(({ record }) => stopped.has(record.id))) await readyForExecution();
          } catch (cause) {
            throw new Error("Stop saved. Workspace cleanup is pending until execution is available.", { cause });
          }
        });
      },
      compact(instructions?: string) {
        return command(async () => {
          await load.validateModel((await conversation.agent(context)).model);
          await readyForExecution();
          assertAdmission();
          return conversation.compact(instructions, context);
        });
      },
      /** Reset context, retaining searchable history and the current settings. */
      reset() {
        return command(async () => {
          await assertIdle();
          await readyForExecution();
          assertAdmission();
          await conversation.reset(undefined, context);
          await tokenOptimizer?.reset(conversation,identity);
        });
      },
    };
  }

  const catalogWatch = await harness.watchDoc(WorkspaceAgents, context);
  catalogWatch!.start(onValues(async value => {
    if (suspended) return;
    for (const listener of workListeners) listener();
    for (const record of value.agents) {
      if (!record.parentId || record.readOnly || agents.has(record.agentId)) continue;
      const pending = (async () => controller((await harness.conversation(record.durableId, context))!, record))();
      agents.set(record.agentId, pending);
      await pending;
    }
  }));
  observers.add(async () => { await catalogWatch!.stop(); });

  return {
    /** Atomic passive import. No prompts, submissions, model calls, or task replay. */
    async importHistory(identity: Pick<DurableAgentRecord, "agentId" | "label" | "title">, entries: readonly EntryDraft[]) {
      assertOpen();
      return harness.commit(async tx => {
        assertOpen();
        const catalog = await tx.doc(WorkspaceAgents);
        const existing = catalog.agents.find(record => record.agentId === identity.agentId);
        if (existing) return existing.durableId;
        if (deleted) throw new Error("Durable workspace is deleted");
        const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
        for (const entry of entries) await tx.appendEntry(created.id, entry);
        catalog.agents.push({ agentId: identity.agentId, label: identity.label, title: identity.title, durableId: created.id, readOnly: true });
        return created.id;
      }, context);
    },
    async admission() { assertOpen(); return harness.snapshot(WorkspaceAdmission, context); },
    /** Trusted native module access; public routes expose only scoped operations. */
    get harness() { return harness; },
    /** Discover retained histories without preparing prompts or starting work. */
    async catalog() {
      assertOpen();
      return (await harness.snapshot(WorkspaceAgents, context))!.agents;
    },
    /** Reuse one host command line per Kintsugi UUID; reopening never rebuilds its prompt. */
    agent(record: AgentIdentity, initial: Pick<AgentChange, "model" | "thinkingLevel"> = {}) {
      assertOpen();
      let pending = agents.get(record.agentId);
      if (!pending) {
        pending = (async () => {
          const catalog = await harness.snapshot(WorkspaceAgents, context);
          const existing = catalog?.agents.find((item) => item.agentId === record.agentId);
          if (!existing && deleted) throw new Error("Durable workspace is deleted");
          if (!existing) {
            await checkReady();
            if (deleted) throw new Error("Durable workspace is deleted");
          }
          const prepared = existing ? {} : await load.prepare(workspaceId, record.agentId, options, initial);
          assertOpen();
          if (!existing && deleted) throw new Error("Durable workspace is deleted");
          return controller(await workspace.agent(record, prepared), existing ?? record);
        })().catch((error) => {
          agents.delete(record.agentId);
          throw error;
        });
        agents.set(record.agentId, pending);
      }
      return pending;
    },
    /** Permanent admission fence; journal remains available for history and recovery. */
    delete() {
      assertOpen();
      deleted = true;
      return deleting ??= (async () => {
        // New attachment/admission is fenced before waiting for in-flight preparation.
        // Failed attachment still rejects to its caller, but cannot prevent deletion.
        await Promise.allSettled([...agents.values()]);
        await Promise.all([...commandDrains].map((drain) => drain()));
        await persistGates();
        await settleTasks();
      })().catch((error) => {
        deleting = undefined;
        throw error;
      });
    },
    /** Host restart resumes durable tasks, never submits a synthetic user prompt. */
    async resume() {
      const catalog = (await harness.snapshot(WorkspaceAgents, context))!;
      await Promise.all(catalog.agents.filter(record => !record.readOnly && !closed.has(record.durableId)).map(record => this.agent(record)));
      await readyForExecution();
      harness.resume();
    },
    /** Host shutdown/unload: stop observation and scheduling, not the task's effects. */
    async suspend() {
      suspended = true;
      await tokenOptimizer?.close();
      await Promise.all([...observers].map(stop => stop()));
      await workspace.close();
    },
  };
}

export type DurableAgentRuntime = Awaited<ReturnType<typeof openDurableAgentRuntime>>;
export type DurableAgentController = Awaited<ReturnType<DurableAgentRuntime["agent"]>>;
