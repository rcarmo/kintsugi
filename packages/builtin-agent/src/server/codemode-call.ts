import type { JsonValue } from "@earendil-works/chord/json";
import { defineEntry, defineDoc, type JsonObject } from "@earendil-works/pi-durable";

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


/** Complete emitted text staged until the root MCP recall hook; never a model entry. */
type McpScriptOutputState={calls:Record<string,boolean>;raw:string|null};
export const McpScriptOutputDoc = defineDoc({kind:"kintsugi.mcp-script-output",version:1,scope:"task",checkpointWhen:()=>false,initial:():McpScriptOutputState=>({calls:{},raw:null})});
