#!/usr/bin/env bun

import { resolve } from "node:path";
import type { JsonObject } from "@kintsugi/core";

const previewNamespace = "kintsugi-redesign-preview";
const previewTitle = "Kintsugi redesign preview";
const previewTerminalTitle = "Terminal";
const defaultBaseUrl = "http://127.0.0.1:3000";
const repoRoot = resolve(new URL("..", import.meta.url).pathname);

interface WorkspaceSummary { id: string; title: string; phase: { kind: string; status?: string; busy: boolean } }
interface WorkView { reference: { type: string; path?: string; browserId?: string; terminalId?: string; title?: string }; requestingAttention: boolean }
interface WorkspaceState {
  id: string;
  title: string;
  phase: { kind: string; status?: string; busy: boolean };
  url: string;
  agents?: Array<{ id: string; title: string }>;
  workViews?: WorkView[];
}

async function api<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers({ Accept: "application/json", Origin: new URL(baseUrl).origin });
  if (init?.body) headers.set("Content-Type", "application/json");
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed (${response.status}): ${await response.text()}`);
  // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
  return await response.json() as T;
}

async function post<T>(baseUrl: string, path: string, body: JsonObject = {}): Promise<T> {
  return await api<T>(baseUrl, path, { method: "POST", body: JSON.stringify(body) });
}

async function waitForServer(server?: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) throw new Error(`Kintsugi dev server exited with code ${server.exitCode}`);
    if ((await fetch(`${defaultBaseUrl}/up`).catch(() => undefined))?.ok) return;
    await Bun.sleep(250);
  }
  throw new Error(`Kintsugi did not become ready at ${defaultBaseUrl} within 120 seconds`);
}

async function workspace(baseUrl: string): Promise<WorkspaceState> {
  const summaries = (await api<{ workspaces: WorkspaceSummary[] }>(baseUrl, "/workspaces")).workspaces;
  const summary = summaries.find((candidate) => candidate.title === previewTitle && candidate.phase.status !== "failed")
    ?? (await post<{ workspace: WorkspaceState }>(baseUrl, "/workspaces", { source: { type: "empty" }, title: previewTitle })).workspace;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = (await api<{ workspace: WorkspaceState }>(baseUrl, `/workspaces/${summary.id}`)).workspace;
    if (state.phase.kind === "runningPhase") return state;
    if (state.phase.status === "failed") throw new Error("preview workspace failed to start");
    await Bun.sleep(500);
  }
  throw new Error("preview workspace did not become ready within 120 seconds");
}

async function state(baseUrl: string, workspaceId: string): Promise<WorkspaceState> {
  return (await api<{ workspace: WorkspaceState }>(baseUrl, `/workspaces/${workspaceId}`)).workspace;
}

export async function preparePreview(baseUrl = defaultBaseUrl): Promise<string> {
  const previewWorkspace = await workspace(baseUrl);
  let current = await state(baseUrl, previewWorkspace.id);
  const has = (type: string) => current.workViews?.some((view) => view.reference.type === type) ?? false;

  if (!has("browser")) await post(baseUrl, `/workspaces/${current.id}/commands/browser.create`, { url: "https://github.com/rcarmo/kintsugi" });
  if (!has("terminal")) await post(baseUrl, `/workspaces/${current.id}/commands/terminal.create`, { title: previewTerminalTitle });
  if (!has("files")) await post(baseUrl, `/workspaces/${current.id}/commands/files.create`);
  if (!has("vscode")) await post(baseUrl, `/workspaces/${current.id}/commands/vscode.open`);

  current = await state(baseUrl, current.id);
  const browser = current.workViews?.find((view) => view.reference.type === "browser");
  if (!browser?.reference.browserId) throw new Error("preview Browser Work view was not opened");
  const destination = `browser:${browser.reference.browserId}`;
  return `${baseUrl}${current.url}?${new URLSearchParams({ workView: destination })}`;
}

if (import.meta.main) {
  const prepareOnly = process.argv.includes("--prepare-only");
  const server = prepareOnly ? undefined : Bun.spawn(["bun", "run", "web"], {
    cwd: repoRoot,
    env: { ...process.env, KINTSUGI_NAMESPACE: previewNamespace },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  try {
    await waitForServer(server);
    const previewUrl = await preparePreview();
    console.log(`\n[redesign-preview] ready: ${previewUrl}`);
    console.log(`[redesign-preview] namespace: ${previewNamespace}`);
    console.log("[redesign-preview] stop with Ctrl-C; rerun this command to restore the fixture\n");
    if (server) process.exit(await server.exited);
  } catch (error) {
    server?.kill();
    throw error;
  }
}
