// SPDX-License-Identifier: Apache-2.0
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { inferenceAllowed, modelFor } from "../core/config.ts";
import { completeProposal, renderDistiller, updateDistiller } from "../core/microskills/distiller.ts";
import { genericDigest } from "../core/microskills/digest.ts";
import { renderEnvironment, updateEnvironment } from "../core/microskills/envfacts.ts";
import { observeEnvironment } from "../core/microskills/observe.ts";
import { foldEvidence } from "../core/toolprune/evidence.ts";
import { noveltyGate, auditSelected } from "../core/savers.ts";
import { JobsDoc, type Knowledge } from "./documents.ts";
import type { HostDomain } from "./domain.ts";
import type { SessionFolder } from "./lifecycle.ts";
import type { createInferenceQueue } from "./sidecall.ts";
export function createMechanismFolder(options: {harness:() => Harness;domain:HostDomain;queue:ReturnType<typeof createInferenceQueue>}): SessionFolder {
  return async ({knowledge,policy,session,host,trajectory,signal}) => {
    let novelty = structuredClone(knowledge.novelty);
    let environment = knowledge.environment, distiller = knowledge.distiller, render = knowledge.render, injectedIds = knowledge.injectedIds;
    const observations = trajectory.observations, complete = observations.every(call => call.coverage === "complete");
    const envSelected = policy.microSkills === "envfacts" || policy.microSkills === "both", paidSelected = policy.microSkills === "distiller" || policy.microSkills === "both";
    if (envSelected) environment = updateEnvironment(environment,complete ? observeEnvironment(observations,host.repositoryRoot) : null,session.injectedIds);
    const renders:NonNullable<Knowledge["renders"]> = knowledge.renders ? structuredClone(knowledge.renders) : {environment:"",distilled:"",ids:[]};
    const free = renderEnvironment(environment,policy.maxFacts,policy.maxFactTokens);
    if (paidSelected) {
      const model = modelFor(policy,"proposer"), account = model ? JSON.stringify([host.scope.host,model.provider]) : "";
      const paused = (await options.harness().snapshot(JobsDoc,BACKGROUND_CONTEXT))?.paused.includes(account) ?? false;
      const tick = updateDistiller(distiller,complete ? genericDigest(observations,session.id,[host.repositoryRoot],"") : null,observations.filter(call => call.semantic === "shell").map(call => ({command:call.command,output:call.output})),policy.proposeEvery,inferenceAllowed(policy) && model !== null && !paused,host.scope.repository,envSelected ? free.claims : []);
      distiller = tick.state;
      if (tick.prompt && model && (!policy.savers.novelty || distiller.now-novelty.lastSkip >= policy.proposeEvery)) {
        const signals = [host.environmentRevision,JSON.stringify(distiller.window.map(({iid:_iid,...digest}) => digest)),JSON.stringify(distiller.facts.map(fact => fact.spec)),JSON.stringify(distiller.extractors),JSON.stringify(distiller.raw_window)];
        const evaluated = policy.savers.novelty ? noveltyGate(novelty,signals,complete,distiller.now) : null;
        const skip = evaluated?.skip === true, audit = skip && policy.mode === "observe" && auditSelected(host.id,String(distiller.now),policy.savers.auditPercent);
        if (skip) novelty = {...novelty,...evaluated!.state};
        const key = JSON.stringify([host.scope.host,host.scope.repository,host.scope.environment,host.id,"proposer",distiller.now]);
        const admission = !skip || audit ? await options.queue.enqueue(host.conversationId,{id:key,purpose:audit ? "audit" : "proposer",auditFor:"proposer",model,prompt:tick.prompt,maxOutputTokens:policy.budget.maxOutputTokens,deadlineMs:policy.budget.deadlineMs},{sessionKey:JSON.stringify([JSON.stringify([host.scope.host,host.scope.repository,host.scope.environment]),host.id]),account,runId:null,revision:String(policy.version),digest:key,estimatedMaximumCost:null}) : {job:null};
        // No budget or paused runner makes no attempt and must not consume the cadence.
        if (admission.job?.taskId) {
          await options.harness().waitForTask(admission.job.taskId,BACKGROUND_CONTEXT);signal.throwIfAborted();
          const job = (await options.harness().snapshot(JobsDoc,BACKGROUND_CONTEXT))!.jobs[key];
          if (job.status !== "cancelled") {
            if (audit) {novelty.audits++;const preview = completeProposal(distiller,job.status === "complete" ? job.result!.text : null).state;novelty.missed += preview.facts.filter(fact => !distiller.facts.some(prior => prior.spec.id === fact.spec.id)).length;}
            else {if (evaluated) novelty = {...novelty,...evaluated.state};distiller = completeProposal(distiller,job.status === "complete" ? job.result!.text : null).state;}
          }
        }
      }
    }
    if (envSelected) {renders.environment = free.text;renders.ids = free.ids;}
    if (paidSelected) renders.distilled = renderDistiller(distiller,host.scope.repository);
    if (policy.microSkills !== "off") {
      render = [envSelected ? free.text : "",paidSelected ? renderDistiller(distiller,host.scope.repository) : ""].filter(Boolean).join("\n");
      injectedIds = envSelected ? free.ids : [];
    }
    const catalogue = await options.domain.catalogue(host);
    const tools = catalogue.complete ? foldEvidence(knowledge.tools,observations.filter(call => call.semantic !== "wrapper").map(call => call.tool),catalogue.tools,trajectory.prompts,policy,Date.now(),session.frozenMask.length === 0) : knowledge.tools;
    return {environment,distiller,render,injectedIds,tools,novelty,renders};
  };
}
