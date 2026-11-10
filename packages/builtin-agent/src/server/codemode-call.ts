import type { JsonValue } from "@earendil-works/chord/json";
import { defineEntry, type JsonObject } from "@earendil-works/pi-durable";

export type CallStart = { phase: "start"; name: string; arguments?: JsonValue; issuedAt?: number };
export type CallEnd = { phase: "end"; isError: boolean; cancelled: boolean; durationMs?: number; output?: string; error?: string; details?: JsonObject };

/**
 * One call a code mode script made, recorded when it starts and when it ends. A bookkeeping entry
 * without model payload, so it follows branches and survives the script being stopped, unlike the
 * script's own result, which lists no results and, for a stopped script, no calls. `callId` is the
 * code mode call's, `key` the nested call's.
 */
export type CodemodeCallRecord = { callId: string; key: string } & (CallStart | CallEnd);
export const codemodeCallEntry = defineEntry<CodemodeCallRecord>("kintsugi.codemode-call");

