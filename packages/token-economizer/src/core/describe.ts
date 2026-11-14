// SPDX-License-Identifier: Apache-2.0
import { environmentClaim, type EnvironmentState } from "./microskills/envfacts.ts";
import type { Distiller } from "./microskills/distiller.ts";
import { injectable, type Lifecycle } from "./microskills/lifecycle.ts";
import { factKey, factPermitted, type FactSource, type FactReview, type FactReviews } from "./microskills/feedback.ts";
import { fingerprint } from "./identity.ts";
export type FactSummary = {id:string;claim:string;source:FactSource;status:"in-use"|"quiet"|"checking"|"needs-review"|"rejected"|"stale"|"retired";confirmations:number;contradictions:number;evidence:string[];review:FactReview|null;claimRevision:string};
export type KnowledgeSummary = {facts:FactSummary[];retired:number};
function status(life:Lifecycle,source:FactSource,id:string,claim:string,reviews:FactReviews):FactSummary["status"] {
  const review = reviews[factKey(source,id)];
  if (review?.decision === "rejected" || review?.decision === "stale") return review.decision;
  if (life.state === "RETIRED") return "retired";
  if (!factPermitted(source,id,claim,reviews)) return "needs-review";
  return injectable(life) ? "in-use" : life.state === "ACTIVE" ? "quiet" : "checking";
}
const order = {"needs-review":0,"in-use":1,checking:2,quiet:3,rejected:4,stale:5,retired:6};
/** Read-only summaries include suppressed facts so feedback can be inspected and corrected. */
export function describeKnowledge(environment:EnvironmentState,distiller:Distiller,reviews:FactReviews = {}):KnowledgeSummary {
  const facts:FactSummary[] = [];
  function add(id:string,claim:string,source:FactSource,life:Lifecycle,evidence:string[]) {
    if (!claim) return;
    facts.push({id,claim,source,status:status(life,source,id,claim,reviews),confirmations:life.confirms.length,contradictions:life.contradicts.length,evidence,review:reviews[factKey(source,id)] ?? null,claimRevision:fingerprint(claim)});
  }
  for (const fact of environment.facts) add(fact.id,environmentClaim(fact),"environment",fact.life,[`Detector: ${fact.family}`,`Observed parameters: ${JSON.stringify(fact.params).slice(0,2000)}`]);
  for (const fact of distiller.facts) {
    const evidence = (fact.spec.cite ?? []).slice(0,8).map(id => {
      const digest = distiller.window.find(row => row.iid === id);
      return digest ? `Session ${id}: ${digest.check_commands.join("; ") || digest.cmd_templates.join("; ")}` : `Session ${id}: digest no longer in the recent window`;
    });
    add(fact.spec.id,fact.spec.injection ?? fact.spec.claim ?? fact.spec.id,"distilled",fact.life,[...evidence,`Detector: ${JSON.stringify(fact.spec.detector)}`]);
  }
  return {facts:facts.sort((a,b) => order[a.status]-order[b.status] || b.confirmations-a.confirmations),retired:facts.filter(fact => fact.status === "retired").length};
}
