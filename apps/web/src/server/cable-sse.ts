import { cableCommandBodyLimit } from "@kintsugi/shared";
import type { CableServer, CableSocket } from "./cable.ts";

const capacity = 1024 * 1024;
const encoder = new TextEncoder();

/** Commands use same-origin POSTs; the streaming POST shares the management CSRF boundary. */
export function createCableSseTransport(cable: CableServer) {
  const connections = new Map<string, CableSocket>();

  return async function handle(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (path !== "/cable" && !/^\/cable\/[^/]+$/.test(path)) return;
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    if (request.signal.aborted) return new Response(null, { status: 499 });

    if (path !== "/cable") {
      const connectionId = path.slice("/cable/".length);
      const connection = connections.get(connectionId);
      if (!connection) return new Response("Live connection expired", { status: 410 });
      if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response("Expected JSON", { status: 415 });
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        const cancelRead = () => { void reader.cancel().catch(() => {}); };
        request.signal.addEventListener("abort", cancelRead, { once: true });
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (request.signal.aborted || done) break;
            length += value.byteLength;
            if (length > cableCommandBodyLimit) {
              cancelRead();
              return new Response("Live command too large", { status: 413 });
            }
            if (value.byteLength !== 0) chunks.push(value);
          }
        } catch {
          if (!request.signal.aborted) return new Response("Live command upload failed", { status: 400 });
        } finally {
          request.signal.removeEventListener("abort", cancelRead);
          reader.releaseLock();
        }
      }
      // Cancelling the reader can look like end-of-body, including after a
      // complete JSON value but before the HTTP request has been committed.
      if (request.signal.aborted) return new Response(null, { status: 499 });
      if (connections.get(connectionId) !== connection) return new Response("Live connection expired", { status: 410 });
      cable.message(connection, Buffer.concat(chunks, length));
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    const connectionId = crypto.randomUUID();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let connection: CableSocket;
    const close = (cancelled = false): void => {
      if (!connections.delete(connectionId)) return;
      request.signal.removeEventListener("abort", aborted);
      cable.close(connection);
      if (!cancelled) controller.close();
    };
    const aborted = () => close();
    const body = new ReadableStream<Uint8Array>({
      start(output) {
        controller = output;
        connection = {
          send(raw) {
            if (!connections.has(connectionId)) return 0;
            const frame = encoder.encode(`data: ${raw}\n\n`);
            controller.enqueue(frame);
            return frame.byteLength;
          },
          getBufferedAmount: () => Math.max(0, capacity - (controller.desiredSize ?? 0)),
          close: () => close(),
        };
        connections.set(connectionId, connection);
        request.signal.addEventListener("abort", aborted, { once: true });
        cable.open(connection, { kind: "cable", connectionId });
      },
      cancel() { close(true); },
    }, { highWaterMark: capacity, size: chunk => chunk!.byteLength });
    return new Response(body, { headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    } });
  };
}
