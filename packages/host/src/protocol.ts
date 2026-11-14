import type { ResourceSnapshot } from "@kintsugi/core/resource-metrics";
import type { HostMetricId } from "./diagnostics.ts";
import { workspaceResourceChangeSchema, workspaceMemoryPolicyChangeSchema, type WorkspaceMemoryPolicySnapshot, type WorkspaceResourceSnapshot } from "@kintsugi/shared/workspace-resources";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
export const hostSocketPath = "/run/kintsugi-host/control.sock";
export interface HostTerminal { id: string; title: string }
export interface HostMetric { id: HostMetricId; value: string; warning?: boolean }
export interface HostSection { title: string; text: string; error?: boolean }
export interface HostSample { sampledAt: string; durationMs: number; metrics: HostMetric[]; sections: HostSection[] }
import { networkModeSchema, networkConfigurationSchema, type WorkspaceNetworkPolicy } from "@kintsugi/shared/network-policy";
export interface HostResults {
  meters: ResourceSnapshot;
  network: WorkspaceNetworkPolicy;
  resources: null | WorkspaceResourceSnapshot;
  "resource-policy": WorkspaceMemoryPolicySnapshot;
  list: HostTerminal[];
  create: HostTerminal;
  terminate: null;
  sample: HostSample;
}
export type HostResult = HostResults[keyof HostResults];
const terminalId = Type.String({ pattern: "^host-[a-f0-9-]{36}$" });
const requestSchema = Type.Union([
  Type.Object({ operation: Type.Literal("meters"), workspaceIds: Type.Array(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$" }), { maxItems: 32 }) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("resource-policy"), action: Type.Literal("inspect") }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("resource-policy"), action: Type.Literal("configure"), changes: workspaceMemoryPolicyChangeSchema }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("resources"), action: Type.Optional(Type.Union([Type.Literal("admit"), Type.Literal("park")])), workspaceId: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$" }), recover: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("resources"), action: Type.Literal("inspect"), workspaceId: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$" }) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("resources"), action: Type.Literal("configure"), workspaceId: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$" }), changes: workspaceResourceChangeSchema }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("network"), destinations: Type.Optional(Type.Array(Type.Object({ host: Type.String({ maxLength: 253 }), port: Type.Integer({ minimum: 1, maximum: 65535 }) }, { additionalProperties: false }), { maxItems: 256 })), workspaceId: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$" }), mode: networkModeSchema, configuration: networkConfigurationSchema }),
  Type.Object({ operation: Type.Literal("list") }),
  Type.Object({ operation: Type.Literal("create") }),
  Type.Object({ operation: Type.Literal("terminate"), id: terminalId }),
  Type.Object({ operation: Type.Literal("sample"), fresh: Type.Optional(Type.Boolean()) }),
  Type.Object({ operation: Type.Literal("attach"), id: terminalId, cols: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }),
]);
export type HostRequest = Static<typeof requestSchema>;
export type HostCommand = Exclude<HostRequest, { operation: "attach" }>;
export function parseHostRequest(line: string): HostRequest { return Value.Parse(requestSchema, JSON.parse(line)); }
export function parseHostInput(line: string): string { return Value.Parse(Type.String({ maxLength: 1024 * 1024 }), JSON.parse(line)); }
export type HostReply = { type: "result"; value: HostResult } | { type: "error"; message: string } | { type: "output"; data: string } | { type: "exit" };
export function validTerminalId(id: string): boolean { return /^host-[a-f0-9-]{36}$/.test(id); }
export function terminalSize(value: number | string | null | undefined, defaultValue: number): number { const n = Number(value); return Number.isInteger(n) && n > 0 && n <= 1000 ? n : defaultValue; }
