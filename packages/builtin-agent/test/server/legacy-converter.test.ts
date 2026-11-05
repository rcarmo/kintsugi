import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { convertLegacyAgents } from "@kintsugi/legacy-converter";
import { removeClosedWorkspaceAgent, ensureDefaultWorkspaceAgent, listWorkspaceAgents, setWorkspaceAgentTitle } from "../../src/server/agent-store.ts";
import { durableWorkspaceOwner, suspendAllDurableWorkspaceOwners } from "../../src/server/runtime.ts";
import { getWorkspaceAgentPresentation, unloadWorkspaceAgentPresentation, closeWorkspaceAgent } from "../../src/server/runtime.ts";
import { AgentPresentation } from "../../src/server/agent-presentation.ts";
import { historyNote } from "@kintsugi/legacy-converter/entries";

let root: string;
let workspace: string;
const previous = process.env.KINTSUGI_DATA_DIR;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "legacy-converter-"));
  workspace = `import-${crypto.randomUUID()}`;
  process.env.KINTSUGI_DATA_DIR = root;
});
afterEach(async () => {
  await suspendAllDurableWorkspaceOwners();
  if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous;
  await rm(root, { recursive: true, force: true });
});
const ctx = BACKGROUND_CONTEXT;
function metadataPath() { return join(root, "workspaces", workspace, "metadata", "agent-conversations.json"); }
async function fixture() {
  const record = { agentId: crypto.randomUUID(), label: "Agent 1", title: "Old investigation" };
  await mkdir(join(root, "workspaces", workspace, "metadata"), { recursive: true });
  await writeFile(metadataPath(), JSON.stringify({ conversations: [{ conversationId: record.agentId, label: record.label, title: record.title }] }));
  const directory = join(root, "workspaces", workspace, "agent-sessions");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${record.agentId}.jsonl`);
  const now = new Date().toISOString();
  const entry = (id: string, parentId: string | null, message: Message) => ({ type: "message", id, parentId, timestamp: now, message });
  await writeFile(path, [
    { type: "session", version: 3, id: "old-session", timestamp: now, cwd: "/work" },
    entry("u", null, { role: "user", content: [{ type: "text", text: "Original input" }, { type: "image", mimeType: "image/png", data: Buffer.from("user image").toString("base64") }], timestamp: 1 }),
    entry("abandoned", "u", fauxAssistantMessage("Abandoned answer")),
    entry("a", "u", fauxAssistantMessage([fauxToolCall("read", { path: "notes.png" }, { id: "call" })])),
    entry("t", "a", { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "image", mimeType: "image/png", data: Buffer.from("tool image").toString("base64") }], isError: false, timestamp: 2 }),
    { type: "compaction", id: "c", parentId: "t", timestamp: now, summary: "Preserved compaction summary", firstKeptEntryId: "u", tokensBefore: 100 },
    entry("final", "c", fauxAssistantMessage("Selected answer")),
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  return { record, path };
}

test("selected legacy branch becomes passive native history with scoped images, summaries and immutable source", async () => {
  const { record, path } = await fixture();
  const before = await readFile(path, "utf8");
  const [agent] = await listWorkspaceAgents(workspace);
  expect(agent!.storage).toBe("durable");
  expect(agent!.readOnly).toBe(true);
  const owner = await durableWorkspaceOwner(workspace);
  const controller = await owner.agent(record);
  const view = await controller.historyView();
  const serialized = JSON.stringify(view.entries);
  expect(serialized).toContain("Selected answer");
  expect(serialized).not.toContain("Abandoned answer");
  expect(view.entries.some(entry => historyNote.is(entry) && entry.data.text === "Preserved compaction summary")).toBe(true);
  const user = view.entries.find(entry => entry.model?.[0]?.role === "user")!;
  const tool = view.entries.find(entry => entry.model?.[0]?.role === "toolResult")!;
  expect(await (await controller.image(String(user.id), 1)).text()).toBe("user image");
  const image = await controller.image(String(tool.id), 0);
  expect(await image.text()).toBe("tool image");
  expect(image.headers.get("content-security-policy")).toContain("sandbox");
  expect((await controller.image(String(user.id), 0)).status).toBe(404);
  expect(await readFile(path, "utf8")).toBe(before);
  // No Docker workspace, available model, or prompt preparation exists for this ID.
  const runtime = await getWorkspaceAgentPresentation(agent!);
  expect(runtime).toBeInstanceOf(AgentPresentation);
  expect(runtime.currentModel()).toBeUndefined();
  expect(runtime.isStreaming).toBe(false);
  expect(await controller.userMessages()).toEqual(["Original input"]);
  await unloadWorkspaceAgentPresentation(workspace, record.agentId);
  const reopened = await durableWorkspaceOwner(workspace);
  // Unload only detaches presentation; the pooled owner retains the same entries.
  expect((await (await reopened.agent(record)).historyView()).entries).toEqual(view.entries);
});

test("read-only is enforced by the canonical owner even with forged writable tab metadata", async () => {
  const { record } = await fixture();
  await listWorkspaceAgents(workspace);
  const controller = await (await durableWorkspaceOwner(workspace)).agent({ ...record, readOnly: false });
  expect(controller.readOnly).toBe(true);
  for (const operation of [
    () => controller.submit({ text: "Do not execute", requestId: "new" }),
    () => controller.configure({ thinkingLevel: "off" }),
    () => controller.stop(), () => controller.compact(), () => controller.reset(),
    () => controller.navigate("1"), () => controller.label("1", "bookmark", "add"),
  ]) await expect(operation()).rejects.toThrow("read-only");
  const watch = await controller.watch(ctx);
  expect(JSON.stringify(watch.value.docs)).not.toContain("Do not execute");
  await watch.stop();
});

test("crash after journal commit before metadata replacement retries without reopening the source", async () => {
  const { record, path } = await fixture();
  const metadata = await Bun.file(metadataPath()).text();
  const options = {
    workspaceId: workspace, workspaceDirectory: join(root, "workspaces", workspace),
    shareDirectory: join(root, "session-shares", "projectless"), metadata,
    destination: () => durableWorkspaceOwner(workspace),
  };
  await Promise.all([convertLegacyAgents(options), convertLegacyAgents(options)]);
  const owner = await durableWorkspaceOwner(workspace);
  const before = await (await owner.agent(record)).historyView();
  await rm(path);
  const [agent] = await listWorkspaceAgents(workspace);
  expect(agent!.readOnly).toBe(true);
  expect(await owner.catalog()).toHaveLength(1);
  expect((await (await owner.agent(record)).historyView()).entries).toEqual(before.entries);
  expect((await Bun.file(join(root, "workspaces", workspace, "metadata", "agents.json")).json()).version).toBe(2);
});

test("shared sidecar import is discovered once, renamed natively, and never resurrected after close", async () => {
  const { record, path } = await fixture();
  const share = join(root, "session-shares", "projectless");
  await mkdir(share, { recursive: true });
  const target = join(share, `old-investigation--${workspace}--agent-1--${record.agentId}.jsonl`);
  await writeFile(target, await readFile(path));
  await writeFile(target.replace(/\.jsonl$/, ".title"), record.title);
  await rm(metadataPath());
  const [agent] = await listWorkspaceAgents(workspace);
  const renamed = await setWorkspaceAgentTitle(agent!, "Imported notes");
  expect((await (await durableWorkspaceOwner(workspace)).catalog())[0]!.title).toBe("Imported notes");
  await closeWorkspaceAgent(workspace, record.agentId);
  await removeClosedWorkspaceAgent(renamed);
  expect(await listWorkspaceAgents(workspace)).toEqual([]);
  expect(await Bun.file(target).exists()).toBe(true);
  expect(await Bun.file(target.replace(/\.jsonl$/, ".title")).text()).toBe(record.title);
  expect((await ensureDefaultWorkspaceAgent(workspace)).agentId).not.toBe(record.agentId);
});

test("invalid JSON and broken ancestry fail without publishing a partial import or changing metadata", async () => {
  const { path } = await fixture();
  const metadata = await readFile(metadataPath(), "utf8");
  await writeFile(path, '{broken\n');
  await expect(listWorkspaceAgents(workspace)).rejects.toThrow();
  expect(await readFile(metadataPath(), "utf8")).toBe(metadata);
  expect(await (await durableWorkspaceOwner(workspace)).catalog()).toEqual([]);
  await writeFile(path, [
    { type: "session", version: 3 },
    { type: "message", id: "a", parentId: "missing", message: { role: "user", content: "orphan" } },
  ].map(row => JSON.stringify(row)).join("\n"));
  await expect(listWorkspaceAgents(workspace)).rejects.toThrow("Missing legacy parent");
  expect(await (await durableWorkspaceOwner(workspace)).catalog()).toEqual([]);
});

test("v1 sessions are normalized in memory without rewriting the old source", async () => {
  const { record, path } = await fixture();
  const source = [
    { type: "session", version: 1, id: "v1", cwd: "/work", timestamp: new Date().toISOString() },
    { type: "message", message: { role: "user", content: "Old linear history", timestamp: 1 } },
    { type: "message", message: fauxAssistantMessage("Preserved answer") },
  ].map(row => JSON.stringify(row)).join("\n");
  await writeFile(path, source);
  await listWorkspaceAgents(workspace);
  expect(await readFile(path, "utf8")).toBe(source);
  const history = await (await (await durableWorkspaceOwner(workspace)).agent(record)).historyView();
  expect(JSON.stringify(history.entries)).toContain("Old linear history");
  expect(JSON.stringify(history.entries)).toContain("Preserved answer");
});

test("native and imported sibling tabs coexist, and import cannot expose a sibling's images", async () => {
  const { record } = await fixture();
  const imported = (await listWorkspaceAgents(workspace))[0]!;
  const owner = await durableWorkspaceOwner(workspace);
  const history = await owner.agent(record);
  const other = { agentId: crypto.randomUUID(), label: "Agent 2", title: "Other retained history" };
  await owner.importHistory(other, [{ kind: "pi.user", model: [{ role: "user", content: [{ type: "image", data: Buffer.from("private").toString("base64"), mimeType: "image/png" }], timestamp: 1 }] }]);
  const otherEntry = (await (await owner.agent(other)).historyView()).entries[0]!;
  expect((await history.image(String(otherEntry.id), 0)).status).toBe(404);
  const { createNextWorkspaceAgent } = await import("../../src/server/agent-store.ts");
  const native = await createNextWorkspaceAgent(workspace);
  expect(native.readOnly).toBeUndefined();
  expect(native.agentId).not.toBe(imported.agentId);
  expect((await listWorkspaceAgents(workspace)).map(agent => Boolean(agent.readOnly))).toEqual([true, false]);
});
