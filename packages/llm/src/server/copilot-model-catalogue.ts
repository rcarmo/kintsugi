import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { lock } from "proper-lockfile";
import { readStoredCredential, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isJsonObject } from "@kintsugi/core";
import { readJsonSettings } from "@kintsugi/core/json-settings";
import { Type } from "typebox";
import { Value } from "typebox/value";

const provider = "github-copilot";
const accountModelsSchema = Type.Object({ data: Type.Array(Type.Object({
  id: Type.String({ minLength: 1 }),
  model_picker_enabled: Type.Optional(Type.Boolean()),
  policy: Type.Optional(Type.Object({ state: Type.Optional(Type.String()) })),
  capabilities: Type.Optional(Type.Object({ supports: Type.Optional(Type.Object({ tool_calls: Type.Optional(Type.Boolean()) })) })),
})) });

/** Refresh the account allow-list even when Copilot's inference token is still valid. */
export async function refreshGitHubCopilotModelAvailability(runtime: Pick<ModelRuntime, "getAuth">, authPath: string, signal: AbortSignal): Promise<boolean> {
  // API-key connections have no persisted OAuth allow-list; their definitions use the normal SDK refresh.
  if (readStoredCredential(provider, authPath)?.type !== "oauth") return false;
  const resolved = await runtime.getAuth(provider, { signal });
  const credential = readStoredCredential(provider, authPath);
  if (credential?.type !== "oauth" || resolved?.source !== "OAuth" || credential.access !== resolved.auth.apiKey) {
    throw new Error("Copilot sign-in changed during refresh. Try again.");
  }
  if (!resolved.auth.baseUrl) throw new Error("Copilot did not provide an account endpoint.");
  const base = new URL(resolved.auth.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Invalid Copilot account endpoint.");
  const response = await fetch(`${base.href.replace(/\/+$/, "")}/models`, {
    headers: {
      Accept: "application/json", Authorization: `Bearer ${credential.access}`,
      // Match the catalogue request identity/protocol used by Pi's Copilot OAuth provider.
      "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0",
      "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat", "X-GitHub-Api-Version": "2026-06-01",
    }, signal, redirect: "error",
  });
  if (!response.ok) throw new Error(`Copilot model list returned HTTP ${response.status}.`);
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error("Copilot returned invalid model metadata."); }
  if (!Value.Check(accountModelsSchema, body)) throw new Error("Copilot returned invalid model metadata.");
  const usable = body.data.filter(model => model.capabilities?.supports?.tool_calls !== false);
  const picker = usable.filter(model => model.model_picker_enabled === true && model.policy?.state !== "disabled");
  // Match Pi: only Individual accounts permit enabled policies when every picker flag is false.
  const selected = picker.length || base.origin !== "https://api.individual.githubcopilot.com"
    ? picker : usable.filter(model => model.policy?.state === "enabled");
  const ids = [...new Set(selected.map(model => model.id))];

  // Use the same credential-file lock as the SDK, not the app settings queue: login,
  // logout and OAuth refresh can also write this file in another process.
  let release: (() => Promise<void>) | undefined, compromised: Error | undefined;
  while (!release) {
    signal.throwIfAborted();
    try { release = await lock(authPath, { retries: 0, stale: 30_000, onCompromised(error) { compromised = error; } }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ELOCKED")) throw error;
      await sleep(50, undefined, { signal });
    }
  }
  try {
    signal.throwIfAborted();
    if (compromised) throw compromised;
    const stored = await readJsonSettings(authPath), current = stored[provider];
    if (!isJsonObject(current) || current.type !== "oauth" || current.refresh !== credential.refresh || current.access !== credential.access) {
      throw new Error("Copilot sign-in changed during refresh. Try again.");
    }
    current.availableModelIds = ids;
    signal.throwIfAborted();
    if (compromised) throw compromised;
    // Write in place, like the SDK, so symlink aliases keep using the same file and lock.
    await writeFile(authPath, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
    if (compromised) throw compromised;
  } finally { await release(); }
  return true;
}
