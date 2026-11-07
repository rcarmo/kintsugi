import type { WorkspaceHttpAppBackend, WorkspaceServerSocketSession } from "@kintsugi/shared";
import { backendTransport } from "./backend-transport.ts";
import { localAppHost } from "./local-app.ts";
import { bufferUpstreamSocket, closeWebSocket, forwardToUpstream, maxSocketBufferedBytes } from "./websocket.ts";

/** A management-owned viewer can stream a fixed workspace backend without a public port. */
export function createWorkspaceSocketSession(resolve: () => Promise<WorkspaceHttpAppBackend>): WorkspaceServerSocketSession {
  let upstream: WebSocket | undefined;
  let closed = false;
  let ready = false;
  let pendingBytes = 0;
  const pending: Array<string | ArrayBuffer> = [];
  return {
    async open(socket) {
      const backend = await resolve();
      if (closed) return;
      const host = localAppHost(backend);
      const headers = new Headers({ host, origin: new URL(`${backend.target.protocol}//${host}`).origin });
      const transport = backendTransport(backend, headers);
      const target = new URL(transport.target);
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      // SAFETY: Bun implements this options constructor; the DOM type omits it.
      const WithOptions = WebSocket as typeof WebSocket & (new (url: string, options: Bun.WebSocketOptions) => WebSocket);
      const client = upstream = new WithOptions(target.href, { headers: Object.fromEntries(transport.headers), proxy: "" });
      client.binaryType = "arraybuffer";
      const attach = bufferUpstreamSocket(client);
      try {
        await new Promise<void>((done, reject) => {
          const timer = setTimeout(() => reject(new Error("Workspace display WebSocket timed out")), 5000);
          const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else done(); };
          client.addEventListener("open", () => finish(), { once: true });
          client.addEventListener("error", () => finish(new Error("Workspace display WebSocket failed")), { once: true });
          client.addEventListener("close", () => finish(new Error("Workspace display WebSocket closed during setup")), { once: true });
        });
        if (closed) { client.close(); return; }
        ready = true;
        attach({
          send(data) {
            const size = data instanceof ArrayBuffer ? data.byteLength : Buffer.byteLength(data);
            if ((socket.getBufferedAmount?.() ?? 0) + size > maxSocketBufferedBytes) return 0;
            return socket.send(data instanceof ArrayBuffer ? new Uint8Array(data) : data) ?? size;
          },
          close: (code, reason) => socket.close(code, reason),
        });
        for (const data of pending) forwardToUpstream(client, socket, data);
        pending.length = 0; pendingBytes = 0;
      } catch (error) {
        client.close();
        throw error;
      }
    },
    message(socket, message) {
      if (closed) return;
      const data = message instanceof Uint8Array ? Uint8Array.from(message).buffer : message;
      if (ready) { forwardToUpstream(upstream!, socket, data); return; }
      pendingBytes += data instanceof ArrayBuffer ? data.byteLength : Buffer.byteLength(data);
      if (pendingBytes > maxSocketBufferedBytes) { closed = true; pending.length = 0; upstream?.close(1013, "Display input is too large"); socket.close(1013, "Display input is too large"); return; }
      pending.push(data);
    },
    close() { closed = true; pending.length = 0; if (upstream) closeWebSocket(upstream, 1000, "Viewer closed"); },
  };
}
