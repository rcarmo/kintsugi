import { bridgeWebSocket, requestWebSocketUpgrade, validateWebSocketRequest, type UpgradeRequest } from "./websocket.ts";
import { getProxyForUrl } from "proxy-from-env";
import dns from "node:dns/promises";
import { lookupWorkspaceHost } from "./workspace-dns.ts";
import { readFileSync } from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type IncomingMessage, type RequestOptions, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type AddressInfo } from "node:net";
import { Readable, type Duplex } from "node:stream";
import tls from "node:tls";
import { kintsugiDataPath, dockerHostKintsugiDataPath, getKintsugiRuntimeContext, isNotFoundError } from "@kintsugi/core";
import { HttpRequestBlockedError } from "../secrets/errors.ts";
import { matchHostname } from "../secrets/patterns.ts";
import { workspaceRequestTransformMatchesHost, createWorkspaceSecretContext, forgetWorkspaceSecretContext, getWorkspaceSecretContext, type WorkspaceSecretContext } from "../secrets/workspace-secrets.ts";
import type { KintsugiEventBus } from "@kintsugi/core";
import { isHopByHopHeader, stripHopByHopHeaders } from "@kintsugi/shared";
import { workspaceLocalProxyInitScript, workspaceLocalProxyUrl } from "./local-proxy.ts";
import { defaultNoProxyEntries, uniqueNoProxyEntries } from "./no-proxy.ts";
import { ensureLeafCertificate, ensureMitmCa, type MitmCa } from "./mitm-ca.ts";

const workspaceMitmCaPath = "/run/kintsugi-mitm-ca.crt";

const workspaceProxies = new Map<string, Promise<WorkspaceEgressProxy>>();
type SecretContext = () => Promise<WorkspaceSecretContext>;
type FetchUpstream = (url: string, init: RequestInit & { tls?: { serverName?: string; rejectUnauthorized?: boolean }; proxy?: string }) => Promise<Response>;
type ConnectUpstream = (port: number, address: string) => net.Socket;
type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
type ProxyContext = { secrets: SecretContext; fetch: FetchUpstream; connect: ConnectUpstream; upgrade: UpgradeRequest; dnsLookup: DnsLookup; proxyForUrl: typeof getProxyForUrl };
export type WorkspaceEgressProxy = { close(): Promise<void> };
const mitmTargetServers = new Map<string, Promise<MitmTargetServer>>();

/** A policy-checked destination for direct connections; trusted upstream proxies check their own. */
type ResolvedDestination = { address: string; family: 4 | 6 };

type MitmConnectionContext = { context: ProxyContext; authority: string };
type MitmTargetServer = { server: ReturnType<typeof createHttpsServer>; port: number; connections: Map<number, MitmConnectionContext>; renewAt: number };

function workspaceProxyEnv() {
  const proxy = workspaceLocalProxyUrl;
  const noProxy = uniqueNoProxyEntries(defaultNoProxyEntries()).join(",");
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
    CURL_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
    // Yarn uses Node's extra CA trust. Do not set YARN_CA_FILE: modern Yarn
    // treats it as the unsupported caFile setting and refuses to start.
    NODE_EXTRA_CA_CERTS: workspaceMitmCaPath,
    GIT_SSL_CAINFO: "/etc/ssl/certs/ca-certificates.crt",
    NPM_CONFIG_CAFILE: "/etc/ssl/certs/ca-certificates.crt",
    PIP_CERT: "/etc/ssl/certs/ca-certificates.crt",
  };
}

export function registerWorkspaceProxyEvents(events: KintsugiEventBus): void {
  events.on("workspace_plan_prepare", async ({ workspaceId, init, plan }) => {
    const runtimeContext = getKintsugiRuntimeContext();
    const secretContext = await createWorkspaceSecretContext(workspaceId, init);
    Object.assign(plan.env, secretContext.env);

    await ensureWorkspaceEgressProxy(workspaceId);
    Object.assign(plan.env, workspaceProxyEnv());
    // Repository init scripts can already use the proxy environment, so the
    // forwarder must start before any of them (and before nested dockerd).
    plan.mounts.push({ type: "bind", source: dockerHostKintsugiDataPath(runtimeContext, "proxy-ca", "kintsugi-mitm-ca.pem"), target: workspaceMitmCaPath, readonly: true });
    plan.initScripts.unshift(
      workspaceLocalProxyInitScript(),
      `cat ${workspaceMitmCaPath} >> /etc/ssl/certs/ca-certificates.crt`,
      'git config --system http.proxy "$HTTPS_PROXY"',
    );
    plan.cleanup.push(async () => cleanupWorkspaceProxy(workspaceId));
  });

  events.on("workspace_deleted", async ({ workspaceId }) => cleanupWorkspaceProxy(workspaceId));
}

async function cleanupWorkspaceProxy(workspaceId: string): Promise<void> {
  const existing = workspaceProxies.get(workspaceId);
  if (existing) {
    await (await existing).close();
    workspaceProxies.delete(workspaceId);
  }
  forgetWorkspaceSecretContext(workspaceId);
}

export async function ensureWorkspaceEgressProxy(workspaceId: string): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(workspaceId)) throw new Error("Invalid workspace id");
  let existing = workspaceProxies.get(workspaceId);
  if (!existing) {
    existing = (async () => startWorkspaceEgressProxy({
      socketPath: kintsugiDataPath(getKintsugiRuntimeContext(), "workspace-sockets", workspaceId, "egress.sock"),
      ca: await ensureMitmCa(),
      getContext: () => getWorkspaceSecretContext(workspaceId),
      upstreamDnsLookup: hostname => lookupWorkspaceHost(workspaceId, hostname),
    }))().catch(error => { workspaceProxies.delete(workspaceId); throw error; });
    workspaceProxies.set(workspaceId, existing);
  }
  await existing;
}

// The listener's closure supplies identity. Nothing in HTTP headers, CONNECT,
// or the requested URL can select another workspace's secrets.
export async function startWorkspaceEgressProxy({ socketPath, ca, getContext, upstreamFetch = fetch, upstreamConnect = (port, address) => net.connect(port, address), upstreamUpgrade = requestWebSocketUpgrade, upstreamDnsLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: false }), upstreamProxyForUrl = getProxyForUrl }: {
  socketPath: string; ca: MitmCa; getContext: SecretContext; upstreamFetch?: FetchUpstream; upstreamConnect?: ConnectUpstream; upstreamUpgrade?: UpgradeRequest; upstreamDnsLookup?: DnsLookup; upstreamProxyForUrl?: typeof getProxyForUrl;
}): Promise<WorkspaceEgressProxy> {
  const context: ProxyContext = { secrets: getContext, fetch: upstreamFetch, connect: upstreamConnect, upgrade: upstreamUpgrade, dnsLookup: upstreamDnsLookup, proxyForUrl: upstreamProxyForUrl };
  const connections = new Set<net.Socket>();
  const server = createServer((req, res) => void handleProxyHttp(context, req, res).catch((thrown) => {
    handleProxyHttpFailure(res, thrown instanceof Error ? thrown : new Error(String(thrown)));
  }));
  server.on("upgrade", (req, socket, head) => {
    socket.pause();
    void handleProxyUpgrade(context, req, socket, head).catch(error => socket.end(connectErrorResponse(proxyFailure(error))));
  });
  server.on("connection", socket => { connections.add(socket); socket.once("close", () => connections.delete(socket)); });
  server.on("connect", (req, socket, head) => void handleConnect(ca, context, req, socket, head).catch((thrown) => {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    socket.end(connectErrorResponse(proxyFailure(error)));
  }));
  await mkdir(dirname(socketPath), { recursive: true });
  try { await unlink(socketPath); } catch (error) { if (!isNotFoundError(error)) throw error; }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  await chmod(socketPath, 0o666);
  server.unref();
  return { async close() {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

async function handleConnect(ca: MitmCa, context: ProxyContext, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const { hostname, port } = parseConnectTarget(req.url || "");
  // Resolve and check once; the tunnel connects to this exact address, so a
  // hostname cannot re-resolve to something the policy never approved.
  const authority = `${hostname.includes(":") ? `[${hostname}]` : hostname}${port === 443 ? "" : `:${port}`}`;
  const optedInTlsOrigin = (await context.secrets()).untrustedTlsOrigins?.includes(new URL(`https://${authority}`).origin) === true;
  const destination = await resolveAllowedDestination(context, hostname, port, port === 443 || optedInTlsOrigin ? "https" : "http");
  // Zig std.http HTTPS proxy compatibility (verified with 0.15.2 and 0.16.0):
  // CONNECT normally establishes a byte tunnel, after which the client must start
  // TLS before sending HTTP. Zig's connectProxied() instead returns the plain
  // connection to our HTTP proxy and sends a plaintext GET after our 200 response.
  // Both a real upstream HTTPS server and our secret-injecting TLS listener close
  // that connection; Zig reports HttpConnectionClosing before injection can run.
  //
  // Reject CONNECT *before* opening a tunnel. Zig treats a non-5xx CONNECT failure
  // as TunnelNotSupported, disables CONNECT on that proxy, and retries with an
  // absolute-form request such as GET https://api.github.com/user. Our existing
  // handleProxyHttp path supports this: it applies secret hooks and performs the
  // upstream HTTPS request with certificate verification. Use 405, not 5xx (which
  // Zig treats as a potentially temporary failure), and explicitly close this
  // connection with an empty response so the client can reconnect cleanly.
  //
  // Match the default std.http User-Agent independently of version, including
  // development builds and future releases, rather than maintaining a version
  // allowlist. This is a deliberate compatibility policy, not a claim that every
  // future Zig release has the bug. Revisit if Zig changes its retry behavior.
  // Applications overriding/omitting this signature cannot be identified here.
  //
  // User-Agent is spoofable and is NOT an authorization signal. Destination
  // checks run above and again on the retried request; workspace identity and
  // secret-host restrictions remain unchanged. The request is plaintext over
  // the workspace-local relay/Unix-socket transport, not over the upstream link.
  // Never accept plaintext inside a successful HTTPS tunnel or invent missing
  // Authorization headers. Clients must still enable proxy use and send their
  // placeholders. Other clients and non-443 tunnels keep their normal behavior.
  if (port === 443 && /^zig\/\S+ \(std\.http\)$/.test(req.headers["user-agent"] ?? "")) {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  if (!(await shouldMitmConnectTarget(context, hostname))) return tunnelConnect(context.connect, destination.address, port, socket, head);
  if (port !== 443 && !optedInTlsOrigin) throw new HttpRequestBlockedError("MITM CONNECT only allowed to port 443 or an explicitly configured untrusted HTTPS origin");
  const targetServer = await ensureMitmTargetServer(ca, hostname);
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  let connectionPort: number | undefined;
  const bridge = net.connect(targetServer.port, "127.0.0.1", () => {
    connectionPort = bridge.localPort;
    if (connectionPort) targetServer.connections.set(connectionPort, { context, authority });
    if (head.length) bridge.write(head);
  });
  socket.pipe(bridge).pipe(socket);
  const cleanup = () => {
    if (connectionPort) targetServer.connections.delete(connectionPort);
  };
  socket.on("error", () => bridge.destroy());
  bridge.on("error", () => socket.destroy());
  socket.once("close", () => { cleanup(); bridge.destroy(); });
  bridge.once("close", () => { cleanup(); socket.destroy(); });
}

async function shouldMitmConnectTarget(context: ProxyContext, hostname: string): Promise<boolean> {
  const secrets = await context.secrets();
  return secrets.secrets.some((secret) => secret.hosts.some((host) => matchHostname(hostname, host)))
    || await workspaceRequestTransformMatchesHost(hostname);
}

async function tunnelConnect(connect: ConnectUpstream, address: string, port: number, socket: Duplex, head: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const upstream = connect(port, address);
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    upstream.once("error", onError);
    upstream.once("connect", () => {
      upstream.off("error", onError);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
      resolve();
    });
  });
}

async function ensureMitmTargetServer(ca: MitmCa, hostname: string): Promise<MitmTargetServer> {
  const key = `${ca.dir}:${hostname.toLowerCase()}`;
  const existing = mitmTargetServers.get(key);
  let expiring: MitmTargetServer | undefined;
  if (existing) {
    const target = await existing;
    if (Date.now() < target.renewAt) return target;
    if (mitmTargetServers.get(key) !== existing) return await mitmTargetServers.get(key)!;
    expiring = target;
  }
  const created: Promise<MitmTargetServer> = startMitmTargetServer(ca, hostname).then((replacement) => {
    expiring?.server.close();
    return replacement;
  }).catch((error) => {
    if (mitmTargetServers.get(key) === created) {
      if (existing) mitmTargetServers.set(key, existing);
      else mitmTargetServers.delete(key);
    }
    throw error;
  });
  mitmTargetServers.set(key, created);
  return await created;
}

async function startMitmTargetServer(ca: MitmCa, hostname: string): Promise<MitmTargetServer> {
  const leaf = await ensureLeafCertificate(ca, hostname);
  const connections = new Map<number, MitmConnectionContext>();
  const server = createHttpsServer({
    cert: readFileSync(leaf.certPath),
    key: readFileSync(leaf.keyPath),
    ALPNProtocols: ["http/1.1"],
  }, (mitmReq, mitmRes) => {
    const remotePort = mitmReq.socket.remotePort;
    const context = remotePort ? connections.get(remotePort) : undefined;
    if (!context) {
      writeError(mitmRes, proxyFailure(new HttpRequestBlockedError("unknown MITM connection")));
      return;
    }
    const path = mitmReq.url || "/";
    mitmReq.url = `https://${context.authority}${path.startsWith("/") ? path : `/${path}`}`;
    void handleProxyHttp(context.context, mitmReq, mitmRes).catch((thrown) => {
      handleProxyHttpFailure(mitmRes, thrown instanceof Error ? thrown : new Error(String(thrown)));
    });
  });
  server.on("upgrade", (req, socket, head) => {
    socket.pause();
    const connection = req.socket.remotePort ? connections.get(req.socket.remotePort) : undefined;
    if (!connection) {
      socket.end(connectErrorResponse(proxyFailure(new HttpRequestBlockedError("unknown MITM connection"))));
      return;
    }
    // The CONNECT-bound hostname, never the inner Host header, selects the destination.
    const path = req.url || "/";
    req.url = `https://${connection.authority}${path.startsWith("/") ? path : `/${path}`}`;
    void handleProxyUpgrade(connection.context, req, socket, head).catch(error => socket.end(connectErrorResponse(proxyFailure(error))));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.unref();
  // SAFETY: This server listens with a TCP host and port, so Node returns an
  // AddressInfo rather than the string address used by Unix-domain sockets.
  const address = server.address() as AddressInfo;
  return { server, port: address.port, connections, renewAt: leaf.renewAt };
}

async function handleProxyHttp(context: ProxyContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url === "/health" && req.method === "GET") { res.end("ok"); return; }
  const targetUrl = requestTargetUrl(req);
  const parsed = new URL(targetUrl);
  const protocol = parsed.protocol === "https:" ? "https" : "http";
  const port = parsed.port ? Number(parsed.port) : protocol === "https" ? 443 : 80;
  const destination = await resolveAllowedDestination(context, parsed.hostname, port, protocol);

  const method = (req.method || "GET").toUpperCase();
  const canHaveBody = !["GET", "HEAD"].includes(method);
  // SAFETY: Readable.toWeb returns a WHATWG ReadableStream at runtime. Node's
  // declaration differs from the DOM declaration only in overloads; Bun accepts it as BodyInit.
  const body = canHaveBody ? Readable.toWeb(req) as any : undefined;
  const requestInit: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: incomingHeaders(req),
    body,
  };
  if (canHaveBody) requestInit.duplex = "half";
  const request = new Request(parsed.toString(), requestInit);

  const secrets = await context.secrets();
  const { hooks } = secrets;
  const next = await hooks.onRequest(request);
  const scrubHeader = (value: string) => hooks.scrubResponseHeader(value, next);
  if (hooks.isRequestAllowed && !(await hooks.isRequestAllowed(new Request(next.url, { method: next.method, headers: next.headers })))) throw new HttpRequestBlockedError("request blocked by policy");

  const upstreamHeaders = filteredForwardHeaders(next.headers);
  // For direct egress, connect to the checked address: the request URL carries the
  // pinned IP, the Host header and TLS serverName keep the routed hostname for
  // virtual hosting, SNI and certificate verification. A hostname that answers
  // DNS differently on a second lookup cannot redirect the connection.
  const nextUrl = new URL(next.url);
  const nextProtocol = nextUrl.protocol === "https:" ? "https" : "http";
  const nextPort = nextUrl.port ? Number(nextUrl.port) : nextProtocol === "https" ? 443 : 80;
  const finalDestination = nextUrl.hostname !== parsed.hostname || nextPort !== port || nextProtocol !== protocol
    ? await resolveAllowedDestination(context, nextUrl.hostname, nextPort, nextProtocol)
    : destination;
  const pinnedUrl = new URL(next.url);
  pinnedUrl.hostname = finalDestination.family === 6 ? `[${finalDestination.address}]` : finalDestination.address;
  upstreamHeaders.set("host", nextUrl.host);
  // Environment proxies are trusted egress boundaries (including the parent in
  // nested installations). Preserve the logical hostname so that boundary can
  // enforce policy, pin its own outbound socket, and apply hostname-bound secrets.
  const proxy = context.proxyForUrl(next.url);
  const upstreamInit: RequestInit & { duplex?: "half"; tls?: { serverName: string; rejectUnauthorized?: boolean }; proxy: string } = {
    proxy,
    method: next.method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(next.method.toUpperCase()) ? undefined : next.body,
    redirect: "manual",
  };
  if (nextProtocol === "https") {
    upstreamInit.tls = { serverName: nextUrl.hostname };
    if (secrets.untrustedTlsOrigins?.includes(nextUrl.origin)) upstreamInit.tls.rejectUnauthorized = false;
  }
  if (!["GET", "HEAD"].includes(next.method.toUpperCase())) upstreamInit.duplex = "half";
  const upstream = await context.fetch(proxy ? next.url : pinnedUrl.toString(), upstreamInit);
  const finalResponse = hooks.onResponse ? await hooks.onResponse(upstream, next) ?? upstream : upstream;
  await writeFetchResponse(res, finalResponse, scrubHeader);
}

async function handleProxyUpgrade(context: ProxyContext, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  // Install a listener before asynchronous policy/credential work; disconnects cancel the bridge below.
  socket.on("error", () => socket.destroy());
  const target = new URL(requestTargetUrl(req));
  if (target.protocol === "ws:") target.protocol = "http:";
  if (target.protocol === "wss:") target.protocol = "https:";
  const checkDestination = async (url: URL): Promise<ResolvedDestination> => {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new HttpRequestBlockedError("Invalid WebSocket destination", 400, "Bad Request");
    }
    return await resolveAllowedDestination(context, url.hostname, Number(url.port || (url.protocol === "https:" ? 443 : 80)), url.protocol === "https:" ? "https" : "http");
  };
  const destination = await checkDestination(target);
  const request = new Request(target, { method: req.method, headers: incomingHeaders(req) });
  validateWebSocketRequest(request);
  const secrets = await context.secrets();
  const { hooks } = secrets;
  const next = await hooks.onRequest(request);
  validateWebSocketRequest(next);
  // Direct upgrades use the checked address. An environment proxy owns its
  // outbound resolution and policy instead; CONNECT must keep the hostname for
  // its credential hooks. A lookup callback cannot pin a proxy CONNECT target.
  const finalDestination = next.url !== request.url ? await checkDestination(new URL(next.url)) : destination;
  if (hooks.isRequestAllowed && !await hooks.isRequestAllowed(next)) throw new HttpRequestBlockedError("request blocked by policy");
  if (socket.destroyed) return;
  const open = (url: URL, options: RequestOptions) => {
    const forwarded = { ...options, rejectUnauthorized: !(url.protocol === "https:" && secrets.untrustedTlsOrigins?.includes(url.origin)) };
    return context.upgrade(url, context.proxyForUrl(url.href) ? forwarded : { ...forwarded, lookup: pinnedLookup(finalDestination) });
  };
  await bridgeWebSocket(next, socket, head, open, value => hooks.scrubResponseHeader(value, next));
}

/** Resolve a hostname once and require every address to pass the egress policy.
 * Returns the first allowed address for direct connections; a trusted upstream
 * proxy owns resolution and pinning when a request is delegated to it. */
async function resolveAllowedDestination(context: ProxyContext, hostname: string, port: number, protocol: "http" | "https"): Promise<ResolvedDestination> {
  const secrets = await context.secrets();
  const hooks = secrets.hooks;
  const addresses = await context.dnsLookup(hostname);
  if (addresses.length === 0) throw new HttpRequestBlockedError(`could not resolve host: ${hostname}`);
  for (const address of addresses) {
    const family = address.family === 6 ? 6 : 4;
    if (!(await hooks.isIpAllowed?.({ hostname, ip: address.address, family, port, protocol }))) throw new HttpRequestBlockedError(`destination not allowed: ${hostname}`);
  }
  const first = addresses[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** A DNS lookup that always answers with the policy-checked address. */
function pinnedLookup(destination: ResolvedDestination): NonNullable<import("node:net").TcpSocketConnectOpts["lookup"]> {
  return (_hostname: string, options: { all?: boolean }, callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
    if (options?.all) callback(null, [{ address: destination.address, family: destination.family }]);
    else callback(null, destination.address, destination.family);
  };
}

function requestTargetUrl(req: IncomingMessage): string {
  const raw = req.url || "/";
  if (/^(https?|wss?):\/\//i.test(raw)) return raw;
  const host = req.headers.host;
  if (!host) throw new HttpRequestBlockedError("missing Host header");
  const encrypted = req.socket instanceof tls.TLSSocket;
  return `${encrypted ? "https" : "http"}://${host}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

interface ConnectTarget {
  hostname: string;
  port: number;
}

function parseConnectTarget(target: string): ConnectTarget {
  const match = target.match(/^\[([^\]]+)\]:(\d+)$/) || target.match(/^([^:]+):(\d+)$/);
  if (!match) throw new HttpRequestBlockedError(`invalid CONNECT target: ${target}`);
  return { hostname: match[1]!.toLowerCase(), port: Number(match[2]) };
}

function incomingHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (/^(proxy-authorization|proxy-connection)$/i.test(name)) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v); else headers.set(name, value);
  }
  return headers;
}

function filteredForwardHeaders(headers: Headers): Headers {
  const out = stripHopByHopHeaders(headers, ["proxy-connection"]);
  // Keep upstream response framing predictable for strict clients such as
  // dockerd/BuildKit. If fetch transparently decodes a compressed response,
  // the upstream Content-Length would no longer match the bytes we forward.
  out.set("accept-encoding", "identity");
  return out;
}

async function writeFetchResponse(res: ServerResponse, response: Response, scrubHeader: (value: string) => string): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = scrubHeader(response.statusText);
  response.headers.forEach((value, key) => {
    if (isHopByHopHeader(key) || key.toLowerCase() === "content-encoding") return;
    if (scrubHeader(key) !== key) return;
    if (key.toLowerCase() === "set-cookie") res.setHeader(key, response.headers.getSetCookie().map(scrubHeader));
    else res.setHeader(key, scrubHeader(value));
  });
  const body = response.body;
  if (!body) { res.end(); return; }
  await new Promise<void>((resolve, reject) => {
    Readable.from(body).on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
  });
}

interface ProxyFailure {
  status: number;
  statusText: string;
  message: string;
}

function proxyFailure(error: Error): ProxyFailure {
  if (error instanceof HttpRequestBlockedError) return { status: error.status, statusText: error.statusText, message: error.message };
  return { status: 502, statusText: "Bad Gateway", message: error.message };
}

function writeError(res: ServerResponse, failure: ProxyFailure): void {
  res.writeHead(failure.status, failure.statusText, { "content-type": "text/plain" });
  res.end(`${failure.message}\n`);
}

function handleProxyHttpFailure(res: ServerResponse, error: Error): void {
  if (res.headersSent) {
    console.error("Workspace egress response failed after its headers were sent", error);
    res.destroy();
    return;
  }
  writeError(res, proxyFailure(error));
}

function connectErrorResponse(failure: ProxyFailure): string {
  const headers = [
    `HTTP/1.1 ${failure.status} ${failure.statusText}`,
    "Connection: close",
    "Content-Type: text/plain",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${failure.message}\n`;
}
