import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import {
  createRegistry, defineDoc, defineExtension, defineTool, LiveDoc, NestedCallDoc,
  type Conversation, type Harness, type SubmissionId,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createCommittedObservations } from "../../../token-economizer/src/pi-durable/observations.ts";
import { decodeArguments, decodeResult } from "../../../token-economizer/src/pi-durable/decode.ts";
import { defaultPolicy } from "../../../token-economizer/src/core/config.ts";
import type { Observation } from "../../../token-economizer/src/core/types.ts";
import type { HostDomain } from "../../../token-economizer/src/pi-durable/domain.ts";
import { openDurableWorkspace, type DurableWorkspace } from "../../src/server/durable-workspace.ts";

// M0 spike: only public SDK documents; no Kintsugi codemode receipt types/private documents.
const Evidence = defineDoc<{ receipts: Record<string, { output: string }>; redirects: string[] }>({
  kind: "test.te-evidence", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ receipts: {}, redirects: [] }), checkpointWhen: () => true,
});
const paths: string[] = [];
const workspaces: DurableWorkspace[] = [];
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.close();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

async function setup(path?: string, automatic = false) {
  if (!path) { path = await mkdtemp(join(tmpdir(), "te-sdk-")); paths.push(path); }
  const models = createModels(), faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  const held = Promise.withResolvers<void>(), secondHeld = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let arrivals = 0;
  const registry = createRegistry();
  registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
  registry.install(defineExtension({ name: "te-sdk-probe", tools: [
    defineTool({ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }), structuredOutputSchema: Type.String(), replay: "safe",
      async execute(args) { return { structuredOutput: args.text }; },
    }),
    defineTool({ name: "hold", description: "Wait", parameters: Type.Object({}), structuredOutputSchema: Type.String(), replay: "safe",
      async execute(_args, _api, ctx) {
        (arrivals++ === 0 ? held : secondHeld).resolve();
        await new Promise<void>((resolve, reject) => {
          void release.promise.then(resolve);
          ctx.abortSignal!.addEventListener("abort", () => reject(ctx.abortSignal!.reason), { once: true });
        });
        return { structuredOutput: "released" };
      },
    }),
  ] }));
  const recorded: Observation[] = [];
  const policy = {...defaultPolicy(),enabled:true,mode:"active" as const};
  const domain: HostDomain = {integrationId:"sdk-probe",session:async id => ({id:"session",conversationId:id,scope:{host:"probe",repository:"repo",environment:"v1"},repositoryRoot:"/repo",environmentRevision:"v1",classificationGroup:"group",delegated:false}),
    tool:name => ({semantic:name === "codemode" ? "wrapper" : "other",readOnly:true}),arguments:(_name,args) => decodeArguments(args),decode:decodeResult,setTools:async () => {},
    catalogue:async () => ({revision:"1",source:"fixture",complete:true,tools:[]}),trajectory:async () => ({kind:"later",reason:"fixture"})};
  const recorder = automatic ? createCommittedObservations({harness:() => workspace.harness,domain,policy:() => policy,onObservation:async (_host,observation) => {recorded.push(observation);},onError:error => {throw error;}}) : null;
  if (recorder) registry.install(recorder.extension);
  const workspace = await openDurableWorkspace(path, "te-sdk", { models, registry });
  recorder?.attach();
  workspaces.push(workspace);
  const conversation = await workspace.agent({ agentId: "root", label: "Root", title: "TE SDK" }, {
    model: { provider: "faux", modelId: "faux-1" }, instructions: "Run the supplied script.",
  });
  return { workspace, conversation, faux, held, secondHeld, release, path, recorder, recorded };
}
const code = "await tools.echo({text:'first'}); await tools.echo({text:'second'}); await tools.hold({});";

/** Recover committed nested results while their caller is live. The transaction pins result and receipt together. */
async function capture(harness: Harness, conversation: Conversation) {
  return harness.commit(async tx => {
    const live = await tx.doc(LiveDoc, conversation.id);
    const found: { key: string; output: string }[] = [];
    for (const slot of live.nestedTools ?? []) {
      if (slot.status !== "done") continue;
      const task = await tx.task(slot.taskId);
      if (!task) throw new Error("Missing nested task");
      Value.Assert(Type.Object({ kind: Type.Literal("nested"), key: Type.String() }), task.input);
      const state = await tx.doc(NestedCallDoc, slot.parentTaskId, task.input.key, null);
      if (!state.result) continue;
      expect(task.state).toMatchObject({ status: "terminal" });
      expect("outcome" in task.state ? task.state.outcome : undefined).toMatchObject({ status: "completed", result: { kind: "nested" } });
      Value.Assert(Type.String(), state.result.structuredOutput);
      found.push({ key: `${conversation.id}/${slot.parentTaskId}/${task.input.key}`, output: state.result.structuredOutput });
    }
    const evidence = await tx.doc(Evidence, conversation.id);
    for (const item of found) evidence.receipts[item.key] = { output: item.output };
    return found;
  }, context);
}

/** One redirect per originating input batch; a steer never becomes the identity of a new budget. */
async function redirect(harness: Harness, conversation: Conversation, inputs: readonly SubmissionId[], id: string) {
  return harness.commit(async tx => {
    const live = await tx.doc(LiveDoc, conversation.id);
    const evidence = await tx.doc(Evidence, conversation.id);
    if (!live.run?.inputs.length || live.run.afterRun || inputs.some(input => !live.run!.inputs.includes(input)) || evidence.redirects.includes(id)) return false;
    // SDK requires submission before this transaction's first table write.
    await conversation.submit(tx, { type: "input", content: "Reassess the repeated failure.", whenBusy: "steer", whenIdle: "reject", requestId: `redirect-${id}` });
    evidence.redirects.push(id);
    return true;
  }, context);
}

async function start(fixture: Awaited<ReturnType<typeof setup>>, requestId = "script") {
  fixture.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  const submission = await fixture.conversation.submit({ type: "input", content: "Run", requestId }, context);
  await fixture.held.promise;
  return submission;
}

test("TE M0: two committed nested results are recoverable during one running codemode script and deduplicate", async () => {
  const f = await setup();
  const submission = await start(f);
  const live = await f.workspace.harness.snapshot(LiveDoc, f.conversation.id, context);
  const parent = live!.tools![0]!.taskId!;
  expect(live!.nestedTools?.filter(slot => slot.status === "done")).toHaveLength(2);
  const found = await capture(f.workspace.harness, f.conversation);
  expect(found.map(r => r.output)).toEqual(["first", "second"]);
  await capture(f.workspace.harness, f.conversation);
  expect(Object.keys((await f.workspace.harness.snapshot(Evidence, f.conversation.id, context))!.receipts)).toHaveLength(2);
  const firstKey = live!.nestedTools![0]!.callId.split("/").at(-1)!;
  expect(await f.workspace.harness.snapshot(NestedCallDoc, parent, firstKey, context)).toHaveProperty("result");
  f.release.resolve();
  expect((await submission.wait(context)).status).toBe("done");
  expect(await f.workspace.harness.snapshot(NestedCallDoc, parent, firstKey, context)).toBeUndefined();
  expect(Object.values((await f.workspace.harness.snapshot(Evidence, f.conversation.id, context))!.receipts).map(r => r.output)).toEqual(["first", "second"]);
}, 15_000);

test("TE M0: restart in the result-to-receipt gap recovers from public nested state without rerunning completed calls", async () => {
  const f = await setup();
  await start(f);
  // Completed results exist, but the scanner has not stored any receipt yet.
  await f.workspace.close();
  const reopened = await setup(f.path);
  expect((await capture(reopened.workspace.harness, reopened.conversation)).map(r => r.output)).toEqual(["first", "second"]);
  reopened.faux.setResponses([fauxAssistantMessage("Done after reopen")]);
  reopened.release.resolve();
  await reopened.conversation.abort(context);
  expect(Object.keys((await reopened.workspace.harness.snapshot(Evidence, reopened.conversation.id, context))!.receipts)).toHaveLength(2);
}, 15_000);

test("TE M0: transactional steering admits once, rejects after Stop and cannot bind to a later run", async () => {
  const f = await setup();
  await start(f);
  const inputs = (await f.workspace.harness.snapshot(LiveDoc, f.conversation.id, context))!.run!.inputs;
  expect(await redirect(f.workspace.harness, f.conversation, inputs, "original")).toBe(true);
  expect(await redirect(f.workspace.harness, f.conversation, inputs, "original")).toBe(false);
  await f.conversation.abort(context);
  expect(await redirect(f.workspace.harness, f.conversation, inputs, "late-stop")).toBe(false);
  // A later prompt-run must not consume the previous run's stale judgement.
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: "await tools.hold({});" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done after second run"),
  ]);
  const next = await f.conversation.submit({ type: "input", content: "Another run", requestId: "next" }, context);
  await f.secondHeld.promise;
  expect((await f.workspace.harness.snapshot(LiveDoc, f.conversation.id, context))!.run!.inputs).not.toEqual(inputs);
  expect(await redirect(f.workspace.harness, f.conversation, inputs, "late-active-run")).toBe(false);
  f.release.resolve();
  await next.wait(context);
  expect(await redirect(f.workspace.harness, f.conversation, inputs, "late-answer")).toBe(false);
  await f.conversation.reset(undefined, context);
  await f.conversation.waitForIdle(context);
  expect(await redirect(f.workspace.harness, f.conversation, inputs, "late-reset")).toBe(false);
  expect((await f.workspace.harness.snapshot(Evidence, f.conversation.id, context))!.redirects).toEqual(["original"]);
}, 15_000);

test("TE committed adapter: fast nested calls persist automatically before caller retirement, without a hold", async () => {
  const f = await setup(undefined,true);
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode",{code:"for (let i=0;i<20;i++) await tools.echo({text:String(i)});"})],{stopReason:"toolUse"}),
    fauxAssistantMessage("Done"),
  ]);
  const submission = await f.conversation.submit({type:"input",content:"Run the fast batch",requestId:"fast"},context);
  expect((await submission.wait(context)).status).toBe("done");
  await f.recorder!.drained();
  expect(f.recorded.map(observation => observation.output)).toEqual(Array.from({length:20},(_,i) => String(i)));
  expect(f.recorded.every(observation => observation.nested)).toBe(true);
  expect(new Set(f.recorded.map(observation => observation.id)).size).toBe(20);
},15_000);
