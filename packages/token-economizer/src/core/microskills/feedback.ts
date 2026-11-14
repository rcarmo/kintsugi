// SPDX-License-Identifier: Apache-2.0
// Kintsugi safety controls for the Modified TypeScript port of Microsoft TokenEconomizer.
// Upstream baseline: 81e32e56bb3c4c1b4c9756b429be91e3960116ca; see ../../../LICENSE.
import { fingerprint } from "../identity.ts";
export type FactSource = "environment" | "distilled";
export type FactDecision = "approved" | "rejected" | "stale";
export type FactReview = {decision:FactDecision;at:number;note:string;claim:string};
export type FactReviews = Record<string,FactReview>;
export const factKey = (source:FactSource,id:string) => `${source}:${id}`;
/** Approval is bound to the exact text, not a mutable detector or a reused ID. Rejection stays sticky. */
export function factPermitted(source:FactSource,id:string,text:string,reviews:FactReviews):boolean {
  const review = reviews[factKey(source,id)];
  if (review && review.decision !== "approved") return false;
  return source === "environment" || Boolean(review?.claim === fingerprint(text));
}
