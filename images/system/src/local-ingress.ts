import { validateProxyAccess, type ProxyAccess } from "../../../packages/shared/src/proxy-access.ts";
import { bufferUpstreamSocket, closeWebSocket, forwardToUpstream, maxSocketBufferedBytes } from "../../../packages/proxy-ingress/src/ingress/websocket.ts";

/** Only named Kintsugi endpoints are reachable; never proxy arbitrary loopback ports. */
export function localTarget(host: string, appPort: number): number | undefined {
  const hostname = host.split(":")[0];
  if (hostname === "kintsugi.localhost") return appPort;
  if (hostname === "system.kintsugi.localhost") return 3001;
  const preview = /^p(41\d{3})\.kintsugi\.localhost$/.exec(hostname ?? "");
  return preview ? Number(preview[1]) : undefined;
}
export function proxyTarget(host: string, config: ProxyAccess, appPort: number): number | undefined {
  const url = new URL(config.origin);
  if (host === url.host) return appPort;
  const match = /^(.*):(\d+)$/.exec(host);
  const port = Number(match?.[2]);
  return match?.[1] === url.hostname && match?.[2] === String(port) && port >= config.previewPorts.start && port <= config.previewPorts.end ? port : undefined;
}

export function startProxyIngress(appPort: () => number, config: () => ProxyAccess | undefined, listenPort = 3081) {
  return startIngress(host => { const proxy = config(); return proxy ? proxyTarget(host, validateProxyAccess(proxy), appPort()) : undefined; }, listenPort, () => config() ? new URL(config()!.origin).protocol.slice(0, -1) : undefined);
}
export function startAdminProxy(config: () => ProxyAccess | undefined, listenPort = 3082) {
  return startIngress(() => config()?.adminPort, listenPort, () => "http");
}
export function startLocalIngress(appPort: () => number, listenPort = 3080) {
  return startIngress(host => localTarget(host, appPort()), listenPort);
}
function startIngress(targetPort: (host: string) => number | undefined, listenPort: number, scheme?: () => string | undefined) {
  return Bun.serve<{ upstream: WebSocket; attach: ReturnType<typeof bufferUpstreamSocket> }>({
    hostname: "0.0.0.0", port: listenPort, idleTimeout: 0,
    async fetch(request, server) {
      const port = targetPort(request.headers.get("host") ?? "");
      if (!port) return new Response("Unknown Kintsugi endpoint", { status: 404 });
      const url = new URL(request.url);
      const target = `127.0.0.1:${port}${url.pathname}${url.search}`;
      // This dedicated listener is the configured proxy boundary. Never manufacture Origin.
      const protocol = scheme?.();
      if (protocol) request.headers.set("x-forwarded-proto", protocol);
      for (const name of ["forwarded", "x-forwarded-host", "x-kintsugi-public-origin"]) request.headers.delete(name);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const headers = new Headers(request.headers);
        const protocols = headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim()) ?? [];
        for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol", "connection", "upgrade"]) headers.delete(name);
        // SAFETY: This ingress runs in Bun, whose WebSocket constructor accepts headers.
        const Client = WebSocket as typeof WebSocket & (new (url: string, options: Bun.WebSocketOptions) => WebSocket);
        const upstream = new Client(`ws://${target}`, { headers: Object.fromEntries(headers), protocols });
        upstream.binaryType = "arraybuffer";
        const attach = bufferUpstreamSocket(upstream);
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { upstream.close(); reject(new Error("Kintsugi WebSocket timed out")); }, 5000);
            upstream.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
            upstream.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Kintsugi WebSocket is unavailable")); }, { once: true });
          });
          if (server.upgrade(request, { data: { upstream, attach }, headers: upstream.protocol ? { "sec-websocket-protocol": upstream.protocol } : undefined })) return;
          upstream.close();
        } catch (error) { return new Response(String(error), { status: 502 }); }
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      const headers = new Headers(request.headers);
      headers.delete("connection");
      headers.delete("transfer-encoding");
      headers.set("accept-encoding", "identity");
      try {
        const response = await fetch(`http://${target}`, { method: request.method, headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body, signal: request.signal, redirect: "manual" });
        return response;
      } catch (error) { return new Response(`Kintsugi endpoint is unavailable: ${String(error)}`, { status: 502 }); }
    },
    websocket: {
      backpressureLimit: maxSocketBufferedBytes, closeOnBackpressureLimit: true,
      open(socket) { socket.data.attach(socket); },
      message(socket, message) { forwardToUpstream(socket.data.upstream, socket, message instanceof Uint8Array ? new Uint8Array(message).buffer : message); },
      close(socket, code, reason) { closeWebSocket(socket.data.upstream, code, reason); },
    },
  });
}
