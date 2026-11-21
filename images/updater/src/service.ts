import { requiredResourceStateVersion, assertResourceStateCompatible } from "../../../packages/shared/src/resource-compatibility.ts";
import { requiredNetworkStateVersion, assertNetworkStateCompatible } from "../../../packages/shared/src/network-compatibility.ts";
import { systemVersionLabel, networkPolicyVersionLabel, resourcePolicyVersionLabel } from "../../../packages/shared/src/system-version.ts";
import { assertSystemCompatible, assertImagePairCompatible } from "../../../packages/shared/src/system-version.ts";
import { readStorageDriver, assertStorageSupport } from "../../../packages/core/src/storage-driver.ts";
import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readReleaseSettings, releaseReference } from "../../../packages/shared/src/release-source.ts";
import { installationUpdateSchema, updaterSocket, type InstallationPlan, type InstallationUpdate } from "../../../packages/shared/src/installation-update.ts";
import { createReleaseRegistry } from "../../system/src/release-registry.ts";
import { resolveImage, type PlannedImage } from "../../../packages/update/src/server/registry.ts";

export interface CommandResult { code: number; stdout: string; stderr?: string }
export type UpdaterCommand = (args: string[], timeoutMs?: number) => Promise<CommandResult>;
const execute: UpdaterCommand = async (args, timeoutMs = 45 * 60_000) => {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  // Never reflect Docker/installer output: it may contain registry credentials or user data.
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer); return { code, stdout, stderr };
};
const imageMetadata = Type.Object({ Id: Type.String(), RepoDigests: Type.Optional(Type.Array(Type.String())), Config: Type.Object({ Labels: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()])) }) });
type Metadata = import("typebox").Static<typeof imageMetadata>;
// An older installer can copy this updater without applying its new boot rule.
// Install the owned rule on service startup too, before the next host reboot.
export async function ensureUpdaterBootDirectory(rule = "/etc/tmpfiles.d/kintsugi-updater.conf", command: UpdaterCommand = execute): Promise<void> {
  await mkdir(dirname(rule), { recursive: true });
  const temporary = `${rule}.${crypto.randomUUID()}`;
  await writeFile(temporary, "d /run/kintsugi-updater 0700 root root -\n", { mode: 0o644, flag: "wx" });
  await chmod(temporary, 0o644);
  await rename(temporary, rule);
  const result = await command(["systemd-tmpfiles", "--create", rule]);
  if (result.code !== 0) throw new Error("Cannot prepare the host updater boot directory");
}

export interface UpdaterOptions { directory: string; installer: string; systemName?: string; command?: UpdaterCommand; resolve?: (reference: string, directory: string) => Promise<PlannedImage>; updated?: () => void }

/** Owns only one installation. Requests never supply commands, repositories, credentials or paths. */
export class InstallationUpdater {
  private state: InstallationUpdate = { phase: "idle", message: "Check for installation updates." };
  private checking = false;
  private starting = false;
  private operation: Promise<void> | undefined;
  private readonly name: string;
  private readonly command: UpdaterCommand;
  constructor(private readonly options: UpdaterOptions) {
    this.name = options.systemName ?? "kintsugi-system";
    Value.Assert(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$" }), this.name);
    this.command = options.command ?? execute;
  }
  private async diagnostic(message: string) {
    await appendFile(join(this.options.directory, "diagnostics.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  }
  private async commandFailure(operation: string, result: CommandResult) {
    await this.diagnostic(`${operation} exited ${result.code}\n${result.stdout}\n${result.stderr ?? ""}`);
  }
  private async run(args: string[], timeoutMs?: number) {
    const result = await this.command(args, timeoutMs);
    if (result.code !== 0) {
      await this.commandFailure(args[0]!, result);
      throw Error("Installation operation failed; inspect private host diagnostics.");
    }
    return result.stdout.trim();
  }
  private async persist() {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const path = join(this.options.directory, "state.json"); await writeFile(path + ".next", JSON.stringify(this.state) + "\n", { mode: 0o600 }); await rename(path + ".next", path);
  }
  async initialize() {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 }); await chmod(this.options.directory, 0o700);
    let text: string;
    try { text = await readFile(join(this.options.directory, "state.json"), "utf8"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    this.state = Value.Parse(installationUpdateSchema, JSON.parse(text));
    if (this.state.phase === "preparing" || this.state.phase === "updating") {
      this.state = { ...this.state, phase: "failed", message: "The host updater was interrupted. Inspect installation health before retrying or rolling back." }; await this.persist();
    }
  }
  snapshot(): InstallationUpdate { return structuredClone(this.state); }
  async wait() { await this.operation; }
  private async installation() {
    const data = await this.run(["docker", "inspect", "--format", '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}', this.name]);
    if (!data.startsWith("/") || data.includes("\n")) throw Error("Installation data mount is unavailable.");
    const systemId = await this.run(["docker", "inspect", "--format", "{{.Image}}", this.name]);
    const system = Value.Parse(Type.Array(imageMetadata), JSON.parse(await this.run(["docker", "image", "inspect", systemId])))[0]!;
    const app = Value.Parse(Type.Array(imageMetadata), JSON.parse(await this.run(["docker", "exec", this.name, "docker", "image", "inspect", await this.run(["docker", "exec", this.name, "docker", "inspect", "--format", "{{.Image}}", "kintsugi"])])))[0]!;
    const settings = await readReleaseSettings(join(data, "app/update.json"));
    const selection = createHash("sha256").update(JSON.stringify(settings)).digest("hex");
    return { data, settings, selection, system, app };
  }
  private async resolve(reference: string, data: string) {
    if (this.options.resolve) return this.options.resolve(reference, data);
    return resolveImage(reference, await createReleaseRegistry(join(data, "supervisor/docker-auth")).fetcher());
  }
  private matches(image: Metadata, plan: PlannedImage) {
    return Boolean(plan.revision && image.Config.Labels?.["org.opencontainers.image.revision"] === plan.revision)
      || Boolean(image.RepoDigests?.some(reference => reference === plan.reference || reference.endsWith("@" + (plan.indexDigest ?? plan.reference.split("@")[1]))));
  }
  private async inspectPair(app: string, system: string, data: string): Promise<void> {
    const systemImage = Value.Parse(Type.Array(imageMetadata), JSON.parse(await this.run(["docker", "image", "inspect", system], 10_000)))[0];
    const appImage = Value.Parse(Type.Array(imageMetadata), JSON.parse(await this.run(["docker", "exec", this.name, "docker", "image", "inspect", app], 10_000)))[0];
    if (!appImage || !systemImage) throw Error("Retained image pair is unavailable.");
    assertImagePairCompatible(appImage.Config.Labels, systemImage.Config.Labels);
    assertNetworkStateCompatible(await requiredNetworkStateVersion(data), appImage.Config.Labels, systemImage.Config.Labels);
    assertResourceStateCompatible(await requiredResourceStateVersion(data), appImage.Config.Labels, systemImage.Config.Labels);
  }
  async check() {
    if (this.operation || this.checking || this.starting) return this.snapshot();
    this.checking = true;
    try {
      const current = await this.installation();
      if (this.state.phase === "ready" && this.state.plan?.selection === current.selection && this.state.plan.previousApp === current.app.Id && this.state.plan.previousSystem === current.system.Id) { await this.inspectPair(this.state.plan.app, this.state.plan.system, current.data); return this.snapshot(); }
      const [app, system] = await Promise.all([this.resolve(releaseReference(current.settings, "app"), current.data), this.resolve(releaseReference(current.settings, "system"), current.data)]);
      assertSystemCompatible(system.systemVersion ?? 0, app.requiredSystemVersion ?? 0);
      assertNetworkStateCompatible(await requiredNetworkStateVersion(current.data), { [networkPolicyVersionLabel]: String(app.networkPolicyVersion ?? 0) }, { [systemVersionLabel]: String(system.systemVersion ?? 0) });
      assertResourceStateCompatible(await requiredResourceStateVersion(current.data), { [resourcePolicyVersionLabel]: String(app.resourcePolicyVersion ?? 0) }, { [systemVersionLabel]: String(system.systemVersion ?? 0) });
      if ((await this.installation()).selection !== current.selection) throw Error("Release selection changed. Check again.");
      const plan: InstallationPlan = { id: crypto.randomUUID(), app: app.reference, system: system.reference, available: !this.matches(current.app, app) || !this.matches(current.system, system), selection: current.selection, previousApp: current.app.Id, previousSystem: current.system.Id };
      this.state = { retainedPlan: this.state.retainedPlan, phase: plan.available ? "available" : "idle", plan, message: plan.available ? "An installation update is available." : "The installation matches the selected releases." }; await this.persist(); return this.snapshot();
    } catch (error) {
      await this.diagnostic("Discovery or compatibility check failed: " + String(error));
      this.state = { retainedPlan: this.state.retainedPlan, phase: "failed", message: "Release discovery or compatibility checks failed. The running installation has not been changed." };
      await this.persist();
      throw error;
    } finally { this.checking = false; }
  }
  private requirePlan(id: string, phase: InstallationUpdate["phase"]) {
    if (this.checking || this.starting || this.operation || !this.state.plan || this.state.plan.id !== id || this.state.phase !== phase) throw Error("This update plan is not ready. Check the installation again.");
    this.starting = true;
    return this.state.plan;
  }
  async prepare(id: string) {
    const plan = this.requirePlan(id, "available"); try {      
this.state = { ...this.state, phase: "preparing", message: "Downloading System, app and workspace dependencies…" }; await this.persist();
      this.operation = (async () => {
        try {
          const current = await this.installation(); if (current.selection !== plan.selection) throw Error("Release selection changed.");
          const [appPlan, systemPlan] = await Promise.all([this.resolve(plan.app, current.data), this.resolve(plan.system, current.data)]);
          assertSystemCompatible(systemPlan.systemVersion ?? 0, appPlan.requiredSystemVersion ?? 0);
          await this.run(["docker", "--config", join(current.data, "supervisor/docker-auth"), "pull", plan.system]);
          const metadata = Value.Parse(Type.Array(imageMetadata), JSON.parse(await this.run(["docker", "image", "inspect", plan.system])))[0]!;
          if (metadata.Config.Labels?.["kintsugi.installer-config"] !== "1" || metadata.Config.Labels?.["kintsugi.host-updater"] !== "1") throw Error("Selected System lacks host updater support.");
          assertStorageSupport(metadata.Config.Labels, await readStorageDriver(join(current.data, "supervisor/storage.json")));
          if (metadata.Config.Labels?.["kintsugi.deployment-config"] !== "1") throw Error("Selected System lacks deployment support.");
          const code = 'const r=await fetch("http://127.0.0.1:3001/release/prepare",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reference:process.argv[1]})});if(!r.ok)process.exit(1);';
          await this.run(["docker", "exec", this.name, "bun", "-e", code, plan.app]);
          const app = Value.Parse(Type.Array(imageMetadata), JSON.parse(await this.run(["docker", "exec", this.name, "docker", "image", "inspect", plan.app])))[0]!;
          if (app.Config.Labels?.["kintsugi.deployment-config"] !== "1") throw Error("Selected app lacks deployment support.");
          assertImagePairCompatible(app.Config.Labels, metadata.Config.Labels);
          assertNetworkStateCompatible(await requiredNetworkStateVersion(current.data), app.Config.Labels, metadata.Config.Labels);
          assertResourceStateCompatible(await requiredResourceStateVersion(current.data), app.Config.Labels, metadata.Config.Labels);
          const fresh = await this.installation();
          if (fresh.selection !== plan.selection || fresh.system.Id !== plan.previousSystem || fresh.app.Id !== plan.previousApp) throw Error("Installation changed during preparation.");
          // The installer performs storage, access and other capability checks again before replacement.
          this.state = { ...this.state, phase: "ready", message: "System, app and dependencies are downloaded. Restart to update the installation." };
        } catch (error) { await this.diagnostic("Preparation failed: " + String(error)); this.state = { ...this.state, phase: "failed", message: "Download or compatibility checks failed. The running installation has not been replaced." }; }
        await this.persist();
      })().finally(() => { this.operation = undefined; }); return this.snapshot();
    } finally { this.starting = false; }
  }
  async apply(id: string) {
    const plan = this.requirePlan(id, "ready"); try {      
const current = await this.installation();
      if (current.selection !== plan.selection || current.system.Id !== plan.previousSystem || current.app.Id !== plan.previousApp) throw Error("The installation or release selection changed. Check again before restarting.");
      try { await this.inspectPair(plan.app, plan.system, current.data); }
      catch (error) {
        await this.diagnostic("Prepared compatibility check failed: " + String(error));
        this.state = { ...this.state, phase: "failed", message: "Prepared image compatibility could not be verified. Check again before restarting." };
        await this.persist();
        throw Error(this.state.message);
      }
      const previousContainer = await this.run(["docker", "inspect", "--format", "{{.Id}}", this.name]);
      this.state = { ...this.state, phase: "updating", message: "Replacing System and app. Running workspaces will restart." }; await this.persist();
      this.operation = (async () => {
        try {
          await this.run(["bash", this.options.installer, "--non-interactive", "--action", "update", "--confirm-replace", "--app-image", plan.app, "--system-image", plan.system, "--preserve-release-selection"]);
          this.state = { ...this.state, phase: "succeeded", retainedPlan: plan, message: "System and app are healthy. Installation update complete." };
        } catch (error) {
          await this.diagnostic("Update failed: " + String(error));
          this.state = { ...this.state, phase: "failed", message: "Installation update failed. Inspect host diagnostics; rollback restores retained images, not app data." };
          try {
            const outer = await this.run(["docker", "inspect", "--format", "{{.Id}}", this.name], 10_000);
            // Even an app-only change in the paired installer replaces the outer container.
            if (outer !== previousContainer) {
              await this.verifyRollback(current.data, plan);
              await this.run(["bash", this.options.installer, "--non-interactive", "--action", "rollback", "--confirm-replace"]);
              this.state = { ...this.state, phase: "rolled-back", retainedPlan: undefined, message: "Update failed; retained System/app images restored. Persisted app data was not rolled back." };
            }
          } catch (recoveryError) {
            await this.diagnostic("Automatic image recovery failed: " + String(recoveryError));
            this.state = { ...this.state, phase: "failed", message: "Update and image recovery failed. Inspect private host diagnostics." };
          }
        }
        await this.persist(); if (this.state.phase === "succeeded") this.options.updated?.();
      })().finally(() => { this.operation = undefined; }); return this.snapshot();
    } finally { this.starting = false; }
  }
  private async verifyRollback(data: string, plan: InstallationPlan) {
    const history = Value.Parse(Type.Object({ previousSystemImage: Type.String(), previousAppImage: Type.String() }), JSON.parse(await readFile(join(data, "supervisor/installer.json"), "utf8")));
    if (history.previousSystemImage !== plan.previousSystem || history.previousAppImage !== plan.previousApp) throw Error("Retained image pair no longer matches this update plan.");
    // A stopped System owns the only copy of the nested image store. Start that same container,
    // with its existing mounts, limits and configuration, and wait for Docker, not app health.
    const status = await this.run(["docker", "inspect", "--format", "{{.State.Status}}", this.name], 10_000);
    const stopped = status === "exited" || status === "created";
    if (!stopped && status !== "running") throw Error(`Cannot validate rollback images while System is ${status}.`);
    if (stopped) await this.run(["docker", "start", this.name], 60_000);
    try {
      if (stopped) {
        const until = performance.now() + 60_000;
        const probe = ["docker", "exec", this.name, "docker", "info"];
        for (;;) {
          const result = await this.command(probe, 3_000);
          if (result.code === 0) break;
          const state = await this.run(["docker", "inspect", "--format", "{{.State.Status}}", this.name], 3_000);
          if (state !== "running" || performance.now() >= until) {
            await this.commandFailure("Nested Docker readiness probe", result);
            throw Error(state === "running" ? "Nested Docker did not become ready for rollback within 60 seconds." : `System is ${state}; nested Docker is unavailable for rollback.`);
          }
          await Bun.sleep(1000);
        }
      }
      await this.inspectPair(plan.previousApp, plan.previousSystem, data);
    } catch (error) {
      if (stopped) {
        try { await this.run(["docker", "stop", "--time", "120", this.name], 130_000); }
        catch (cleanupError) { await this.diagnostic("Could not restore stopped System after rollback check: " + String(cleanupError)); }
      }
      throw error;
    }
  }
  async rollback() {
    if (this.checking || this.starting || this.operation || (!this.state.retainedPlan && (this.state.phase !== "failed" || !this.state.plan))) throw Error("No failed installation update is available to roll back.");
    this.starting = true; try {
      const data = await this.run(["docker", "inspect", "--format", '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}', this.name]);
      const plan = (this.state.phase === "failed" ? this.state.plan : undefined) ?? this.state.retainedPlan!;
      try { await this.verifyRollback(data, plan); }
      catch (error) { await this.diagnostic("Rollback preflight failed: " + String(error)); throw error; }
      this.state = { ...this.state, phase: "updating", message: "Restoring the retained System/app image pair…" }; await this.persist();
      this.operation = (async () => { try { await this.run(["bash", this.options.installer, "--non-interactive", "--action", "rollback", "--confirm-replace"]); this.state = { ...this.state, phase: "rolled-back", retainedPlan: undefined, message: "Retained System/app images restored. Persisted app data was not rolled back." }; } catch { this.state = { ...this.state, phase: "failed", message: "Rollback failed. Host intervention is required." }; } await this.persist(); })().finally(() => { this.operation = undefined; }); return this.snapshot();
    } finally { this.starting = false; }
  }
}

export function updaterHandler(updater: InstallationUpdater) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/status" && request.method === "GET") return Response.json(updater.snapshot());
      if (request.method !== "POST") return new Response("Not found", { status: 404 });
      const input: unknown = await request.json();
      if (path === "/check" || path === "/rollback") Value.Assert(Type.Object({}, { additionalProperties: false }), input);
      else Value.Assert(Type.Object({ id: Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" }) }, { additionalProperties: false }), input);
      if (path === "/check") return Response.json(await updater.check());
      if (path === "/rollback") return Response.json(await updater.rollback(), { status: 202 });
      const { id } = Value.Parse(Type.Object({ id: Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" }) }), input);
      if (path === "/prepare") return Response.json(await updater.prepare(id), { status: 202 });
      if (path === "/apply") return Response.json(await updater.apply(id), { status: 202 });
      return new Response("Not found", { status: 404 });
    } catch { return Response.json({ error: "Host update operation refused. Check status and private host diagnostics." }, { status: 409 }); }
  };
}
if (import.meta.main) {
  if (process.getuid?.() !== 0) throw Error("The host updater must run as root.");
  const { values } = parseArgs({ options: { directory: { type: "string", default: "/var/lib/kintsugi-updater" }, installer: { type: "string", default: "/usr/local/lib/kintsugi-updater/install.sh" } } });
  if ((await stat(values.installer!)).uid !== 0 || ((await stat(values.installer!)).mode & 0o022)) throw Error("Updater installer must be root-owned and not writable by group/others.");
  await ensureUpdaterBootDirectory();
  const updater = new InstallationUpdater({ directory: values.directory!, installer: values.installer!, updated: () => setTimeout(() => process.exit(0), 1000) }); await updater.initialize();
  await mkdir("/run/kintsugi-updater", { recursive: true, mode: 0o700 }); await chmod("/run/kintsugi-updater", 0o700);
  // The systemd unit holds service.lock before starting this process.
  await rm(updaterSocket, { force: true });
  const server = Bun.serve({ unix: updaterSocket, idleTimeout: 255, maxRequestBodySize: 4096, fetch: updaterHandler(updater) }); await chmod(updaterSocket, 0o600);
  const shutdown = async () => { server.stop(true); await updater.wait(); await rm(updaterSocket, { force: true }); process.exit(0); };
  process.on("SIGTERM", () => void shutdown());
  process.on("exit", () => server.stop(true));
}
