import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { AgentDoc, UsageDoc, LiveDoc, configure } from "@earendil-works/pi-durable";
import { openDurableAgentRuntime, type DurableAgentRuntime } from "@kintsugi/builtin-agent/server/durable-runtime";
import { createDurableWorkspaceRegistry } from "@kintsugi/builtin-agent/server/durable-assembly";
import { createNativePlanExtension } from "../../../builtin-agent/src/server/durable-plan.ts";
import { oneShotLimits } from "../../src/server/one-shot-limits.ts";
import { codemodeIntegration } from "../../src/server/integration.ts";
import { projectDurableTranscript } from "@kintsugi/builtin-agent/server";
import { codemodeTool } from "./support.ts";


const paths: string[] = [];
const owners: DurableAgentRuntime[] = [];
afterEach(async () => { for (const owner of owners.splice(0)) await owner.suspend(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });

const oneShot = "You are a one-shot agent working for a code mode script.";
const schema = { type: "object", required: ["count"], additionalProperties: false, properties: { count: { type: "integer" } } };

/** The request's system message, with its prompt sections. */
const system = (request: Parameters<FauxResponseFactory>[0]) => {
  const [message] = request.messages;
  return message?.role === "system" ? Object.values(message.sections ?? {}).join("\n") : "";
};

async function setup(script: string, child: FauxResponseFactory, options: { wait?: boolean; restricted?: boolean } = {}) {
  const path = await mkdtemp(join(tmpdir(), "one-shot-agent-")); paths.push(path);
  const models = createModels(); const faux = fauxProvider({ tokensPerSecond: 100000 }); models.setProvider(faux.provider);
  // The workspace's own tools and code mode, as the builtin agent assembles them; the agents never call them.
  const registry = createDurableWorkspaceRegistry("one-shot");
  registry.install(codemodeIntegration.extension!("one-shot", models));
  registry.install(oneShotLimits);
  let owner: DurableAgentRuntime;
  registry.install(createNativePlanExtension("one-shot", () => owner.harness));
  const open = () => openDurableAgentRuntime(path, "one-shot", {}, {
    harness: async () => ({ models, registry, settings: { retry: { enabled: false } } }),
    prepare: async () => ({ model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off", instructions: 'Testing one-shot agents. Your Kintsugi Agent ID is "root".' }),
    expand: async (_id, text) => text, ready: async () => {}, validateModel: async () => {},
  });
  owner = await open();
  owners.push(owner);
  const root = await owner.agent({ agentId: "root", label: "Root", title: "Root" });
  if (options.restricted) await owner.harness.commit(async tx => configure(tx, (await owner.catalog())[0]!.durableId, { tools: registry.snapshot().tools().filter(({ tool }) => ["codemode", "agent", "read"].includes(tool.name)).map(({ tool }) => tool) }), context);
  let scripted = false;
  faux.setResponses(Array.from({ length: 20 }, () => (request, options, state, model) => {
    if (system(request).includes(oneShot)) return child(request, options, state, model);
    if (!scripted) { scripted = true; return fauxAssistantMessage(fauxToolCall("codemode", { code: script }), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Script finished");
  }));
  const submission = await root.submit({ requestId: "start", text: "Run the workflow" });
  const finished = submission.wait(context);
  if (options.wait !== false) await finished;
  const view = await root.historyView();
  const result = view.entries.flatMap(entry => entry.model ?? []).find(message => message.role === "toolResult" && message.toolName === "codemode");
  return { owner, root, view, faux, finished, submission, reopen: async () => { owner = await open(); owners.push(owner); return owner; }, output: result?.role === "toolResult" ? result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("") : "" };
}

test("a script's one-shot agent answers with validated JSON, retrying an unusable answer", async () => {
  const answers = ["Not JSON at all", '{"count": "three"}', '```json\n{"count": 3}\n```'];
  const requests: { tools: string[]; system: string }[] = [];
  const { owner, view, output } = await setup(
    `return await tools.agent({ prompt: "Count the files", label: "counter", schema: ${JSON.stringify(schema)}, tools: ["read"] });`,
    request => { requests.push({ tools: request.messages.flatMap(message => message.role === "system" ? message.toolsAdded ?? [] : []).map(tool => tool.name), system: system(request) }); return fauxAssistantMessage(answers[requests.length - 1]!); },
  );
  expect(output).toEndWith('Output:\n{"count":3}');
  expect(requests).toHaveLength(3);
  // Only the chosen tools, and no scripts or delegation of its own.
  expect(requests[0]!.tools).toEqual(["read"]);
  expect(requests[0]!.system).toContain("Testing one-shot agents.");
  expect(requests[0]!.system).not.toContain("<codemode>");
  const record = (await owner.catalog()).find(record => record.oneShotCallId)!;
  expect(record).toMatchObject({ parentId: "root", rootId: "root", label: "counter", title: "Count the files", readOnly: true });
  expect(requests[0]!.system).toContain(`Your Kintsugi Agent ID is ${JSON.stringify(record.agentId)}.`);
  expect((await owner.harness.snapshot(AgentDoc, record.durableId, context))?.model).toEqual({ provider: "faux", modelId: "faux-1" });
  // The script's row opens its conversation.
  expect(codemodeTool(projectDurableTranscript(view))!.nested).toMatchObject([{ callId: record.oneShotCallId, childAgentId: record.agentId }]);
  expect(record.oneShotCallId).toMatch(/\/c1$/);
});

test("what a one-shot agent costs is its script call's, and its caller's", async () => {
  const { owner, root, view } = await setup(
    `return await tools.agent({ prompt: "Count the files", schema: ${JSON.stringify(schema)} });`,
    () => fauxAssistantMessage('{"count": 3}'),
  );
  const record = (await owner.catalog()).find(record => record.oneShotCallId)!;
  const usage = (await owner.harness.snapshot(UsageDoc, record.durableId, context))!;
  const outputTokens = Object.values(usage.models).reduce((sum, item) => sum + item.output, 0);
  expect(outputTokens).toBeGreaterThan(0);
  // The script's row shows what it used.
  const [call] = codemodeTool(projectDurableTranscript(view))!.nested!;
  expect(call).toMatchObject({ name: "agent", status: "ok", childAgentId: record.agentId, usage: { outputTokens, cost: 0 } });
  // The faux provider charges nothing: price what it used, which counts toward the Agent's total.
  const cost = 0.25;
  await owner.harness.commit(async tx => { Object.values((await tx.doc(UsageDoc, record.durableId)).models)[0]!.cost.total = cost; }, context);
  expect(await root.descendantCost()).toBe(cost);
});

test("a one-shot agent rejects after three unusable answers, and is read-only", async () => {
  const { owner, output } = await setup(
    `return { agents: await Promise.all([1, 2].map(n => tools.agent({ prompt: "Answer " + n, schema: ${JSON.stringify(schema)} }).catch(error => error.message))) };`,
    () => fauxAssistantMessage("still not JSON"),
  );
  const result = JSON.parse(output.slice(output.indexOf("Output:\n") + 8));
  expect(result.agents).toEqual(Array.from({ length: 2 }, () => expect.stringContaining("The agent's answer was not usable after 3 attempts: it is not JSON")));
  expect((await owner.catalog()).filter(record => record.oneShotCallId)).toHaveLength(2);
  const child = (await owner.agent((await owner.catalog()).find(record => record.oneShotCallId)!));
  await expect(child.submit({ requestId: "user", text: "Hi" })).rejects.toThrow("read-only");
});

test("one-shot tools never restore a capability disabled for their caller", async () => {
  const { owner, output } = await setup(`return await tools.agent({ prompt: "Count", schema: ${JSON.stringify(schema)}, tools: ["write"] });`, () => fauxAssistantMessage('{"count":1}'), { restricted: true });
  expect(output).toContain("Unknown or unavailable tools: write");
  expect((await owner.catalog()).filter(record => record.oneShotCallId)).toHaveLength(0);
});

test("default one-shot capabilities are intersected with the caller's enabled tools", async () => {
  const tools: string[] = [];
  await setup(`return await tools.agent({ prompt: "Count", schema: ${JSON.stringify(schema)} });`, request => {
    tools.push(...request.messages.flatMap(message => message.role === "system" ? message.toolsAdded ?? [] : []).map(tool => tool.name));
    return fauxAssistantMessage('{"count":1}');
  }, { restricted: true });
  expect(tools).toEqual(["read"]);
});

test("Stop ends a script's in-flight one-shot generation", async () => {
  const entered = Promise.withResolvers<void>();
  const fixture = await setup(`return await tools.agent({ prompt: "Count", schema: ${JSON.stringify(schema)} });`, (_request, options) => {
    entered.resolve();
    return new Promise(resolve => options!.signal!.addEventListener("abort", () => resolve(fauxAssistantMessage('{"count":1}')), { once: true }));
  }, { wait: false });
  await entered.promise;
  const record = (await fixture.owner.catalog()).find(record => record.oneShotCallId)!;
  await fixture.root.stop();
  await fixture.finished;
  expect((await fixture.owner.harness.snapshot(LiveDoc, record.durableId, context))?.run).toBeUndefined();
});

test("recovery reattaches to the one-shot conversation and deduplicates its input", async () => {
  const entered = Promise.withResolvers<void>();
  let requests = 0;
  const fixture = await setup(`return await tools.agent({ prompt: "Count", schema: ${JSON.stringify(schema)} });`, (_request, options) => {
    if (++requests > 1) return fauxAssistantMessage('{"count":1}');
    entered.resolve();
    return new Promise(resolve => options!.signal!.addEventListener("abort", () => resolve(fauxAssistantMessage('{"count":0}')), { once: true }));
  }, { wait: false });
  await entered.promise;
  const before = (await fixture.owner.catalog()).find(record => record.oneShotCallId)!;
  const closed = fixture.finished.catch(error => expect(error.message).toBe("Harness is closed"));
  await fixture.owner.suspend();
  await closed;
  const recovered = await fixture.reopen();
  const root = await recovered.agent({ agentId: "root", label: "Root", title: "Root" });
  const submission = await recovered.harness.submission(fixture.submission.id, context);
  await submission!.wait(context);
  const after = (await recovered.catalog()).filter(record => record.oneShotCallId);
  expect(after).toHaveLength(1);
  expect(after[0]!.agentId).toBe(before.agentId);
  const child = await recovered.harness.conversation(before.durableId, context);
  const entries = await child!.entries({}, 100, undefined, context);
  expect(entries.items.filter(entry => entry.model?.some(message => message.role === "user"))).toHaveLength(1);
});

test("one-shot admission caps live children before their first submission", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0;
  const fixture = await setup(`return await Promise.allSettled(Array.from({length:9}, (_, n) => tools.agent({ prompt: "Count " + n, schema: ${JSON.stringify(schema)} })));`, async () => {
    if (++requests === 8) entered.resolve();
    await release.promise;
    return fauxAssistantMessage('{"count":1}');
  }, { wait: false });
  await entered.promise;
  let rejected = false;
  for (let index = 0; index < 100; index++) {
    rejected = JSON.stringify((await fixture.root.historyView()).entries).includes("At most eight one-shot agents");
    if (rejected) break;
    await Bun.sleep(10);
  }
  release.resolve();
  await fixture.finished;
  expect(rejected).toBe(true);
  expect((await fixture.owner.catalog()).filter(record => record.oneShotCallId)).toHaveLength(8);
});
