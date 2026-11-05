import { ModelToolUsage } from "../../src/server/durable-model-tool-usage.ts";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, UsageDoc, UserEntry } from "@earendil-works/pi-durable";
import { tokenTelemetry } from "@kintsugi/llm/server";
import { registerDurableTelemetry } from "../../src/server/durable-telemetry.ts";
import { openDurableWorkspace, WorkspaceAgents } from "../../src/server/durable-workspace.ts";

/** Native storage/accounting integration, with no provider calls, container or presentation. */
test("native usage snapshots include subagents and model tools but never inherited fork usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-native-telemetry-")), previous = process.env.KINTSUGI_DATA_DIR;
  process.env.KINTSUGI_DATA_DIR = directory;
  const workspace = await openDurableWorkspace(join(directory, "journal"), "workspace", { models: createModels(), registry: createRegistry() });
  const context = BACKGROUND_CONTEXT, { harness } = workspace;
  const parent = await workspace.agent({ agentId: "parent", label: "Parent", title: "Parent" });
  const values = (tokens: number) => ({ input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const entry = await harness.commit(async tx => {
    (await tx.doc(UsageDoc, parent.id)).models["provider/model"] = values(100);
    return tx.appendEntry(UserEntry, parent.id, { model: [{ role: "user", content: "Inherited context", timestamp: 1 }] });
  }, context);
  const unregister = await registerDurableTelemetry(harness, "workspace"), service = tokenTelemetry();
  try {
    await service.configure({ enabled: true, host: "127.0.0.1", port: 2003, instance: "native-test", intervalMinutes: 15 });
    const child = await workspace.agent({ agentId: "child", parentId: "parent", rootId: "parent", label: "Child", title: "Child" });
    await harness.commit(async tx => {
      (await tx.doc(UsageDoc, parent.id)).models["provider/model"] = values(110);
      (await tx.doc(UsageDoc, child.id)).models["provider/model"] = values(7);
      (await tx.doc(UsageDoc, child.id)).tools["pi.codemode.models.classify"] = values(2);
      (await tx.doc(ModelToolUsage, child.id)).models["classifier-provider/classifier-model"] = values(2);
      const fork = await tx.forkConversation(parent.id, entry.id, { ownership: { kind: "ownerless" } });
      const catalog = await tx.doc(WorkspaceAgents);
      const root = catalog.agents.find(agent => agent.agentId === "parent")!;
      root.branches = [parent.id, fork.id]; root.durableId = fork.id;
    }, context);
    await service.collect();
    const { TokenTelemetryStore } = await import("../../../llm/src/server/token-telemetry-store.ts");
    const db = new TokenTelemetryStore(join(directory, "telemetry/usage.sqlite"));
    try {
      db.transaction(() => db.batch({ enabled: true, host: "127.0.0.1", port: 2003, instance: "native-test", intervalMinutes: 15 }, Date.now()));
      const payload = db.nextBatch()!.payload;
      expect(payload).toContain(".provider.model.tokens.total 17 ");
      expect(payload).toContain(".classifier-provider.classifier-model.tokens.total 2 ");
      expect(payload).not.toContain(".tokens.total 117 ");
      expect(payload).not.toContain("unknown.unknown");
      db.discard();
    } finally { db.close(); }
  } finally {
    await unregister(); await service.close(); await workspace.close();
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
