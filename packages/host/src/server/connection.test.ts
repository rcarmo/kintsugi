import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostRequest } from "./connection.ts";

async function terminalReplyScenario(reply: string, protocolFailure = true): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "host-terminal-reply-"));
  const socketPath = join(directory, "control.sock");
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock, spyOn } from "bun:test";
      import { createServer } from "node:net";
      const protocolPath = ${JSON.stringify(new URL("../protocol.ts", import.meta.url).pathname)};
      const protocol = await import(protocolPath);
      mock.module(protocolPath, () => ({ ...protocol, hostSocketPath: ${JSON.stringify(socketPath)} }));
      const { hostTerminalSocket } = await import(${JSON.stringify(new URL("./connection.ts", import.meta.url).pathname)});
      const log = spyOn(console, "error").mockImplementation(() => {});
      const server = createServer(socket => {
        socket.once("data", () => { socket.write(JSON.stringify({ type: "output", data: Buffer.from("before failure").toString("base64") }) + "\\n"); socket.end(${JSON.stringify(reply)}); });
      });
      await new Promise(resolve => server.listen(${JSON.stringify(socketPath)}, resolve));
      const sent = [], closes = [], ended = Promise.withResolvers();
      const connection = hostTerminalSocket(new URL("http://localhost/host/terminals/host-00000000-0000-0000-0000-000000000001/ws"));
      try {
        connection.open({ send: value => sent.push(Buffer.from(value).toString()), close: (...args) => { closes.push(args); ended.resolve(); } });
        await ended.promise;
        await Bun.sleep(0);
        expect(sent).toEqual(["before failure"]);
        expect(closes).toEqual(${protocolFailure ? '[[1011, "Host terminal protocol error"]]' : '[[undefined, undefined]]'});
        ${protocolFailure ? 'expect(log.mock.calls[0][0]).toBe("Invalid host terminal response");' : 'expect(log).not.toHaveBeenCalled();'}
        expect(JSON.stringify(log.mock.calls)).not.toContain("private-response");
      } finally { connection.close(); log.mockRestore(); await new Promise(resolve => server.close(resolve)); }
    `], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a valid Host terminal handshake and exit preserve preceding output and close once", () => terminalReplyScenario('{"type":"result","value":null}\n{"type":"exit"}', false));
test("a truncated Host terminal reply ends its viewer rather than escaping the IPC callback", () => terminalReplyScenario('{"type":"output","data":"private-response'));
test("an invalid Host terminal output payload ends its viewer without reporting backend contents", () => terminalReplyScenario('{"type":"output","data":{"private-response":true}}'));

test("an aborted diagnostic closes its host socket even when System never replies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-abort-")), path = join(dir, "control.sock");
  const received = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  const server = createServer(socket => { socket.on("data", () => received.resolve()); socket.on("close", () => closed.resolve()); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    const abort = new AbortController();
    const request = hostRequest({ operation: "resources", action: "inspect", workspaceId: "w" }, path, { signal: abort.signal });
    request.catch(() => {});
    await received.promise;
    abort.abort();
    await expect(request).rejects.toThrow("Host request aborted");
    await closed.promise;
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
test("already-aborted host inspection never opens a connection", async () => {
  const abort = new AbortController(); abort.abort(new Error("cancelled before connect"));
  await expect(hostRequest({ operation: "list" }, "/unreachable/control.sock", { signal: abort.signal })).rejects.toThrow("cancelled before connect");
});
