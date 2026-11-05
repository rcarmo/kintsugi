import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKintsugiEventBus } from "@kintsugi/core";
import { createNextWorkspaceAgent, ensureDefaultWorkspaceAgent, listWorkspaceAgents } from "../../src/server/agent-store.ts";
import { builtinAgentWorkspaceModule, createWorkspaceAgentTabProvider, workspaceAgentTabProvider } from "../../src/server/web.ts";
import { handleAgentRequest } from "../../src/server/routes.ts";
import { agentAttachmentDraftId, findStagedAttachment, stageAttachment } from "@kintsugi/prompt/server";
import { readInitialPromptDraft, stageInitialPrompt } from "../../src/server/initial-prompt-draft.ts";
import { publishWorkspaceAgentBusy } from "@kintsugi/agent/server";
import { agentWorkspaceModule } from "@kintsugi/agent/server";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let dir: string | undefined;

async function dataDir(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "kintsugi-agent-tabs-"));
  process.env.KINTSUGI_DATA_DIR = dir;
}

afterEach(async () => {
  delete process.env.KINTSUGI_DATA_DIR;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

test("a Subagent finishing while its parent works does not request workspace attention", async () => {
  await dataDir();
  const root = await ensureDefaultWorkspaceAgent("workspace-1");
  const childId = crypto.randomUUID();
  const events = createKintsugiEventBus();
  const surfaceRequests: string[] = [];
  const workspaceRequests: string[] = [];
  const busyAgents = new Set<string>();
  // SAFETY: The event handler under test only uses these context members.
  const context = {
    events,
    registry: {
      requestSurfaceAttention(_workspaceId: string, key: string) { surfaceRequests.push(key); },
      requestAttention(workspaceId: string) { workspaceRequests.push(workspaceId); },
      setAgentBusy(_workspaceId: string, key: string, busy: boolean) {
        if (busy) busyAgents.add(key);
        else busyAgents.delete(key);
      },
    },
    invalidateWorkspace() {},
    registerSocketHandler() {},
    registerWorkspaceAppResolver() {},
    onWorkspaceRemoved() {},
  } as any;
  agentWorkspaceModule.initialize!(context);
  builtinAgentWorkspaceModule.initialize!(context);

  // The delegated conversation is not a top-level workspace Agent tab.
  publishWorkspaceAgentBusy({ workspaceId: "workspace-1", agentKey: `agent:${root.agentId}`, busy: true });
  await events.emit("workspace_agent_turn_finished", { workspaceId: "workspace-1", agentId: childId });
  expect(surfaceRequests).toEqual([`agent:${childId}`]);
  expect(workspaceRequests).toEqual([]);
  expect(busyAgents.has(`agent:${root.agentId}`)).toBe(true);

  await events.emit("workspace_agent_turn_finished", { workspaceId: "workspace-1", agentId: root.agentId });
  expect(workspaceRequests).toEqual(["workspace-1"]);
});

describe("Workspace Agent-tab provider", () => {
  test("keeps listing metadata-only and renders exactly the requested immutable identity", async () => {
    const conversations = [
      { workspaceId: "workspace-1", agentId: "53fc77b7-dc19-42d5-b200-2e134ec67529", label: "Agent 1", title: "First", path: "/tmp/first.jsonl" },
      { workspaceId: "workspace-1", agentId: "268604ac-d16a-4a4a-ab1e-1ed3ca54687d", label: "Agent 2", title: "Second", path: "/tmp/second.jsonl" },
    ];
    const rendered: string[] = [];
    const provider = createWorkspaceAgentTabProvider({
      list: async () => conversations,
      render: async (conversation) => {
        rendered.push(conversation.agentId);
        return { html: `<article>${conversation.title}</article>` };
      },
      dispose: async () => {},
      restore: () => {},
      removeClosedAgent: async () => {},
    });

    expect(await provider.list({ workspaceId: "workspace-1" })).toEqual([
      { id: conversations[0]!.agentId, title: "First", untitled: false },
      { id: conversations[1]!.agentId, title: "Second", untitled: false },
    ]);
    expect(rendered).toEqual([]);
    expect(await provider.render({ workspaceId: "workspace-1", agentId: conversations[1]!.agentId })).toEqual({ html: "<article>Second</article>" });
    expect(rendered).toEqual([conversations[1]!.agentId]);
    expect(provider.render({ workspaceId: "workspace-1", agentId: conversations[1]!.label })).rejects.toMatchObject({ code: "agent_not_found" });
  });

  test("listing an unoccupied workspace does not create a native session", async () => {
    await dataDir();
    expect(await workspaceAgentTabProvider.list({ workspaceId: "workspace-1" })).toEqual([]);
    expect(await listWorkspaceAgents("workspace-1")).toEqual([]);
  });

  test("lists shell metadata without labels, paths, or bodies", async () => {
    await dataDir();
    const first = await ensureDefaultWorkspaceAgent("workspace-1");
    const second = await createNextWorkspaceAgent("workspace-1");

    expect(await workspaceAgentTabProvider.list({ workspaceId: "workspace-1" })).toEqual([
      { id: first.agentId, title: "Untitled", untitled: true },
      { id: second.agentId, title: "Untitled", untitled: true },
    ]);
  });

  test("failed closed Agent removal rolls back the close tombstone so the active Agent remains usable", async () => {
    const conversations = [
      { workspaceId: "workspace-1", agentId: "53fc77b7-dc19-42d5-b200-2e134ec67529", label: "Agent 1", title: "First", path: "/tmp/first.jsonl" },
      { workspaceId: "workspace-1", agentId: "268604ac-d16a-4a4a-ab1e-1ed3ca54687d", label: "Agent 2", title: "Second", path: "/tmp/second.jsonl" },
    ];
    const blocked = new Set<string>();
    const provider = createWorkspaceAgentTabProvider({
      list: async () => conversations,
      render: async (conversation) => {
        if (blocked.has(conversation.agentId)) throw new Error("conversation tombstoned");
        return { html: conversation.title };
      },
      dispose: async (_workspaceId, agentId) => { blocked.add(agentId); },
      restore: (_workspaceId, agentId) => { blocked.delete(agentId); },
      removeClosedAgent: async () => { throw new Error("closed Agent removal failed"); },
    });

    await expect(provider.close({ workspaceId: "workspace-1", agentId: conversations[0]!.agentId })).rejects.toThrow("closed Agent removal failed");

    expect(await provider.render({ workspaceId: "workspace-1", agentId: conversations[0]!.agentId })).toEqual({ html: "First" });
  });

  test("close waits for runtime disposal before removing the closed Agent", async () => {
    const conversations = [
      { workspaceId: "workspace-1", agentId: "53fc77b7-dc19-42d5-b200-2e134ec67529", label: "Agent 1", title: "First", path: "/tmp/first.jsonl" },
      { workspaceId: "workspace-1", agentId: "268604ac-d16a-4a4a-ab1e-1ed3ca54687d", label: "Agent 2", title: "Second", path: "/tmp/second.jsonl" },
    ];
    const disposal = deferred();
    const lifecycle: string[] = [];
    const provider = createWorkspaceAgentTabProvider({
      list: async () => conversations,
      render: async (conversation) => ({ html: conversation.title }),
      async dispose() {
        lifecycle.push("dispose:start");
        await disposal.promise;
        lifecycle.push("dispose:end");
      },
      restore: () => {},
      async removeClosedAgent() {
        lifecycle.push("remove-closed-agent");
      },
    });

    const closing = provider.close({ workspaceId: "workspace-1", agentId: conversations[0]!.agentId });
    await Bun.sleep(0);
    expect(lifecycle).toEqual(["dispose:start"]);

    disposal.resolve();
    await closing;
    expect(lifecycle).toEqual(["dispose:start", "dispose:end", "remove-closed-agent"]);
  });

  test("can dispose all native sessions without imposing the shell last-tab policy", async () => {
    await dataDir();
    const first = await ensureDefaultWorkspaceAgent("workspace-1");
    const second = await createNextWorkspaceAgent("workspace-1");

    const results = await Promise.allSettled([
      workspaceAgentTabProvider.close({ workspaceId: "workspace-1", agentId: first.agentId }),
      workspaceAgentTabProvider.close({ workspaceId: "workspace-1", agentId: second.agentId }),
    ]);

    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({ status: "fulfilled" });
    expect(await listWorkspaceAgents("workspace-1")).toEqual([]);
  });

  test("Agent file completions reject a display label in place of the immutable conversation id", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgent("workspace-1");
    const request = new Request(`http://kintsugi.test/workspaces/workspace-1/agents/${encodeURIComponent(conversation.label)}/completions?q=src`);

    expect(handleAgentRequest(request, new URL(request.url))).rejects.toMatchObject({ code: "agent_not_found" });
  });

  test("Agent prompt-template expansion resolves the immutable conversation id, not its label", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgent("workspace-1");
    const request = (identity: string) => new Request(`http://kintsugi.test/workspaces/workspace-1/agents/${encodeURIComponent(identity)}/completions/slash-command-expand`, {
      method: "POST",
      body: new URLSearchParams({ text: "Keep this prompt" }),
    });

    const labelRequest = request(conversation.label);
    expect(handleAgentRequest(labelRequest, new URL(labelRequest.url))).rejects.toMatchObject({ code: "agent_not_found" });

    const conversationRequest = request(conversation.agentId);
    const response = await handleAgentRequest(conversationRequest, new URL(conversationRequest.url));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/plain");
    expect(await response?.text()).toBe("Keep this prompt");
  });

  test("rejects an empty Agent submission without accepting or clearing the composer", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgent("workspace-1");
    const request = new Request(`http://kintsugi.test/workspaces/workspace-1/agents/${conversation.agentId}/messages`, {
      method: "POST",
      headers: { accept: "text/vnd.turbo-stream.html" },
      body: new URLSearchParams({ text: "   ", attachmentDraft: agentAttachmentDraftId("workspace-1", conversation.agentId) }),
    });

    const response = await handleAgentRequest(request, new URL(request.url));

    expect(response?.status).toBe(422);
    expect(response?.headers.get("x-kintsugi-attachment-draft-consumed")).toBeNull();
  });

  test("requests parking the current Workspace when /park is submitted", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgent("workspace-1");
    const request = new Request(`http://kintsugi.test/workspaces/workspace-1/agents/${conversation.agentId}/messages`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ text: "/park" }),
    });

    const response = await handleAgentRequest(request, new URL(request.url), {});

    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe("/workspaces/workspace-1/park");
  });

  test("renames the current Agent when /name has a title", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgent("workspace-1");
    const events = createKintsugiEventBus();
    const renamed: string[] = [];
    events.on("workspace_agent_title_changed", ({ title }) => { renamed.push(title); });
    const request = new Request(`http://kintsugi.test/workspaces/workspace-1/agents/${conversation.agentId}/messages`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ text: "/name investigate-name-command" }),
    });

    const response = await handleAgentRequest(request, new URL(request.url), { events });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ agent: { agentId: conversation.agentId, state: "idle" } });
    expect((await listWorkspaceAgents("workspace-1"))[0]?.title).toBe("investigate-name-command");
    expect(renamed).toEqual(["investigate-name-command"]);
  });

  test("accepts a message with the exact Agent draft and consumes the initial composer text", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgent("workspace-1");
    const draftId = agentAttachmentDraftId("workspace-1", conversation.agentId);
    const attachment = await stageAttachment(draftId, new File(["image"], "reference.png", { type: "image/png" }));
    await stageInitialPrompt("workspace-1", conversation.agentId, "Draft task");
    const submissions: Array<{ text: string; imageCount: number; requestId?: string; whenBusy?: string }> = [];
    const runtime = {
      async submit(input: { text: string; images?: unknown[]; requestId?: string; whenBusy?: string }) {
        submissions.push({ text: input.text, imageCount: input.images?.length ?? 0, requestId: input.requestId, whenBusy: input.whenBusy });
        return { id: 7 };
      },
      userMessages: () => [],
      settings: async () => ({}),
    };
    const request = new Request(`http://kintsugi.test/workspaces/workspace-1/agents/${conversation.agentId}/messages`, {
      method: "POST",
      headers: { accept: "text/vnd.turbo-stream.html" },
      body: new URLSearchParams({ attachmentDraft: draftId, attachment: attachment.id, requestId: "image-request" }),
    });

    const response = await handleAgentRequest(request, new URL(request.url), {
      // SAFETY: This focused route test supplies exactly the runtime methods exercised by message acceptance.
      getController: async () => runtime as never,
    });
    const html = await response?.text();

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-kintsugi-attachment-draft-consumed")).toBe("true");
    expect(response?.headers.get("x-kintsugi-submission-id")).toBe("7");
    expect(html).toBe("");
    // Without a mode, a prompt steers a busy agent, as it did for API callers before follow-ups.
    expect(submissions).toEqual([{ text: "", imageCount: 1, requestId: "image-request", whenBusy: "steer" }]);
    expect(await readInitialPromptDraft("workspace-1", conversation.agentId)).toBeUndefined();
    expect(await findStagedAttachment(draftId, attachment.id)).toBeUndefined();
  });

  test("failed prompt preflight retains the durable composer draft and staged attachments", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgent("workspace-1");
    const draftId = agentAttachmentDraftId("workspace-1", conversation.agentId);
    const attachment = await stageAttachment(draftId, new File(["image"], "reference.png", { type: "image/png" }));
    await stageInitialPrompt("workspace-1", conversation.agentId, "Draft task");
    let suggestedTitle = false;
    const runtime = {
      async submit(): Promise<void> {
        throw new Error("model authentication unavailable");
      },
      userMessages: () => [],
      settings: async () => ({}),
    };
    const request = new Request(`http://kintsugi.test/workspaces/workspace-1/agents/${conversation.agentId}/messages`, {
      method: "POST",
      headers: { accept: "text/vnd.turbo-stream.html" },
      body: new URLSearchParams({ text: "Keep this text", attachmentDraft: draftId, attachment: attachment.id }),
    });

    await expect(handleAgentRequest(request, new URL(request.url), {
      // SAFETY: This focused route test supplies exactly the runtime methods exercised before preflight rejection.
      getController: async () => runtime as never,
      suggestTitleFromPrompt: () => { suggestedTitle = true; },
    })).rejects.toThrow("model authentication unavailable");

    expect(suggestedTitle).toBe(false);
    expect(await readInitialPromptDraft("workspace-1", conversation.agentId)).toEqual({ prompt: "Draft task" });
    expect(await findStagedAttachment(draftId, attachment.id)).toBeDefined();
  });

  test("rejects attachment drafts owned by another Agent or Workspace without consuming them", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgent("workspace-1");
    const sibling = await createNextWorkspaceAgent("workspace-1");
    const otherWorkspace = await ensureDefaultWorkspaceAgent("workspace-2");
    const foreignDrafts = [
      agentAttachmentDraftId("workspace-1", sibling.agentId),
      agentAttachmentDraftId("workspace-2", otherWorkspace.agentId),
    ];

    for (const [index, draftId] of foreignDrafts.entries()) {
      const attachment = await stageAttachment(draftId, new File([`image-${index}`], `foreign-${index}.png`, { type: "image/png" }));
      const request = new Request(`http://kintsugi.test/workspaces/workspace-1/agents/${conversation.agentId}/messages`, {
        method: "POST",
        headers: { accept: "text/vnd.turbo-stream.html" },
        body: new URLSearchParams({ attachmentDraft: draftId, attachment: attachment.id }),
      });

      const response = await handleAgentRequest(request, new URL(request.url));

      expect(response?.status).toBe(422);
      expect(response?.headers.get("x-kintsugi-attachment-draft-consumed")).toBeNull();
      expect(await findStagedAttachment(draftId, attachment.id)).toBeDefined();
    }
  });

  test("keeps JSON message submission compatible without an attachment list", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgent("workspace-1");
    const submissions: string[] = [];
    const runtime = {
      async submit(input: { text: string }) {
        submissions.push(input.text);
        return { id: 1 };
      },
      userMessages: () => [],
      settings: async () => ({}),
    };
    const request = new Request(`http://kintsugi.test/workspaces/workspace-1/agents/${conversation.agentId}/messages`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ text: "Keep going" }),
    });

    const response = await handleAgentRequest(request, new URL(request.url), {
      // SAFETY: This focused route test supplies exactly the runtime methods exercised by message acceptance.
      getController: async () => runtime as never,
      suggestTitleFromPrompt: () => {},
    });

    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual({ agent: { agentId: conversation.agentId, state: "running" } });
    expect(submissions).toEqual(["Keep going"]);
  });
  test("message request identities are forwarded unchanged and invalid identities reject before runtime admission", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgent("workspace-1");
    const admissions: string[] = [];
    const runtime = {
      async submit(input: { requestId: string }) { admissions.push(input.requestId); return { id: admissions.length }; },
      userMessages: () => [],
      settings: async () => ({}),
    };
    for (const requestId of ["browser_retry-123", "browser_retry-123", "", "has spaces", "x".repeat(129), 42]) {
      const request = new Request(`http://kintsugi.test/workspaces/workspace-1/agents/${conversation.agentId}/messages`, {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello", requestId }),
      });
      const response = await handleAgentRequest(request, new URL(request.url), {
        // SAFETY: This route fixture supplies only the operations message admission uses.
        getController: async () => runtime as never,
        suggestTitleFromPrompt: () => {},
      });
      expect(response?.status).toBe(requestId === "browser_retry-123" ? 202 : 422);
    }
    expect(admissions).toEqual(["browser_retry-123", "browser_retry-123"]);
  });

});
