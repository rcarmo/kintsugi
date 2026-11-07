function isForwardableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
    || (code >= 3000 && code <= 4999);
}

export function closeWebSocket(socket: Pick<WebSocket, "close">, code: number, reason: string): void {
  if (isForwardableCloseCode(code)) socket.close(code, reason);
  else socket.close();
}

export const maxSocketBufferedBytes = 8 * 1024 * 1024;

/** Bound the other direction too: browser input must not queue without limit. */
export function forwardToUpstream(
  upstream: Pick<WebSocket, "bufferedAmount" | "send" | "close">,
  downstream: Pick<WebSocket, "close">,
  payload: string | ArrayBuffer,
): void {
  const bytes = payload instanceof ArrayBuffer ? payload.byteLength : Buffer.byteLength(payload);
  if (upstream.bufferedAmount + bytes > maxSocketBufferedBytes) {
    const reason = "Workspace stream consumer is too slow";
    upstream.close(1013, reason);
    downstream.close(1013, reason);
    return;
  }
  upstream.send(payload);
}

/** Listen before awaiting upstream upgrade: VNC sends its greeting immediately. */
export function bufferUpstreamSocket(upstream: WebSocket): (socket: { send(data: string | ArrayBuffer): number; close(code?: number, reason?: string): void }) => void {
  type Socket = { send(data: string | ArrayBuffer): number; close(code?: number, reason?: string): void };
  let downstream: Socket | undefined;
  const pending: (string | ArrayBuffer)[] = [];
  let bytes = 0;
  let ended: { code: number; reason: string } | undefined;
  function end(code: number, reason: string) {
    ended = { code, reason }; pending.length = 0;
    if (downstream) closeWebSocket(downstream, code, reason);
  }
  function send(socket: Socket, payload: string | ArrayBuffer) {
    if (socket.send(payload) === 0 && (payload instanceof ArrayBuffer ? payload.byteLength : payload.length)) {
      end(1013, "Workspace stream consumer is too slow"); upstream.close(1013, "Workspace stream consumer is too slow");
    }
  }
  upstream.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
    if (ended) return;
    if (downstream) return send(downstream, event.data);
    bytes += event.data instanceof ArrayBuffer ? event.data.byteLength : Buffer.byteLength(event.data);
    if (bytes > maxSocketBufferedBytes) { end(1013, "Workspace stream consumer is too slow"); upstream.close(1013, "Workspace stream consumer is too slow"); return; }
    pending.push(event.data);
  });
  upstream.addEventListener("close", (event: CloseEvent) => end(event.code, event.reason));
  upstream.addEventListener("error", () => end(1011, "Upstream WebSocket failed"));
  return socket => {
    downstream = socket;
    if (ended) { closeWebSocket(socket, ended.code, ended.reason); return; }
    for (const payload of pending) { send(socket, payload); if (ended) break; }
    pending.length = 0; bytes = 0;
  };
}
