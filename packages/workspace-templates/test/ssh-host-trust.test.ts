import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, createWorkspaceTemplateSshKey, deleteWorkspaceTemplateSshKey, workspaceInitFromTemplate, setWorkspaceTemplateSshKnownHosts, getWorkspaceTemplateSshKnownHosts } from "@kintsugi/workspace-templates";
import { registerWorkspaceTemplateWorkspaceInitEvents } from "../src/workspace-source.ts";
import { prepareWorkspaceSshTrust, workspaceGitSshCommand } from "../src/ssh-host-trust.ts";
import { unknownSshHost, sshHostTrustFailure, scanSshHost, trustScannedSshHost } from "../src/ssh-trust-recovery.ts";
import { requestWorkspaceSshTrust, workspaceSshTrustRequests, decideWorkspaceSshTrust, onWorkspaceSshTrustChanged } from "../src/ssh-trust-broker.ts";
import { createKintsugiEventBus } from "@kintsugi/core";
import type { WorkspaceDockerPlan } from "@kintsugi/workspace";
import { stopWorkspaceTemplateSshAgents, registerWorkspaceTemplateSshAgentWorkspaceEvents } from "../src/ssh-agent.ts";

let root: string;
let previousDataDir: string | undefined;
let daemon: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
async function run(command: string[], cwd?: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(`${command[0]} failed: ${stderr}`);
  return stdout;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kintsugi-ssh-transport-"));
  previousDataDir = process.env.KINTSUGI_DATA_DIR;
  process.env.KINTSUGI_DATA_DIR = join(root, "data");
});
afterEach(async () => {
  await stopWorkspaceTemplateSshAgents();
  if (daemon) { daemon.kill(); await daemon.exited; const stderr = await new Response(daemon.stderr).text(); if (stderr) console.error(stderr); daemon = undefined; }
  if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

async function key(name: string) {
  const path = join(root, name);
  await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path]);
  return { path, publicKey: (await readFile(`${path}.pub`, "utf8")).trim(), privateKey: await readFile(path, "utf8") };
}

test("host trust validates every record, persists explicitly, and can be cleared", async () => {
  const workspaceTemplate = (await addWorkspaceTemplate("git@example.test:repo.git")).workspaceTemplate;
  expect(await getWorkspaceTemplateSshKnownHosts(workspaceTemplate.id)).toBe("");
  const host = await key("host");
  const trusted = `example.test ${host.publicKey}\n`;
  expect(await setWorkspaceTemplateSshKnownHosts(workspaceTemplate.id, trusted)).toBe(trusted);
  await expect(setWorkspaceTemplateSshKnownHosts(workspaceTemplate.id, `${trusted}invalid record`)).rejects.toThrow("known_hosts");
  await expect(setWorkspaceTemplateSshKnownHosts(workspaceTemplate.id, "example.test ssh-ed25519 invalid")).rejects.toThrow("Invalid SSH host");
  await expect(setWorkspaceTemplateSshKnownHosts(workspaceTemplate.id, host.privateKey)).rejects.toThrow("known_hosts");
  expect(await getWorkspaceTemplateSshKnownHosts(workspaceTemplate.id)).toBe(trusted);
  expect(await setWorkspaceTemplateSshKnownHosts(workspaceTemplate.id, "")).toBe("");
});

test("unknown SSH hosts are identified without offering changed identities as new trust", () => {
  expect(unknownSshHost("No ED25519 host key is known for [127.0.0.1]:2222 and you have requested strict checking.\nHost key verification failed.")).toEqual({ host: "127.0.0.1", port: 2222 });
  expect(unknownSshHost("No ED25519 host key is known for git.example.com and you have requested strict checking.\nHost key verification failed.")).toEqual({ host: "git.example.com", port: 22 });
  expect(unknownSshHost("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.")).toBeUndefined();
  expect(sshHostTrustFailure("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key for [example.test]:2222 has changed and you have requested strict checking.\nHost key verification failed.")).toEqual({ host: "example.test", port: 2222, changed: true });
  expect(unknownSshHost("Permission denied (publickey).")).toBeUndefined();
});

test("workspace SSH trust requests await a decision and persist per-workspace, including changed identities", async () => {
  const id = "workspace-trust";
  const directory = join(root, "data", "ssh-agents", id);
  await prepareWorkspaceSshTrust(directory);
  const first = await key("first-host");
  const second = await key("second-host");
  const line = (publicKey: string) => `example.test ${publicKey.split(" ").slice(0, 2).join(" ")}`;
  const firstLine = line(first.publicKey);
  const firstPending = Promise.withResolvers<void>();
  const unsubscribeFirst = onWorkspaceSshTrustChanged(() => firstPending.resolve());
  const asking = requestWorkspaceSshTrust(id, "example.test", 22, firstLine);
  await firstPending.promise;
  unsubscribeFirst();
  const pending = workspaceSshTrustRequests(id);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.changed).toBe(false);
  await decideWorkspaceSshTrust(id, pending[0]!.id, [firstLine]);
  expect(await asking).toContain(firstLine);
  expect(await requestWorkspaceSshTrust(id, "example.test", 22, firstLine)).toContain(firstLine);
  const otherLine = `other.test ${first.publicKey.split(" ").slice(0, 2).join(" ")}`;
  const otherPending = Promise.withResolvers<void>();
  const unsubscribeOther = onWorkspaceSshTrustChanged(() => otherPending.resolve());
  const other = requestWorkspaceSshTrust(id, "other.test", 22, otherLine);
  await otherPending.promise;
  unsubscribeOther();
  await decideWorkspaceSshTrust(id, workspaceSshTrustRequests(id)[0]!.id, [otherLine]);
  await other;
  const secondLine = line(second.publicKey);
  const nextPending = Promise.withResolvers<void>();
  const unsubscribeNext = onWorkspaceSshTrustChanged(() => nextPending.resolve());
  const changed = requestWorkspaceSshTrust(id, "example.test", 22, secondLine);
  await nextPending.promise;
  unsubscribeNext();
  expect(workspaceSshTrustRequests(id)[0]?.changed).toBe(true);
  await decideWorkspaceSshTrust(id, workspaceSshTrustRequests(id)[0]!.id, [secondLine]);
  expect(await changed).toContain(secondLine);
  expect(await readFile(join(directory, "workspace_known_hosts"), "utf8")).toBe(`${otherLine}\n${secondLine}\n`);
});

test("GitHub host keys are trusted without project configuration, including SSH over port 443", async () => {
  const workspaceTemplate = (await addWorkspaceTemplate("git@github.com:org/repo.git")).workspaceTemplate;
  for (const workspaceTemplateId of [undefined, workspaceTemplate.id]) {
    const path = await prepareWorkspaceSshTrust(join(root, "github-defaults"), workspaceTemplateId);
    for (const host of ["github.com", "[ssh.github.com]:443"]) {
      const entries = await run(["ssh-keygen", "-F", host, "-f", path]);
      expect(entries).toContain("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl");
    }
    expect(workspaceGitSshCommand(path)).toContain("StrictHostKeyChecking=yes");
  }
  const extra = await key("additional-host");
  await setWorkspaceTemplateSshKnownHosts(workspaceTemplate.id, `example.test ${extra.publicKey}`);
  let path = await prepareWorkspaceSshTrust(join(root, "github-defaults"), workspaceTemplate.id);
  expect(await run(["ssh-keygen", "-F", "example.test", "-f", path])).toContain(extra.publicKey);
  await setWorkspaceTemplateSshKnownHosts(workspaceTemplate.id, "");
  path = await prepareWorkspaceSshTrust(join(root, "github-defaults"), workspaceTemplate.id);
  expect(await run(["ssh-keygen", "-F", "github.com", "-f", path])).toContain("ssh-ed25519");
});

async function startServer(hostKey: string, authorizedKey: string): Promise<number> {
  // Requires passwordless sudo to install OpenSSH if needed and run its privilege-separated daemon.
  const sshd = Bun.which("sshd") ?? "/usr/sbin/sshd";
  if (!(await Bun.file(sshd).exists())) {
    await run(["sudo", "-n", "apt-get", "update", "-qq"]);
    await run(["sudo", "-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-qq", "openssh-server"]);
  }
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  // SAFETY: listen completed successfully on an explicit TCP address, not a Unix socket.
  const address = socket.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const username = (await run(["id", "-un"])).trim();
  const config = join(root, "sshd_config");
  await writeFile(config, `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${hostKey}\nAuthorizedKeysFile ${authorizedKey}\nPidFile ${root}/sshd.pid\nStrictModes no\nUsePAM yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nAllowUsers ${username}\nLogLevel ERROR\n`);
  await run(["sudo", "-n", "mkdir", "-p", "/run/sshd"]);
  daemon = Bun.spawn(["sudo", "-n", sshd, "-D", "-e", "-f", config], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) {
      const stderr = await new Response(daemon.stderr).text();
      daemon = undefined;
      throw new Error(`sshd exited: ${stderr}`);
    }
    const ready = await new Promise<boolean>((resolve) => {
      const connection = createConnection({ host: "127.0.0.1", port });
      connection.once("connect", () => { connection.destroy(); resolve(true); });
      connection.once("error", () => { connection.destroy(); resolve(false); });
    });
    if (ready) return port;
    await Bun.sleep(20);
  }
  throw new Error("sshd did not start");
}

async function repository(name: string) {
  const seed = join(root, name);
  await run(["git", "init", "-b", "main", seed]);
  await run(["git", "config", "user.name", "Test"], seed);
  await run(["git", "config", "user.email", "test@example.test"], seed);
  await writeFile(join(seed, "file.txt"), name);
  await run(["git", "add", "."], seed);
  await run(["git", "commit", "-m", "initial"], seed);
  const remote = `${seed}.git`;
  await run(["git", "clone", "--bare", seed, remote]);
  return { seed, remote };
}

test("real SSH cloning and nested submodules require verified host trust and valid project credentials", async () => {
  const host = await key("server");
  const login = await key("login");
  const port = await startServer(host.path, `${login.path}.pub`);
  const username = (await run(["id", "-un"])).trim();
  const url = (path: string) => `ssh://${username}@127.0.0.1:${port}${path}`;
  const leaf = await repository("leaf");
  const middle = await repository("middle");
  const parent = await repository("parent");
  for (const [outer, inner] of [[middle, leaf], [parent, middle]] as const) {
    await run(["git", "-c", "protocol.file.allow=always", "submodule", "add", inner.remote, "child"], outer.seed);
    await run(["git", "config", "-f", ".gitmodules", "submodule.child.url", url(inner.remote)], outer.seed);
    await run(["git", "commit", "-am", "SSH submodule"], outer.seed);
    await run(["git", "push", outer.remote, "main"], outer.seed);
  }
  const workspaceTemplate = (await addWorkspaceTemplate(url(parent.remote))).workspaceTemplate;
  const storedKey = await createWorkspaceTemplateSshKey(workspaceTemplate.id, login.privateKey);
  const events = createKintsugiEventBus();
  registerWorkspaceTemplateWorkspaceInitEvents(events);
  registerWorkspaceTemplateSshAgentWorkspaceEvents(events);
  const prepare = async (workspaceId: string, gitUrl = workspaceTemplate.gitUrl) => {
    const source = { workspaceId, init: { ...workspaceInitFromTemplate(workspaceTemplate), gitUrl, branch: "main" }, workHostPath: join(root, "data", "workspaces", workspaceId, "work"), workContainerPath: "/work" };
    await events.emit("workspace_source_prepare", source);
    return source;
  };
  await expect(prepare("missing-trust")).rejects.toThrow("Trusted SSH servers");
  const missingOutput = await readFile(join(root, "data", "workspaces", "missing-trust", (await readdir(join(root, "data", "workspaces", "missing-trust"))).find(name => name.startsWith("project-provision-"))!), "utf8");
  expect(unknownSshHost(missingOutput)).toEqual({ host: "127.0.0.1", port });
  const candidate = await scanSshHost("127.0.0.1", port);
  expect(candidate.records.some(record => record.line.includes(host.publicKey.split(" ")[1]!))).toBe(true);
  expect(candidate.records[0]?.fingerprint).toStartWith("SHA256:");
  await expect(trustScannedSshHost(workspaceTemplate.id, candidate, ["unverified key"])).rejects.toThrow("changed");
  expect(await getWorkspaceTemplateSshKnownHosts(workspaceTemplate.id)).toBe("");
  expect(await Bun.file(join(root, "data", "ssh-agents", "missing-trust", "agent.sock")).exists()).toBe(false);
  await expect(prepare("missing-submodule-trust", parent.remote)).rejects.toThrow("Trusted SSH servers");
  await trustScannedSshHost(workspaceTemplate.id, candidate, candidate.records.map(record => record.line));
  expect(await getWorkspaceTemplateSshKnownHosts(workspaceTemplate.id)).toContain(host.publicKey.split(" ")[1]!);
  const source = await prepare("trusted");
  expect(await readFile(join(source.workHostPath, "child", "child", "file.txt"), "utf8")).toBe("leaf");
  const agentDirectory = join(root, "data", "ssh-agents", "trusted");
  const socket = join(agentDirectory, "agent.sock");
  const beforePlan = await stat(socket);
  const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
  await events.emit("workspace_plan_prepare", { ...source, plan });
  expect((await stat(socket)).ino).toBe(beforePlan.ino);
  expect(plan.env.SSH_AUTH_SOCK).toBe("/run/kintsugi-ssh-agent/agent.sock");
  expect(plan.env.GIT_SSH_COMMAND).toContain("/run/kintsugi-ssh-agent/known_hosts");
  expect(plan.mounts).toContainEqual({ type: "bind", source: agentDirectory, target: "/run/kintsugi-ssh-agent", readonly: true });
  await events.emit("workspace_deleted", { workspaceId: source.workspaceId });
  expect(await Bun.file(socket).exists()).toBe(false);
  const mixed = await prepare("non-ssh-main", parent.remote);
  expect(await readFile(join(mixed.workHostPath, "child", "child", "file.txt"), "utf8")).toBe("leaf");
  const changedHost = await key("changed-server");
  await setWorkspaceTemplateSshKnownHosts(workspaceTemplate.id, `[127.0.0.1]:${port} ${changedHost.publicKey}`);
  await expect(prepare("changed-host")).rejects.toThrow("Host key verification failed");
  await trustScannedSshHost(workspaceTemplate.id, await scanSshHost("127.0.0.1", port), candidate.records.map(record => record.line));
  expect(await readFile((await prepare("changed-host-recovered")).workHostPath + "/child/child/file.txt", "utf8")).toBe("leaf");
  await setWorkspaceTemplateSshKnownHosts(workspaceTemplate.id, `[127.0.0.1]:${port} ${host.publicKey}`);
  await deleteWorkspaceTemplateSshKey(workspaceTemplate.id, storedKey.id);
  const wrongLogin = await key("wrong-login");
  await createWorkspaceTemplateSshKey(workspaceTemplate.id, wrongLogin.privateKey);
  await expect(prepare("wrong-login")).rejects.toThrow("Permission denied");
}, 180_000);
