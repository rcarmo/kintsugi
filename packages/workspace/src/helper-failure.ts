import { KintsugiCoreError } from "@kintsugi/core";
import { WorkspaceHelperError, WorkspaceHelperStatus } from "@kintsugi/workspace-helper";
import type { WorkspaceResourceSnapshot } from "@kintsugi/shared/workspace-resources";

/** A failed transport is not evidence that the workspace image is obsolete.
 * Inspection is read-only: never restart the container or replay an unsafe RPC.
 */
export async function describeWorkspaceHelperFailure(id: string, error: Error, inspect: () => Promise<WorkspaceResourceSnapshot | undefined>): Promise<Error> {
  if (!(error instanceof WorkspaceHelperError) || error.code !== WorkspaceHelperStatus.UNAVAILABLE) return error;
  let status: WorkspaceResourceSnapshot | undefined;
  let inspectionFailure = "";
  try { status = await inspect(); }
  catch (cause) {
    console.error("Could not inspect workspace after helper transport failure", cause);
    inspectionFailure = " Resource status could not be inspected.";
  }
  const reason = status?.state.oomKilled || (status?.blockedAt !== undefined && status.oomKills > 0)
    ? "was stopped after an out-of-memory event. Check memory limits and OOM diagnostics in Workspace Properties before explicitly retrying"
    : status && !status.state.running
      ? `is stopped (exit code ${status.state.exitCode}). Start or unpark it before retrying`
      : status?.state.running
        ? "is running, but its helper is unavailable. Check the helper/service logs; a workspace restart may be needed"
        : "helper is unavailable. The workspace may have stopped or restarted, or its helper may have failed. Check Workspace Properties and helper logs";
  return new KintsugiCoreError("workspace_unavailable", `Workspace ${id} ${reason}.${inspectionFailure}\n${error.message}`);
}
