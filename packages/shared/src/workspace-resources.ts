import { Type, type Static } from "typebox";

export const workspaceResourceLimitsSchema = Type.Object({
  memory: Type.Integer({ minimum: 6 * 1024 ** 2, maximum: 1024 ** 4 }),
  memorySwap: Type.Integer({ minimum: 0, maximum: 2 * 1024 ** 4 }),
  cpus: Type.Number({ minimum: 0.01, maximum: 1024 }),
  pids: Type.Integer({ minimum: 1, maximum: 1048576 }),
}, { additionalProperties: false });
export type WorkspaceResourceLimits = Static<typeof workspaceResourceLimitsSchema>;
export const workspaceResourceChangeSchema = Type.Object({
  memory: Type.Integer({ minimum: 6 * 1024 ** 2, maximum: 1024 ** 4 }),
  additionalSwap: Type.Integer({ minimum: 0, maximum: 1024 ** 4 }),
  cpus: Type.Number({ minimum: 0.01, maximum: 1024 }),
  acknowledgeMemoryReduction: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type WorkspaceResourceChange = Static<typeof workspaceResourceChangeSchema>;
export const workspaceMemoryPolicyChangeSchema = Type.Object({ maximumMemory: Type.Integer({ minimum: 6 * 1024 ** 2, maximum: 1024 ** 4 }) }, { additionalProperties: false });
export const workspaceMemoryPolicySchema = Type.Object({ version: Type.Literal(2), maximumMemory: workspaceMemoryPolicyChangeSchema.properties.maximumMemory }, { additionalProperties: false });
export type WorkspaceMemoryPolicyChange = Static<typeof workspaceMemoryPolicyChangeSchema>;
export interface WorkspaceMemoryPolicySnapshot {
  maximumMemory: number;
  configuredMaximumMemory?: number;
  capacity: number;
  defaultMemory: number;
}
export interface WorkspaceResourceUsage {
  memory?: number; memoryPeak?: number; swap?: number; cpuCores?: number;
  effectiveMemory?: number; effectiveAdditionalSwap?: number; effectiveCpus?: number; effectivePids?: number;
}
export interface WorkspaceResourceSnapshot {
  workspaceId: string; containerId: string; image: string;
  state: { running: boolean; status: string; oomKilled: boolean; exitCode: number; restartCount: number; restartPolicy: string; finishedAt: string; startedAt: string };
  desired: WorkspaceResourceLimits;
  applied: WorkspaceResourceLimits;
  usage: WorkspaceResourceUsage;
  capacity: { hostMemory: number; hostAvailable: number; systemMemory: number; workspaceBudget: number; otherMemory: number; otherCpus?: number; swapSupported?: boolean; additionalSwapBudget: number; otherAdditionalSwap: number; cpus: number };
  lastExit?: { code: number; finishedAt: string; reason: string };
  oomKills: number; restartSource?: string; blockedAt?: number; failure?: string;
  inSync: boolean; pending: boolean;
  addresses: Array<{ network: string; ipv4: string; ipv6: string }>;
  publishedPorts: Array<{ containerPort: string; hostIp: string; hostPort: string }>;
  exposedPorts: string[];
  affinity: string;
}
