import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readInitialPromptDraft,
  removeInitialPromptDraft,
  removeWorkspaceInitialPromptDrafts,
  stageInitialPrompt,
} from "../../src/server/initial-prompt-draft.ts";
import { renderAgentPane } from "../../src/server/render-composer.ts";
import { ids, type AgentRenderContext } from "@kintsugi/agent/server/render-context";

let temporaryDataDir: string | undefined;

afterEach(async () => {
  delete process.env.KINTSUGI_DATA_DIR;
  if (temporaryDataDir) await rm(temporaryDataDir, { recursive: true, force: true });
  temporaryDataDir = undefined;
});

async function useTemporaryDataDir(): Promise<void> {
  temporaryDataDir = await mkdtemp(join(tmpdir(), "kintsugi-initial-agent-draft-"));
  process.env.KINTSUGI_DATA_DIR = temporaryDataDir;
}

const emptyPaneState = (ctx: AgentRenderContext) => ({ regions: () => [ids.transcript(ctx), ids.actions(ctx), ids.stats(ctx), ids.completionCatalog(ctx)].map(target => ({ target, html: "" })) });

describe("initial Agent prompt drafts", () => {
  test("belong to one immutable conversation and survive body reconstruction", async () => {
    await useTemporaryDataDir();
    const workspaceId = "workspace-1";
    const firstId = "53fc77b7-dc19-42d5-b200-2e134ec67529";
    const secondId = "268604ac-d16a-4a4a-ab1e-1ed3ca54687d";
    await stageInitialPrompt(workspaceId, firstId, "Wait for a model");

    expect(await readInitialPromptDraft(workspaceId, firstId)).toEqual({ prompt: "Wait for a model" });
    expect(await readInitialPromptDraft(workspaceId, secondId)).toBeUndefined();

    const firstAgent = { workspaceId, agentId: firstId, label: "Agent 1", title: "First", path: "/tmp/first.jsonl" };
    const secondAgent = { workspaceId, agentId: secondId, label: "Agent 2", title: "Second", path: "/tmp/second.jsonl" };
    const { html: firstRender } = await renderAgentPane({ workspaceId, agentId: firstId }, firstAgent, emptyPaneState({ workspaceId, agentId: firstId }));
    const { html: reconstructed } = await renderAgentPane({ workspaceId, agentId: firstId }, firstAgent, emptyPaneState({ workspaceId, agentId: firstId }));
    const { html: secondRender } = await renderAgentPane({ workspaceId, agentId: secondId }, secondAgent, emptyPaneState({ workspaceId, agentId: secondId }));
    expect(firstRender).toContain(">Wait for a model</textarea>");
    expect(reconstructed).toContain(">Wait for a model</textarea>");
    expect(secondRender).not.toContain("Wait for a model");
  });

  test("discards a workspace-template-preparation suggestion left by an older server", async () => {
    await useTemporaryDataDir();
    const path = join(temporaryDataDir!, "agent-initial-prompt-drafts", "workspace-1", "agent-a.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ prompt: "Prepare this project", accepted: false }));

    expect(await readInitialPromptDraft("workspace-1", "agent-a")).toBeUndefined();
  });

  test("removes one conversation draft without consuming its sibling", async () => {
    await useTemporaryDataDir();
    await stageInitialPrompt("workspace-1", "agent-a", "A");
    await stageInitialPrompt("workspace-1", "agent-b", "B");

    await removeInitialPromptDraft("workspace-1", "agent-a");
    expect(await readInitialPromptDraft("workspace-1", "agent-a")).toBeUndefined();
    expect(await readInitialPromptDraft("workspace-1", "agent-b")).toEqual({ prompt: "B" });

    await removeWorkspaceInitialPromptDrafts("workspace-1");
    expect(await readInitialPromptDraft("workspace-1", "agent-b")).toBeUndefined();
  });
});
