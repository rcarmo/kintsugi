// SPDX-License-Identifier: Apache-2.0
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTask, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { reserve, settle } from "../core/accounting.ts";
import { redact } from "../core/observations.ts";
import { purposeAllowed, type Policy } from "../core/config.ts";
import type { InferenceRequest, InferenceResult, SideCall, Spend } from "../core/types.ts";
import { JobsDoc, type InferenceJob } from "./documents.ts";
export type JobOrigin = { sessionKey: string; account: string; runId: string | null; revision: string; digest: string; estimatedMaximumCost: number | null };
export type JobAdmission = { accepted: boolean; reason: string; job: InferenceJob | null };
export function createInferenceQueue(options: { harness: () => Harness; backgroundOwner?:() => ConversationId; policy: (sessionKey: string) => Policy; sideCall: SideCall; maximumCost?:(request:InferenceRequest) => number|null;onAuthPause?:(account:string,revision:number,key:string) => Promise<void>; now?:() => number }) {
  const controllers = new Map<string, AbortController>();
  const task = defineTask<{ id: string }, { phase: "queued" | "invoke" }, null>({
    name: "token-economizer.inference", version: 1, initial: () => ({ phase: "queued" }),
    phases: {
      async queued(current, runtime, context) {
        await runtime.commit(async tx => {
          const state = await tx.doc(JobsDoc), job = state.jobs[current.input.id];
          if (!job) throw new Error("Missing inference job");
          if (job.status !== "queued") return { status: "terminal", outcome: { status: "completed", result: null } };
          if (!purposeAllowed(options.policy(job.sessionKey),job.request) || state.paused.includes(job.account) || runtime.now() >= job.deadline) {
            job.status = "cancelled"; job.error = "Policy, authentication or deadline prevents execution";
            settle(state.budget, spend(job, null, "failed"));
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          const priority = (row:InferenceJob) => ["loop-judge","writer"].includes(row.request.purpose) || row.request.classification?.purpose === "loop";
          const guardWaiting = Object.values(state.jobs).some(row => row.status === "queued" && priority(row));
          if (state.worker !== null || guardWaiting && !priority(job)) return { status: "sleeping", until: runtime.now()+50, checkpoint: { phase: "queued" } };
          state.worker = job.id; job.status = "running";
          return { status: "running", checkpoint: { phase: "invoke" } };
        }, context);
      },
      async invoke(current, runtime, context) {
        const id = current.input.id, invocation = crypto.randomUUID();
        const first = await runtime.memo("provider-invocation", invocation, context);
        const snapshot = await runtime.snapshot(JobsDoc, context), job = snapshot!.jobs[id];
        if (!job) throw new Error("Missing running inference job");
        if (first !== invocation) {
          await runtime.commit(async tx => {
            const state = await tx.doc(JobsDoc), row = state.jobs[id];
            row.status = "unknown"; row.error = "Restart interrupted a provider attempt; not retried";
            state.budget.ledger.push(spend(row, null, "unknown")); state.budget.unknown.push(id);
            if (state.worker === id) state.worker = null;
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          return;
        }
        const controller = new AbortController(); controllers.set(id, controller);
        const signal = AbortSignal.any([controller.signal, runtime.signal]);
        const remaining = Math.max(1, job.deadline-runtime.now());
        const clear = runtime.setTimer(() => controller.abort(new Error("Optimisation deadline exceeded")), remaining);
        let result: InferenceResult | null = null, error: string | null = null, attempted = false;
        try {
          if (!purposeAllowed(options.policy(job.sessionKey),job.request)) throw new Error("Optimisation disabled");
          const aborted = new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          attempted = true;
          const reply = await Promise.race([options.sideCall(job.request, signal), aborted]);
          if (reply.cost !== null && (!Number.isFinite(reply.cost) || reply.cost < 0) || !Number.isFinite(reply.durationMs) || reply.durationMs < 0) throw new Error("Invalid optimization billing metadata");
          result = {...reply,text:redact(reply.text).slice(0,64_000),error:reply.text.length > 64_000 ? "Optimization output limit exceeded" : reply.error === null ? null : redact(reply.error)};
        } catch (cause) { error = redact(Error.isError(cause) ? cause.message : String(cause)); }
        finally { clear(); controllers.delete(id); }
        // A close cancels this invocation. The next invocation records unknown billing, never retries.
        runtime.signal.throwIfAborted();
        let pauseRevision:number|null = null;
        await runtime.commit(async tx => {
          const state = await tx.doc(JobsDoc), row = state.jobs[id];
          row.result = result; row.error = error ?? result?.error ?? null;
          row.status = result ? row.error ? "failed" : "complete" : attempted ? "unknown" : "cancelled";
          if (result?.authUnavailable && !state.paused.includes(row.account)) {state.paused.push(row.account);pauseRevision = (state.pauseRevisions[row.account] ?? 0)+1;state.pauseRevisions[row.account] = pauseRevision;}
          const usage = spend(row, result, result ? row.status === "complete" ? "complete" : "failed" : attempted ? "unknown" : "failed");
          if (usage.status === "unknown") { state.budget.ledger.push(usage); state.budget.unknown.push(id); }
          else settle(state.budget, usage);
          if (state.worker === id) state.worker = null;
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
        if (pauseRevision !== null) await options.onAuthPause?.(job.account,pauseRevision,job.sessionKey);
      },
    },
    async abort(current, runtime, context) {
      controllers.get(current.input.id)?.abort(new Error("Optimisation cancelled"));
      await runtime.commit(async tx => {
        const state = await tx.doc(JobsDoc), row = state.jobs[current.input.id];
        if (row && ["queued","running"].includes(row.status)) {
          const uncertain = row.status === "running";
          row.status = uncertain ? "unknown" : "cancelled"; row.error = "Optimisation cancelled";
          if (!state.budget.ledger.some(item => item.id === row.id)) {
            if (uncertain) { state.budget.ledger.push(spend(row,null,"unknown")); state.budget.unknown.push(row.id); }
            else settle(state.budget, spend(row,null,"failed"));
          }
        }
        if (state.worker === current.input.id) state.worker = null;
        return { status: "terminal", outcome: { status: "aborted", result: null, reason: "Optimisation cancelled" } };
      }, context);
    },
  });
  function spend(job: InferenceJob, result: InferenceResult | null, status: Spend["status"]): Spend {
    return { id: job.id, sessionId: job.sessionKey, purpose: job.request.purpose, model: result?.model ?? job.request.model,
      usage: result?.usage ?? null, cost: result?.cost ?? (job.status === "cancelled" ? 0 : null), durationMs: result?.durationMs ?? 0, status };
  }
  return {
    extension: defineExtension({ name: "token-economizer.inference", tasks: [task] }),
    async enqueue(conversationId: ConversationId, request: InferenceRequest, origin: JobOrigin): Promise<JobAdmission> {
      return options.harness().commit(async tx => {
        const state = await tx.doc(JobsDoc);
        if (Object.hasOwn(state.jobs,request.id)) return { accepted: false, reason: "duplicate", job: state.jobs[request.id] };
        const policy = options.policy(origin.sessionKey);
        if (request.prompt.length > 64_000 || request.classification && JSON.stringify(request.classification).length > 64_000) return {accepted:false,reason:"input_limit",job:null};
        if (!purposeAllowed(policy,request)) return { accepted: false, reason: "disabled", job: null };
        if (state.paused.includes(origin.account)) return { accepted: false, reason: "auth_paused", job: null };
        if (Object.values(state.jobs).filter(row => ["queued","running"].includes(row.status)).length >= 32) return { accepted: false, reason: "queue_full", job: null };
        const now = (options.now ?? Date.now)(), admission = reserve(state.budget, request.id, origin.sessionKey, new Date(now).toISOString().slice(0,10), origin.estimatedMaximumCost ?? options.maximumCost?.(request) ?? null, policy);
        if (!admission.accepted) return { accepted: false, reason: admission.reason, job: null };
        const job: InferenceJob = { id: request.id, sessionKey: origin.sessionKey, account: origin.account, runId: origin.runId, revision: origin.revision, digest: origin.digest,
          request: { ...request, prompt:redact(request.prompt), maxOutputTokens: Math.min(request.maxOutputTokens,policy.budget.maxOutputTokens), deadlineMs: Math.min(policy.budget.deadlineMs,request.deadlineMs) }, created: now, deadline: now+Math.min(policy.budget.deadlineMs,request.deadlineMs), taskId: null, status: "queued", result: null, error: null };
        job.taskId = await tx.createTask(task, { id: job.id }, { ownership: { kind: "conversation" }, conversationId:options.backgroundOwner?.() ?? conversationId, background: true });
        state.jobs[job.id] = job;
        return { accepted: true, reason: "queued", job };
      }, BACKGROUND_CONTEXT);
    },
    async cancelDisabled() {
      for (const [id, controller] of controllers) {
        const state = await options.harness().snapshot(JobsDoc, BACKGROUND_CONTEXT), job = state?.jobs[id];
        if (job && !purposeAllowed(options.policy(job.sessionKey),job.request)) controller.abort(new Error("Optimisation disabled"));
      }
      const state = await options.harness().snapshot(JobsDoc, BACKGROUND_CONTEXT);
      for (const job of Object.values(state?.jobs ?? {})) if (job.taskId && job.status === "queued" && !purposeAllowed(options.policy(job.sessionKey),job.request)) await options.harness().abortTask(job.taskId, BACKGROUND_CONTEXT);
    },
    async retry(account: string) { await options.harness().commit(async tx => { const state = await tx.doc(JobsDoc); state.paused = state.paused.filter(key => key !== account); }, BACKGROUND_CONTEXT); },
    async reconcile(id: string, result: InferenceResult) {
      await options.harness().commit(async tx => {
        const state = await tx.doc(JobsDoc), job = state.jobs[id];
        if (!job || job.status !== "unknown") throw new Error("Only uncertain jobs may be reconciled");
        state.budget.ledger = state.budget.ledger.filter(row => row.id !== id);
        if (!state.budget.reserved[id]) state.budget.reserved[id] = { session: job.sessionKey, day: new Date(job.created).toISOString().slice(0,10), cost: null };
        job.result = result; job.status = result.error ? "failed" : "complete"; job.error = result.error;
        settle(state.budget, spend(job, result, job.status === "complete" ? "complete" : "failed"));
        state.budget.unknown = state.budget.unknown.filter(key => key !== id);
      }, BACKGROUND_CONTEXT);
    },
  };
}
