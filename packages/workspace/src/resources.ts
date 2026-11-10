import { workspaceResourceControlAvailable } from "@kintsugi/core";
import { workspaceMemoryPolicySystemVersion, workspaceTaskLimitsSystemVersion } from "@kintsugi/shared/system-version";
import { hostAvailable, readSystemVersion, hostRequest } from "@kintsugi/host/control";
import { workspaceResourceChangeSchema, workspaceMemoryPolicyChangeSchema, type WorkspaceMemoryPolicyChange, type WorkspaceMemoryPolicySnapshot, type WorkspaceResourceChange, type WorkspaceResourceSnapshot } from "@kintsugi/shared/workspace-resources";
import { Value } from "typebox/value";

export async function workspaceMemoryPolicyAvailable(): Promise<boolean> {
  return hostAvailable() && await readSystemVersion() >= workspaceMemoryPolicySystemVersion;
}
export async function inspectWorkspaceMemoryPolicy(): Promise<WorkspaceMemoryPolicySnapshot> {
  if (!await workspaceMemoryPolicyAvailable()) throw new Error("Global workspace RAM limits need System compatibility version 4. Update the installation first.");
  return hostRequest({ operation: "resource-policy", action: "inspect" });
}
export async function configureWorkspaceMemoryPolicy(changes: WorkspaceMemoryPolicyChange): Promise<WorkspaceMemoryPolicySnapshot> {
  if (!await workspaceMemoryPolicyAvailable()) throw new Error("Global workspace RAM limits need System compatibility version 4. Update the installation first.");
  if (changes.defaultPids !== undefined && await readSystemVersion() < workspaceTaskLimitsSystemVersion) throw new Error("Editable task defaults need System compatibility version 5. Update the installation first.");
  return hostRequest({ operation: "resource-policy", action: "configure", changes: Value.Parse(workspaceMemoryPolicyChangeSchema, changes) });
}

async function requireControl() {
  if (!await workspaceResourceControlAvailable()) throw new Error("Workspace resource inspection needs System compatibility version 3. Update the installation; network settings remain available.");
}
export async function inspectWorkspaceResources(workspaceId: string, options: { signal?: AbortSignal } = {}): Promise<WorkspaceResourceSnapshot> {
  await requireControl();
  const result = await hostRequest({ operation: "resources", action: "inspect", workspaceId }, undefined, options);
  if (!result) throw new Error("System did not provide a workspace resource snapshot. Update the installation.");
  return result;
}
export async function configureWorkspaceResources(workspaceId: string, changes: WorkspaceResourceChange): Promise<WorkspaceResourceSnapshot> {
  await requireControl();
  if (changes.pids !== undefined && await readSystemVersion() < workspaceTaskLimitsSystemVersion) throw new Error("Editable task limits need System compatibility version 5. Update the installation first.");
  const result = await hostRequest({ operation: "resources", action: "configure", workspaceId, changes: Value.Parse(workspaceResourceChangeSchema, changes) });
  if (!result) throw new Error("System did not provide the applied resource state. Refresh before retrying.");
  return result;
}
