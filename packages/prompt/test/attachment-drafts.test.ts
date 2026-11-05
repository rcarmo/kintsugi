import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentAttachmentDraftId,
  deliverAttachmentDraft,
  listStagedAttachments,
  moveAttachmentDraft,
  removeStagedAttachments,
  stageAttachment,
  validDraftId,
} from "@kintsugi/prompt/server";

import { handleAttachmentRequest } from "../src/server/attachment-routes.ts";

let dir: string | undefined;

async function dataDir(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "kintsugi-agent-attachments-"));
  process.env.KINTSUGI_DATA_DIR = dir;
}

afterEach(async () => {
  delete process.env.KINTSUGI_DATA_DIR;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("Agent attachment drafts", () => {
  test("uses one stable valid draft identity per Workspace conversation", () => {
    const first = agentAttachmentDraftId("workspace-1", "53fc77b7-dc19-42d5-b200-2e134ec67529");
    expect(first).toBe(agentAttachmentDraftId("workspace-1", "53fc77b7-dc19-42d5-b200-2e134ec67529"));
    expect(first).not.toBe(agentAttachmentDraftId("workspace-1", "268604ac-d16a-4a4a-ab1e-1ed3ca54687d"));
    expect(first).not.toBe(agentAttachmentDraftId("workspace-2", "53fc77b7-dc19-42d5-b200-2e134ec67529"));
    expect(validDraftId(first)).toBe(true);
  });

  test("prepares completed uploads without consuming them", async () => {
    await dataDir();
    const draftId = agentAttachmentDraftId("workspace-1", "53fc77b7-dc19-42d5-b200-2e134ec67529");
    const staged = await stageAttachment(draftId, new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" }));

    const delivered = await deliverAttachmentDraft("workspace-1", draftId, [staged.id]);

    expect(delivered.images).toHaveLength(1);
    expect((await listStagedAttachments(draftId)).map(({ id }) => id)).toEqual([staged.id]);

  });

  test("delivers files into container temp storage outside the repository", async () => {
    await dataDir();
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const workspace = await import("@kintsugi/workspace");
      const calls = [];
      mock.module("@kintsugi/workspace", () => ({
        ...workspace,
        execWorkspaceShell: async (...args) => {
          calls.push(args);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }));
      const { stageAttachment, deliverAttachmentDraft } = await import("@kintsugi/prompt/server");
      const draftId = crypto.randomUUID();
      const staged = await stageAttachment(draftId, new File(["contents"], "my file.txt"));
      const delivered = await deliverAttachmentDraft("workspace-1", draftId, [staged.id]);
      expect(delivered).toEqual({ images: [], attachmentNotes: [
        "[Attached file copied into the workspace at /tmp/kintsugi-attachments/my file.txt]",
      ] });
      expect(calls).toEqual([["workspace-1",
        "mkdir -p '/tmp/kintsugi-attachments' && base64 -d > '/tmp/kintsugi-attachments/my file.txt'",
        { stdin: Buffer.from("contents").toString("base64") },
      ]]);
    `], { cwd: join(import.meta.dir, ".."), env: process.env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("moves launch attachments into the new Agent composer", async () => {
    await dataDir();
    const launchDraftId = crypto.randomUUID();
    const agentDraftId = agentAttachmentDraftId("workspace-1", "53fc77b7-dc19-42d5-b200-2e134ec67529");
    const staged = await stageAttachment(launchDraftId, new File(["draft"], "draft.txt"));

    await moveAttachmentDraft(launchDraftId, agentDraftId);

    expect(await listStagedAttachments(launchDraftId)).toEqual([]);
    expect((await listStagedAttachments(agentDraftId)).map(({ id, name }) => ({ id, name }))).toEqual([{ id: staged.id, name: "draft.txt" }]);
  });

  test("consumes only the submitted attachments and preserves concurrent uploads", async () => {
    await dataDir();
    const draftId = agentAttachmentDraftId("workspace-1", "53fc77b7-dc19-42d5-b200-2e134ec67529");
    const submitted = await stageAttachment(draftId, new File(["first"], "first.png", { type: "image/png" }));
    const concurrent = await stageAttachment(draftId, new File(["second"], "second.png", { type: "image/png" }));

    await deliverAttachmentDraft("workspace-1", draftId, [submitted.id]);
    await removeStagedAttachments(draftId, [submitted.id]);

    expect((await listStagedAttachments(draftId)).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: concurrent.id, name: "second.png" },
    ]);
  });
});

describe("Draft image reads", () => {
  test("serves persisted image bytes without consuming the draft and stops serving removed images", async () => {
    await dataDir();
    const draftId = crypto.randomUUID();
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const image = await stageAttachment(draftId, new File([bytes], "clipboard.png"));
    const url = new URL(`http://localhost/agent-attachment-drafts/${draftId}/attachments/${image.id}`);
    const response = (await handleAttachmentRequest(new Request(url), url))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(await listStagedAttachments(draftId)).toHaveLength(1);
    await removeStagedAttachments(draftId, [image.id]);
    expect((await handleAttachmentRequest(new Request(url), url))!.status).toBe(404);
  });

  test("rejects non-images, invalid identities, and attachments from another draft", async () => {
    await dataDir();
    const draftId = crypto.randomUUID();
    const text = await stageAttachment(draftId, new File(["text"], "notes.txt"));
    const image = await stageAttachment(draftId, new File(["image"], "screen.png"));
    for (const [draft, id] of [[draftId, text.id], [crypto.randomUUID(), image.id], ["invalid", image.id], [draftId, "invalid"]]) {
      const url = new URL(`http://localhost/agent-attachment-drafts/${draft}/attachments/${id}`);
      expect((await handleAttachmentRequest(new Request(url), url))!.status).toBe(404);
    }
  });
});
