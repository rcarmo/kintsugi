// SPDX-License-Identifier: Apache-2.0
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { fingerprint } from "../core/identity.ts";
import { inferenceAllowed, modelFor } from "../core/config.ts";
import { buildProposerPrompt, completeProposal, renderDistiller, updateDistiller } from "../core/microskills/distiller.ts";
import { detectorVerdict } from "../core/microskills/detectors.ts";
import { creditLearning } from "../core/microskills/lifecycle.ts";
import { genericDigest } from "../core/microskills/digest.ts";
import { renderEnvironment, updateEnvironment } from "../core/microskills/envfacts.ts";
import { observeEnvironment } from "../core/microskills/observe.ts";
import { foldEvidence } from "../core/toolprune/evidence.ts";
import { noveltyGate, auditSelected } from "../core/savers.ts";
import { JobsDoc, type Knowledge } from "./documents.ts";
import type { HostDomain } from "./domain.ts";
import type { SessionFolder } from "./lifecycle.ts";
import type { createInferenceQueue } from "./sidecall.ts";
export function createMechanismFolder(options: {harness:() => Harness;domain:HostDomain;queue:ReturnType<typeof createInferenceQueue>;now?:() => number}): SessionFolder {
  return async ({knowledge,policy,session,host,trajectory,signal,incremental}) => {
    const learning = session.learning ? structuredClone(session.learning) : undefined;
    const hasEvidence = trajectory.observations.length > 0;
    if (learning && hasEvidence) learning.ticks++;
    const now = (options.now ?? Date.now)();
    // Live proposals need three evidence-bearing checkpoints; all attempts share a ten-minute cooldown.
    // Session end retains the original proposer cadence when there has been no live attempt.
    // Existing budget, auth pause and novelty gates still apply. Basic never calls a model.
    const proposalDue = !learning || !incremental && learning.lastProposalAt === null || learning.ticks >= Math.max(3,policy.proposeEvery) && (learning.lastProposalAt === null || now-learning.lastProposalAt >= 600_000);
    let novelty = structuredClone(knowledge.novelty);
    let environment = knowledge.environment, distiller = knowledge.distiller, render = knowledge.render, injectedIds = knowledge.injectedIds;
    const observations = trajectory.observations, complete = observations.every(call => call.coverage === "complete");
    const envSelected = policy.microSkills === "envfacts" || policy.microSkills === "both", paidSelected = policy.microSkills === "distiller" || policy.microSkills === "both";
    if (envSelected && (!learning || hasEvidence)) environment = updateEnvironment(environment,complete ? observeEnvironment(observations,host.repositoryRoot) : null,session.injectedIds,learning?.credits);
    const renders:NonNullable<Knowledge["renders"]> = knowledge.renders ? structuredClone(knowledge.renders) : {environment:"",distilled:"",ids:[]};
    const free = renderEnvironment(environment,policy.maxFacts,policy.maxFactTokens);
    const distillObservations = learning ? observations.slice(-64).map(call => ({...call,command:call.command.slice(0,2048),output:call.output.slice(-1024)})) : observations;
    if (paidSelected && (!learning || hasEvidence || !incremental)) {
      const model = modelFor(policy,"proposer"), account = model ? JSON.stringify([host.scope.host,model.provider]) : "";
      const paused = (await options.harness().snapshot(JobsDoc,BACKGROUND_CONTEXT))?.paused.includes(account) ?? false;
      const tick = learning && !hasEvidence ? {state:distiller,prompt:proposalDue && inferenceAllowed(policy) && model && !paused && distiller.window.length && distiller.now-distiller.last_propose >= policy.proposeEvery ? buildProposerPrompt(host.scope.repository,distiller,[],envSelected ? free.claims : []) : null} : updateDistiller(distiller,complete ? genericDigest(distillObservations,session.id,[host.repositoryRoot],"") : null,distillObservations.filter(call => call.semantic === "shell").map(call => ({command:call.command,output:call.output})),policy.proposeEvery,inferenceAllowed(policy) && model !== null && !paused && proposalDue,host.scope.repository,envSelected ? free.claims : [],learning?.credits);
      distiller = tick.state;
      if (tick.prompt && model && (!policy.savers.novelty || distiller.now-novelty.lastSkip >= policy.proposeEvery)) {
        const signals = [host.environmentRevision,JSON.stringify(distiller.window.map(({iid:_iid,...digest}) => digest)),JSON.stringify(distiller.facts.map(fact => fact.spec)),JSON.stringify(distiller.extractors),JSON.stringify(distiller.raw_window)];
        const proposalDigest = fingerprint(JSON.stringify([host.environmentRevision,
          distiller.window.map(({iid:_iid,n_cmds:_count,_cmd_blob:_commands,_out_blob:_output,...digest}) => digest),
          distiller.facts.map(fact => fact.spec),distiller.extractors,
          [...new Set(distiller.raw_window.flat().map(call => JSON.stringify(call)))].sort()]));
        const unchanged = learning?.lastProposalDigest === proposalDigest;
        const evaluated = policy.savers.novelty ? noveltyGate(novelty,signals,complete,distiller.now) : null;
        const skip = evaluated?.skip === true, audit = skip && policy.mode === "observe" && auditSelected(host.id,String(distiller.now),policy.savers.auditPercent);
        if (skip) novelty = {...novelty,...evaluated!.state};
        const key = JSON.stringify([host.scope.host,host.scope.repository,host.scope.environment,host.id,"proposer",distiller.now]);
        const admission = !unchanged && (!skip || audit) ? await options.queue.enqueue(host.conversationId,{id:key,purpose:audit ? "audit" : "proposer",auditFor:"proposer",model,prompt:tick.prompt,maxOutputTokens:policy.budget.maxOutputTokens,deadlineMs:policy.budget.deadlineMs},{sessionKey:JSON.stringify([JSON.stringify([host.scope.host,host.scope.repository,host.scope.environment]),host.id]),account,runId:null,revision:String(policy.version),digest:key,estimatedMaximumCost:null}) : {job:null};
        // No budget or paused runner makes no attempt and must not consume the cadence.
        if (admission.job?.taskId) {
          if (learning) {learning.lastProposalAt = now;learning.lastProposalDigest = proposalDigest;learning.ticks = 0;}
          await options.harness().waitForTask(admission.job.taskId,BACKGROUND_CONTEXT);signal.throwIfAborted();
          const job = (await options.harness().snapshot(JobsDoc,BACKGROUND_CONTEXT))!.jobs[key];
          if (job.status !== "cancelled") {
            if (audit) {novelty.audits++;const preview = completeProposal(distiller,job.status === "complete" ? job.result!.text : null).state;novelty.missed += preview.facts.filter(fact => !distiller.facts.some(prior => prior.spec.id === fact.spec.id)).length;}
            else {if (evaluated) novelty = {...novelty,...evaluated.state};distiller = completeProposal(distiller,job.status === "complete" ? job.result!.text : null).state;
              // Grounding may have credited a newly admitted fact using this very session.
              const digest = distiller.window.find(row => row.iid === session.id);
              if (learning && digest) for (const fact of distiller.facts) {
                const verdict = detectorVerdict(fact.spec.detector,digest);
                creditLearning(learning.credits,`fact:${fact.spec.id}`,verdict.verdict,verdict.fired,verdict.exercised);
              }
            }
          }
        }
      }
    }
    if (envSelected && (!learning || hasEvidence)) {renders.environment = free.text;renders.ids = free.ids;}
    if (paidSelected) renders.distilled = renderDistiller(distiller,host.scope.repository);
    if (policy.microSkills !== "off" && (!learning || hasEvidence || distiller !== knowledge.distiller)) {
      render = [envSelected ? free.text : "",paidSelected ? renderDistiller(distiller,host.scope.repository) : ""].filter(Boolean).join("\n");
      injectedIds = envSelected ? free.ids : [];
    }
    let tools = structuredClone(knowledge.tools);
    const catalogue = await options.domain.catalogue(host);
    // Final fold reconciles the complete session; checkpoints contribute only new prompts.
    const source = !incremental && session.learning?.cutoff ? await options.domain.trajectory(host,trajectory.cutoff) : trajectory;
    if (source.kind !== "ready") throw new Error("Complete tool-evidence trajectory is not ready");
    const prompts = learning && !incremental && source.prompts !== null ? Math.max(0,source.prompts-(learning.toolPrompts ?? 0)) : source.prompts;
    const countSession = !learning?.toolCounted;
    if (catalogue.complete) {
      tools = foldEvidence(tools,source.observations.filter(call => call.semantic !== "wrapper").map(call => call.tool),catalogue.tools,prompts,policy,now,session.frozenMask.length === 0,countSession);
      if (learning && policy.pruning !== "off" && policy.enabled && policy.mode !== "off" && (prompts !== 0 || !countSession)) {
        learning.toolCounted = true;learning.toolPrompts = (learning.toolPrompts ?? 0)+(prompts ?? 0);
      }
    }
    if (learning) {learning.cutoff = trajectory.cutoff;learning.processed = learning.requested;}
    return {environment,distiller,render,injectedIds,tools,novelty,renders,learning};
  };
}
