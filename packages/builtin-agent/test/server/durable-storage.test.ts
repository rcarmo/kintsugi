import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { durableJournalDirectory, durableJournalMountPath, workspaceDurableJournalDirectory } from "../../src/server/durable-storage.ts";
import { openDurableAgentRuntime, type DurableAgentRuntime } from "../../src/server/durable-runtime.ts";

const previousDataDir = process.env.KINTSUGI_DATA_DIR;
const paths: string[] = [];
const runtimes: DurableAgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.suspend()));
  if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = previousDataDir;
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function dataDirectory() {
  const path = await mkdtemp(join(tmpdir(), "kintsugi-durable-storage-"));
  paths.push(path);
  process.env.KINTSUGI_DATA_DIR = path;
  return path;
}

async function workspaceTemplate(root: string, workspaceId: string, shareKey: string) {
  const metadata = join(root, "workspaces", workspaceId, "metadata");
  await mkdir(metadata, { recursive: true });
  await writeFile(join(metadata, "init.json"), JSON.stringify({ type: "project.git", projectId: "project", name: "repo", gitUrl: "https://example.com/repo.git", branch: null, sessionShareKey: shareKey }));
}

test("journals use the existing project share outside disposable workspace files", async () => {
  const root = await dataDirectory();
  await workspaceTemplate(root, "one", "Product Suite");
  await workspaceTemplate(root, "two", "Other Product");
  expect(await workspaceDurableJournalDirectory("one")).toBe(join(root, "session-shares", "product-suite", "builtin-durable", "one"));
  expect(await workspaceDurableJournalDirectory("two")).toBe(join(root, "session-shares", "other-product", "builtin-durable", "two"));
  expect(await workspaceDurableJournalDirectory("scratch")).toBe(join(root, "session-shares", "projectless", "builtin-durable", "scratch"));
  expect(durableJournalMountPath("one")).toBe("/kintsugi/session-share/builtin-durable/one");
  for (const id of ["../escape", "/absolute", ".", "..", "nested/path", ""]) {
    expect(() => durableJournalDirectory("share", id, root)).toThrow("invalid workspace id");
    await expect(workspaceDurableJournalDirectory(id, root)).rejects.toThrow("invalid workspace id");
  }
});

test("workspace journal retains the original searchable journal and deletion gate after workspace files are removed", async () => {
  const root = await dataDirectory();
  await workspaceTemplate(root, "retained", "Product Suite");
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Retained answer")]);
  const load = {
    harness: async () => ({ models, registry: createRegistry() }),
    prepare: async () => ({ model: { provider: "faux", modelId: "faux-1" } }),
    expand: async (_workspace: string, text: string) => text,
    validateModel: async (_ref: { provider: string; modelId: string } | undefined) => {},
    ready: async () => {},
  };
  const runtime = await openDurableAgentRuntime(await workspaceDurableJournalDirectory("retained"), "retained", {}, load);
  runtimes.push(runtime);
  const record = { agentId: "tab", label: "Agent 1", title: "Retained history" };
  const agent = await runtime.agent(record);
  await (await agent.submit({ requestId: "retained-request", text: "Searchable retained input" })).wait(BACKGROUND_CONTEXT);
  await runtime.delete();
  await runtime.suspend();
  await rm(join(root, "workspaces", "retained"), { recursive: true });
  // A retained-history listing knows its share; never resolve a deleted
  // workspace through its now-absent metadata (which would mean projectless).
  const directory = durableJournalDirectory("Product Suite", "retained", root);
  expect(await readFile(join(directory, "main.jsonl"), "utf8")).toContain("Searchable retained input");
  load.ready = async () => { throw new Error("Deleted workspace is unavailable"); };
  const restored = await openDurableAgentRuntime(directory, "retained", {}, load);
  runtimes.push(restored);
  expect((await restored.catalog())[0]?.title).toBe("Retained history");
  const history = await restored.agent(record);
  expect(JSON.stringify((await history.history({}, 100, undefined, BACKGROUND_CONTEXT)).items)).toContain("Retained answer");
  await expect(history.submit({ requestId: "retained-request", text: "Retry" })).rejects.toThrow("deleted");
  expect(faux.state.callCount).toBe(1);
});
