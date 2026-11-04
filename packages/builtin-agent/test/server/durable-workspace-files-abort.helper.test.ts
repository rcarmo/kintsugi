import { getKintsugiRuntimeContext, kintsugiDataPath } from "@kintsugi/core";
import { ensureWorkspaceHelperIdentity } from "../../../workspace/src/helper-identity.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow, type BinaryReader } from "@earendil-works/pi-durable/env";
import { buildGoProgram } from "@kintsugi/core";
import { closeWorkspaceHelperConnection, workspaceHelperSocketPath } from "@kintsugi/workspace";
import { WorkspaceFileSystem } from "../../src/server/durable-workspace-files.ts";

// Stopping a tool call must not wait for a workspace helper that stopped answering, e.g. in a frozen container.
const workspaceId = "files-abort";
let directory: string;
let helper: Bun.Subprocess<"ignore", "inherit", "pipe">;
/** The helper itself, which sudo runs as a child. */
let helperPid: string;

const signal = (name: string, pid: string | number) => Bun.spawn(["sudo", "-n", "kill", `-${name}`, String(pid)]).exited;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "workspace-files-abort-"));
  const binary = join(directory, "aitc-workspace-helper");
  await buildGoProgram(fileURLToPath(new URL("../../../workspace-helper/helper", import.meta.url)), binary, `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`);
  const workspaceDirectory = kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", workspaceId);
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(join(workspaceDirectory, "gateway-token"), crypto.getRandomValues(new Uint8Array(32)), { mode: 0o600 });
  const identity = await ensureWorkspaceHelperIdentity(workspaceId);
  const socket = workspaceHelperSocketPath(workspaceId);
  await mkdir(dirname(socket), { recursive: true });
  // Detached: sudo stops its process group when the helper is stopped.
  helper = Bun.spawn(["sudo", "-n", binary, "--tls-cert-file", join(identity, "cert.pem"), "--tls-key-file", join(identity, "key.pem"), "--listen", socket, "--state", join(directory, "state")], { stdout: "inherit", stderr: "pipe", detached: true });
  const stderr = helper.stderr.pipeThrough(new TextDecoderStream()).getReader();
  let log = "";
  while (!log.includes("listening on")) {
    const { done, value } = await stderr.read();
    if (done) throw new Error(`The helper did not start: ${log}`);
    log += value;
  }
  void (async () => { while (!(await stderr.read()).done); })();
  helperPid = (await new Response(Bun.spawn(["pgrep", "-P", String(helper.pid)]).stdout).text()).trim().split("\n").at(-1)!;
}, 120_000);

afterAll(async () => {
  await signal("CONT", helperPid);
  await signal("CONT", helper.pid);
  closeWorkspaceHelperConnection(workspaceId);
  await signal("KILL", helperPid);
  await helper.exited;
  await Bun.spawn(["sudo", "-n", "rm", "-rf", directory]).exited;
});

/** What `operation` settles with when aborted while the helper doesn't answer, or `undefined` if it doesn't within `ms`. */
async function abortedWhileUnanswered(operation: (context: Context) => Promise<{ ok: boolean }>, ms = 2_000) {
  const abort = new AbortController();
  await signal("STOP", helperPid);
  try {
    const settled = operation(withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
    setTimeout(() => abort.abort(new Error("stopped")), 100);
    return await Promise.race([settled, Bun.sleep(ms).then(() => undefined)]);
  } finally {
    await signal("CONT", helperPid);
    await signal("CONT", helper.pid);
  }
}

const aborted = { ok: false, error: expect.objectContaining({ code: "aborted" }) };

const operations = {
  fileInfo: (env, context) => env.fileInfo("file.txt", context),
  readTextFile: (env, context) => env.readTextFile("file.txt", context),
  writeFile: (env, context) => env.writeFile("file.txt", "x", context),
  openBinaryReader: (env, context) => env.openBinaryReader("file.txt", undefined, context),
  createTempDir: (env, context) => env.createTempDir("abort-", context),
} satisfies Record<string, (env: WorkspaceFileSystem, context: Context) => Promise<{ ok: boolean }>>;

test.each(Object.entries(operations))("an aborted %s ends while the helper doesn't answer", async (_name, operation) => {
  const env = new WorkspaceFileSystem(workspaceId, directory);
  // Connect first, so the stopped helper only stops answering calls.
  await env.exists("anything", BACKGROUND_CONTEXT);
  expect(await abortedWhileUnanswered((context) => operation(env, context))).toEqual(aborted);
}, 30_000);

const readerOperations = {
  info: (reader, context) => reader.info(context),
  read: (reader, context) => reader.read(0, 1, context),
  scanLines: (reader, context) => reader.scanLines({ startLine: 0 }, context),
} satisfies Record<string, (reader: BinaryReader, context: Context) => Promise<{ ok: boolean }>>;

test.each(Object.entries(readerOperations))("an aborted %s of a file opened before ends while the helper doesn't answer", async (_name, operation) => {
  await writeFile(join(directory, "open.txt"), "open\n");
  const env = new WorkspaceFileSystem(workspaceId, directory);
  const reader = getOrThrow(await env.openBinaryReader("open.txt", undefined, BACKGROUND_CONTEXT));
  try {
    expect(await abortedWhileUnanswered((context) => operation(reader, context))).toEqual(aborted);
  } finally { await reader.close(BACKGROUND_CONTEXT); }
}, 30_000);
