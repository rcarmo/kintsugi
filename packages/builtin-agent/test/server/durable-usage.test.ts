import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, UsageDoc, UserEntry } from "@earendil-works/pi-durable";
import { openDurableWorkspace, WorkspaceAgents } from "../../src/server/durable-workspace.ts";
import { collectDescendantUsage } from "../../src/server/durable-usage.ts";
import { ModelToolUsage } from "../../src/server/durable-model-tool-usage.ts";
import { promptCacheHitPercent } from "@kintsugi/agent/server/prompt-usage";

const usage = (input: number, cacheRead: number, cost: number) => ({ input, cacheRead, cacheWrite: 0, output: 10000, totalTokens: input + cacheRead + 10000, cost: { input: cost, cacheRead: 0, cacheWrite: 0, output: 0, total: cost } });
test("family totals count delegated/one-shot/nested agents and each fork's own ledger once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "family-usage-"));
  const workspace = await openDurableWorkspace(dir, "w", { models: createModels(), registry: createRegistry() });
  try {
    const root = await workspace.agent({ agentId: "root", label: "Root", title: "Root" });
    const child = await workspace.agent({ agentId: "child", parentId: "root", label: "Child", title: "Child" });
    const one = await workspace.agent({ agentId: "one", parentId: "root", oneShotCallId: "script-call", readOnly: true, label: "One", title: "One" });
    const nested = await workspace.agent({ agentId: "nested", parentId: "child", label: "Nested", title: "Nested" });
    const other = await workspace.agent({ agentId: "other", label: "Other", title: "Other" });
    const boundary = await workspace.harness.commit(async tx => {
      (await tx.doc(UsageDoc, child.id)).models.m = usage(10, 90, 1);
      return tx.appendEntry(UserEntry, child.id, { model: [{ role: "user", timestamp: 0, content: "Fork here" }] });
    }, ctx);
    const fork = await child.fork(boundary.id, { ownership: { kind: "ownerless" } }, ctx);
    await workspace.harness.commit(async tx => {
      (await tx.doc(UsageDoc, root.id)).models.m = usage(10, 90, 4);
      (await tx.doc(UsageDoc, child.id)).tools.classify = usage(5, 15, 0.2);
      (await tx.doc(ModelToolUsage, child.id)).models["classifier/m"] = usage(5, 15, 0.2);
      (await tx.doc(UsageDoc, fork.id)).models.m = usage(20, 80, 0.4);
      (await tx.doc(UsageDoc, one.id)).models.m = usage(80, 20, 2);
      (await tx.doc(UsageDoc, nested.id)).models.m = usage(5, 5, 3);
      (await tx.doc(UsageDoc, other.id)).models.m = usage(1000000, 0, 1000000);
      const record = (await tx.doc(WorkspaceAgents)).agents.find(a => a.agentId === "child")!;
      record.durableId = fork.id;
      record.branches = [child.id, child.id, fork.id];
    }, ctx);
    const records = (await workspace.harness.snapshot(WorkspaceAgents, ctx))!.agents;
    const reads: number[] = [];
    const sum = await collectDescendantUsage(records, "root", id => { reads.push(id); return workspace.harness.snapshot(UsageDoc, id, ctx); });
    expect(sum).toMatchObject({ agents: 3, input: 120, cacheRead: 210, cacheWrite: 0 });
    expect(sum!.cost).toBeCloseTo(6.6);
    expect(new Set(reads).size).toBe(4);
    expect(reads).not.toContain(root.id);
    expect(reads).not.toContain(other.id);
    expect(promptCacheHitPercent([usage(10, 90, 4), sum!])).toBeCloseTo(300 / 430 * 100);
    expect(await collectDescendantUsage(records, "other", async () => { throw Error("No children"); })).toBeUndefined();
  } finally { await workspace.close(); await rm(dir, { recursive: true, force: true }); }
});
