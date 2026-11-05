import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAgentLaunch, nativeAgentLaunch } from "../../src/server/launch.ts";
import { stageAttachment } from "@kintsugi/prompt/server";
import { listWorkspaceAgents } from "../../src/server/agent-store.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kintsugi-agent-launch-"));
  process.env.KINTSUGI_DATA_DIR = directory;
});
afterEach(async () => {
  delete process.env.KINTSUGI_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

test("empty launch settings do not introduce an agent task", async () => {
  expect(await prepareAgentLaunch()).toBeUndefined();
  expect(await prepareAgentLaunch({ initialPrompt: "   " })).toBeUndefined();
});

test("empty composer submissions can launch without an available enabled model", async () => {
  for (const text of ["", "   \n "]) {
    const form = new FormData();
    form.set("text", text);
    form.set("attachmentDraft", crypto.randomUUID());
    const submission = await nativeAgentLaunch.submit(form);
    expect("response" in submission).toBe(false);
    if ("response" in submission) throw new Error("Empty launch was rejected");
    expect(await submission.prepare()).toEqual({ agent: {} });
  }
});

test("composer prompts still require an available enabled model", async () => {
  const form = new FormData();
  form.set("text", "Start working");
  const submission = await nativeAgentLaunch.submit(form);
  expect("response" in submission && submission.response.status).toBe(422);
});

test("attachment-only composer submissions still require an available enabled model", async () => {
  const draftId = crypto.randomUUID();
  await stageAttachment(draftId, new File(["Task details"], "task.txt"));
  const form = new FormData();
  form.set("attachmentDraft", draftId);
  const submission = await nativeAgentLaunch.submit(form);
  expect("response" in submission && submission.response.status).toBe(422);
});

test("agent launch owns validation of its parameters", async () => {
  await expect(prepareAgentLaunch({ model: 42 })).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(prepareAgentLaunch({ thinkingLevel: [] })).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(prepareAgentLaunch({ initialPromptMode: "run-anything" })).rejects.toMatchObject({ code: "invalid_arguments" });
});

test("launching with a model that can't run is refused instead of using the default", async () => {
  await expect(prepareAgentLaunch({ initialPrompt: "Start", model: "xai::no-such-model" })).rejects.toMatchObject({ code: "invalid_arguments", message: "xai::no-such-model can't run: Not in the provider’s catalogue" });
  await expect(prepareAgentLaunch({ initialPrompt: "Start", model: "xai::grok-4.7" })).rejects.toMatchObject({ code: "invalid_arguments", message: "xai::grok-4.7 can't run: Model provider not connected" });
  await expect(prepareAgentLaunch({ initialPrompt: "Start", model: "grok-4.7" })).rejects.toMatchObject({ code: "invalid_arguments" });
});

test("explicit composer drafts preserve native settings", async () => {
  expect(await prepareAgentLaunch({
    initialPrompt: "  Investigate later  ", initialPromptMode: "composer",
    model: "openai::gpt-5.4", thinkingLevel: "high", attachmentDraft: "draft-1",
  })).toEqual({ agent: {
    initialPrompt: "Investigate later", initialPromptMode: "composer",
    model: "openai::gpt-5.4", thinkingLevel: "high", attachmentDraft: "draft-1",
  } });
});

test("host-requested preparation retains the existing native session identity", async () => {
  await nativeAgentLaunch.prepareWorkspace("launch-workspace");
  const first = await listWorkspaceAgents("launch-workspace");
  await nativeAgentLaunch.prepareWorkspace("launch-workspace");
  expect(await listWorkspaceAgents("launch-workspace")).toEqual(first);
  expect(first).toHaveLength(1);
});
