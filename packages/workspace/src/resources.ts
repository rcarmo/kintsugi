import { workspaceResourceControlAvailable } from "@kintsugi/core";
import { hostRequest } from "@kintsugi/host/control";
import { workspaceResourceChangeSchema, type WorkspaceResourceChange, type WorkspaceResourceSnapshot } from "@kintsugi/shared/workspace-resources";
import { Value } from "typebox/value";

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
  const result = await hostRequest({ operation: "resources", action: "configure", workspaceId, changes: Value.Parse(workspaceResourceChangeSchema, changes) });
  if (!result) throw new Error("System did not provide the applied resource state. Refresh before retrying.");
  return result;
}
