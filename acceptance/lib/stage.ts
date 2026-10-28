/**
 * Stages the shared acceptance setup through Kintsugi's automation API
 * (docs/automation.md): a built-in agent with a long transcript, a Pi CLI
 * agent, a terminal tab and a prompt template with a composer button. An existing
 * workspace can be reused.
 */

export interface Stage {
  kintsugi: string;
  workspaceId: string;
  builtinId: string;
  /** Omitted only by the explicitly partial layout-only setup. */
  piId?: string;
  terminalKey: string;
}

interface WorkspaceJson {
  workspace: {
    id: string;
    phase: { kind: string; status?: string };
    agents: { id: string; agentTypeId: string; busy: boolean; title: string }[];
    workViews: { key: string; reference: { type: string } }[];
  };
}

async function json<T>(kintsugi: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(new URL(path, kintsugi), {
    method: init.method ?? "GET",
    headers: { Accept: "application/json", "Content-Type": "application/json", Origin: new URL(kintsugi).origin },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${text.slice(0, 400)}`);
  // SAFETY: Kintsugi's documented JSON contract for these operations (GET /openapi.json).
  return JSON.parse(text) as T;
}

const longPrompt = "Without using any tools, write a long markdown explanation (about 1500 words, with headings, lists and two short code blocks) of how terminal emulators handle window resizing (SIGWINCH, PTY, tmux).";

async function workspace(kintsugi: string, id: string): Promise<WorkspaceJson["workspace"]> {
  return (await json<WorkspaceJson>(kintsugi, `/workspaces/${encodeURIComponent(id)}`)).workspace;
}

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(1000);
  }
}

export async function stage(options: { kintsugi: string; workspaceId?: string; model?: string; layoutOnly?: boolean; log(message: string): void }): Promise<Stage> {
  const { kintsugi, log } = options;
  let id = options.workspaceId;
  if (!id) {
    log("creating workspace");
    const created = await json<{ workspace: { id: string } }>(kintsugi, "/workspaces", { method: "POST", body: { source: { type: "empty" }, title: "Composer acceptance", agent: { agentTypeId: "builtin" } } });
    id = created.workspace.id;
  }
  await until("workspace to run", 300_000, async () => {
    const current = await workspace(kintsugi, id!);
    if (current.phase.status === "failed") throw new Error(`workspace ${id} failed to start`);
    return current.phase.kind === "runningPhase" ? true : undefined;
  });
  let current = await workspace(kintsugi, id);
  let builtin = current.agents.find((agent) => agent.agentTypeId === "builtin");
  if (!builtin) {
    log("creating built-in agent");
    await json(kintsugi, `/workspaces/${id}/commands/agent.create.builtin`, { method: "POST", body: {} });
    current = await workspace(kintsugi, id);
    builtin = current.agents.find((agent) => agent.agentTypeId === "builtin")!;
  }
  const transcript = await fetch(new URL(`/workspaces/${id}?agent=${builtin.id}`, kintsugi)).then((response) => response.text());
  if (!options.layoutOnly && !transcript.includes("SIGWINCH")) {
    log("generating a long transcript");
    if (options.model) await json(kintsugi, `/workspaces/${id}/agents/${builtin.id}/model`, { method: "POST", body: { model: options.model } });
    await json(kintsugi, `/workspaces/${id}/agents/${builtin.id}/messages`, { method: "POST", body: { text: longPrompt, mode: "send" } });
    await Bun.sleep(3000);
    await until("the long answer", 300_000, async () => (await workspace(kintsugi, id!)).agents.find((agent) => agent.id === builtin!.id)!.busy ? undefined : true);
  }
  let pi = current.agents.find((agent) => agent.agentTypeId === "pi");
  if (!pi && !options.layoutOnly) {
    log("creating Pi agent");
    const created = await json<{ command: { agentId: string } }>(kintsugi, `/workspaces/${id}/commands/agent.create.pi`, { method: "POST", body: {} });
    pi = { id: created.command.agentId, agentTypeId: "pi", busy: false, title: "Pi" };
  }
  current = await workspace(kintsugi, id);
  let terminal = current.workViews.find((view) => view.reference.type === "terminal");
  if (!terminal) {
    log("creating terminal tab");
    await json(kintsugi, `/workspaces/${id}/commands/terminal.create`, { method: "POST", body: { title: "Shell", cwd: "/work" } });
    terminal = (await workspace(kintsugi, id)).workViews.find((view) => view.reference.type === "terminal")!;
  }
  await stagePromptTemplateButton(id);
  return { kintsugi, workspaceId: id, builtinId: builtin.id, piId: pi?.id, terminalKey: terminal.key };
}

/** A prompt template with its composer button enabled, so composers show their Prompt template button row. */
async function stagePromptTemplateButton(workspaceId: string): Promise<void> {
  const template = "---\ndescription: Reply with OK\ncomposer-button: true\n---\nReply with just the word OK.\n";
  await workspaceExec(workspaceId, ["sh", "-c", "mkdir -p /work/.kintsugi/prompts && cat > /work/.kintsugi/prompts/ok.md"], template);
}

/** tmux window sizes inside the workspace container, by session name. Read-only: no hooks are installed. */
export async function tmuxSizes(workspaceId: string): Promise<Record<string, string>> {
  const process = Bun.spawn(["docker", "exec", "-u", "agent", `kintsugi-${workspaceId}`, "tmux", "list-windows", "-a", "-F", "#{session_name} #{window_width}x#{window_height}"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [output, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) {
    // A fresh or restarted workspace has no sessions until a terminal is opened.
    if (code === 1 && /^(?:no current target|no sessions|no server running on [^\n]+|error connecting to [^\n]+ \(No such file or directory\))$/.test(stderr.trim())) return {};
    throw new Error(`Sampling tmux sizes failed (${code}): ${stderr}`);
  }
  return Object.fromEntries(output.trim().split("\n").filter(Boolean).map((line) => {
    const space = line.lastIndexOf(" ");
    return [line.slice(0, space), line.slice(space + 1)];
  }));
}

/** Runs a command in the workspace container as its user and returns its output. */
async function workspaceExec(workspaceId: string, command: string[], stdin?: string): Promise<string> {
  const process = Bun.spawn(["docker", "exec", "-i", "-u", "agent", `kintsugi-${workspaceId}`, ...command], { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(process.stdout).text();
  if (await process.exited !== 0) throw new Error(`${command.join(" ")} failed: ${await new Response(process.stderr).text()}`);
  return output;
}
