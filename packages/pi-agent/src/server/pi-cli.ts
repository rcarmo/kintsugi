import { shellQuote } from "@kintsugi/core";
import { execWorkspaceShell } from "@kintsugi/workspace";
import { createPiModelRuntime, getEnabledModels } from "@kintsugi/llm/server";
import { createPiCliConfiguration } from "./pi-cli-bridge.ts";

/** Pi's standard config location is managed by Kintsugi; other Pi settings are preserved. */
export async function installPiCliConfiguration(workspaceId: string): Promise<void> {
  const configuration = await createPiCliConfiguration(await createPiModelRuntime(), await getEnabledModels());
  const script = `
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(require('node:os').homedir(), '.pi', 'agent');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const settingsPath = path.join(directory, 'settings.json');
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
Object.assign(settings, { enabledModels: input.enabledModels, transport: 'sse', enableAnalytics: false });
for (const [name, content] of Object.entries({ 'auth.json': input.auth, 'models.json': input.models, 'settings.json': settings })) {
  const target = path.join(directory, name);
  const temporary = target + '.' + require('node:crypto').randomUUID();
  fs.writeFileSync(temporary, JSON.stringify(content, null, 2) + '\\n', { mode: 0o600 });
  fs.renameSync(temporary, target);
}
`;
  const result = await execWorkspaceShell(workspaceId, `set -eu
umask 077
mkdir -p "$HOME/.pi/agent"
flock "$HOME/.pi/kintsugi-config.lock" node -e ${shellQuote(script)}`, { stdin: JSON.stringify(configuration) });
  if (result.exitCode !== 0) throw new Error(`Could not configure Pi: ${result.stderr.trim() || result.stdout.trim()}`);
}
