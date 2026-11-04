import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import { err, ExecutionError, FileError, LineScanner, ok, type BinaryReader, type ExecutionEnv, type FileErrorCode, type FileInfo, type Result } from "@earendil-works/pi-durable/env";
import { openFileInWorkspace, readFileInWorkspace, runInWorkspace, statFilesInWorkspace, workspaceRoot, WorkspaceHelperError, WorkspaceHelperStatus, writeFileInWorkspace, type WorkspaceFileStat } from "@kintsugi/workspace";

const user = "agent";
const home = "/home/agent";
/**
 * The most one read takes into the app's memory, such as a whole file to edit or an image to show: larger ones fail,
 * and the agent can use bash. `read` pages through text of any size.
 */
const maxWholeFileBytes = 64 * 1024 * 1024;
const scanChunkBytes = 1024 * 1024;

/** The helper's failures that are expected of a file, by its status. */
function helperFileErrorCode(code: number): FileErrorCode {
  switch (code) {
    case WorkspaceHelperStatus.NOT_FOUND: return "not_found";
    case WorkspaceHelperStatus.PERMISSION_DENIED: return "permission_denied";
    case WorkspaceHelperStatus.INVALID_ARGUMENT:
    case WorkspaceHelperStatus.FAILED_PRECONDITION: return "invalid";
    default: return "unknown";
  }
}

/**
 * Expected failures, such as a missing file, become results; a workspace that can't be reached is an `unknown` one with
 * its message. Operations take the context's abort signal, so a stopped call ends even while the workspace doesn't answer.
 */
async function attempt<T>(path: string, context: Context, operation: () => Promise<T>): Promise<Result<T, FileError>> {
  if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
  try {
    return ok(await operation());
  } catch (error) {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
    const cause = error instanceof Error ? error : new Error(String(error));
    const code = error instanceof WorkspaceHelperError ? helperFileErrorCode(error.code) : "unknown";
    return err(new FileError(code, cause.message, path, cause));
  }
}

/** A file URL's path; one naming another host, or malformed, stays an ordinary path, as the Node environment keeps it. */
function filePath(url: string): string {
  try {
    return fileURLToPath(url);
  } catch {
    return url;
  }
}

function unsupported(path: string): Result<never, FileError> {
  return err(new FileError("not_supported", "Workspace files support only what read, write, edit and code mode need", path));
}

/**
 * The files of one workspace, as its agent user reaches them through the workspace helper: what pi-durable's read,
 * write and edit tools, and code mode's output files, need of an execution environment. The rest fails with
 * `not_supported`; commands run through the bash tool instead.
 */
export class WorkspaceFileSystem implements ExecutionEnv {
  readonly id: string;

  /** Relative paths resolve against `cwd`, the workspace's /work unless a test gives another folder. */
  constructor(private readonly workspaceId: string, readonly cwd = workspaceRoot) {
    this.id = `workspace:${workspaceId}`;
  }

  /** Where `path` is in the workspace: relative to `cwd`, with `~` the agent user's home, as the Node environment resolves locally. */
  #resolve(path: string): string {
    if (path === "~") return home;
    if (path.startsWith("~/")) return posix.join(home, path.slice(2));
    return posix.resolve(this.cwd, path.startsWith("file://") ? filePath(path) : path);
  }

  /** What is at `path`, following symlinks; nothing there, or nothing the user may reach, is an error. */
  async #describe(path: string, context: Context): Promise<Result<Exclude<WorkspaceFileStat, { kind: "missing" | "inaccessible" }>, FileError>> {
    const described = await attempt(path, context, async () => (await statFilesInWorkspace(this.workspaceId, user, [path], { signal: context.abortSignal }))[0]!);
    if (!described.ok) return described;
    const { value } = described;
    if (value.kind === "missing") return err(new FileError("not_found", `${path} does not exist`, path));
    if (value.kind === "inaccessible") return err(new FileError("permission_denied", `${path} is in a folder the agent may not look into`, path));
    return ok(value);
  }

  readonly absolutePath: ExecutionEnv["absolutePath"] = async (path) => ok(this.#resolve(path));
  readonly joinPath: ExecutionEnv["joinPath"] = async (parts) => ok(posix.join(...parts));

  /** Its kind as the Node environment's `lstat` reports it, so a symlink is one; its size and time are those of what it points to. */
  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const absolute = this.#resolve(path);
    const described = await this.#describe(absolute, context);
    if (!described.ok) return described;
    const { value } = described;
    if (value.kind === "other") return err(new FileError("invalid", `${absolute} is a device, FIFO or socket`, absolute));
    const kind = value.symlink ? "symlink" : value.kind === "regular" ? "file" : "directory";
    return ok({ name: posix.basename(absolute), path: absolute, kind, size: value.size, mtimeMs: value.modified.getTime() });
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : info;
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const absolute = this.#resolve(path);
    const described = await this.#describe(absolute, context);
    if (!described.ok) return described;
    // None for a file removed since it was described, or one whose real path is too long to resolve. Not found lets
    // callers fall back to its folder's, as pi-durable's mutation queue does.
    const { canonicalPath } = described.value;
    return canonicalPath === undefined ? err(new FileError("not_found", `${absolute} has no real path that can be resolved`, absolute)) : ok(canonicalPath);
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const absolute = this.#resolve(path);
    // Buffer keeps a byte-order mark, as Node's readFile does; edit puts it back after matching.
    return attempt(absolute, context, async () => (await readFileInWorkspace(this.workspaceId, { user, path: absolute }, { maxBytes: maxWholeFileBytes, signal: context.abortSignal })).toString("utf8"));
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const absolute = this.#resolve(path);
    return attempt(absolute, context, () => writeFileInWorkspace(this.workspaceId, { user, path: absolute }, content, { signal: context.abortSignal }));
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const absolute = this.#resolve(path);
    if (options?.noFollow) return err(new FileError("not_supported", "Workspace files always follow symlinks", absolute));
    const opened = await attempt(absolute, context, () => openFileInWorkspace(this.workspaceId, { user, path: absolute }, { signal: context.abortSignal }));
    if (!opened.ok) {
      // The helper refuses anything but a regular file alike; tell a folder apart, as the Node environment does.
      const info = opened.error.code === "invalid" ? await this.fileInfo(absolute, context) : undefined;
      if (info?.ok && info.value.kind === "directory") return err(new FileError("is_directory", `${absolute} is a folder`, absolute));
      return opened;
    }
    const file = opened.value;
    let closed = false;
    // The file stays open on the context it was opened with; each use ends when its own context is aborted.
    const use = <T>(useContext: Context, operation: () => Promise<T>) =>
      closed ? Promise.resolve(err<T, FileError>(new FileError("invalid", `${absolute} is closed`, absolute))) : attempt(absolute, useContext, () => awaitWithContext(operation(), useContext));
    return ok({
      info: (infoContext) => use(infoContext, async () => {
        const { size, modified } = await file.stat();
        return { name: posix.basename(absolute), path: absolute, kind: "file" as const, size, mtimeMs: modified.getTime() };
      }),
      async read(offset, length, readContext) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
          return err(new FileError("invalid", `Can't read ${length} bytes at ${offset}`, absolute));
        }
        if (length > maxWholeFileBytes) {
          return err(new FileError("invalid", `${absolute} is too large to read at once: ${length} bytes, over the limit of ${maxWholeFileBytes}`, absolute));
        }
        return use(readContext, () => file.read(offset, length));
      },
      async scanLines(range, scanContext) {
        let scanner: LineScanner;
        try {
          scanner = new LineScanner(range.startLine, range.endLine);
        } catch {
          return err(new FileError("invalid", "Invalid line range", absolute));
        }
        return use(scanContext, async () => {
          for (let position = 0; ; position += scanChunkBytes) {
            // Stop reading once aborted, not only waiting: the file takes one request at a time.
            if (scanContext.abortSignal?.aborted) throw new Error("aborted");
            const chunk = await file.read(position, scanChunkBytes);
            scanner.push(chunk);
            if (chunk.byteLength < scanChunkBytes) return scanner.finish();
          }
        });
      },
      async close() {
        closed = true;
        file.close();
      },
    });
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return attempt("/tmp", context, async () => {
      const result = await runInWorkspace(this.workspaceId, { argv: ["mktemp", "-d", `/tmp/${prefix ?? ""}XXXXXX`], user }, { signal: context.abortSignal });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `mktemp exited with ${result.exitCode}`);
      return result.stdout.toString().trim();
    });
  }

  readonly openTextLineReader: ExecutionEnv["openTextLineReader"] = async (path) => unsupported(path);
  readonly readTextLines: ExecutionEnv["readTextLines"] = async (path) => unsupported(path);
  readonly readBinaryFile: ExecutionEnv["readBinaryFile"] = async (path) => unsupported(path);
  readonly appendFile: ExecutionEnv["appendFile"] = async (path) => unsupported(path);
  readonly truncateFile: ExecutionEnv["truncateFile"] = async (path) => unsupported(path);
  readonly flushFile: ExecutionEnv["flushFile"] = async (path) => unsupported(path);
  readonly renameFile: ExecutionEnv["renameFile"] = async (path) => unsupported(path);
  readonly listDir: ExecutionEnv["listDir"] = async (path) => unsupported(path);
  readonly openDirReader: ExecutionEnv["openDirReader"] = async (path) => unsupported(path);
  readonly watch: ExecutionEnv["watch"] = async () => unsupported(this.cwd);
  readonly createDir: ExecutionEnv["createDir"] = async (path) => unsupported(path);
  readonly remove: ExecutionEnv["remove"] = async (path) => unsupported(path);
  readonly createTempFile: ExecutionEnv["createTempFile"] = async () => unsupported("/tmp");
  readonly exec: ExecutionEnv["exec"] = async () => err(new ExecutionError("shell_unavailable", "Workspace commands run through the bash tool"));
  async cleanup() {}
}
