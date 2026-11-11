// SPDX-License-Identifier: Apache-2.0
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTask, type Harness, type ConversationId } from "@earendil-works/pi-durable";
import { observing, type Policy } from "../core/config.ts";
import { claimFold, deferFold, endSession, finishFold, prepareSession, recoverableSessions, sessionKey, transcriptChanged, type LearningSession } from "../core/sessions.ts";
import { scopeKey } from "../core/types.ts";
import { KnowledgeDoc, ObservationsDoc, SessionsDoc, type Knowledge } from "./documents.ts";
import type { HostDomain, HostSession, SessionStart, Trajectory } from "./domain.ts";
export type FoldResult = Pick<Knowledge,"tools" | "render" | "injectedIds" | "environment" | "distiller"> & Partial<Pick<Knowledge,"novelty"|"renders">>;
export type SessionFolder = (input: { session: LearningSession; host: HostSession; trajectory: Extract<Trajectory,{kind:"ready"}>; knowledge: Knowledge; policy: Policy; signal: AbortSignal }) => Promise<FoldResult>;
export function createSessionLifecycle(options: { harness: () => Harness; backgroundOwner?:() => ConversationId; domain: HostDomain; policy: (key: string) => Policy; fold: SessionFolder; renderCached?:(text:string) => string; now?:() => number; onFolded?:(host:HostSession) => Promise<void> }) {
  const task = defineTask<{ key: string; host: HostSession }, { phase: "fold" }, null>({
    name: "token-economizer.fold", version: 1, initial: () => ({ phase: "fold" }),
    phases: { async fold(current,runtime,context) {
      const { key,host } = current.input, claim = String(runtime.taskId);
      await runtime.commit(async tx => {
        const sessions = await tx.doc(SessionsDoc), knowledge = await tx.doc(KnowledgeDoc,scopeKey(host.scope),host.scope), row = sessions.sessions[key];
        if (!row || row.folded || !observing(options.policy(key))) return;
        if (row.claim === claim) return;
        if (knowledge.foldClaim !== null || knowledge.foldQueue[0] !== key) return;
        const admitted = claimFold(row,claim,row.cutoff ?? "",runtime.now());
        if (admitted.kind === "admitted") { sessions.sessions[key] = admitted.session; knowledge.foldClaim = claim; sessions.claims[key] = runtime.taskId; }
      },context);
      const session = (await runtime.snapshot(SessionsDoc,context))!.sessions[key];
      if (!session || session.folded || !observing(options.policy(key))) {
        await runtime.commit(async tx => {
          const knowledge = await tx.doc(KnowledgeDoc,scopeKey(host.scope),host.scope), state = await tx.doc(SessionsDoc), row = state.sessions[key];
          if (row && !row.folded && row.claim === claim) state.sessions[key] = deferFold(row,claim,runtime.now());
          if (knowledge.foldClaim === claim) knowledge.foldClaim = null;
          knowledge.foldQueue = knowledge.foldQueue.filter(item => item !== key);
          return {status:"terminal",outcome:{status:"completed",result:null}};
        },context); return;
      }
      if (session.claim !== claim) {
        await runtime.sleepUntil(runtime.now()+100,{phase:"fold"},context); return;
      }
      const trajectory = await options.domain.trajectory(host,session.cutoff || null);
      if (trajectory.kind === "later") {
        await runtime.commit(async tx => {
          const sessions = await tx.doc(SessionsDoc), knowledge = await tx.doc(KnowledgeDoc,scopeKey(host.scope),host.scope);
          sessions.sessions[key] = deferFold(sessions.sessions[key],claim,runtime.now()); knowledge.foldClaim = null; knowledge.foldQueue = knowledge.foldQueue.filter(item => item !== key);
          return { status:"terminal",outcome:{status:"completed",result:null} };
        },context); return;
      }
      let result: FoldResult | null = null;
      if (trajectory.kind === "ready") {
        await runtime.commit(async tx => { (await tx.doc(SessionsDoc)).sessions[key].cutoff = trajectory.cutoff; },context);
        const knowledge = await runtime.snapshot(KnowledgeDoc,scopeKey(host.scope),context);
        try { result = await options.fold({ session,host,trajectory,knowledge:knowledge!,policy:options.policy(key),signal:runtime.signal }); }
        catch (error) {
          runtime.signal.throwIfAborted();
          const message = Error.isError(error) ? error.message : String(error);
          runtime.report(error);
          await runtime.commit(async tx => {
            const sessions = await tx.doc(SessionsDoc), knowledge = await tx.doc(KnowledgeDoc,scopeKey(host.scope),host.scope);
            const row = deferFold(sessions.sessions[key],claim,runtime.now()); row.foldError = message; sessions.sessions[key] = row;
            knowledge.foldClaim = null; knowledge.foldQueue = knowledge.foldQueue.filter(item => item !== key);
            return {status:"terminal",outcome:{status:"failed",error:{message}}};
          },context); return;
        }
      }
      await runtime.commit(async tx => {
        const sessions = await tx.doc(SessionsDoc), knowledge = await tx.doc(KnowledgeDoc,scopeKey(host.scope),host.scope), row = sessions.sessions[key];
        if (!observing(options.policy(key))) {
          sessions.sessions[key] = deferFold(row,claim,runtime.now()); knowledge.foldClaim = null;
        } else {
          if (result) { knowledge.tools = result.tools; knowledge.render = result.render; knowledge.injectedIds = result.injectedIds; knowledge.environment = result.environment; knowledge.distiller = result.distiller;if (result.novelty) knowledge.novelty = result.novelty;if (result.renders) knowledge.renders = result.renders; }
          sessions.sessions[key] = finishFold(row,claim,runtime.now(),trajectory.kind === "unreadable" || trajectory.kind === "absent" ? trajectory.reason : null);
          const observations = await tx.doc(ObservationsDoc,key,null);
          observations.observations = observations.observations.slice(-256);observations.ids = observations.ids.slice(-256);
          knowledge.foldOrder.push(key); knowledge.foldClaim = null;
        }
        knowledge.foldQueue = knowledge.foldQueue.filter(item => item !== key);
        return { status:"terminal",outcome:{status:"completed",result:null} };
      },context);
      if (observing(options.policy(key))) await options.onFolded?.(host);
    } },
    async abort(current,runtime,context) {
      await runtime.commit(async tx => {
        const sessions = await tx.doc(SessionsDoc), row = sessions.sessions[current.input.key];
        const knowledge = await tx.doc(KnowledgeDoc,scopeKey(current.input.host.scope),current.input.host.scope);
        if (row?.claim === String(runtime.taskId)) sessions.sessions[current.input.key] = deferFold(row,String(runtime.taskId),runtime.now());
        if (knowledge.foldClaim === String(runtime.taskId)) knowledge.foldClaim = null;
        knowledge.foldQueue = knowledge.foldQueue.filter(item => item !== current.input.key);
        return {status:"terminal",outcome:{status:"aborted",result:null,reason:"Fold cancelled"}};
      },context);
    },
  });
  async function enqueue(key: string,host: HostSession) {
    await options.harness().commit(async tx => {
      const row = (await tx.doc(SessionsDoc)).sessions[key], knowledge = await tx.doc(KnowledgeDoc,scopeKey(host.scope),host.scope);
      if (!row || row.folded || row.claim || knowledge.foldQueue.includes(key) || !observing(options.policy(key))) return;
      knowledge.foldQueue.push(key);
      await tx.createTask(task,{key,host},{ownership:{kind:"conversation"},conversationId:options.backgroundOwner?.() ?? host.conversationId,background:true});
    },BACKGROUND_CONTEXT);
  }
  return {
    extension: defineExtension({name:"token-economizer.sessions",tasks:[task]}),
    async sessionStarted(host: HostSession,start: SessionStart & { carriedIds: string[] }) {
      if (host.delegated) return null;
      const key = sessionKey(host.scope,host.id), now = (options.now ?? Date.now)();
      const prepared = await options.harness().commit(async tx => {
        const state = await tx.doc(SessionsDoc), knowledge = await tx.doc(KnowledgeDoc,scopeKey(host.scope),host.scope), policy = options.policy(key);
        const mode = policy.enabled ? policy.mode : "off";
        const cached = knowledge.renders ? [policy.microSkills === "envfacts" || policy.microSkills === "both" ? knowledge.renders.environment : "",policy.microSkills === "distiller" || policy.microSkills === "both" ? knowledge.renders.distilled : ""].filter(Boolean).join("\n") : knowledge.render;
        const row = prepareSession(state.sessions[key] ?? null,{id:host.id,scope:host.scope,conversation:String(host.conversationId),group:host.classificationGroup,now,
          ...start,cachedSection:policy.microSkills === "off" ? "" : options.renderCached ? options.renderCached(cached) : cached,cachedIds:policy.microSkills === "distiller" ? [] : knowledge.renders?.ids ?? knowledge.injectedIds,publishedMask:start.runningMask ?? knowledge.tools.applied,mode});
        state.sessions[key] = row; state.hosts[key] = structuredClone(host); return structuredClone(row);
      },BACKGROUND_CONTEXT);
      // The fresh snapshot is frozen before recovery can change the repository render.
      await options.harness().commit(async tx => {
        const state = await tx.doc(SessionsDoc);
        for (const [sessionId,taskId] of Object.entries(state.claims)) {
          const row = state.sessions[sessionId];if (!row) throw new Error("Missing claimed learning session");if (!row.claim) {delete state.claims[sessionId];continue;}
          const owner = await tx.task(taskId);if (!owner) throw new Error("Missing durable fold claim owner");
          if (owner.state.status !== "terminal") continue;
          const knowledge = await tx.doc(KnowledgeDoc,scopeKey(row.scope),row.scope), released = deferFold(row,row.claim,(options.now ?? Date.now)());
          if (knowledge.foldClaim !== row.claim) throw new Error("Repository fold claim ownership mismatch");
          released.foldError = owner.state.outcome.status === "failed" || owner.state.outcome.status === "faulted" ? owner.state.outcome.error.message : "Fold ended without its marker";
          state.sessions[sessionId] = released;knowledge.foldClaim = null;knowledge.foldQueue = knowledge.foldQueue.filter(item => item !== sessionId);delete state.claims[sessionId];
        }
      },BACKGROUND_CONTEXT);
      const state = await options.harness().snapshot(SessionsDoc,BACKGROUND_CONTEXT);
      for (const row of recoverableSessions(Object.values(state!.sessions),host.scope,host.id,now)) {
        const source = state!.hosts[sessionKey(row.scope,row.id)];
        if (!source) throw new Error("Missing pinned learning session host");
        await enqueue(sessionKey(row.scope,row.id),source);
      }
      return prepared;
    },
    async sessionEnded(host: HostSession) {
      if (host.delegated) return;
      const key = sessionKey(host.scope,host.id);
      const prior = (await options.harness().snapshot(SessionsDoc,BACKGROUND_CONTEXT))?.sessions[key];
      if (!prior) {
        const source = await options.domain.trajectory(host,null);if (source.kind === "absent") return;
        await options.harness().commit(async tx => {
          const state = await tx.doc(SessionsDoc);if (state.sessions[key]) return;
          state.sessions[key] = prepareSession(null,{id:host.id,scope:host.scope,conversation:String(host.conversationId),group:host.classificationGroup,now:(options.now ?? Date.now)(),event:"resume",visibleHistory:true,carriedSections:{},carriedIds:[],cachedSection:"",cachedIds:[],publishedMask:[],mode:"off"});state.hosts[key] = host;
        },BACKGROUND_CONTEXT);
      }
      const exists = await options.harness().commit(async tx => {
        const state = await tx.doc(SessionsDoc), row = state.sessions[key];
        if (!row) return false;
        state.sessions[key] = endSession(row,(options.now ?? Date.now)()); return true;
      },BACKGROUND_CONTEXT);
      if (exists) await enqueue(key,host);
    },
    async transcriptChanged(host: HostSession,at = (options.now ?? Date.now)()) {
      const key = sessionKey(host.scope,host.id);
      await options.harness().commit(async tx => {
        const state = await tx.doc(SessionsDoc), row = state.sessions[key];
        if (row) {const next = transcriptChanged(row,Math.max(row.transcriptActivity,at));next.recordActivity = (options.now ?? Date.now)();state.sessions[key] = next;}
      },BACKGROUND_CONTEXT);
    },
    async observations(key: string) { return (await options.harness().snapshot(ObservationsDoc,key,BACKGROUND_CONTEXT))?.observations ?? []; },
  };
}
