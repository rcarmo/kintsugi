import { expect, test } from "bun:test";
import { describeWorkspaceHelperFailure } from "../src/helper-failure.ts";
import { WorkspaceHelperError, WorkspaceHelperStatus } from "@kintsugi/workspace-helper";
import type { WorkspaceResourceSnapshot } from "@kintsugi/shared/workspace-resources";

const unavailable = () => new WorkspaceHelperError(WorkspaceHelperStatus.UNAVAILABLE, "connect ECONNREFUSED helper.sock");
// SAFETY: Error translation reads only these resource fields; unrelated snapshot fields are not used in this fixture.
const snapshot = (running: boolean, oom = false) => ({ state: { running, oomKilled: oom, exitCode: oom ? 137 : 0 }, oomKills: oom ? 1 : 0 } as WorkspaceResourceSnapshot);
test("helper transport errors report stopped/OOM/running states without suggesting recreation", async () => {
  for (const [status, text] of [[snapshot(false, true), "out-of-memory"], [snapshot(false), "is stopped"], [snapshot(true), "is running"]] as const) {
    const result = await describeWorkspaceHelperFailure("w", unavailable(), async () => status);
    expect(result.message).toContain(text);
    expect(result.message).toContain("ECONNREFUSED");
    expect(result.message).not.toContain("recreating");
  }
  const blocked = { ...snapshot(false), oomKills: 2, blockedAt: 123 };
  expect((await describeWorkspaceHelperFailure("w", unavailable(), async () => blocked)).message).toContain("out-of-memory");
});
test("legacy deployments retain transport context without inferring image age", async () => {
  const result = await describeWorkspaceHelperFailure("w", unavailable(), async () => undefined);
  expect(result.message).toContain("helper is unavailable");
  expect(result.message).not.toContain("older Kintsugi");
});
test("permission, cancellation and non-helper errors are not reclassified or inspected", async () => {
  for (const error of [new Error("ordinary"), new WorkspaceHelperError(WorkspaceHelperStatus.PERMISSION_DENIED, "denied"), new WorkspaceHelperError(WorkspaceHelperStatus.CANCELLED, "stopped")]) {
    expect(await describeWorkspaceHelperFailure("w", error, async () => { throw new Error("must not inspect"); })).toBe(error);
  }
});
