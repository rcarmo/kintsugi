import { Client, credentials, Metadata, status, type ClientDuplexStream, type ClientWritableStream, type ServiceDefinition, type ServiceError } from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import { parse } from "protobufjs";
// Bundled runtimes must carry the schema instead of resolving a source-tree file.
import protoSource from "../proto/workspace_helper.proto" with { type: "text" };


export type WorkspaceHelperUser = "agent" | "root";
export type WorkspaceHelperSignal = "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGKILL";
export interface TerminalSize { cols: number; rows: number }

export interface WorkspaceExecStart {
  argv: string[];
  user: WorkspaceHelperUser;
  /** Absolute; defaults to /work. */
  workdir?: string;
  env?: Record<string, string>;
  /** Gives the process a stdin pipe. */
  stdin?: boolean;
  /** Runs the process on a PTY; output then arrives only on stdout. */
  terminal?: TerminalSize;
}

export type WorkspaceExit = { exitCode: number; signal?: undefined } | { exitCode?: undefined; signal: number };

/** An exit status the way shells report it, e.g. 137 for SIGKILL. */
export function exitStatus(exit: WorkspaceExit): number {
  return exit.signal === undefined ? exit.exitCode : 128 + exit.signal;
}

/** A process running in a workspace through its helper. */
export interface WorkspaceProcess {
  /** Applies backpressure to the process. Cancelling either stream cancels the call. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Buffers without limit, so ignoring it never stalls stdout. */
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves after all output; rejects when the call fails. */
  readonly exited: Promise<WorkspaceExit>;
  write(data: string | Uint8Array): void;
  closeStdin(): void;
  signal(signal: WorkspaceHelperSignal): void;
  resize(size: TerminalSize): void;
  /** Ends the call, which kills the process group. */
  cancel(): void;
}

/** Starts a process in one particular workspace. */
export type StartWorkspaceProcess = (start: WorkspaceExecStart) => WorkspaceProcess;

export class WorkspaceHelperError extends Error {
  constructor(readonly code: status, message: string) {
    super(message);
    this.name = "WorkspaceHelperError";
  }
}

/** How a detached process ended. `unknown` means it exited while a restarted helper was no longer its parent. */
export type DetachedWorkspaceExit = WorkspaceExit | { exitCode?: undefined; signal?: undefined; unknown: true };

/** Output offsets: how many bytes of stdout and stderr a client has read. */
export interface WorkspaceOutputOffsets { stdout: number; stderr: number }

/** A process that outlives its call; see `startDetachedWorkspaceProcess`. */
export interface DetachedWorkspaceProcess {
  /** Applies backpressure to the call, not the process, which writes to disk. */
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves once the process has exited and all its output arrived; the process is gone after that. Rejects when the call ends first, e.g. on `detach`. */
  readonly exited: Promise<DetachedWorkspaceExit>;
  write(data: string | Uint8Array): void;
  signal(signal: WorkspaceHelperSignal): void;
  /** The output before these offsets is no longer needed; the helper frees it, and attaching before them fails. */
  acknowledge(offsets: WorkspaceOutputOffsets): void;
  /** Ends this call. The process keeps running. */
  detach(): void;
}

type HelperSignal = (typeof signals)[WorkspaceHelperSignal];
/** ExecStart on the wire: how stdio connects is one explicit choice. */
type HelperStart = Pick<WorkspaceExecStart, "argv" | "workdir" | "env"> & { user: string } & (
  | { pipes: { stdin: boolean } }
  | { terminal: TerminalSize }
  | { detached: { name: string; stdin: boolean } }
);
/** Options for a detached process; it can't have a terminal. */
export type WorkspaceDetachedStart = Omit<WorkspaceExecStart, "terminal">;
type Acknowledge = { stdoutOffset: number; stderrOffset: number };
type ExecRequest =
  | { start: HelperStart }
  | { stdin: Uint8Array }
  | { closeStdin: Record<string, never> }
  | { signal: HelperSignal }
  | { resize: TerminalSize }
  | { acknowledge: Acknowledge };
type AttachRequest =
  | { attach: { name: string } & Acknowledge }
  | { stdin: Uint8Array }
  | { signal: HelperSignal }
  | { acknowledge: Acknowledge };
type Exited = { status: "exitCode"; exitCode: number } | { status: "signal"; signal: number } | { status: "unknown"; unknown: Record<string, never> };
type ExecResponse =
  | { response: "stdout"; stdout: Buffer }
  | { response: "stderr"; stderr: Buffer }
  | { response: "exited"; exited: Exited };
type HelperCall<Request> = ClientDuplexStream<Request, ExecResponse>;
type WriteFileRequest = { start: { user: string; path: string } } | { data: Uint8Array };

const definition = fromJSON(parse(protoSource).root.toJSON(), { longs: Number, enums: String, defaults: false, oneofs: true });
// SAFETY: workspace_helper.proto defines WorkspaceHelper as a service whose Exec and Attach stream ExecRequest and AttachRequest to ExecResponse, decoded with the options above.
const service = definition["kintsugi.workspace_helper.v1.WorkspaceHelper"] as ServiceDefinition;
const execMethod = service.Exec!;
const attachMethod = service.Attach!;
const readFileMethod = service.ReadFile!;
const writeFileMethod = service.WriteFile!;
const statFilesMethod = service.StatFiles!;
const openFileMethod = service.OpenFile!;

const users = { "agent": "USER_AGENT", root: "USER_ROOT" } satisfies Record<WorkspaceHelperUser, string>;
const signals = { SIGHUP: "SIGNAL_HUP", SIGINT: "SIGNAL_INT", SIGTERM: "SIGNAL_TERM", SIGKILL: "SIGNAL_KILL" } satisfies Record<WorkspaceHelperSignal, string>;

const clients = new Map<string, Client>();
const identities = new Map<string, {certificate: Buffer; key: Buffer}>();

/** App-owned workspace identity, never read from the workspace socket directory. */
export function configureWorkspaceHelperIdentity(socketPath: string, certificate: Buffer, key: Buffer): void {
 const current = identities.get(socketPath);
 if (current?.certificate.equals(certificate) && current.key.equals(key)) return;
 closeWorkspaceHelper(socketPath);
 identities.set(socketPath, {certificate, key});
}

function client(socketPath: string): Client {
  let existing = clients.get(socketPath);
  if (!existing) {
    const identity = identities.get(socketPath);
    const transport = identity ? credentials.createSsl(identity.certificate, identity.key, identity.certificate) : credentials.createInsecure();
    existing = new Client(`unix://${socketPath}`, transport, {
      "grpc.ssl_target_name_override": "kintsugi-workspace-helper",
      "grpc.default_authority": "kintsugi-workspace-helper",
      // The helper is local; reconnect quickly once it is back, e.g. after a workspace restart.
      "grpc.initial_reconnect_backoff_ms": 100,
      "grpc.max_reconnect_backoff_ms": 1000,
    });
    clients.set(socketPath, existing);
  }
  return existing;
}

/** Drops the connection to a helper, e.g. once its workspace is gone. */
export function closeWorkspaceHelper(socketPath: string): void {
  clients.get(socketPath)?.close();
  clients.delete(socketPath);
  identities.delete(socketPath);
}

function openCall<Request>(socketPath: string, method: typeof execMethod, waitForReady: boolean | undefined): HelperCall<Request> {
  return client(socketPath).makeBidiStreamRequest(method.path, method.requestSerialize, method.responseDeserialize, new Metadata({ waitForReady }), {});
}

function callError(error: ServiceError, signal: AbortSignal | undefined): Error {
  if (error.code === status.CANCELLED && signal?.aborted) return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
  return new WorkspaceHelperError(error.code, error.details || error.message);
}

/** The output and exit of one Exec or Attach call. */
function receive<Request>(call: HelperCall<Request>, signal: AbortSignal | undefined) {
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let outputCancelled = false;
  const cancelOutput = () => {
    outputCancelled = true;
    call.cancel();
  };
  const stdoutStream = new ReadableStream<Uint8Array>({
    start: (controller) => { stdout = controller; },
    // Paused calls stop reading, so HTTP/2 flow control holds the helper back.
    pull: () => { call.resume(); },
    cancel: cancelOutput,
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }));
  const stderrStream = new ReadableStream<Uint8Array>({ start: (controller) => { stderr = controller; }, cancel: cancelOutput });
  let exit: DetachedWorkspaceExit | undefined;
  let finished = false;
  const abort = () => call.cancel();
  signal?.addEventListener("abort", abort, { once: true });

  const exited = new Promise<DetachedWorkspaceExit>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      if (error) {
        stdout.error(error);
        stderr.error(error);
        reject(error);
        return;
      }
      if (!outputCancelled) {
        stdout.close();
        stderr.close();
      }
      if (!exit) {
        reject(new WorkspaceHelperError(status.INTERNAL, "The workspace helper ended the call without an exit status"));
        return;
      }
      resolve(exit);
    };
    call.on("data", (response: ExecResponse) => {
      if (outputCancelled) return;
      switch (response.response) {
        case "stdout":
          stdout.enqueue(new Uint8Array(response.stdout));
          if (stdout.desiredSize! <= 0) call.pause();
          return;
        case "stderr": stderr.enqueue(new Uint8Array(response.stderr)); return;
        case "exited": {
          const exited = response.exited;
          exit = exited.status === "exitCode" ? { exitCode: exited.exitCode } : exited.status === "signal" ? { signal: exited.signal } : { unknown: true };
          return;
        }
      }
    });
    call.on("error", (error: ServiceError) => finish(callError(error, signal)));
    call.on("end", () => finish());
  });
  // Callers that only use the output streams still learn about failures there.
  exited.catch(() => {});
  return {
    stdout: stdoutStream,
    stderr: stderrStream,
    exited,
    /** Sends a request unless the call is over. */
    send(request: Request) { if (!finished) call.write(request); },
  };
}

const encode = (data: string | Uint8Array) => data instanceof Uint8Array ? data : new TextEncoder().encode(data);
const acknowledgement = (offsets: WorkspaceOutputOffsets): Acknowledge => ({ stdoutOffset: offsets.stdout, stderrOffset: offsets.stderr });

/**
 * Starts a process in a workspace. `waitForReady` waits for a helper that is
 * still starting instead of failing at once; pair it with an abort signal.
 */
export function startWorkspaceProcess(socketPath: string, start: WorkspaceExecStart, options: { signal?: AbortSignal; waitForReady?: boolean } = {}): WorkspaceProcess {
  options.signal?.throwIfAborted();
  const { terminal, stdin, user, ...rest } = start;
  if (terminal && stdin) throw new Error("A terminal always takes input; stdin must be unset with one");
  const call = openCall<ExecRequest>(socketPath, execMethod, options.waitForReady);
  const received = receive(call, options.signal);
  call.write({ start: { ...rest, user: users[user], ...terminal ? { terminal } : { pipes: { stdin: stdin ?? false } } } });
  return {
    stdout: received.stdout,
    stderr: received.stderr,
    exited: received.exited.then((exit) => {
      if ("unknown" in exit) throw new WorkspaceHelperError(status.INTERNAL, "The workspace helper lost track of a process it should have reaped");
      return exit;
    }),
    write(data) { received.send({ stdin: encode(data) }); },
    closeStdin() { received.send({ closeStdin: {} }); },
    signal(signal) { received.send({ signal: signals[signal] }); },
    resize(size) { received.send({ resize: size }); },
    cancel() { call.cancel(); },
  };
}

/**
 * Starts a process that outlives this call, so `attachWorkspaceProcess` can
 * reconnect to it, e.g. after the app restarts. Its output goes to disk in the
 * workspace and its stdin never closes; stop it with `signal`. The call
 * streams the output from the start.
 */
export function startDetachedWorkspaceProcess(socketPath: string, name: string, start: WorkspaceDetachedStart, options: { signal?: AbortSignal; waitForReady?: boolean } = {}): DetachedWorkspaceProcess {
  options.signal?.throwIfAborted();
  const call = openCall<ExecRequest>(socketPath, execMethod, options.waitForReady);
  const received = receive(call, options.signal);
  const { stdin, user, ...rest } = start;
  call.write({ start: { ...rest, user: users[user], detached: { name, stdin: stdin ?? false } } });
  return detachedProcess(call, received);
}

/** Reconnects to a detached process, streaming its output from `offsets`. Fails with NOT_FOUND once the process is gone. */
export function attachWorkspaceProcess(socketPath: string, name: string, offsets: WorkspaceOutputOffsets, options: { signal?: AbortSignal; waitForReady?: boolean } = {}): DetachedWorkspaceProcess {
  options.signal?.throwIfAborted();
  const call = openCall<AttachRequest>(socketPath, attachMethod, options.waitForReady);
  const received = receive(call, options.signal);
  call.write({ attach: { name, ...acknowledgement(offsets) } });
  return detachedProcess(call, received);
}

function detachedProcess<Request extends ExecRequest | AttachRequest>(call: HelperCall<Request>, received: ReturnType<typeof receive<Request>>): DetachedWorkspaceProcess {
  // SAFETY: Exec and Attach requests share the stdin, signal and acknowledge shapes.
  const send = (request: ExecRequest & AttachRequest) => received.send(request as Request);
  return {
    stdout: received.stdout,
    stderr: received.stderr,
    exited: received.exited,
    write(data) { send({ stdin: encode(data) }); },
    signal(signal) { send({ signal: signals[signal] }); },
    acknowledge(offsets) { send({ acknowledge: acknowledgement(offsets) }); },
    detach() { call.cancel(); },
  };
}

const stdinChunkBytes = 64 * 1024;

export interface WorkspaceRunResult { exitCode: number; stdout: Buffer; stderr: Buffer }

/** Runs a process to completion, collecting its output. */
export async function runWorkspaceProcess(socketPath: string, start: Omit<WorkspaceExecStart, "stdin" | "terminal">, options: { stdin?: string | Uint8Array; signal?: AbortSignal; waitForReady?: boolean } = {}): Promise<WorkspaceRunResult> {
  const process = startWorkspaceProcess(socketPath, { ...start, stdin: options.stdin !== undefined }, options);
  if (options.stdin !== undefined) {
    const input = options.stdin instanceof Uint8Array ? options.stdin : new TextEncoder().encode(options.stdin);
    for (let offset = 0; offset < input.byteLength; offset += stdinChunkBytes) process.write(input.subarray(offset, offset + stdinChunkBytes));
    process.closeStdin();
  }
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).arrayBuffer(), new Response(process.stderr).arrayBuffer(), process.exited]);
  return { exitCode: exitStatus(exit), stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

/** A file in a workspace, accessed with `user`'s permissions. Symlinks are followed. */
export interface WorkspaceFile {
  user: WorkspaceHelperUser;
  /** Absolute. */
  path: string;
}

/** Streams a regular file. Cancelling the stream ends the call; a failure, e.g. NOT_FOUND, errors it. */
export function readWorkspaceFileStream(socketPath: string, file: WorkspaceFile, options: { signal?: AbortSignal } = {}): ReadableStream<Uint8Array> {
  options.signal?.throwIfAborted();
  const call = client(socketPath).makeServerStreamRequest(readFileMethod.path, readFileMethod.requestSerialize, readFileMethod.responseDeserialize, { user: users[file.user], path: file.path });
  // Set once the stream is cancelled or settled; grpc-js emits `end` even after `error`.
  let finished = false;
  const abort = () => call.cancel();
  options.signal?.addEventListener("abort", abort, { once: true });
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      const finish = (settle: () => void) => {
        if (finished) return;
        finished = true;
        options.signal?.removeEventListener("abort", abort);
        settle();
      };
      call.on("data", (chunk: { data: Buffer }) => {
        if (finished) return;
        controller.enqueue(new Uint8Array(chunk.data));
        if (controller.desiredSize! <= 0) call.pause();
      });
      call.on("error", (error: ServiceError) => finish(() => controller.error(callError(error, options.signal))));
      call.on("end", () => finish(() => controller.close()));
    },
    pull: () => { call.resume(); },
    cancel: () => {
      finished = true;
      options.signal?.removeEventListener("abort", abort);
      call.cancel();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }));
}

/** Reads a whole regular file, failing with RESOURCE_EXHAUSTED once it exceeds `maxBytes`. */
export async function readWorkspaceFile(socketPath: string, file: WorkspaceFile, options: { maxBytes: number; signal?: AbortSignal }): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of readWorkspaceFileStream(socketPath, file, options)) {
    size += chunk.byteLength;
    // Leaving the loop cancels the stream, and with it the call.
    if (size > options.maxBytes) throw new WorkspaceHelperError(status.RESOURCE_EXHAUSTED, `${file.path} is larger than ${options.maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const fileChunkBytes = 64 * 1024;

/** Replaces or creates a file atomically, along with any missing folders. */
export async function writeWorkspaceFile(socketPath: string, file: WorkspaceFile, content: string | Uint8Array, options: { signal?: AbortSignal } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  let call!: ClientWritableStream<WriteFileRequest>;
  const finished = new Promise<void>((resolve, reject) => {
    call = client(socketPath).makeClientStreamRequest(writeFileMethod.path, writeFileMethod.requestSerialize, writeFileMethod.responseDeserialize, new Metadata(), {}, (error: ServiceError | null) => {
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(callError(error, options.signal));
      else resolve();
    });
  });
  const abort = () => call.cancel();
  options.signal?.addEventListener("abort", abort, { once: true });
  // A failed call never drains; `finished` rejects instead.
  const drained = () => Promise.race([new Promise((resolve) => call.once("drain", resolve)), finished]);
  call.write({ start: { user: users[file.user], path: file.path } });
  const bytes = encode(content);
  for (let offset = 0; offset < bytes.byteLength; offset += fileChunkBytes) {
    if (!call.write({ data: bytes.subarray(offset, offset + fileChunkBytes) })) await drained();
  }
  call.end();
  await finished;
}

/** What is at a path, as a user sees it, following symlinks. */
export type WorkspaceFileStat = { path: string } & (
  /** Nothing there, a dangling symlink, or a symlink loop. */
  | { kind: "missing" }
  /** The user may not look into a folder on the way. */
  | { kind: "inaccessible" }
  | {
    kind: "regular" | "directory" | "other";
    /** The path itself is a symlink; the rest describes its target. */
    symlink: boolean;
    size: number;
    modified: Date;
    /** Opening it for reading succeeds. Always false for `other`, which is never opened. */
    readable: boolean;
    /** The absolute path without symlinks, `.` or `..`; absent for a file removed since it was described. */
    canonicalPath?: string;
  }
);

const fileKinds = {
  FILE_KIND_MISSING: "missing",
  FILE_KIND_INACCESSIBLE: "inaccessible",
  FILE_KIND_REGULAR: "regular",
  FILE_KIND_DIRECTORY: "directory",
  FILE_KIND_OTHER: "other",
} satisfies Record<string, WorkspaceFileStat["kind"]>;
type FileStat = { kind: keyof typeof fileKinds; symlink?: boolean; size?: number; modifiedUnixMs?: number; readable?: boolean; canonicalPath?: string };

function workspaceFileStat(path: string, stat: FileStat): WorkspaceFileStat {
  const kind = fileKinds[stat.kind];
  if (kind === "missing" || kind === "inaccessible") return { path, kind };
  // Proto3 leaves zero values off the wire.
  const described: WorkspaceFileStat = { path, kind, symlink: stat.symlink ?? false, size: stat.size ?? 0, modified: new Date(stat.modifiedUnixMs ?? 0), readable: stat.readable ?? false };
  if (stat.canonicalPath) described.canonicalPath = stat.canonicalPath;
  return described;
}

/** Describes each of `paths`, all absolute, as `user` sees them, without reading them; in request order. */
export async function statWorkspaceFiles(socketPath: string, user: WorkspaceHelperUser, paths: string[], options: { signal?: AbortSignal } = {}): Promise<WorkspaceFileStat[]> {
  options.signal?.throwIfAborted();
  const stats = await new Promise<FileStat[]>((resolve, reject) => {
    const call = client(socketPath).makeUnaryRequest(statFilesMethod.path, statFilesMethod.requestSerialize, statFilesMethod.responseDeserialize, { user: users[user], paths }, (error: ServiceError | null, response?: { stats?: FileStat[] }) => {
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(callError(error, options.signal));
      else resolve(response!.stats ?? []);
    });
    const abort = () => call.cancel();
    options.signal?.addEventListener("abort", abort, { once: true });
  });
  return paths.map((path, index) => workspaceFileStat(path, stats[index]!));
}

/** A regular file opened in a workspace; see `openWorkspaceFile`. */
export interface WorkspaceOpenFile {
  /** What the open file is now, even when its path names another file meanwhile. */
  stat(): Promise<{ size: number; modified: Date }>;
  /** Up to `length` bytes at `offset`; fewer only at the end of the file. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Closes the file. */
  close(): void;
}

type OpenFileRequest = { open: { user: string; path: string } } | { read: { offset: number; length: number } } | { stat: Record<string, never> };
// Proto3 leaves empty bytes off the wire.
type OpenFileResponse = { response: "stat"; stat: FileStat } | { response: "data"; data?: Buffer };

/** The most the helper reads at once; longer reads take several. */
const maxFileRangeBytes = 1024 * 1024;

/**
 * Opens a regular file, following symlinks, for reads of parts of it, all from the one open file. Fails like
 * `readWorkspaceFileStream`, e.g. with NOT_FOUND, or FAILED_PRECONDITION for a folder. The signal closes it.
 */
export async function openWorkspaceFile(socketPath: string, file: WorkspaceFile, options: { signal?: AbortSignal } = {}): Promise<WorkspaceOpenFile> {
  options.signal?.throwIfAborted();
  const call: ClientDuplexStream<OpenFileRequest, OpenFileResponse> = client(socketPath).makeBidiStreamRequest(openFileMethod.path, openFileMethod.requestSerialize, openFileMethod.responseDeserialize, new Metadata(), {});
  // Each request gets one response, in order.
  const pending: { resolve: (response: OpenFileResponse) => void; reject: (error: Error) => void }[] = [];
  let failure: Error | undefined;
  const abort = () => call.cancel();
  options.signal?.addEventListener("abort", abort, { once: true });
  const fail = (error: Error) => {
    options.signal?.removeEventListener("abort", abort);
    failure ??= error;
    for (const waiter of pending.splice(0)) waiter.reject(failure);
  };
  call.on("data", (response: OpenFileResponse) => pending.shift()?.resolve(response));
  call.on("error", (error: ServiceError) => fail(callError(error, options.signal)));
  call.on("end", () => fail(new WorkspaceHelperError(status.CANCELLED, `${file.path} is closed`)));
  const request = (message: OpenFileRequest) => new Promise<OpenFileResponse>((resolve, reject) => {
    if (failure) { reject(failure); return; }
    pending.push({ resolve, reject });
    call.write(message);
  });
  const stat = (response: OpenFileResponse) => {
    if (response.response !== "stat") throw new WorkspaceHelperError(status.INTERNAL, "The workspace helper answered a stat with data");
    return { size: response.stat.size ?? 0, modified: new Date(response.stat.modifiedUnixMs ?? 0) };
  };
  try {
    stat(await request({ open: { user: users[file.user], path: file.path } }));
  } catch (error) {
    call.cancel();
    throw error;
  }
  return {
    async stat() { return stat(await request({ stat: {} })); },
    async read(offset, length) {
      const chunks: Uint8Array[] = [];
      let read = 0;
      while (read < length) {
        const wanted = Math.min(maxFileRangeBytes, length - read);
        const response = await request({ read: { offset: offset + read, length: wanted } });
        if (response.response !== "data") throw new WorkspaceHelperError(status.INTERNAL, "The workspace helper answered a read with a stat");
        const data = new Uint8Array(response.data ?? []);
        chunks.push(data);
        read += data.byteLength;
        // The end of the file.
        if (data.byteLength < wanted) break;
      }
      return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    },
    close() {
      if (failure) return;
      fail(new WorkspaceHelperError(status.CANCELLED, `${file.path} is closed`));
      call.end();
    },
  };
}

export { status as WorkspaceHelperStatus } from "@grpc/grpc-js";
