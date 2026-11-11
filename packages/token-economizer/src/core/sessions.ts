// SPDX-License-Identifier: Apache-2.0
import type { Mode, Scope } from "./types.ts";
import { scopeKey } from "./types.ts";
import { compareCodePoints } from "./ordering.ts";
export const contextSection = "token-economizer";
export type LearningSession = {
  id: string; scope: Scope; conversation: string; group: string; started: number; ended: number | null;
  transcriptActivity: number; recordActivity: number; folded: boolean; foldedAt: number | null;
  cutoff: string | null; claim: string | null; foldError: string | null;
  section: string; injectedIds: string[]; frozenMask: string[]; appendedAfterFold: boolean;
};
function copySession(prior: LearningSession): LearningSession { return { ...prior, scope: { ...prior.scope }, injectedIds: [...prior.injectedIds], frozenMask: [...prior.frozenMask] }; }
export type SessionPreparation = {
  id: string; scope: Scope; conversation: string; group: string; now: number;
  event: "startup" | "new" | "resume" | "fork" | "reload"; visibleHistory: boolean;
  carriedSections: Record<string, string>; carriedIds: string[];
  cachedSection: string; cachedIds: string[]; publishedMask: string[]; mode: Mode;
};
export function sessionKey(scope: Scope, id: string): string { return JSON.stringify([scopeKey(scope), id]); }
export function prepareSession(prior: LearningSession | null, input: SessionPreparation): LearningSession {
  if (prior && (scopeKey(prior.scope) !== scopeKey(input.scope) || prior.id !== input.id)) throw new Error("Learning session identity changed");
  const resume = input.visibleHistory || !["startup", "new"].includes(input.event);
  if (prior) return { ...copySession(prior), ended: null, recordActivity: input.now, frozenMask: [...input.publishedMask] };
  const freshInjection = !resume && input.mode === "active";
  return { id: input.id, scope: structuredClone(input.scope), conversation: input.conversation, group: input.group,
    started: input.now, ended: null, transcriptActivity: input.now, recordActivity: input.now,
    folded: false, foldedAt: null, cutoff: null, claim: null, foldError: null,
    section: freshInjection ? input.cachedSection : resume ? input.carriedSections[contextSection] ?? "" : "",
    injectedIds: freshInjection ? [...input.cachedIds] : resume ? [...input.carriedIds] : [],
    frozenMask: [...input.publishedMask], appendedAfterFold: false };
}
/** An ordinary unrelated patch preserves the section; compaction replaces the complete map. */
export function replaySections(prior: LearningSession, sections: Record<string, string>, compacted: boolean, now: number): LearningSession {
  const next = copySession(prior);
  if (compacted || Object.hasOwn(sections, contextSection)) {
    next.section = sections[contextSection] ?? "";
    if (next.section !== prior.section || !next.section) next.injectedIds = [];
  }
  next.recordActivity = now;
  return next;
}
export function transcriptChanged(prior: LearningSession, now: number): LearningSession {
  return { ...copySession(prior), transcriptActivity: now, recordActivity: now, appendedAfterFold: prior.appendedAfterFold || prior.folded };
}
export function endSession(prior: LearningSession, now: number): LearningSession {
  return { ...copySession(prior), ended: prior.ended ?? now, recordActivity: now };
}
export function recoverableSessions(sessions: LearningSession[], scope: Scope, currentId: string, now: number): LearningSession[] {
  return sessions.filter(row => scopeKey(row.scope) === scopeKey(scope) && row.id !== currentId && !row.folded
    && (row.ended !== null || now-row.transcriptActivity >= 600_000))
    .sort((a,b) => a.started-b.started || compareCodePoints(a.id,b.id));
}
export type FoldAdmission = { kind: "admitted"; session: LearningSession } | { kind: "folded" | "busy" };
export function claimFold(prior: LearningSession, claim: string, cutoff: string, now: number): FoldAdmission {
  if (prior.folded) return { kind: "folded" };
  if (prior.claim !== null) return { kind: "busy" };
  return { kind: "admitted", session: { ...copySession(prior), claim, cutoff, recordActivity: now } };
}
export function finishFold(prior: LearningSession, claim: string, now: number, terminalError: string | null = null): LearningSession {
  if (prior.claim !== claim || prior.folded) throw new Error("Fold claim is not current");
  return { ...copySession(prior), claim: null, folded: true, foldedAt: now, foldError: terminalError, recordActivity: now };
}
export function deferFold(prior: LearningSession, claim: string, now: number): LearningSession {
  if (prior.claim !== claim || prior.folded) throw new Error("Fold claim is not current");
  return { ...copySession(prior), claim: null, cutoff: null, recordActivity: now };
}
export function repositoryActivity(sessions: LearningSession[], scope: Scope): number {
  return Math.max(0, ...sessions.filter(row => row.scope.host === scope.host && row.scope.repository === scope.repository).flatMap(row => [row.transcriptActivity,row.recordActivity]));
}
