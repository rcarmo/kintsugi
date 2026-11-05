import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHistoryFiles } from "../../claude-cli-agent/src/server/transcript.ts";
import { codexHistoryFiles } from "../../codex-cli-agent/src/server/transcript.ts";
import { piHistoryFiles } from "../../pi-agent/src/server/transcript.ts";
import { exportCliHistory } from "../src/server/history.ts";

let directory: string;
async function setup() {
  directory = await mkdtemp(join(tmpdir(), "cli-history-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  const metadata = join(directory, "workspaces", "workspace", "metadata");
  await mkdir(metadata, { recursive: true });
  await writeFile(join(metadata, "init.json"), JSON.stringify({ type: "project.git", projectId: "p", name: "repo", gitUrl: "https://example.com/repo.git", branch: null, sessionShareKey: "Team Project" }));
  return directory;
}
afterEach(async () => {
  delete process.env.KINTSUGI_DATA_DIR;
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function source(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

test("exports native Pi and Codex CLI sessions beside built-in sessions, without config or sidecars", async () => {
  const root = await setup();
  const local = join(root, "workspaces", "workspace", "home-local", ".local", "share");
  await source(join(local, "pi", "sessions", "tab", "-work", "native-pi.jsonl"), "pi turn 1\n");
  await source(join(local, "kintsugi-agents", "tab", "codex", "sessions", "2026", "rollout-123.jsonl"), "codex turn 1\n");
  await source(join(local, "kintsugi-agents", "tab", "codex", "config.toml"), "secret");
  const shared = join(root, "session-shares", "team-project");
  await exportCliHistory("workspace", "pi", "tab", "named-task", await piHistoryFiles("workspace", "tab"));
  await exportCliHistory("workspace", "codex-cli", "tab", "named-task", await codexHistoryFiles("workspace", "tab"));
  expect((await readdir(shared)).sort()).toEqual([
    "codex-cli--named-task--workspace--tab--rollout-123.jsonl",
    "pi--named-task--workspace--tab--native-pi.jsonl",
  ]);
  await source(join(local, "pi", "sessions", "tab", "-work", "native-pi.jsonl"), "pi turn 1\npi turn 2\n");
  await exportCliHistory("workspace", "pi", "tab", "named-task", await piHistoryFiles("workspace", "tab"));
  expect(await Bun.file(join(shared, "pi--named-task--workspace--tab--native-pi.jsonl")).text()).toBe("pi turn 1\npi turn 2\n");
});

test("exports only Claude's session ID from the shared home", async () => {
  const root = await setup();
  const home = join(root, "home", ".claude", "projects", "-work");
  await source(join(home, "tab.jsonl"), "correct\n");
  await source(join(home, "other.jsonl"), "unrelated\n");
  await exportCliHistory("workspace", "claude", "tab", "named-task", await claudeHistoryFiles("workspace", "tab"));
  const shared = join(root, "session-shares", "team-project");
  expect(await readdir(shared)).toEqual(["claude--named-task--workspace--tab--tab.jsonl"]);
  expect(await Bun.file(join(shared, "claude--named-task--workspace--tab--tab.jsonl")).text()).toBe("correct\n");
});

test("missing native session does not publish an empty transcript", async () => {
  const root = await setup();
  await exportCliHistory("workspace", "pi", "tab", "named-task", await piHistoryFiles("workspace", "tab"));
  expect(await Bun.file(join(root, "session-shares", "team-project", "pi--named-task--workspace--tab--tab.jsonl")).exists()).toBe(false);
});
