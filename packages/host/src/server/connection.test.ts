import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostRequest } from "./connection.ts";

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
