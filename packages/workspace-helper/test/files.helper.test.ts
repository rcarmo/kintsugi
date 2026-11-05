import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGoProgram } from "@kintsugi/core";
import { closeWorkspaceHelper, openWorkspaceFile, statWorkspaceFiles, WorkspaceHelperError, WorkspaceHelperStatus } from "../src/index.ts";

// A real helper, running as root and looking at files as the agent's user, as in a workspace.
let directory: string;
let socket: string;
let helper: Bun.Subprocess<"ignore", "inherit", "pipe">;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "helper-files-"));
  const binary = join(directory, "kintsugi-workspace-helper");
  await buildGoProgram(fileURLToPath(new URL("../helper", import.meta.url)), binary, `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`);
  socket = join(directory, "helper.sock");
  helper = Bun.spawn(["sudo", "-n", binary, "--allow-unauthenticated", "--listen", socket, "--state", join(directory, "state")], { stdout: "inherit", stderr: "pipe" });
  const stderr = helper.stderr.pipeThrough(new TextDecoderStream()).getReader();
  let log = "";
  while (!log.includes("listening on")) {
    const { done, value } = await stderr.read();
    if (done) throw new Error(`The helper did not start: ${log}`);
    log += value;
  }
  void (async () => { while (!(await stderr.read()).done); })();
}, 120_000);

afterAll(async () => {
  closeWorkspaceHelper(socket);
  helper.kill();
  await helper.exited;
  // The helper keeps its state as root.
  await Bun.spawn(["sudo", "-n", "rm", "-rf", directory]).exited;
});

test("stats decode into kinds, with zero values restored", async () => {
  const files = join(directory, "files");
  await mkdir(files);
  await writeFile(join(files, "file.md"), "hello");
  await writeFile(join(files, "empty.md"), "", { mode: 0 });
  await utimes(join(files, "file.md"), 1_700_000_000, 1_700_000_000);
  await symlink(join(files, "file.md"), join(files, "link.md"));
  const paths = ["file.md", "empty.md", "link.md", "missing.md"].map((name) => join(files, name));

  expect(await statWorkspaceFiles(socket, "agent", [...paths, files])).toEqual([
    { path: paths[0]!, kind: "regular", symlink: false, size: 5, modified: new Date(1_700_000_000_000), readable: true, canonicalPath: await realpath(paths[0]!) },
    { path: paths[1]!, kind: "regular", symlink: false, size: 0, modified: expect.any(Date), readable: false, canonicalPath: await realpath(paths[1]!) },
    { path: paths[2]!, kind: "regular", symlink: true, size: 5, modified: new Date(1_700_000_000_000), readable: true, canonicalPath: await realpath(paths[0]!) },
    { path: paths[3]!, kind: "missing" },
    { path: files, kind: "directory", symlink: false, size: expect.any(Number), modified: expect.any(Date), readable: true, canonicalPath: await realpath(files) },
  ]);
  expect(await statWorkspaceFiles(socket, "agent", [])).toEqual([]);
});

test("relative paths are refused", async () => {
  const stats = statWorkspaceFiles(socket, "agent", ["relative.md"]);
  await expect(stats).rejects.toBeInstanceOf(WorkspaceHelperError);
  await expect(stats).rejects.toMatchObject({ code: WorkspaceHelperStatus.INVALID_ARGUMENT });
});

test("an open file reads ranges of itself, longer than one helper read, even after its path is replaced", async () => {
  const path = join(directory, "large.bin");
  const content = new Uint8Array(3 * 1024 * 1024 + 5).map((_, index) => index % 251);
  await writeFile(path, content);
  const file = await openWorkspaceFile(socket, { user: "agent", path });
  try {
    expect((await file.stat()).size).toBe(content.byteLength);
    expect(await file.read(0, content.byteLength + 100)).toEqual(content);
    expect(await file.read(1_048_570, 10)).toEqual(content.subarray(1_048_570, 1_048_580));
    expect(await file.read(content.byteLength, 10)).toEqual(new Uint8Array());
    await writeFile(`${path}.new`, "replaced");
    await rename(`${path}.new`, path);
    expect(await file.read(0, 3)).toEqual(content.subarray(0, 3));
    expect((await file.stat()).size).toBe(content.byteLength);
  } finally { file.close(); }
});

test("opening a missing file or a folder fails", async () => {
  await expect(openWorkspaceFile(socket, { user: "agent", path: join(directory, "missing") })).rejects.toMatchObject({ code: WorkspaceHelperStatus.NOT_FOUND });
  await expect(openWorkspaceFile(socket, { user: "agent", path: directory })).rejects.toMatchObject({ code: WorkspaceHelperStatus.FAILED_PRECONDITION });
});
