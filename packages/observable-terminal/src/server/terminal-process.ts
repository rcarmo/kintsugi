import { createHash } from "node:crypto";
import { KintsugiCoreError, commandSignal, invalidArguments, shellQuote, withCommandSignal } from "@kintsugi/core";
import type { WorkspaceServerSocketSession } from "@kintsugi/shared";
import type { StartWorkspaceProcess, WorkspaceExecStart } from "@kintsugi/workspace-helper";
import { terminalEndedCloseCode } from "../shared/index.ts";
import { createObservableTerminalSocket } from "./socket.ts";
import { observableTerminalCols, observableTerminalEnvironment, observableTerminalHistoryLimit, observableTerminalRows } from "./constants.ts";
import { stripTerminalControls } from "./text.ts";

/**
 * Runs one short command to completion where the terminal processes live, such
 * as `runInWorkspace` bound to one workspace.
 */
export type RunTerminalProcessCommand = (
  start: Omit<WorkspaceExecStart, "stdin" | "terminal">,
  options: { stdin?: string },
) => Promise<{ exitCode: number; stdout: Buffer; stderr: string }>;

export interface TerminalProcessStart {
  /** Chosen by the caller, so a retried start finds the same process instead of running it twice. */
  id: string;
  /** A bash script. It runs on the terminal, so it sees a TTY and can be watched live. */
  command: string;
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Epoch milliseconds. Enforced where the process runs, and never extended by starting again. */
  deadline?: number;
  /** Also keep the output as plain text in `textFile(id)`, which outlives `release`. */
  keepText?: boolean;
  /** Viewers can type, and the terminal follows their size. Otherwise they only watch it, at its own size. */
  interactive?: boolean;
}

export interface TerminalProcessOutput {
  /** Scrollback and final screen, with colors. */
  ansi: string;
  /** The same, as plain text. */
  text: string;
}

export type TerminalProcessState =
  | { state: "running"; interactive: boolean }
  | {
    state: "exited";
    /** Null when the command never ran: it was stopped before it started, or its deadline had passed. */
    exitCode: number | null;
    /** Stopped with `stop`. */
    aborted: boolean;
    /** Stopped at its deadline. */
    timedOut: boolean;
    output: TerminalProcessOutput;
  }
  /** Started, but its terminal disappeared before recording a result, e.g. because tmux was killed. */
  | { state: "lost" }
  /** Never started here, or already released. */
  | { state: "missing" };

export interface TerminalProcesses {
  /**
   * Starts the process in its own tmux session, returning once its command runs.
   * Starting it again with the same input does nothing, and so does starting a
   * process that was stopped first.
   */
  start(options: TerminalProcessStart): Promise<void>;
  state(id: string): Promise<TerminalProcessState>;
  /** Waits until the process is no longer running; the ambient command signal cancels waiting, not the process. */
  waitForEnd(id: string): Promise<Exclude<TerminalProcessState, { state: "running" }>>;
  /** Waits until the process exits; the ambient command signal cancels waiting, not the process. */
  waitForExit(id: string): Promise<Extract<TerminalProcessState, { state: "exited" }>>;
  /**
   * Interrupts the command, killing it if it ignores that, and records it as
   * aborted. Stopping a process that was not started yet keeps it from starting.
   */
  stop(id: string): Promise<void>;
  /**
   * Forgets the process and its result, killing it if it still runs. Release only
   * once the result is stored elsewhere: starting the same id again runs it again.
   */
  release(id: string): Promise<void>;
  /** Where `keepText` keeps the plain-text output. */
  textFile(id: string): string;
  /**
   * A viewer's live connection to the process's terminal, sized `size` if the
   * process is interactive. It closes with `terminalEndedCloseCode` once the
   * process is no longer running, at once if it already isn't.
   */
  connect(id: string, size: { cols: number; rows: number }): WorkspaceServerSocketSession;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const rootPattern = /^\/[A-Za-z0-9._/-]+$/;

export function terminalProcessSession(id: string): string {
  return `kintsugi-process-${id}`;
}

// Existing processes keep their tmux session and the channels embedded in their
// wrapper scripts. Resolve those names without renaming or interrupting them.
const sessionExistsFunction = `session_exists() {
  if tmux -N has-session -t "=$session" 2>/dev/null; then return 0; fi
  session="aitc-process-\${session#kintsugi-process-}"
  tmux -N has-session -t "=$session" 2>/dev/null
}
`;

/**
 * Waits for the session's finish, or `seconds` at most; callers check again
 * either way. tmux keeps waiters that were killed, and a signal to one of those
 * is lost, so instead of timing out a waiter, a tmux timer signals it.
 */
const awaitFinishFunction = `await_finish() {
  tmux run-shell -b -d "$2" "tmux wait-for -S $1"
  tmux wait-for "$1"
}
`;

// The scripts below live in each process's directory. They are POSIX sh, and
// rely only on tmux, flock and pgrep besides. Nothing waits by sleeping:
// tmux reports when a pane is dead (only once it has read all of the pane's
// output), runs the deadline timer, and signals waiters through `wait-for`.

/**
 * Interrupts the process group led by the wrapper, sparing the wrapper so the
 * pane outlives the command. Members still running after a grace period, because
 * they ignore TERM, are killed.
 */
const interruptScript = `${awaitFinishFunction}interrupt() {
  dir=$1 session=$2
  leader=$(cat "$dir/pid")
  kill -TERM "-$leader" 2>/dev/null || return 0
  if [ ! -f "$dir/exit" ]; then await_finish "$session" 2; fi
  if [ -f "$dir/exit" ]; then return 0; fi
  for member in $(pgrep -g "$leader"); do
    if [ "$member" != "$leader" ]; then kill -KILL "$member" 2>/dev/null; fi
  done
}
`;

/** Run by tmux's timer at the deadline. */
const expireScript = `dir=$1 session=$2
if [ ! -d "$dir" ] || [ -f "$dir/exit" ]; then exit 0; fi
touch "$dir/timed-out"
. "$dir/interrupt"
interrupt "$dir" "$session"
`;

/**
 * The pane's process. It waits until start has set up the pane, so the command
 * can't finish before tmux keeps its pane and output, then tells start that the
 * command runs. Handling INT and TERM (rather than ignoring them) keeps it alive
 * through a stop, while the command still receives them with their default
 * behavior. Its exit status is the command's.
 */
const wrapperScript = `dir=$1 session=$2
trap : INT TERM
tmux wait-for "$session-ready"
tmux wait-for -S "$session-running"
bash -- "$dir/command"
`;

/**
 * Run by tmux's pane-died hook: the pane is dead, and tmux has read all of its
 * output. Records the result, then wakes everyone waiting for it.
 */
const finishScript = `dir=$1 session=$2 pane=$3 status=\${4#s} signal=\${5#g}
if [ ! -d "$dir" ]; then exit 0; fi
if [ -n "$signal" ] && [ "$signal" != 0 ]; then code=$((128 + signal)); else code=$status; fi
tmux capture-pane -p -e -J -S - -t "$pane" > "$dir/output"
if [ -f "$dir/keep-text" ]; then tmux capture-pane -p -J -S - -t "$pane" > "$dir.txt"; fi
printf '%s\\n' "$code" > "$dir/exit.tmp"
mv "$dir/exit.tmp" "$dir/exit"
tmux kill-pane -t "$pane"
tmux wait-for -S "$session"
`;

// Starting, stopping and releasing hold a lock on the root, so a stop can't
// slip between claiming an id and launching it. The command arrives on stdin.
const lockRoot = `mkdir -p "$root" || exit 1
exec 9<"$root"
flock 9
`;

/** A process that never ran, recorded the way the finish script records one that did. */
const recordNotRun = `touch "$dir/output"
if [ -f "$dir/keep-text" ]; then : > "$dir.txt"; fi
printf 'none\\n' > "$dir/exit.tmp"
mv "$dir/exit.tmp" "$dir/exit"
`;

const startScript = `root=$1 dir=$2 session=$3 digest=$4 cwd=$5 cols=$6 rows=$7 history=$8 deadline=$9
shift 9
keep=$1 interactive=$2 pane=$3 hook=$4 expiry=$5
shift 5
${lockRoot}if ! mkdir "$dir" 2>/dev/null; then
  if [ "$(cat "$dir/request" 2>/dev/null)" = "$digest" ]; then exit 0; fi
  # Stopped before it started.
  if [ -f "$dir/aborted" ] && [ ! -f "$dir/request" ]; then exit 0; fi
  echo "Terminal process \${dir##*/} was already started with different input" >&2
  exit 3
fi
printf '%s\\n' "$digest" > "$dir/request"
cat > "$dir/command"
if [ "$keep" = 1 ]; then touch "$dir/keep-text"; fi
remaining=
if [ -n "$deadline" ]; then
  remaining=$((deadline - $(date +%s%N) / 1000000))
  if [ "$remaining" -le 0 ]; then
    touch "$dir/timed-out"
${recordNotRun}    exit 0
  fi
fi
cat > "$dir/interrupt" <<'INTERRUPT'
${interruptScript}INTERRUPT
cat > "$dir/expire" <<'EXPIRE'
${expireScript}EXPIRE
cat > "$dir/finish" <<'FINISH'
${finishScript}FINISH
cat > "$dir/run" <<'WRAPPER'
${wrapperScript}WRAPPER
# Interactive panes follow their viewer's size and pass escape sequences, like the clipboard's, through.
if [ "$interactive" = 1 ]; then
  touch "$dir/interactive"
  viewers="set-option -p -t =$session: allow-passthrough on"
else
  viewers="set-option -t =$session: window-size manual"
fi
# Older tmux versions apply history-limit only when a pane is created.
# A discard pipe also makes tmux drain unread PTY bytes before pane-died:
# its exit-readiness check only checks FIONREAD while a pipe is installed.
tmux -N set-option -g history-limit "$history" || exit 1
if ! pid=$(tmux -N new-session -d -P -F '#{pane_pid}' -s "$session" -x "$cols" -y "$rows" -c "$cwd" "$@" "$pane" \\; \\
  set-option -t "=$session:" status off \\; \\
  $viewers \\; \\
  set-option -t "=$session:" history-limit "$history" \\; \\
  set-option -p -t "=$session:" remain-on-exit on \\; \\
  set-option -p -t "=$session:" remain-on-exit-format '' \\; \\
  pipe-pane -O -t "=$session:" 'cat >/dev/null' \\; \\
  set-hook -p -t "=$session:" pane-died "$hook"); then
  rm -rf "$dir"
  exit 1
fi
printf '%s\\n' "$pid" > "$dir/pid"
if [ -n "$remaining" ]; then
  tmux -N run-shell -b -d "$((remaining / 1000)).$(printf '%03d' "$((remaining % 1000))")" "$expiry"
fi
tmux -N wait-for -S "$session-ready"
# Holding the lock until the command runs, so a stop always finds it running.
tmux -N wait-for "$session-running"
`;

// Reading the exit before and after checking the session tells a process that
// just finished apart from one whose terminal disappeared.
const stateScript = `dir=$1 session=$2
# Release removes the result directory under the root's exclusive lock. Keep
# the exit marker and captured output alive for the entire snapshot read.
root=\${dir%/*}
if [ ! -d "$root" ]; then echo missing; exit 0; fi
exec 9<"$root" || exit 1
flock -s 9
${sessionExistsFunction}flag() { if [ -f "$dir/$1" ]; then echo 1; else echo 0; fi; }
report() { printf 'exited %s %s %s\\n' "$(cat "$dir/exit")" "$(flag aborted)" "$(flag timed-out)"; cat "$dir/output"; exit 0; }
if [ -f "$dir/exit" ]; then report; fi
if [ ! -d "$dir" ]; then echo missing; exit 0; fi
if session_exists; then echo "running $(flag interactive)"; exit 0; fi
if [ -f "$dir/exit" ]; then report; fi
echo lost
`;

/**
 * Returns once the process has exited, or after a while regardless. A finish
 * that signals between checking for the exit and waiting is remembered for one
 * waiter only, so the others rely on the timer to look again.
 */
const waitScript = `dir=$1 session=$2
${sessionExistsFunction}${awaitFinishFunction}if [ -f "$dir/exit" ] || ! session_exists; then exit 0; fi
await_finish "$session" 60
`;

const stopScript = `root=$1 dir=$2 session=$3
${sessionExistsFunction}${lockRoot}if [ ! -d "$dir" ]; then
  mkdir "$dir"
  touch "$dir/aborted"
${recordNotRun}  exit 0
fi
if [ -f "$dir/exit" ]; then exit 0; fi
touch "$dir/aborted"
flock -u 9
if ! session_exists; then exit 0; fi
. "$dir/interrupt"
interrupt "$dir" "$session"
`;

// Killing the session first destroys its pane without running the pane-died hook.
// While the session exists its wrapper is alive, so the recorded pid is still its own.
const releaseScript = `root=$1 dir=$2 session=$3
${sessionExistsFunction}${lockRoot}if session_exists; then
  pid=$(cat "$dir/pid")
  tmux -N kill-session -t "=$session"
  kill -KILL "-$pid" 2>/dev/null
fi
rm -rf "$dir"
`;

function requestDigest(options: TerminalProcessStart, cols: number, rows: number): string {
  const env = Object.entries(options.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const { command, cwd, deadline, keepText, interactive } = options;
  return createHash("sha256").update(JSON.stringify({ command, cwd, env, cols, rows, deadline, keepText, interactive })).digest("hex");
}

function parseOutput(ansi: string): TerminalProcessOutput {
  // The capture ends with the final screen's unused rows.
  const trimmed = ansi.replace(/\s+$/, "");
  return { ansi: trimmed, text: stripTerminalControls(trimmed).replace(/\s+$/, "") };
}

/**
 * Terminal processes in one place, such as a workspace, keeping each result until
 * it is released. `run` runs the short commands that manage them, and `start`
 * the terminal clients that viewers connect through.
 */
export function createTerminalProcesses(options: { run: RunTerminalProcessCommand; start: StartWorkspaceProcess; root: string }): TerminalProcesses {
  // Paths appear unquoted in tmux commands, such as the pane-died hook.
  if (!rootPattern.test(options.root)) throw invalidArguments(`Invalid terminal processes root: ${options.root}`);
  const directory = (id: string): string => {
    if (!idPattern.test(id)) throw invalidArguments(`Invalid terminal process id: ${id}`);
    return `${options.root}/${id}`;
  };
  const sh = async (script: string, args: string[], stdin?: string): Promise<string> => {
    const result = await options.run({ argv: ["sh", "-c", script, "sh", ...args], user: "agent", workdir: "/" }, { stdin });
    if (result.exitCode !== 0) {
      throw new KintsugiCoreError("terminal_process_failed", result.stderr.trim() || `Terminal process command failed with exit code ${result.exitCode}`);
    }
    return result.stdout.toString();
  };

  async function state(id: string): Promise<TerminalProcessState> {
    const session = terminalProcessSession(id);
    const stdout = await sh(stateScript, [directory(id), session]);
    const newline = stdout.indexOf("\n");
    const header = newline < 0 ? stdout : stdout.slice(0, newline);
    const running = /^running ([01])$/.exec(header);
    if (running) return { state: "running", interactive: running[1] === "1" };
    if (header === "missing" || header === "lost") return { state: header };
    const exited = /^exited (\d+|none) ([01]) ([01])$/.exec(header);
    if (!exited) throw new KintsugiCoreError("terminal_process_failed", `Unexpected terminal process state: ${header}`);
    return {
      state: "exited",
      exitCode: exited[1] === "none" ? null : Number(exited[1]),
      aborted: exited[2] === "1",
      timedOut: exited[3] === "1",
      output: parseOutput(stdout.slice(newline + 1)),
    };
  }

  async function waitForEnd(id: string): Promise<Exclude<TerminalProcessState, { state: "running" }>> {
    const signal = commandSignal();
    for (;;) {
      signal?.throwIfAborted();
      const current = await state(id);
      if (current.state !== "running") return current;
      await sh(waitScript, [directory(id), terminalProcessSession(id)]);
    }
  }

  return {
    async start(start) {
      const dir = directory(start.id);
      const session = terminalProcessSession(start.id);
      const cols = start.cols ?? observableTerminalCols;
      const rows = start.rows ?? observableTerminalRows;
      const env = Object.entries({ ...observableTerminalEnvironment, ...start.env }).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
      const pane = `exec sh ${dir}/run ${dir} ${session}`;
      // The prefixes keep each argument in place when tmux expands it to nothing.
      const hook = `run-shell -b "sh ${dir}/finish ${dir} ${session} #{hook_pane} s#{pane_dead_status} g#{pane_dead_signal} >/dev/null 2>&1"`;
      // The timer outlives release. Guard before opening the script, under the same
      // root lock as release, so deletion cannot race the check or its execution.
      const expiry = `flock ${options.root} sh -c ${shellQuote('if [ -f "$1/expire" ]; then . "$1/expire"; fi')} sh ${dir} ${session} >/dev/null 2>&1`;
      await sh(startScript, [
        options.root, dir, session, requestDigest(start, cols, rows), start.cwd,
        String(cols), String(rows), String(observableTerminalHistoryLimit), start.deadline === undefined ? "" : String(start.deadline),
        start.keepText ? "1" : "0", start.interactive ? "1" : "0", pane, hook, expiry, ...env,
      ], start.command);
    },
    state,
    waitForEnd,
    async waitForExit(id) {
      const ended = await waitForEnd(id);
      if (ended.state !== "exited") throw new KintsugiCoreError("terminal_process_failed", `Terminal process ${id} is ${ended.state}`);
      return ended;
    },
    async stop(id) {
      await sh(stopScript, [options.root, directory(id), terminalProcessSession(id)]);
    },
    async release(id) {
      await sh(releaseScript, [options.root, directory(id), terminalProcessSession(id)]);
    },
    textFile(id) {
      return `${directory(id)}.txt`;
    },
    connect(id, size) {
      const ended = async () => (await state(id)).state !== "running";
      let viewer: ReturnType<typeof createObservableTerminalSocket> | undefined;
      let closed = false;
      return {
        async open(socket) {
          const current = await state(id);
          if (closed) return;
          if (current.state !== "running") { socket.close(terminalEndedCloseCode, "ended"); return; }
          // Whether viewers can type and resize belongs to the process, not to the viewer.
          const session = await sh(`session=$1\n${sessionExistsFunction}session_exists || exit 0\nprintf '%s' "$session"`, [terminalProcessSession(id)]);
          if (closed) return;
          if (!session) { socket.close(terminalEndedCloseCode, "ended"); return; }
          viewer = createObservableTerminalSocket({
            start: options.start, session, ...size,
            user: "agent", workdir: "/", requireExistingServer: true, readonly: !current.interactive,
          }, { ended });
          await viewer.open(socket);
        },
        message(socket, message) { viewer?.message(socket, message); },
        close() {
          closed = true;
          viewer?.close();
        },
      };
    },
  };
}

/**
 * Runs a command to completion as a terminal process that viewers can watch
 * while it runs, telling `started` its id. The process is released however this
 * ends; when waiting is cancelled, that kills it.
 */
export async function runTerminalProcess(processes: TerminalProcesses, start: Omit<TerminalProcessStart, "id">, started: (id: string) => void | Promise<void>): Promise<Extract<TerminalProcessState, { state: "exited" }>> {
  const id = crypto.randomUUID();
  await processes.start({ ...start, id });
  try {
    await started(id);
    return await processes.waitForExit(id);
  } finally {
    // Not under the waiting's signal, which may be what was cancelled.
    await withCommandSignal(AbortSignal.timeout(10_000), () => processes.release(id));
  }
}
