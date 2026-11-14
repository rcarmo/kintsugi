import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
// System ships a standalone bundle, without the app's terminal CSS/node_modules.
import { attachHostObservableTerminal, type ObservableTerminalConnection } from "../../../observable-terminal/src/server/attach.ts";
import { buildObservableSessionCommand } from "../../../observable-terminal/src/server/tmux.ts";
import { parseObservableTerminalMessage } from "@kintsugi/observable-terminal/shared";
import { hostSocketPath, parseHostRequest, parseHostInput, terminalSize, validTerminalId, type HostReply, type HostResult, type HostCommand, type HostSample, type HostTerminal } from "../protocol.ts";
import { command } from "./command.ts";
import { sampleHost } from "./sampler.ts";
import { readCgroupResourceCounter, unavailableResourceCounter, type ResourceCounter, type ResourceSnapshot } from "@kintsugi/core/resource-metrics";

const tmux = (socketName: string, ...args: string[]) => command(["tmux", "-L", socketName, ...args]);

export class HostService {
  private lastSample?: HostSample;
  private sampling?: Promise<HostSample>;
  constructor(private readonly sample: () => Promise<HostSample>, private readonly socketName = "kintsugi-host", private readonly network?: (request: Extract<HostCommand, { operation: "network" }>) => Promise<HostResult>) {}

  meters?: (workspaceIds: readonly string[]) => Promise<ResourceSnapshot>;
  resourceControl?: (request: Extract<HostCommand, { operation: "resources" | "resource-policy" }>) => Promise<HostResult>;

  private async list(): Promise<HostTerminal[]> {
    // The dedicated host tmux server is started once and kept alive with no sessions.
    const text = await tmux(this.socketName, "list-sessions", "-F", "#{session_id}|#{session_name}");
    return text.split("\n").filter(Boolean)
      .map(line => { const [number, id] = line.split("|"); return { number: Number(number!.slice(1)) + 1, id: id! }; })
      .filter(session => validTerminalId(session.id))
      .sort((a, b) => a.number - b.number)
      .map(({ id, number }) => ({ id, title: `Terminal ${number}` }));
  }
  async require(id: string): Promise<HostTerminal> {
    const terminal = (await this.list()).find(item => item.id === id);
    if (!terminal) throw new Error("Host terminal no longer exists");
    return terminal;
  }
  async handle(request: HostCommand): Promise<HostResult> {
    switch (request.operation) {
      case "meters": {
        if (!this.meters) throw new Error("Resource meters are unavailable");
        return this.meters(request.workspaceIds);
      }
      case "resource-policy":
      case "resources": {
        if (!this.resourceControl) throw new Error("Workspace resource control is unavailable");
        return this.resourceControl(request);
      }
      case "network": {
        if (!this.network) throw new Error("Workspace network control is unavailable");
        return this.network(request);
      }
      case "list": return this.list();
      case "create": {
        const id = `host-${crypto.randomUUID()}`;
        await command(["sh", "-c", buildObservableSessionCommand({ session: id, socketName: this.socketName, cwd: "/", command: "/bin/bash", remainOnExit: true, historyLimit: 10000 })]);
        return this.require(id);
      }
      case "terminate": {
        const terminal = await this.require(request.id);
        await tmux(this.socketName, "kill-session", "-t", terminal.id);
        return null;
      }
      case "sample": {
        if (this.sampling) return this.sampling;
        if (!request.fresh && this.lastSample) return this.lastSample;
        this.sampling = this.sample().then(sample => this.lastSample = sample).finally(() => { this.sampling = undefined; });
        return this.sampling;
      }
    }
  }
}

/** Only the app receives this socket mount. No privileged API on the public supervisor listener. */
export async function startHostService(options: { workspaceCounters?: (ids: readonly string[]) => Promise<Record<string, ResourceCounter>>; resourceControl?: (request: Extract<HostCommand, { operation: "resources" | "resource-policy" }>) => Promise<HostResult>; root: string; effectiveMemory: number; socketPath?: string; tmuxSocketName?: string; network?: (request: Extract<HostCommand, { operation: "network" }>) => Promise<HostResult> }) {
  const socketPath = options.socketPath ?? hostSocketPath;
  const socketName = options.tmuxSocketName ?? "kintsugi-host";
  await mkdir(dirname(socketPath), { recursive: true });
  // Keep the server alive even after explicitly terminating the final terminal.
  await tmux(socketName, "-f", "/dev/null", "start-server", ";", "set-option", "-g", "exit-empty", "off");
  const service = new HostService(() => sampleHost(options.root, options.effectiveMemory), socketName, options.network);
  service.resourceControl = options.resourceControl;
  const workspaceCounters = options.workspaceCounters;
  if (workspaceCounters) service.meters = async ids => {
    const [system, workspaces] = await Promise.all([
      readCgroupResourceCounter(options.root, "system").catch(error => {
        console.error("System resource counters unavailable", error);
        return unavailableResourceCounter();
      }),
      workspaceCounters(ids).catch(error => {
        console.error("Workspace resource inspection unavailable", error);
        return Object.fromEntries(ids.map(id => [id, unavailableResourceCounter()]));
      }),
    ]);
    return { scope: "system", system, workspaces };
  };
  const server = createServer(socket => {
    let terminal: ObservableTerminalConnection | undefined;
    let initialized = false;
    let closed = false;
    const send = (reply: HostReply) => { if (!closed) socket.write(`${JSON.stringify(reply)}\n`); };
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    socket.on("close", () => { closed = true; terminal?.close(); lines.close(); });
    socket.on("error", error => { console.error("Host connection failed", error); socket.destroy(); });
    let pending = Promise.resolve();
    lines.on("line", line => {
      pending = pending.then(async () => {
        if (closed) return;
        if (initialized) {
          if (!terminal) throw new Error("Host connection is not interactive");
          const input = parseHostInput(line);
          const control = parseObservableTerminalMessage(input);
          if (control?.type === "resize") terminal.resize(terminalSize(control.cols, 80), terminalSize(control.rows, 24));
          else if (!control) terminal.write(input);
          return;
        }
        initialized = true;
        const request = parseHostRequest(line);
        if (request.operation === "attach") {
          const session = await service.require(request.id);
          if (closed) return;
          terminal = attachHostObservableTerminal({ session: session.id, socketName, cols: request.cols ?? 80, rows: request.rows ?? 24 }, {
            onData: data => send({ type: "output", data: Buffer.from(data).toString("base64") }),
            onExit: () => { send({ type: "exit" }); socket.end(); },
          });
          send({ type: "result", value: null });
        } else {
          send({ type: "result", value: await service.handle(request) });
          socket.end();
        }
      }).catch(error => { send({ type: "error", message: String(error) }); terminal?.close(); socket.end(); });
    });
  });
  await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return server;
}
