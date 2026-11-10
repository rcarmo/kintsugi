import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { configure, createRegistry, defineExtension, LiveDoc, type Harness, type Extension } from "@earendil-works/pi-durable";
import { openDurableAgentRuntime, type DurableAgentRuntime } from "@kintsugi/builtin-agent/server/durable-runtime";
import { createNativeDelegationExtension } from "../../src/server/native-runtime.ts";
import { Delegation, Mailbox } from "../../src/server/native-state.ts";
import { WorkspaceAgents } from "@kintsugi/builtin-agent/server";

const paths: string[] = [];
const owners: DurableAgentRuntime[] = [];
afterEach(async () => { for (const owner of owners.splice(0)) await owner.suspend(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup(pauseSpawn?: (context: Context) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), "native-delegation-")); paths.push(path);
  const models = createModels(); const faux = fauxProvider({ tokensPerSecond: 100000 }); models.setProvider(faux.provider);
  const open = async () => {
    let harness: Harness;
    const registry = createRegistry();
    const extension: Extension = createNativeDelegationExtension(() => harness);
    registry.install(defineExtension({ ...extension, tools: extension.tools!.map(tool => tool.name !== "spawn_agent" ? tool : { ...tool, async execute(args, api, context) {
      const result = await tool.execute(args, api, context);
      await pauseSpawn?.(context);
      return result;
    } }) }));
    const owner = await openDurableAgentRuntime(path, "delegation", {}, {
      harness: async () => ({ models, registry, settings: { retry: { enabled: false } } }),
      prepare: async () => ({ model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off", instructions: "Testing native collaboration." }),
      expand: async (_id, text) => text, ready: async () => {}, validateModel: async () => {},
    });
    harness = owner.harness; owners.push(owner); return owner;
  };
  const owner = await open();
  const root = await owner.agent({ agentId: "root", label: "Root", title: "Root" });
  return { owner, root, faux, open };
}
async function completedDeliveries(owner: DurableAgentRuntime) {
  // Join the useful work, never the persistent background identity anchors.
  for (let round = 0; round < 5; round++) {
    const tasks = (await owner.harness.inspect(context)).tasks.filter(item => item.record.kind !== "kintsugi.delegation-anchor");
    if (!tasks.length) return;
    await Promise.all(tasks.map(item => owner.harness.waitForTask(item.record.id, context)));
  }
  throw new Error("Delegation did not settle");
}

test("spawn, native child completion, passive parent delivery and follow-up survive reopen", async () => {
  const { owner, root, faux, open } = await setup();
  let requested = false;
  const response: FauxResponseFactory = request => {
    const text = JSON.stringify(request.messages);
    if (text.includes("Your canonical task name is /root/review.")) return fauxAssistantMessage([
      { type: "text", text: "Checking an intermediate idea", textSignature: '{"v":1,"phase":"commentary"}' },
      { type: "text", text: "Child result", textSignature: '{"v":1,"phase":"final_answer"}' },
    ]);
    if (!requested) { requested = true; return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "review", message: "Review this", fork_turns: "none" }), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Parent done");
  };
  faux.setResponses(Array.from({ length: 10 }, () => response));
  await (await root.submit({ requestId: "start", text: "Please delegate a review" })).wait(context);
  await completedDeliveries(owner);
  const records = await owner.catalog();
  expect(records).toHaveLength(2);
  const child = records.find(record => record.parentId)!;
  expect(child.rootId).toBe("root");
  const state = (await owner.harness.snapshot(Delegation, context))!;
  expect(Object.values(state.receipts).map(item => item.kind).sort()).toEqual(["completion", "task"]);
  expect(Object.values(state.assignments)[0]?.result).toBe("Child result");
  expect((await owner.harness.snapshot(Mailbox, root.id, context))?.receipts[0]?.text).toBe("Child result");
  expect(faux.state.callCount).toBe(3); // Receipt did not start an extra parent turn.
  await owner.suspend();
  const reopened = await open();
  const restored = await reopened.agent({ agentId: "root", label: "Root", title: "Root" });
  let followup = false;
  faux.setResponses(Array.from({ length: 10 }, () => request => {
    if (JSON.stringify(request.messages).includes("Your canonical task name is /root/review.")) return fauxAssistantMessage("Follow-up result");
    if (!followup) { followup = true; return fauxAssistantMessage(fauxToolCall("followup_task", { target: "review", message: "Continue review" }), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Follow-up assigned");
  }));
  await (await restored.submit({ requestId: "continue", text: "Assign a follow-up" })).wait(context);
  await completedDeliveries(reopened);
  expect(await reopened.catalog()).toHaveLength(2);
  expect(Object.values((await reopened.harness.snapshot(Delegation, context))!.assignments).map(item => item.result)).toEqual(["Child result", "Follow-up result"]);
  await restored.close();
  expect((await reopened.admission())?.closed).toContain(child.durableId);
  // Multiple fsynced journals and a reopen need a bounded disk-integration budget on CI.
}, 20_000);

test("root Stop cancels descendants without retiring their identities", async () => {
  const { owner, root, faux } = await setup();
  let spawned = false;
  const childStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  faux.setResponses(Array.from({ length: 20 }, () => async (request, options) => {
    if (JSON.stringify(request.messages).includes("Your canonical task name is /root/worker.")) {
      childStarted.resolve(); await awaitWithContext(release.promise, { ...context, abortSignal: options?.signal }); return fauxAssistantMessage("Late result");
    }
    if (!spawned) { spawned = true; return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "worker", message: "Work", fork_turns: "none" }), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Root finished");
  }));
  await (await root.submit({ requestId: "start", text: "Delegate" })).wait(context);
  await childStarted.promise;
  const child = (await owner.catalog()).find(record => record.parentId)!;
  const other = await owner.agent({ agentId: "other", label: "Other", title: "Other" });
  const work = async (expected: boolean) => {
    const changed = Promise.withResolvers<void>();
    const check = () => { if (root.hasStoppableWork === expected) changed.resolve(); };
    const unsubscribe = root.subscribeWork(check);
    try { check(); await changed.promise; } finally { unsubscribe(); }
  };
  await work(true);
  expect(await owner.harness.snapshot(LiveDoc, root.id, context)).not.toHaveProperty("run");
  expect(other.hasStoppableWork).toBe(false);
  await root.stop();
  await work(false); // Idle identity anchors must not keep Stop available.
  expect((await owner.catalog()).find(record => record.agentId === child.agentId)).toBeDefined();
  expect(Object.values((await owner.harness.snapshot(Delegation, context))!.assignments)[0]?.status).toBe("interrupted");
  expect((await owner.harness.inspect(context)).tasks.every(item => item.record.kind === "kintsugi.delegation-anchor")).toBe(true);
  release.resolve();
  const childController = await owner.agent(child);
  faux.setResponses([fauxAssistantMessage("New work succeeds")]);
  expect((await (await childController.submit({ requestId: "new-work", text: "Continue" })).wait(context)).status).toBe("done");
  await root.close();
});

test("ordinary mail wakes wait_agent but does not become a second payload in the tool result", async () => {
  const { owner, root, faux } = await setup();
  let spawned = false;
  let waiting = false;
  let sent = false;
  const response: FauxResponseFactory = request => {
    const text = JSON.stringify(request.messages);
    if (text.includes("Your canonical task name is /root/messenger.")) {
      if (!sent) { sent = true; return fauxAssistantMessage(fauxToolCall("send_message", { target: "/root", message: "UNIQUE_MAIL_BODY" }), { stopReason: "toolUse" }); }
      return fauxAssistantMessage("Messenger done");
    }
    if (!spawned) { spawned = true; return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "messenger", message: "Send progress", fork_turns: "none" }), { stopReason: "toolUse" }); }
    if (!waiting) { waiting = true; return fauxAssistantMessage(fauxToolCall("wait_agent", { timeout_ms: 10000 }), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Mail received");
  };
  faux.setResponses(Array.from({ length: 20 }, () => response));
  await (await root.submit({ requestId: "start", text: "Delegate and wait" })).wait(context);
  await completedDeliveries(owner);
  const history = (await root.history({}, 200, undefined, context)).items;
  const waitResult = history.flatMap(entry => entry.model ?? []).find(message => message.role === "toolResult" && message.toolName === "wait_agent");
  expect(JSON.stringify(waitResult)).toContain('timed_out');
  expect(JSON.stringify(waitResult)).not.toContain("UNIQUE_MAIL_BODY");
  expect(JSON.stringify(waitResult)).toContain("false");
  await root.close();
});

test("different root trees cannot address each other's children", async () => {
  const { owner, root, faux } = await setup();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "private", message: "Private task", fork_turns: "none" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"), fauxAssistantMessage("Done"),
  ]);
  await (await root.submit({ requestId: "spawn", text: "Delegate" })).wait(context); await completedDeliveries(owner);
  const child = (await owner.catalog()).find(record => record.parentId)!;
  const other = await owner.agent({ agentId: "other", label: "Other", title: "Other" });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("send_message", { target: child.agentId, message: "Cross-tree intrusion" }), { stopReason: "toolUse" }), fauxAssistantMessage("Rejected")]);
  await (await other.submit({ requestId: "send", text: "Send" })).wait(context);
  expect(Object.values((await owner.harness.snapshot(Delegation, context))!.receipts).some(receipt => receipt.text === "Cross-tree intrusion")).toBe(false);
  const history = await other.history({}, 100, undefined, context);
  expect(JSON.stringify(history)).toContain("Unknown agent in this delegation tree");
  await root.close();
});

test("concurrent spawn admissions reserve six slots atomically", async () => {
  const { owner, root, faux } = await setup();
  let spawned = false;
  faux.setResponses(Array.from({ length: 30 }, () => async (request, options) => {
    if (JSON.stringify(request.messages).includes("Your canonical task name is /root/worker")) {
      await awaitWithContext(new Promise<never>(() => {}), { ...context, abortSignal: options?.signal });
    }
    if (!spawned) {
      spawned = true;
      return fauxAssistantMessage(Array.from({ length: 7 }, (_, index) => fauxToolCall("spawn_agent", { task_name: `worker${index}`, message: "Hold this slot", fork_turns: "none" })), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("Spawn attempts finished");
  }));
  await (await root.submit({ requestId: "capacity", text: "Delegate seven tasks" })).wait(context);
  expect((await owner.catalog()).filter(record => record.parentId)).toHaveLength(6);
  expect(JSON.stringify(await root.history({}, 200, undefined, context))).toContain("At most 6 concurrently running subagents");
  await root.stop(); await root.close();
});

test("pending child execution resumes after host suspension without duplicate spawn or completion", async () => {
  const { owner, root, faux, open } = await setup();
  const started = Promise.withResolvers<void>(); let spawned = false;
  faux.setResponses(Array.from({ length: 10 }, () => async (request, options) => {
    if (JSON.stringify(request.messages).includes("Your canonical task name is /root/recover.")) {
      started.resolve(); await awaitWithContext(new Promise<never>(() => {}), { ...context, abortSignal: options?.signal });
    }
    if (!spawned) { spawned = true; return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "recover", message: "Finish after restart", fork_turns: "none" }), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Parent is idle");
  }));
  await (await root.submit({ requestId: "recover", text: "Delegate" })).wait(context); await started.promise;
  await owner.suspend();
  const reopened = await open();
  const before = faux.state.callCount;
  expect(Object.values((await reopened.harness.snapshot(Delegation, context))!.assignments)[0]?.status).toBe("pending");
  expect(faux.state.callCount).toBe(before); // Attaching remains passive.
  faux.setResponses([fauxAssistantMessage("Recovered child result")]);
  await reopened.resume(); await completedDeliveries(reopened);
  const receipts = Object.values((await reopened.harness.snapshot(Delegation, context))!.receipts);
  expect(receipts.filter(receipt => receipt.kind === "task")).toHaveLength(1);
  expect(receipts.filter(receipt => receipt.kind === "completion")).toHaveLength(1);
  expect(receipts.find(receipt => receipt.kind === "completion")?.text).toBe("Recovered child result");
  expect(faux.state.callCount).toBe(before + 1);
  const controller = await reopened.agent({ agentId: "root", label: "Root", title: "Root" }); await controller.close();
});

test("root close persisted before cleanup blocks descendants after reopening", async () => {
  const { owner, root, faux, open } = await setup();
  const started = Promise.withResolvers<void>(); let spawned = false;
  faux.setResponses(Array.from({ length: 10 }, () => async (request, options) => {
    if (JSON.stringify(request.messages).includes("Your canonical task name is /root/closed.")) {
      started.resolve(); await awaitWithContext(new Promise<never>(() => {}), { ...context, abortSignal: options?.signal });
    }
    if (!spawned) { spawned = true; return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "closed", message: "Never resume this", fork_turns: "none" }), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Parent idle");
  }));
  await (await root.submit({ requestId: "close", text: "Delegate" })).wait(context); await started.promise;
  await root.close(); await owner.suspend();
  const before = faux.state.callCount;
  const reopened = await open(); await reopened.resume();
  expect(faux.state.callCount).toBe(before);
  expect((await reopened.harness.inspect(context)).tasks).toHaveLength(0);
  const child = (await reopened.catalog()).find(record => record.parentId)!;
  await expect((await reopened.agent(child)).submit({ requestId: "closed-child", text: "No" })).rejects.toThrow("closed");
});

test("replay after spawn committed but before its tool result reuses the same child and task", async () => {
  let pause = true;
  const committed = Promise.withResolvers<void>();
  const { owner, root, faux, open } = await setup(async context => {
    if (!pause) return;
    committed.resolve();
    await awaitWithContext(new Promise<never>(() => {}), context);
  });
  let spawned = false;
  faux.setResponses(Array.from({ length: 10 }, () => request => {
    if (JSON.stringify(request.messages).includes("Your canonical task name is /root/once.")) return fauxAssistantMessage("One child result");
    if (!spawned) { spawned = true; return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "once", message: "Run once", fork_turns: "none" }), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Parent done");
  }));
  await root.submit({ requestId: "replay-spawn", text: "Delegate" });
  await committed.promise;
  const firstId = (await owner.catalog()).find(record => record.parentId)!.agentId;
  await owner.suspend(); pause = false;
  const reopened = await open(); await reopened.resume(); await completedDeliveries(reopened);
  const children = (await reopened.catalog()).filter(record => record.parentId);
  expect(children).toHaveLength(1); expect(children[0]?.agentId).toBe(firstId);
  const receipts = Object.values((await reopened.harness.snapshot(Delegation, context))!.receipts);
  expect(receipts.filter(receipt => receipt.kind === "task")).toHaveLength(1);
  expect(receipts.filter(receipt => receipt.kind === "completion")).toHaveLength(1);
  const restored = await reopened.agent({ agentId: "root", label: "Root", title: "Root" }); await restored.close();
});

test("interrupt_agent retains the child for a later follow-up and returns its prior status", async () => {
  const { owner, root, faux } = await setup();
  const childStarted = Promise.withResolvers<void>();
  let spawned = false; let interrupt = false;
  faux.setResponses(Array.from({ length: 15 }, () => async (request, options) => {
    if (JSON.stringify(request.messages).includes("Your canonical task name is /root/interruptible.")) {
      childStarted.resolve(); await awaitWithContext(new Promise<never>(() => {}), { ...context, abortSignal: options?.signal });
    }
    if (!spawned) { spawned = true; return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "interruptible", message: "Wait", fork_turns: "none" }), { stopReason: "toolUse" }); }
    if (interrupt) { interrupt = false; return fauxAssistantMessage(fauxToolCall("interrupt_agent", { target: "interruptible" }), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Root done");
  }));
  await (await root.submit({ requestId: "spawn", text: "Delegate" })).wait(context); await childStarted.promise;
  interrupt = true;
  await (await root.submit({ requestId: "interrupt", text: "Interrupt the child" })).wait(context);
  const state = (await owner.harness.snapshot(Delegation, context))!;
  expect(Object.values(state.assignments)[0]?.status).toBe("interrupted");
  expect(JSON.stringify(await root.history({}, 200, undefined, context))).toContain('previous_status');
  let followup = false;
  faux.setResponses(Array.from({ length: 10 }, () => request => {
    if (JSON.stringify(request.messages).includes("Your canonical task name is /root/interruptible.")) return fauxAssistantMessage("Reusable child");
    if (!followup) { followup = true; return fauxAssistantMessage(fauxToolCall("followup_task", { target: "interruptible", message: "Resume with new task" }), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Done");
  }));
  await (await root.submit({ requestId: "followup", text: "Assign another task" })).wait(context); await completedDeliveries(owner);
  expect(Object.values((await owner.harness.snapshot(Delegation, context))!.assignments).at(-1)?.result).toBe("Reusable child");
  await root.close();
});

test("Stop also fences a native input admitted by an already-stopped dispatcher", async () => {
  const { owner, root, faux } = await setup();
  const { defineTask } = await import("@earendil-works/pi-durable");
  const { DurableTaskAdmissions, WorkspaceStops, commitDurableStop } = await import("@kintsugi/builtin-agent/server");
  const { markGatedDurableWork, settleStoppedDurableWork } = await import("@kintsugi/builtin-agent/server/durable-lifecycle");
  // A not-yet-installed dispatcher models the persisted outbox before execution.
  const dispatcher = defineTask<Record<string, never>, { phase: "send" }, null>({
    name: "test.late-dispatcher", version: 1, initial: () => ({ phase: "send" }),
    phases: { async send() { throw new Error("Must not execute"); } },
    async abort(_task, runtime, context) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: null } }), context); },
  });
  const task = await owner.harness.commit(async tx => {
    const task = await tx.createTask(dispatcher, {}, { conversationId: root.id, ownership: { kind: "conversation" }, background: true });
    (await tx.doc(DurableTaskAdmissions)).requests[String(task)] = { conversationId: root.id, requestId: "late-dispatch" };
    return task;
  }, context);
  await owner.harness.commit(tx => commitDurableStop(tx, root.id), context);
  expect(Object.values((await owner.harness.snapshot(WorkspaceStops, context))!.tasks).flat()).toContain(task);
  faux.setResponses([async (_request, options) => {
    await awaitWithContext(new Promise<never>(() => {}), { ...context, abortSignal: options?.signal });
    return fauxAssistantMessage("Must not finish");
  }]);
  // Reproduce the narrow gap between persisting Stop and joining its dispatcher.
  const raw = (await owner.harness.conversation(root.id, context))!;
  const late = await raw.submit({ type: "input", requestId: "late-dispatch", content: "Old task" }, context);
  await markGatedDurableWork(owner.harness); await settleStoppedDurableWork(owner.harness);
  expect((await late.status(context)).status).toBe("unanswered");
  faux.setResponses([fauxAssistantMessage("New input still works")]);
  expect((await (await root.submit({ requestId: "fresh-after-stop", text: "New task" })).wait(context)).status).toBe("done");
});

test("a script's one-shot agent is no part of delegation: not listed, addressed or given a delegation prompt", async () => {
  const { owner, root, faux } = await setup();
  // As code mode lists one: a read-only child of the root, marked with the script call that runs it.
  const oneShot = await owner.harness.commit(async tx => {
    const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" }, instructions: "Testing native collaboration." });
    const record = { agentId: "one-shot", durableId: created.id, parentId: "root", rootId: "root", label: "counter", title: "Count", readOnly: true, oneShotCallId: "call_script/c1" };
    (await tx.doc(WorkspaceAgents)).agents.push(record);
    return record;
  }, context);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("list_agents", {}), fauxToolCall("send_message", { target: oneShot.agentId, message: "Intrusion" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  await (await root.submit({ requestId: "list", text: "List" })).wait(context);
  const results = (await root.history({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []).flatMap(message => message.role === "toolResult" ? [message] : []);
  expect(JSON.stringify(results.find(message => message.toolName === "list_agents")?.content)).toBe(JSON.stringify([{ type: "text", text: JSON.stringify({ agents: [{ agent_name: "/root", agent_status: "running" }] }) }]));
  expect(JSON.stringify(results.find(message => message.toolName === "send_message"))).toContain("Unknown agent in this delegation tree");
  let prompt = "";
  faux.setResponses([request => { const [system] = request.messages; prompt = system?.role === "system" ? JSON.stringify(system.sections) : ""; return fauxAssistantMessage("{}"); }]);
  const conversation = (await owner.harness.conversation(oneShot.durableId, context))!;
  await (await conversation.submit({ type: "input", requestId: "script", content: "Count" }, context)).wait(context);
  expect(prompt).toContain("Testing native collaboration.");
  expect(prompt).not.toContain("agents-in-the-cloud-delegation");
});
