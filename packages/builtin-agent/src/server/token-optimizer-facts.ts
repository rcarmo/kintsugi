import {escapeHtml as h} from "@kintsugi/shared";
import {fingerprint,type FactSummary} from "@kintsugi/token-economizer/core";
import {buttonHtml} from "@kintsugi/design-system/button";
import {disclosureHtml} from "@kintsugi/design-system/disclosure";
import type {AgentRenderContext} from "@kintsugi/agent/server/render-context";

export const factReviewTarget = (key:string) => `optimizer_fact_${key}`;
export const factReviewKey = (ctx:AgentRenderContext,operation:string,fact:FactSummary) => fingerprint(JSON.stringify([ctx.workspaceId,ctx.agentId,ctx.commentary ?? false,operation,fact.source,fact.id]));
const statuses = {"in-use":"Eligible for the next request when On",quiet:"More evidence needed",checking:"Still gathering evidence","needs-review":"Held back — see evidence",rejected:"Rejected",stale:"Marked stale",retired:"Retired"} satisfies Record<FactSummary["status"],string>;
/** Server-rendered review; the same exact-claim and scope checks serve Settings and the transcript. */
export function inlineFactReview(ctx:Pick<AgentRenderContext,"workspaceId"|"agentId"|"readOnly">,key:string,fact:FactSummary,message = "") {
  const field = (name:string,value:string) => `<input type="hidden" name="${name}" value="${h(value)}">`;
  const evidence = disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:"Evidence"}},bodyHtml:`<p>${fact.confirmations} confirmations · ${fact.contradictions} contradictions</p>${fact.blockingReasons?.length ? `<ul>${fact.blockingReasons.map(line=>`<li>${h(line)}</li>`).join("")}</ul>` : ""}<ul>${fact.evidence.map(line=>`<li>${h(line)}</li>`).join("")}</ul>`});
  const controls = ctx.readOnly ? "" : `<form method="post" action="/settings/token-optimizer/fact-review" data-turbo="true" class="form-stack">${field("workspaceId",ctx.workspaceId)}${field("agentId",ctx.agentId)}${field("factId",fact.id)}${field("factSource",fact.source)}${field("claimRevision",fact.claimRevision)}${field("reviewKey",key)}<label>Optional feedback<input class="text-field" name="note" maxlength="500" value="${h(fact.review?.note ?? "")}"></label><div class="token-optimizer-fact__actions">${([["approved","Confirm"],["rejected","Wrong"],["stale","Stale"]] as const).map(([decision,label])=>buttonHtml({type:"submit",variant:"secondary",content:{kind:"caption",caption:label},attributesHtml:`name="decision" value="${decision}"`})).join("")}</div></form>`;
  return `<div id="${factReviewTarget(key)}" class="token-optimizer-fact"><p>${h(fact.claim)}</p><p class="token-optimizer-op__muted">${fact.source === "distilled" ? "Model-derived fact" : "Recorded observation"} · ${h(statuses[fact.status])}</p>${message ? `<p role="status">${h(message)}</p>` : ""}${evidence}${controls}</div>`;
}
