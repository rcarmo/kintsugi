import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildGoProgram } from "@kintsugi/core";
import { ensureWorkspaceHelperIdentity } from "../../workspace/src/helper-identity.ts";
import { closeWorkspaceHelper, configureWorkspaceHelperIdentity, openWorkspaceFile, runWorkspaceProcess } from "../src/index.ts";

let directory: string;
let socket: string;
let identity: string;
let otherIdentity: string;
let helper: Bun.Subprocess<"ignore", "ignore", "pipe">;
let previous: string | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "helper-authentication-"));
  previous = process.env.ATELIER_DATA_DIR;
  process.env.ATELIER_DATA_DIR = directory;
  for (const id of ["own", "other"]) {
    await mkdir(join(directory, "workspaces", id), { recursive: true });
    await writeFile(join(directory, "workspaces", id, "gateway-token"), crypto.randomUUID() + crypto.randomUUID(), { mode: 0o600 });
  }
  identity = await ensureWorkspaceHelperIdentity("own");
  otherIdentity = await ensureWorkspaceHelperIdentity("other");
  const binary = join(directory, "helper");
  await buildGoProgram(fileURLToPath(new URL("../helper", import.meta.url)), binary, `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`);
  socket = join(directory, "helper.sock");
  helper = Bun.spawn(["sudo", "-n", binary, "--listen", socket, "--state", join(directory, "state"), "--tls-cert-file", join(identity, "cert.pem"), "--tls-key-file", join(identity, "key.pem")], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const reader = helper.stderr!.pipeThrough(new TextDecoderStream()).getReader();
  let output = "";
  while (!output.includes("listening on")) {
    const next = await reader.read();
    if (next.done) throw new Error(`Helper failed to start: ${output}`);
    output += next.value;
  }
  void (async () => { while (!(await reader.read()).done); })();
}, 120_000);

afterAll(async () => {
  closeWorkspaceHelper(socket);
  helper?.kill();
  if (helper) await helper.exited;
  if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previous;
  if (directory) await Bun.spawn(["sudo", "-n", "rm", "-rf", directory]).exited;
});

const request = () => runWorkspaceProcess(socket, { argv: ["sh", "-c", "id -u"], user: "root" }, { signal: AbortSignal.timeout(3000) });

test("root RPCs reject a client with socket access but no workspace identity", async () => {
  await expect(request()).rejects.toThrow();
  await expect(openWorkspaceFile(socket, { user: "root", path: "/etc/hostname" }, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  closeWorkspaceHelper(socket);
});

test("a different workspace identity cannot authenticate the server or run root RPCs", async () => {
  configureWorkspaceHelperIdentity(socket, await readFile(join(otherIdentity, "cert.pem")), await readFile(join(otherIdentity, "key.pem")));
  await expect(request()).rejects.toThrow();
  await expect(openWorkspaceFile(socket, { user: "root", path: "/etc/hostname" }, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  closeWorkspaceHelper(socket);
});

test("the owning app identity can run a root RPC over the authenticated Unix socket", async () => {
  configureWorkspaceHelperIdentity(socket, await readFile(join(identity, "cert.pem")), await readFile(join(identity, "key.pem")));
  const result = await request();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("0");
  const opened = await openWorkspaceFile(socket, { user: "agent", path: "/etc/hostname" });
  try { expect(Buffer.from(await opened.read(0, 1024))).toEqual(await readFile("/etc/hostname")); } finally { opened.close(); }
  closeWorkspaceHelper(socket);
});

test("the workspace identity is stable across preparation and rejects traversal", async () => {
  expect(await ensureWorkspaceHelperIdentity("own")).toBe(identity);
  expect(() => ensureWorkspaceHelperIdentity("../other")).toThrow("Invalid workspace id");
});

test("a helper identity cannot be reused by another app namespace", async () => {
  const previous = process.env.ATELIER_NAMESPACE;
  process.env.ATELIER_NAMESPACE = `${previous || "host"}-other`;
  try {
    await expect(ensureWorkspaceHelperIdentity("own")).rejects.toThrow("another namespace");
  } finally {
    if (previous === undefined) delete process.env.ATELIER_NAMESPACE;
    else process.env.ATELIER_NAMESPACE = previous;
  }
});
