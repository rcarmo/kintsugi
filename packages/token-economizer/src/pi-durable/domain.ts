// SPDX-License-Identifier: Apache-2.0
import type { ConversationId } from "@earendil-works/pi-durable";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Observation, Scope, ToolInfo } from "../core/types.ts";
import type { ToolMapping } from "../core/observations.ts";

/** Trusted host metadata. Never derive these identities from tool/model arguments. */
export type HostSession = {
  id: string; conversationId: ConversationId; scope: Scope; repositoryRoot: string;
  environmentRevision: string; classificationGroup: string; delegated: boolean;
};
export type CatalogueSnapshot = {
  revision: string; source: string; complete: boolean; tools: ToolInfo[];
};
export type Trajectory =
  | { kind: "ready"; cutoff: string; observations: Observation[]; prompts: number | null; transcriptActivity: number }
  | { kind: "absent"; reason: string }
  | { kind: "later"; reason: string }
  | { kind: "unreadable"; reason: string };
export type SessionStart = {
  event: "startup" | "new" | "resume" | "fork" | "reload";
  visibleHistory: boolean; carriedSections: Record<string, string>;
  /** A resumed in-flight run keeps its already prepared mask until an idle start. */
  runningMask?:string[];
};
/** A host may expose its own committed receipts without leaking their document type. */
export type ReceiptAdapter = {
  observations(session: HostSession, cutoff: string): Promise<Observation[]>;
};
export type ToolResultData = {name:string;structured:JsonValue|null;details:JsonValue|null;output:string;isError:boolean;diagnostics:{code:string;message:string}[]};
export type DecodedResult = {output:string;exitCode:number|null;timedOut:boolean;aborted:boolean;coverage:"complete"|"partial"};
export type HostDomain = {
  integrationId: string;
  session(conversationId: ConversationId): Promise<HostSession | null>;
  tool(name: string): ToolMapping;
  arguments(name:string,args:JsonObject): {command:string;targets:string[];coverage:"complete"|"partial"};
  decode(result:ToolResultData): DecodedResult;
  catalogue(session: HostSession): Promise<CatalogueSnapshot>;
  setTools(session:HostSession,excluded:string[]):Promise<void>;
  trajectory(session: HostSession, cutoff: string | null): Promise<Trajectory>;
  receiptAdapter?: ReceiptAdapter;
};
