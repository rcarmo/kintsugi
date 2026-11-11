// SPDX-License-Identifier: Apache-2.0
import { environmentClaim, type EnvironmentState } from "./microskills/envfacts.ts";
import type { Distiller } from "./microskills/distiller.ts";
import { injectable, type Lifecycle } from "./microskills/lifecycle.ts";
/** `in-use` facts reach fresh sessions; `quiet` facts are confirmed but rarely relevant; `checking` facts await confirmation. */
export type FactSummary = { id: string; claim: string; source: "environment" | "distilled"; status: "in-use" | "quiet" | "checking"; confirmations: number };
export type KnowledgeSummary = { facts: FactSummary[]; retired: number };
function status(life: Lifecycle): FactSummary["status"] { return injectable(life) ? "in-use" : life.state === "ACTIVE" ? "quiet" : "checking"; }
const order = { "in-use": 0, quiet: 1, checking: 2 };
/** Read-only presentation of learned facts; it advances no lifecycle clocks. */
export function describeKnowledge(environment: EnvironmentState, distiller: Distiller): KnowledgeSummary {
  const facts: FactSummary[] = [];
  let retired = 0;
  for (const fact of environment.facts) {
    if (fact.life.state === "RETIRED") {retired++;continue;}
    const claim = environmentClaim(fact);
    if (claim) facts.push({ id: fact.id, claim, source: "environment", status: status(fact.life), confirmations: fact.life.confirms.length });
  }
  for (const fact of distiller.facts) {
    if (fact.life.state === "RETIRED") {retired++;continue;}
    facts.push({ id: fact.spec.id, claim: fact.spec.claim ?? fact.spec.injection ?? fact.spec.id, source: "distilled", status: status(fact.life), confirmations: fact.life.confirms.length });
  }
  return { facts: facts.sort((a, b) => order[a.status] - order[b.status] || b.confirmations - a.confirmations), retired };
}
