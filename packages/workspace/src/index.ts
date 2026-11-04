import { workspaceResourceControlAvailable } from "@kintsugi/core";
import { hostRequest } from "@kintsugi/host/control";
import { createHash } from "node:crypto";
import { workspaceHomeMounts } from "./home.ts";
import { workspaceImagePreloader } from "./preload.ts";
import type { WorkspaceImageConfigureEvent } from "./events.ts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertStorageSupport, readStorageDriver, KintsugiCoreError, kintsugiDataPath, createProcessFileLock, dockerHostKintsugiDataPath, getKintsugiRuntimeContext, invalidArguments, isJsonObject, readTextIfExists, requireDocker, runDocker, runDockerBuffer, withManagedDockerCommand, withCommandSignal, waitForCommand, shellQuote, writeJsonAtomic, type KintsugiEventBus, type CommandInput, type JsonObject } from "@kintsugi/core";
import { runTerminalProcess, tailTerminalOutput, tailTerminalText, terminalOutputDisplayBytes } from "@kintsugi/observable-terminal/server";
import { terminalProcessSocketPath } from "@kintsugi/observable-terminal/shared";
import { workspaceTerminalProcesses } from "./terminal-processes.ts";
import { errorMessage, isWorkspaceAppPort, workspaceGatewayPort, type WorkspaceGateway, type WorkspaceHttpAppBackend, type WorkspaceServerProvisioningHook } from "@kintsugi/shared";
import { inspectWorkspaceImage, resolveWorkspaceImage } from "@kintsugi/workspace-image";
import { gitCredentialHelperShellBody } from "@kintsugi/git-hosting";
import { prepareWorkspaceSystemd } from "./systemd.ts";
import { closeWorkspaceHelperConnection, refreshWorkspaceHelper, requireRootInWorkspace, runInWorkspace, workspaceParentSocketDirectory } from "./helper.ts";
import { createWorkspaceContainerLifecycle, workspaceConfigurationLabel } from "./container-lifecycle.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { applySeedConfigManifest } from "./seed-config.ts";
export { registerSeededPiAuth } from "./seed-config.ts";
import type { WorkspaceCreationContext, WorkspaceDockerMount, WorkspaceDockerPlan, WorkspaceInitInstruction } from "./types.ts";
export type { WorkspaceCreationContext, WorkspaceDockerMount, WorkspaceDockerPlan, WorkspaceInitInstruction, WorkspaceInitInstructionMap } from "./types.ts";

import { prepareWorkspaceNetwork, configureWorkspaceDns, revokeWorkspaceNetwork } from "./network.ts";
export { getNetworkConfiguration, setNetworkConfiguration, getWorkspaceNetworkMode, setWorkspaceNetworkMode, getAppliedWorkspaceNetwork, workspaceNetworkRestartRequired } from "./network.ts";
export { closeWorkspaceHelperConnection, workspaceHelperSocketPath, checkFileInWorkspace, existingFilesInWorkspace, openFileInWorkspace, readFileInWorkspace, runInWorkspace, startInWorkspace, statFilesInWorkspace, writeFileInWorkspace } from "./helper.ts";
export { WorkspaceHelperError, WorkspaceHelperStatus, type WorkspaceFileStat } from "@kintsugi/workspace-helper";
export { exitStatus as workspaceExitStatus } from "@kintsugi/workspace-helper";
export { workspaceTerminalProcesses } from "./terminal-processes.ts";
export { createWorkspaceMetadataState, type WorkspaceMetadataState } from "./metadata-state.ts";
export { ensureHostInotifyLimit } from "./host-inotify.ts";
export { createWorkspaceProvisioning, type WorkspaceProvisioning, type WorkspaceProvisionRun } from "./provisioning.ts";
import type { WorkspaceProvisionRun, WorkspaceProvisionProgress } from "./provisioning.ts";

export {
  createWorkspacePresentationStore,
  type WorkspaceWorkViewReference,
  type WorkspaceWorkViewState,
} from "./presentation.ts";

const workspaceTypeLabel = "com.kintsugi.type";
const namespaceLabel = "com.kintsugi.namespace";
const workspaceIdLabel = "com.kintsugi.workspace-id";
const titlePath = "title";
const parkedPath = "parked";
const initPath = "init.json";
const workspaceManifestPath = ".kintsugi/workspace.json";
const workspaceStartupTimeoutMs = 5 * 60_000;
const withWorkspaceIdentityLock = createProcessFileLock({
  label: "workspace identity tombstone",
  lockDir: () => kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", "identity-tombstones.lock"),
});
const dockerLabelsSchema = Type.Record(Type.String(), Type.String());
const nonBlankStringSchema = Type.String({ pattern: "\\S" });
const stringArraySchema = Type.Array(Type.String());
export const workspaceRoot = "/work";
// Reserved for VS Code. The adapter still verifies ownership before using it.
export const workspaceVSCodePort = 24800;

interface WorkspaceListResult { workspaces: Array<{ id: string; title: string | null; parked?: boolean; init?: WorkspaceInitInstruction; imageOutdated?: boolean }> }
export interface WorkspaceExecResult { exitCode: number; stdout: string; stderr: string; durationMs: number }
type WorkspaceExecBufferResult = Omit<WorkspaceExecResult, "stdout"> & { stdout: Buffer }
export interface WorkspaceCommandOptions { workdir?: string; user?: "agent" | "root"; stdin?: CommandInput; maxOutputBytes?: number }
interface DeleteWorkspaceOptions { force?: boolean; events?: KintsugiEventBus }

function namespace(): string { return process.env.ATELIER_NAMESPACE || "host"; }
export function generateWorkspaceId(): string { return crypto.randomUUID().replaceAll("-", "").slice(0, 8); }
export function workspaceContainerName(id: string): string { return `kintsugi-${id}`; }

function workspaceNetworkName(id: string): string { return `kintsugi-workspace-${id}`; }
function workspaceBridgeName(id: string): string { return `atw-${createHash("sha256").update(id).digest("hex").slice(0, 11)}`; }
function formatDeleteBlockedMessage(id: string, issues: JsonObject[]): string { return `workspace ${id} has delete blockers:\n${issues.map((issue) => `- ${JSON.stringify(issue)}`).join("\n")}\nuse --force to delete anyway`; }

async function createWorkspaceWorkDir(id: string): Promise<{ worktreePath: string; dockerHostWorktreePath: string }> {
  const runtime = getKintsugiRuntimeContext();
  const worktreePath = kintsugiDataPath(runtime, "workspaces", id, "work");
  const dockerHostWorktreePath = dockerHostKintsugiDataPath(runtime, "workspaces", id, "work");
  if (await Bun.file(worktreePath).exists()) throw new KintsugiCoreError("workspace_source_exists", `workspace source already exists: ${worktreePath}`);
  await mkdir(worktreePath, { recursive: true });
  return { worktreePath, dockerHostWorktreePath };
}

async function deleteWorkspaceWorkDir(id: string): Promise<void> {
  const runtime = getKintsugiRuntimeContext();
  await rm(kintsugiDataPath(runtime, "workspaces", id), { recursive: true, force: true });
}

async function inspectLabels(id: string): Promise<Record<string, string>> {
  const inspected = await runDocker(["inspect", "--format", "{{json .Config.Labels}}", workspaceContainerName(id)]);
  if (inspected.exitCode !== 0) throw new KintsugiCoreError("workspace_not_found", `workspace not found: ${id}`);
  const trimmed = inspected.stdout.trim();
  return trimmed && trimmed !== "null" ? Value.Parse(dockerLabelsSchema, JSON.parse(trimmed)) : {};
}

async function ensureWorkspaceFilesystem(id: string): Promise<void> {
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `test -d ${shellQuote(workspaceRoot)} && test -d /.kintsugi`]);
  if (result.exitCode !== 0) throw new KintsugiCoreError("workspace_repair_failed", result.stderr.trim() || result.stdout.trim() || `workspace filesystem is not ready for ${id}`);
}

async function waitForWorkspaceStartup(id: string): Promise<string> {
  const timeoutSeconds = Math.ceil(workspaceStartupTimeoutMs / 1000);
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `deadline=$(( $(date +%s) + ${timeoutSeconds} )); while [ "$(date +%s)" -le "$deadline" ]; do if test -f /.kintsugi/ready; then cat /.kintsugi/startup.log; exit 0; fi; if test -S /run/systemd/private && systemctl is-failed --quiet kintsugi-tmux.service kintsugi-init.service kintsugi-gateway.service; then break; fi; sleep 0.05; done; tail -n 120 /.kintsugi/startup.log; journalctl --no-pager -n 120 -u kintsugi-tmux.service -u kintsugi-init.service -u kintsugi-gateway.service; exit 1`]);
  const log = result.stdout.trim();
  if (result.exitCode === 0) return log;
  const output = result.stderr.trim();
  throw new KintsugiCoreError("workspace_startup_timeout", `workspace did not finish startup: ${id}${output ? `\n${output}` : ""}${log ? `\n\nStartup log:\n${log}` : ""}`);
}

async function validateWorkspaceContainer(id: string): Promise<Record<string, string>> {
  assertValidWorkspaceId(id);
  const labels = await inspectLabels(id);
  if (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace()) throw new KintsugiCoreError("workspace_not_found", `workspace not found: ${id}`);
  return labels;
}

export async function resolveWorkspace(id: string): Promise<string> {
  await validateWorkspaceContainer(id);
  await ensureWorkspaceFilesystem(id);
  return id;
}

export async function isWorkspaceRunning(id: string): Promise<boolean> {
  await validateWorkspaceContainer(id);
  const result = await runDocker(["inspect", "--format", "{{.State.Running}}", workspaceContainerName(id)]);
  if (result.exitCode !== 0) throw new KintsugiCoreError("workspace_not_found", `workspace not found: ${id}`);
  return result.stdout.trim() === "true";
}

function assertValidWorkspaceId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
}

function workspaceIdentityTombstonePath(): string {
  return kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", "identity-tombstones.json");
}

async function readRetiredWorkspaceIds(): Promise<Set<string>> {
  const text = await readTextIfExists(workspaceIdentityTombstonePath());
  if (text === undefined) return new Set();
  return new Set(Value.Parse(stringArraySchema, JSON.parse(text)));
}

function workspaceIdentityKey(id: string): string {
  return `${namespace()}\0${id}`;
}

async function isRetiredWorkspaceId(id: string): Promise<boolean> {
  return await withWorkspaceIdentityLock(async () => (await readRetiredWorkspaceIds()).has(workspaceIdentityKey(id)));
}

async function retireWorkspaceId(id: string): Promise<void> {
  await withWorkspaceIdentityLock(async () => {
    const retired = await readRetiredWorkspaceIds();
    retired.add(workspaceIdentityKey(id));
    await writeJsonAtomic(workspaceIdentityTombstonePath(), [...retired].sort());
  });
}

export function workspaceWorkHostPath(id: string): string {
  assertValidWorkspaceId(id);
  return kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", id, "work");
}

function workspaceMetadataDir(context: Awaited<ReturnType<typeof getKintsugiRuntimeContext>>, id: string): string {
  return kintsugiDataPath(context, "workspaces", id, "metadata");
}

function workspaceMetadataPath(context: Awaited<ReturnType<typeof getKintsugiRuntimeContext>>, id: string, name: string): string {
  return join(workspaceMetadataDir(context, id), name);
}

async function readTitle(context: Awaited<ReturnType<typeof getKintsugiRuntimeContext>>, id: string): Promise<string | null> {
  const file = Bun.file(workspaceMetadataPath(context, id, titlePath));
  if (!(await file.exists())) return null;
  return (await file.text()).replace(/\n$/, "");
}

async function readParked(context: Awaited<ReturnType<typeof getKintsugiRuntimeContext>>, id: string): Promise<boolean> {
  return await Bun.file(workspaceMetadataPath(context, id, parkedPath)).exists();
}

async function writeWorkspaceInit(context: Awaited<ReturnType<typeof getKintsugiRuntimeContext>>, id: string, init: WorkspaceInitInstruction | undefined): Promise<void> {
  if (init === undefined) return;
  await mkdir(workspaceMetadataDir(context, id), { recursive: true });
  await writeFile(workspaceMetadataPath(context, id, initPath), `${JSON.stringify(init, null, 2)}\n`);
}

export async function getWorkspaceInit(id: string): Promise<WorkspaceInitInstruction | undefined> {
  await resolveWorkspace(id);
  return await readWorkspaceInit(getKintsugiRuntimeContext(), id);
}

async function readWorkspaceInit(context: Awaited<ReturnType<typeof getKintsugiRuntimeContext>>, id: string): Promise<WorkspaceInitInstruction | undefined> {
  const file = Bun.file(workspaceMetadataPath(context, id, initPath));
  if (!(await file.exists())) return undefined;
  // SAFETY: This internal file serializes the open, declaration-merged
  // WorkspaceInitInstruction union; feature consumers validate concrete variants.
  return JSON.parse(await file.text()) as WorkspaceInitInstruction;
}

export interface RepoWorkspaceManifest {
  version: 1;
  initScripts?: string[];
  seedPiConfig?: {
    authJson?: string;
    modelsJson?: string;
    modelsStoreJson?: string;
  };
  seedKintsugiConfig?: {
    projectsJson?: string;
  };
}

function optionalString(record: JsonObject, key: string, path: string, label = key): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Value.Check(nonBlankStringSchema, value)) throw invalidArguments(`invalid ${path}: ${label} must be a non-empty string`);
  return value;
}

function optionalRecord(record: JsonObject, key: string, path: string): JsonObject | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throw invalidArguments(`invalid ${path}: ${key} must be an object`);
  return value;
}

export function parseRepoWorkspaceManifest(text: string, path = workspaceManifestPath): RepoWorkspaceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidArguments(`invalid ${path}: ${errorMessage(error)}`);
  }
  if (!isJsonObject(parsed)) throw invalidArguments(`invalid ${path}: expected object`);
  const record = parsed;
  if (record.version !== 1) throw invalidArguments(`invalid ${path}: unsupported version`);
  if (record.privileged !== undefined) throw invalidArguments(`invalid ${path}: privileged is no longer supported; use template settings`);
  if (record.isKintsugi !== undefined) throw invalidArguments(`invalid ${path}: isKintsugi is no longer supported`);
  if (record.docker !== undefined) throw invalidArguments(`invalid ${path}: docker settings are no longer supported; use template settings`);
  const initScripts = record.initScripts;
  if (initScripts !== undefined && !Value.Check(stringArraySchema, initScripts)) throw invalidArguments(`invalid ${path}: initScripts must be an array of strings`);
  const seedPiConfigRecord = optionalRecord(record, "seedPiConfig", path);
  const authJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "authJson", path, "seedPiConfig.authJson") : undefined;
  const modelsJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "modelsJson", path, "seedPiConfig.modelsJson") : undefined;
  const modelsStoreJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "modelsStoreJson", path, "seedPiConfig.modelsStoreJson") : undefined;
  const seedKintsugiConfigRecord = optionalRecord(record, "seedKintsugiConfig", path);
  const workspaceTemplatesJson = seedKintsugiConfigRecord ? optionalString(seedKintsugiConfigRecord, "projectsJson", path, "seedKintsugiConfig.projectsJson") : undefined;
  const manifest: RepoWorkspaceManifest = { version: 1 };
  if (initScripts) manifest.initScripts = initScripts;
  if (seedPiConfigRecord) {
    manifest.seedPiConfig = {};
    if (authJson) manifest.seedPiConfig.authJson = authJson;
    if (modelsJson) manifest.seedPiConfig.modelsJson = modelsJson;
    if (modelsStoreJson) manifest.seedPiConfig.modelsStoreJson = modelsStoreJson;
  }
  if (seedKintsugiConfigRecord) {
    manifest.seedKintsugiConfig = {};
    if (workspaceTemplatesJson) manifest.seedKintsugiConfig.projectsJson = workspaceTemplatesJson;
  }
  return manifest;
}

async function readRepoWorkspaceManifest(sourcePath: string): Promise<RepoWorkspaceManifest | undefined> {
  const file = Bun.file(join(sourcePath, workspaceManifestPath));
  if (!(await file.exists())) return undefined;
  return parseRepoWorkspaceManifest(await file.text(), workspaceManifestPath);
}

async function applyRepoWorkspaceManifest(workspaceId: string, sourcePath: string, plan: WorkspaceDockerPlan): Promise<void> {
  const manifest = await readRepoWorkspaceManifest(sourcePath);
  if (!manifest) return;
  const runtime = getKintsugiRuntimeContext();
  await applySeedConfigManifest(manifest, plan, runtime, kintsugiDataPath(runtime, "workspaces", workspaceId, "seed-config"));
  plan.initScripts.push(...(manifest.initScripts ?? []));
}

function workspaceExecDockerArgs(resolved: string, command: string[], options: WorkspaceCommandOptions, terminal = false): string[] {
  return ["exec", ...(terminal ? ["--interactive", "--tty"] : options.stdin !== undefined ? ["-i"] : []), "--user", options.user ?? "agent", "--env", "LANG=C.UTF-8", "--env", "LC_ALL=C.UTF-8", "--workdir", options.workdir ?? workspaceRoot, workspaceContainerName(resolved), ...command];
}

export async function execWorkspaceCommand(id: string, command: string[], options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecResult> {
  if (command.length === 0) throw invalidArguments("command is required");
  const resolved = await resolveWorkspace(id);
  const startedAt = Date.now();
  const capture: Pick<WorkspaceCommandOptions, "stdin" | "maxOutputBytes"> = { stdin: options.stdin };
  if (options.maxOutputBytes !== undefined) capture.maxOutputBytes = options.maxOutputBytes;
  const result = await runDocker(workspaceExecDockerArgs(resolved, command, options), capture);
  return { ...result, durationMs: Date.now() - startedAt };
}
export async function execWorkspaceCommandBuffer(id: string, command: string[], options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecBufferResult> {
  if (command.length === 0) throw invalidArguments("command is required");
  const resolved = await resolveWorkspace(id);
  const startedAt = Date.now();
  const capture: Pick<WorkspaceCommandOptions, "stdin" | "maxOutputBytes"> = { stdin: options.stdin };
  if (options.maxOutputBytes !== undefined) capture.maxOutputBytes = options.maxOutputBytes;
  const result = await runDockerBuffer(workspaceExecDockerArgs(resolved, command, options), capture);
  return { ...result, durationMs: Date.now() - startedAt };
}
export async function execWorkspaceShell(id: string, script: string, options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecResult> { return await execWorkspaceCommand(id, ["sh", "-lc", script], options); }

const workspaceSetupScript = ".kintsugi/setup.sh";
export const workspaceSetupProvisioningHook: WorkspaceServerProvisioningHook = {
  id: "workspace.setup",
  label: "Run repository setup",
  failurePolicy: "continue",
  async run({ workspaceId: id, events }) {
    if (!(await Bun.file(join(workspaceWorkHostPath(id), workspaceSetupScript)).exists())) {
      await events?.emit("workspace_provision_progress", { workspaceId: id, detail: `No ${workspaceSetupScript}` });
      return;
    }

    const result = await runTerminalProcess(workspaceTerminalProcesses(id), { command: `sh ${shellQuote(workspaceSetupScript)}`, cwd: workspaceRoot }, async (processId) => {
      await events?.emit("workspace_provision_progress", { workspaceId: id, terminalSocketPath: terminalProcessSocketPath(id, processId) });
    });
    await events?.emit("workspace_provision_progress", { workspaceId: id, output: tailTerminalOutput(result.output.ansi, terminalOutputDisplayBytes), terminalSocketPath: undefined });
    if (result.exitCode !== 0) throw new KintsugiCoreError("workspace_setup_failed", tailTerminalText(result.output.text) || `${workspaceSetupScript} failed with exit code ${result.exitCode}`);
  },
};

function dockerMountArg(mount: WorkspaceDockerMount): string {
  return [`type=${mount.type}`, ...(mount.source === undefined ? [] : [`src=${mount.source}`]), `dst=${mount.target}`, ...(mount.readonly ? ["readonly"] : [])].join(",");
}

function planEnvDockerArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

function workspaceCreateDockerArgs(container: string, image: string, plan: WorkspaceDockerPlan): string[] {
  return [
    "create",
    "--restart", "no",
    "--name", container,
    ...Object.entries(plan.labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
    "--network", workspaceNetworkName(plan.labels[workspaceIdLabel]!),
    ...planEnvDockerArgs(plan.env),
    ...plan.extraArgs,
    ...plan.mounts.flatMap((mount) => ["--mount", dockerMountArg(mount)]),
    "--user", "root",
    image,
    "/usr/local/bin/kintsugi-workspace-init",
  ];
}

function workspaceGitCredentialInitScript(): string {
  return `cat > /usr/local/bin/kintsugi-git-credential <<'EOF'
#!/bin/sh
${gitCredentialHelperShellBody()}
EOF
chmod 755 /usr/local/bin/kintsugi-git-credential
git config --system credential.helper '!/usr/local/bin/kintsugi-git-credential'`;
}

interface WorkspaceEnvironment {
  [name: string]: string;
}

function hostUserEnv(): WorkspaceEnvironment {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new KintsugiCoreError("unsupported_platform", "workspace containers require a POSIX host uid/gid");
  if (uid === 0 || gid === 0) throw new KintsugiCoreError("unsupported_root_user", "workspace containers require a non-root Kintsugi process");
  return { ATELIER_HOST_UID: String(uid), ATELIER_HOST_GID: String(gid) };
}

function baseWorkspacePlan(labels: Record<string, string>): WorkspaceDockerPlan {
  return { labels, env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...hostUserEnv() }, mounts: [], preloadImages: [], extraArgs: [], initScripts: [workspaceGitCredentialInitScript()], containerFiles: [], cleanup: [] };
}

function alignWorkspaceUserScript(): string {
  return `work_uid="\${ATELIER_HOST_UID:?}"
work_gid="\${ATELIER_HOST_GID:?}"
if [ "$work_uid" = 0 ] || [ "$work_gid" = 0 ]; then echo "Kintsugi must run as a non-root host user" >&2; exit 1; fi
conflict_user="$(getent passwd "$work_uid" | cut -d: -f1 || true)"
if [ -n "$conflict_user" ] && [ "$conflict_user" != agent ]; then userdel "$conflict_user"; fi
if [ "$(id -u agent)" != "$work_uid" ] || [ "$(id -g agent)" != "$work_gid" ]; then
  # Do not replace this with usermod/groupmod without profiling workspace startup.
  # The shared home already belongs to the host user; never recursively chown it.
  sed -i -E "s/^(agent:[^:]*:)[0-9]+:[0-9]+:/\\1\${work_uid}:\${work_gid}:/" /etc/passwd
  sed -i -E "s/^(agent:[^:]*:)[0-9]+:/\\1\${work_gid}:/" /etc/group
  if [ -d /.kintsugi/vscode ]; then chown -R agent:agent /.kintsugi/vscode; fi
  # VS Code writes its extensions manifest here, outside the home directory.
  # Keep installed extensions writable after aligning the image user to the host.
  if [ -d /opt/kintsugi/vscode-extensions ]; then chown -R agent:agent /opt/kintsugi/vscode-extensions; fi
fi
chown agent:agent /.kintsugi`;
}

function workspaceStartupPreambleScript(): string {
  return `set -eu
mkdir -p /.kintsugi
rm -f /.kintsugi/ready
startup_started_at_ms="$(($(date +%s%N) / 1000000))"
startup_log_path=/.kintsugi/startup.log
: > "$startup_log_path"
startup_now_ms() { now_ns="$(date +%s%N)"; echo "$((now_ns / 1000000))"; }
startup_log_step() { now_ms="$(startup_now_ms)"; printf '%s +%sms %s\\n' "$now_ms" "$((now_ms - startup_started_at_ms))" "$1" >> "$startup_log_path"; }
startup_log_failure() { status=$?; if [ "$status" -ne 0 ]; then startup_log_step "failed status=$status"; fi; }
trap startup_log_failure EXIT
startup_log_step start`;
}

function workspaceInitStepScript(id: string, script: string): string {
  return `startup_log_step ${shellQuote(`${id}.start`)}
{ ${script}
}
startup_log_step ${shellQuote(`${id}.done`)}`;
}

function workspaceInitScript(plan: WorkspaceDockerPlan): string {
  return [
    workspaceStartupPreambleScript(),
    workspaceInitStepScript("gateway-credential", "chown root:root /etc/kintsugi-workspace-gateway-token; chmod 600 /etc/kintsugi-workspace-gateway-token"),
    workspaceInitStepScript("align-user", alignWorkspaceUserScript()),
    workspaceInitStepScript("kintsugi-dir", `install -d -o agent -g agent /.kintsugi`),
    // Start after UID/GID alignment, before repository hooks can create sessions.
    workspaceInitStepScript("tmux", "systemctl start kintsugi-tmux.service"),
    ...plan.initScripts.map((script, index) => workspaceInitStepScript(`init-${index + 1}`, script)),
    "startup_log_step gateway.start",
    "trap - EXIT",
  ].join("\n");
}

export async function createWorkspace(options: { id: string; events: KintsugiEventBus; init?: WorkspaceInitInstruction; context?: WorkspaceCreationContext; run: WorkspaceProvisionRun }): Promise<void> {
  const { id, events, run } = options;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
  if (await isRetiredWorkspaceId(id)) throw invalidArguments(`workspace id has been permanently retired and cannot be reused: ${id}`);
  const context = options.context && Object.keys(options.context).length ? options.context : undefined;
  const init = options.init;
  const source = await run.step("workspace.workdir", "Create workspace directory", () => createWorkspaceWorkDir(id));
  let plan: WorkspaceDockerPlan | undefined;
  try {
    await run.step("workspace.source", "Prepare workspace source", async () => {
      await writeWorkspaceInit(getKintsugiRuntimeContext(), id, init);
      await events.emit("workspace_source_prepare", { workspaceId: id, init, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot });
    }, "retry");
    const activePlan = await run.step("workspace.plan", "Prepare workspace container plan", async () => {
      const labels = { [workspaceTypeLabel]: "workspace", [namespaceLabel]: namespace(), [workspaceIdLabel]: id, [workspaceConfigurationLabel]: "1" } satisfies Record<string, string>;
      const activePlan = baseWorkspacePlan(labels);
      plan = activePlan;
      const gatewayTokenPath = kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", id, "gateway-token");
      await writeFile(gatewayTokenPath, crypto.randomUUID() + crypto.randomUUID(), { mode: 0o600 });
      activePlan.containerFiles.push({ source: gatewayTokenPath, target: "/etc/kintsugi-workspace-gateway-token" });
      activePlan.mounts.push({ type: "bind", source: source.dockerHostWorktreePath, target: workspaceRoot });
      activePlan.mounts.push(...await workspaceHomeMounts(id));
      const sockets = kintsugiDataPath(getKintsugiRuntimeContext(), "workspace-sockets", id);
      await mkdir(join(sockets, "helper"), { recursive: true, mode: 0o700 });
      activePlan.mounts.push({ type: "bind", source: dockerHostKintsugiDataPath(getKintsugiRuntimeContext(), "workspace-sockets", id, "helper"), target: "/run/kintsugi-helper" });
      await mkdir(sockets, { recursive: true });
      activePlan.mounts.push({ type: "volume", target: "/data" });
      if (await readStorageDriver() === "erofs") activePlan.mounts.push({ type: "bind", source: "/data/erofs-cache", target: "/data/erofs-cache", readonly: true });
      activePlan.mounts.push({ type: "bind", source: dockerHostKintsugiDataPath(getKintsugiRuntimeContext(), "workspace-sockets", id), target: "/run/kintsugi-parent", readonly: true });
      await events.emit("workspace_plan_prepare", { workspaceId: id, init, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot, plan: activePlan });
      // Host modules authorize seeding before any repository-requested config is exported.
      await applyRepoWorkspaceManifest(id, source.worktreePath, activePlan);
      // Gate once, after all modules have contributed their image requests.
      if (!activePlan.privileged) activePlan.preloadImages = [];
      return activePlan;
    });
    if (!activePlan.image) {
      activePlan.image = await run.step("workspace.image", "Resolve workspace image", async () => {
        const configuration: WorkspaceImageConfigureEvent = { init };
        await events.emit("workspace_image_configure", configuration);
        return resolveWorkspaceImage({ workspaceId: id, events, sourcePath: source.worktreePath, dockerfile: configuration.dockerfile });
      });
    }
    const defaultWorkspaceFile = await run.step("workspace.preload-resolve", "Save configured preload images", () => workspaceImagePreloader.snapshot(activePlan.preloadImages, kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", id)));
    if (defaultWorkspaceFile) activePlan.containerFiles.push({ source: dirname(defaultWorkspaceFile), target: "/etc" });
    await run.step("workspace.container", "Create workspace container", async () => {
      await prepareWorkspaceSystemd(activePlan, kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", id, "systemd"), workspaceInitScript(activePlan));
      const image = activePlan.image;
      if (!image) throw new KintsugiCoreError("workspace_image_missing", "workspace image was not resolved");
      if (await readStorageDriver() === "overlayfs") {
        const inspected = JSON.parse((await requireDocker(["image", "inspect", image])).stdout)[0];
        assertStorageSupport(inspected.Config.Labels, "overlayfs");
      }
      const container = workspaceContainerName(id);
      await workspaceContainerLifecycle(id, true).snapshot(activePlan.containerFiles);
      await requireDocker(["network", "create", "--driver", "bridge", "--opt", `com.docker.network.bridge.name=${workspaceBridgeName(id)}`, "--label", `${workspaceTypeLabel}=workspace-network`, "--label", `${workspaceIdLabel}=${id}`, workspaceNetworkName(id)]);
      await requireDocker(workspaceCreateDockerArgs(container, image, activePlan));
    });
    await run.step("workspace.startup", "Initialize workspace", async () => {
      const log = await ensureWorkspaceStarted(id);
      run.report({ output: log });
    }, "retry");
    await run.step("workspace.preparation", "Prepare workspace", async () => {
      await prepareWorkspaceRuntime(id, (detail) => run.report({ detail }), (progress) => run.report(progress));
    }, "retry-or-continue");
  } catch (error) {
    // Cancellation hands ownership to deletion, which reviews files before removing them.
    if (run.signal.aborted) throw error;
    try {
      const removed = await runDocker(["rm", "-f", "--volumes", workspaceContainerName(id)]);
      if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) throw new Error(removed.stderr.trim() || "could not remove failed workspace container");
      const networks = await requireDocker(["network", "ls", "--quiet", "--filter", `name=^${workspaceNetworkName(id).replaceAll(".", "\\.")}$`]);
      if (networks.stdout.trim()) await requireDocker(["network", "rm", workspaceNetworkName(id)]);
      await events.emit("workspace_deleted", { workspaceId: id });
      await rm(kintsugiDataPath(getKintsugiRuntimeContext(), "workspace-sockets", id), { recursive: true, force: true });
      closeWorkspaceHelperConnection(id);
      await Promise.all((plan?.cleanup ?? []).map((cleanup) => cleanup()));
      await deleteWorkspaceWorkDir(id);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `workspace ${id} provisioning and cleanup failed; ownership records retained`);
    }
    throw error;
  }
}

const workspaceGatewayCache = new Map<string, Promise<WorkspaceGateway>>();

function workspaceGatewayCacheKey(id: string): string {
  return `${namespace()}\0${id}`;
}

async function inspectWorkspaceGateway(id: string): Promise<WorkspaceGateway> {
  await resolveWorkspace(id);
  const result = await requireDocker(["inspect", "--format", `{{with index .NetworkSettings.Networks "${workspaceNetworkName(id)}"}}{{.IPAddress}}{{end}}`, workspaceContainerName(id)]);
  const address = result.stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new KintsugiCoreError("workspace_gateway_unavailable", `Workspace ${id} has no address on its dedicated network`);
  const token = await readFile(kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", id, "gateway-token"), "utf8");
  return { url: new URL(`http://${address}:${workspaceGatewayPort}`), token };
}

async function workspaceGateway(id: string): Promise<WorkspaceGateway> {
  const key = workspaceGatewayCacheKey(id);
  let gateway = workspaceGatewayCache.get(key);
  if (!gateway) {
    gateway = withCommandSignal(AbortSignal.timeout(30_000), () => inspectWorkspaceGateway(id)).catch((error) => {
      workspaceGatewayCache.delete(key);
      throw error;
    });
    workspaceGatewayCache.set(key, gateway);
  }
  return await waitForCommand(gateway);
}

/** Resolve any workspace-local web app through the workspace gateway on its dedicated bridge. */
export async function workspacePortBackend(id: string, port: number, pathAndSearch: string, protocol = "http:"): Promise<WorkspaceHttpAppBackend> {
  if (!isWorkspaceAppPort(port)) throw invalidArguments(`Invalid workspace app port ${port}: use 1–65535, except reserved gateway port ${workspaceGatewayPort}`);
  if (protocol !== "http:" && protocol !== "https:") throw invalidArguments("Workspace apps must use HTTP or HTTPS");
  const path = pathAndSearch.startsWith("/") ? pathAndSearch : `/${pathAndSearch}`;
  // Concatenation, not URL resolution: // in an app path must never change hosts.
  const target = new URL(`${protocol}//127.0.0.1:${port}${path}`);
  return { kind: "http", target, gateway: await workspaceGateway(id) };
}

export async function workspaceImageOutdated(id: string, container = workspaceContainerName(id), events?: KintsugiEventBus): Promise<boolean> {
  const configuration: WorkspaceImageConfigureEvent = { init: await readWorkspaceInit(getKintsugiRuntimeContext(), id) };
  await events?.emit("workspace_image_configure", configuration);
  const [expectedImageId, actualImage] = await Promise.all([
    inspectWorkspaceImage({ sourcePath: workspaceWorkHostPath(id), dockerfile: configuration.dockerfile }),
    requireDocker(["inspect", "--format", "{{.Image}}", container]),
  ]);
  return expectedImageId === undefined || actualImage.stdout.trim() !== expectedImageId;
}

/** Discovery can skip image inspection so server startup only reads workspace identity. */
export async function listWorkspaces(options: { inspectImages?: boolean; events?: KintsugiEventBus } = {}): Promise<WorkspaceListResult> {
  const context = getKintsugiRuntimeContext();
  const listed = await requireDocker(["ps", "-a", "--filter", `label=${workspaceTypeLabel}=workspace`, "--filter", `label=${namespaceLabel}=${namespace()}`, "--format", `{{.ID}}\t{{.Label "${workspaceIdLabel}"}}`]);
  const workspaces = await Promise.all(listed.stdout.trim().split(/\n+/).filter(Boolean).map(async (line) => {
    const [containerId, labelledId] = line.split("\t");
    const id = labelledId?.trim() || containerId!.slice(0, 8);
    const [parked, init, title, imageOutdated] = await Promise.all([
      readParked(context, id),
      readWorkspaceInit(context, id),
      readTitle(context, id),
      options.inspectImages === false ? false : workspaceImageOutdated(id, containerId, options.events),
    ]);
    const workspace: WorkspaceListResult["workspaces"][number] = { id, title };
    if (parked) workspace.parked = parked;
    if (init !== undefined) workspace.init = init;
    if (imageOutdated) workspace.imageOutdated = imageOutdated;
    return workspace;
  }));
  return { workspaces };
}

export async function deleteWorkspace(id: string, options: DeleteWorkspaceOptions = {}): Promise<null> {
  assertValidWorkspaceId(id);
  let containerExists = true;
  if (options.force) {
    const labels = await inspectLabels(id).catch((error) => {
      if (error instanceof KintsugiCoreError && error.code === "workspace_not_found") return undefined;
      throw error;
    });
    if (labels && (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace())) throw new KintsugiCoreError("workspace_not_found", `workspace not found: ${id}`);
    containerExists = labels !== undefined;
  } else {
    await resolveWorkspace(id);
    const issues: JsonObject[] = [];
    await options.events?.emit("workspace_delete_inspect", { workspaceId: id, issues });
    if (issues.length > 0) throw new KintsugiCoreError("workspace_delete_blocked", formatDeleteBlockedMessage(id, issues), { workspaceId: id, issues });
  }
  // Join workspace consumers while their container and persisted files still exist.
  await options.events?.emit("workspace_deleting", { workspaceId: id });
  if (containerExists) await requireDocker(["rm", "-f", "--volumes", workspaceContainerName(id)]);
  const networks = await requireDocker(["network", "ls", "--quiet", "--filter", `name=^${workspaceNetworkName(id).replaceAll(".", "\\.")}$`]);
  if (networks.stdout.trim()) await requireDocker(["network", "rm", workspaceNetworkName(id)]);
  await revokeWorkspaceNetwork(id);
  await retireWorkspaceId(id);
  workspaceGatewayCache.delete(workspaceGatewayCacheKey(id));
  await options.events?.emit("workspace_deleted", { workspaceId: id });
  await rm(kintsugiDataPath(getKintsugiRuntimeContext(), "workspace-sockets", id), { recursive: true, force: true });
  closeWorkspaceHelperConnection(id);
  await deleteWorkspaceWorkDir(id);
  return null;
}

export async function getWorkspaceTitle(id: string): Promise<string | null> {
  await resolveWorkspace(id);
  return await readTitle(getKintsugiRuntimeContext(), id);
}

export async function setWorkspaceTitle(id: string, title: string): Promise<null> {
  await resolveWorkspace(id);
  const context = getKintsugiRuntimeContext();
  await mkdir(workspaceMetadataDir(context, id), { recursive: true });
  await writeFile(workspaceMetadataPath(context, id, titlePath), title);
  return null;
}

function workspaceContainerLifecycle(id: string, checkpointRequired: boolean, recover = false) {
  return createWorkspaceContainerLifecycle({
    directory: kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", id, "configuration"),
    container: workspaceContainerName(id), checkpointRequired,
    waitForStartup: () => waitForWorkspaceStartup(id),
    started: () => refreshWorkspaceHelper(id, workspaceContainerName(id)),
    beforeStart: async () => {
      if (await isWorkspaceRunning(id)) return;
      const resourceControl = await workspaceResourceControlAvailable();
      if (!resourceControl && await Bun.file(kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", id, "metadata", "resource-policy.json")).exists()) throw new Error("Configured workspace resources require newer System services before starting workspaces.");
      if (resourceControl) await hostRequest({ operation: "resources", workspaceId: id, recover });
      const policy = await prepareWorkspaceNetwork(id);
      await configureWorkspaceDns(id, policy);
    },
  });
}

/** Complete interrupted configuration before starting; never rerun planning hooks. */
export async function ensureWorkspaceStarted(id: string, recover = false): Promise<string> {
  const labels = await validateWorkspaceContainer(id);
  const lifecycle = workspaceContainerLifecycle(id, labels[workspaceConfigurationLabel] === "1", recover);
  const log = await lifecycle.ensureStarted();
  workspaceGatewayCache.delete(workspaceGatewayCacheKey(id));
  return log;
}

/** Give the gateway 15 seconds to boot before reporting a recoverable startup failure. */
async function checkWorkspaceGateway(id: string): Promise<void> {
  await workspaceGateway(id);
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `deadline=$(( $(date +%s) + 15 )); while [ "$(date +%s)" -lt "$deadline" ]; do if test "$(curl --noproxy '*' --silent --max-time 1 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:${workspaceGatewayPort}/)" = 401; then exit 0; fi; sleep 0.05; done; exit 1`]);
  if (result.exitCode !== 0) throw new KintsugiCoreError("workspace_gateway_unavailable", `Workspace gateway did not become ready within 15 seconds.${result.stderr.trim() ? `\n${result.stderr.trim()}` : ""}`);
}

export async function stopWorkspaceContainer(id: string): Promise<void> {
  await validateWorkspaceContainer(id);
  await requireDocker(["stop", "--time", "10", workspaceContainerName(id)]);
  closeWorkspaceHelperConnection(id);
  workspaceGatewayCache.delete(workspaceGatewayCacheKey(id));
}

export async function setWorkspaceParked(id: string, parked: boolean, recover = false): Promise<null> {
  await validateWorkspaceContainer(id);
  const context = getKintsugiRuntimeContext();
  await mkdir(workspaceMetadataDir(context, id), { recursive: true });
  const path = workspaceMetadataPath(context, id, parkedPath);
  if (parked) {
    if (await workspaceResourceControlAvailable()) await hostRequest({ operation: "resources", workspaceId: id, action: "park" });
    await writeFile(path, "");
    await stopWorkspaceContainer(id);
  } else {
    await ensureWorkspaceStarted(id, recover);
    await rm(path, { force: true });
  }
  return null;
}

/** Repeated on resume and app start; the persisted list never rereads template settings. */
export async function prepareWorkspaceRuntime(id: string, report: (detail: string) => void = () => {}, activity: (progress: WorkspaceProvisionProgress) => void = () => {}): Promise<void> {
  report("Checking workspace gateway");
  await checkWorkspaceGateway(id);
  for (const socket of ["ingress", "egress"]) {
    report(`Checking ${socket} proxy`);
    await requireDocker(["exec", "--user", "root", workspaceContainerName(id), "curl", "--noproxy", "*", "--fail", "--silent", "--max-time", "5", "--unix-socket", `/run/kintsugi-parent/${socket}.sock`, "http://localhost/health"]);
  }
  report("Checking workspace image service");
  await requireDocker(["exec", "--user", "root", workspaceContainerName(id), "curl", "--noproxy", "*", "--fail", "--silent", "--max-time", "5", "http://127.0.0.1:58124/health"]);
  report("Resolving required images");
  const images = await workspaceImagePreloader.load(kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", id), report);
  await workspaceImagePreloader.install(images, workspaceContainerName(id), report, activity);
}

export { inspectWorkspaceResources, configureWorkspaceResources } from "./resources.ts";
