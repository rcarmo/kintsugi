import { KintsugiCoreError, withCommandSignal, type JsonValue } from "@kintsugi/core";
import { errorMessage, type WorkspaceDeletionResult, type WorkspaceDeletionAssessment } from "@kintsugi/shared";
import type { WorkspaceDeletionState, WorkspaceRegistry } from "./workspace-registry.ts";

/** Owns deletion assessment, confirmation, retries, and restart recovery. */
export function createWorkspaceDeletion(options: {
  registry: WorkspaceRegistry;
  inspect(id: string): Promise<WorkspaceDeletionAssessment>;
  destroy(id: string): Promise<void>;
  cancelPreparation(id: string): Promise<void>;
  changed(id: string, state: WorkspaceDeletionState): void | Promise<void>;
}) {
  const { registry } = options;
  const evidence = new Map<string, JsonValue>();

  function requireWorkspace(id: string) {
    const entry = registry.get(id);
    if (!entry) throw new KintsugiCoreError("workspace_not_found", `workspace not found: ${id}`);
    return entry;
  }

  function canRequest(id: string): boolean {
    const entry = requireWorkspace(id);
    if (!entry.phase.deletion) return true;
    return entry.phase.deletion.status === "blocked" || entry.phase.deletion.status === "failed";
  }

  function setState(id: string, state: WorkspaceDeletionState): void | Promise<void> {
    registry.setDeletion(id, state);
    return options.changed(id, state);
  }

  async function destroy(id: string, forced: boolean): Promise<string | undefined> {
    await setState(id, { status: "deleting", forced });
    try {
      await options.cancelPreparation(id);
      await withCommandSignal(AbortSignal.timeout(60_000), () => options.destroy(id));
      evidence.delete(id);
      registry.remove(id);
      return undefined;
    } catch (error) {
      console.error(`Workspace ${id} deletion failed`, error);
      const message = errorMessage(error);
      await setState(id, { status: "failed", forced, operation: "deleting", error: message });
      return message;
    }
  }

  function schedule(id: string, forced: boolean): WorkspaceDeletionResult {
    void destroy(id, forced);
    return { deleted: true, blocked: false };
  }

  async function check(id: string, confirmedFingerprint?: string): Promise<WorkspaceDeletionResult> {
    await setState(id, { status: "checking" });
    try {
      await options.cancelPreparation(id);
      const assessment = await withCommandSignal(AbortSignal.timeout(60_000), () => options.inspect(id));
      if (assessment.status === "blocked") {
        if (assessment.fingerprint === confirmedFingerprint) return schedule(id, true);
        evidence.set(id, assessment.details);
        await setState(id, { status: "blocked", fingerprint: assessment.fingerprint });
        return { deleted: false, blocked: true, details: assessment.details };
      }
    } catch (error) {
      const message = errorMessage(error);
      await setState(id, { status: "failed", operation: "checking", error: message });
      return { deleted: false, blocked: false };
    }
    return schedule(id, false);
  }

  async function request(id: string, input: { force?: boolean; fingerprint?: string } = {}): Promise<WorkspaceDeletionResult> {
    const entry = requireWorkspace(id);
    if (input.fingerprint !== undefined) {
      if (entry.phase.deletion?.status !== "blocked" || entry.phase.deletion.fingerprint !== input.fingerprint) throw new KintsugiCoreError("workspace_not_ready", "The deletion assessment is no longer current");
      return check(id, input.fingerprint);
    }
    if (!canRequest(id)) throw new KintsugiCoreError("workspace_not_ready", `workspace ${id} is not ready for deletion`);
    if (entry.phase.deletion?.status === "blocked" && !input.force) return { deleted: false, blocked: true, details: evidence.get(id) };
    const retryForced = entry.phase.deletion?.status === "failed" && entry.phase.deletion.operation === "deleting" ? entry.phase.deletion.forced : undefined;
    if (input.force || (entry.phase.kind === "provisioningPhase" && entry.phase.status === "failed") || retryForced !== undefined) return schedule(id, input.force === true || retryForced === true);
    return check(id);
  }

  return {
    request,
    canRequest,
    evidence(id: string): JsonValue | undefined {
      return evidence.get(id);
    },
    cancel(id: string): boolean {
      const entry = requireWorkspace(id);
      if (entry.phase.deletion?.status !== "blocked" && entry.phase.deletion?.status !== "failed") return false;
      registry.cancelDeletion(id);
      evidence.delete(id);
      return true;
    },
    resume(): void {
      for (const entry of registry.list()) {
        if (entry.phase.deletion?.status === "checking") void check(entry.id);
        else if (entry.phase.deletion?.status === "deleting") schedule(entry.id, entry.phase.deletion.forced);
      }
    },
    async destroyAll(ids: readonly string[]): Promise<{ deleted: number; errors: string[] }> {
      const errors: string[] = [];
      let deleted = 0;
      for (const id of ids) {
        const error = await destroy(id, true);
        if (error) errors.push(`${id}: ${error}`);
        else deleted += 1;
      }
      return { deleted, errors };
    },
  };
}
