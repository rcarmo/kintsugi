import { ingressErrorPage } from "./error-page.ts";
import { errorCategory, UnknownWorkspaceAppError, WorkspaceAuthenticationError, WorkspaceConnectionError, WorkspaceUpstreamError } from "./failure.ts";
import { createLocalOriginPublisher, type ParentOriginPublisher } from "./parent.ts";
import { adaptLocalAppResponse, localAppHost, translateLocalAppOrigin } from "./local-app.ts";
import { backendTransport } from "./backend-transport.ts";
import type { ServerWebSocket } from "bun";
import { workspaceGatewayErrorHeader, isWorkspaceAppPort, parseWorkspacePortAppKey, workspacePortAppKey, stripHopByHopHeaders, type WorkspaceAppBackend, type WorkspaceAppRef, type WorkspaceHttpAppBackend } from "@kintsugi/shared";
import { createMemoryOriginIdentityStore, type OriginIdentityStore } from "./origin-identity.ts";
import { bufferUpstreamSocket, closeWebSocket, maxSocketBufferedBytes, forwardToUpstream } from "./websocket.ts";
import {
  defaultPublicOriginPortRange,
  type PortRange,
} from "./tailscale-serve.ts";

export { UnknownWorkspaceAppError, StoppedWorkspaceError } from "./failure.ts";

export type WorkspaceAppHost = WorkspaceAppRef;
export type WorkspaceAppResolver = (app: WorkspaceAppRef, requestUrl: URL) => Promise<WorkspaceAppBackend | undefined> | WorkspaceAppBackend | undefined;

export interface WorkspaceIngressOptions {
  hostname: string;
  workspaceName?(workspaceId: string): string | undefined;
  resolveWorkspace(workspaceId: string): Promise<void> | void;
  resolveApp: WorkspaceAppResolver;
  originPortRange?: PortRange;
  originIdentityStore?: OriginIdentityStore;
  parentOriginPublisher?: ParentOriginPublisher;
  resolvePort?(workspaceId: string, port: number, protocol: "http" | "https", requestUrl: URL): Promise<WorkspaceAppBackend> | WorkspaceAppBackend;
}

export interface IngressStatus {
  workspaceId: string;
  appKey: string;
  port?: number;
  scope?: "public" | "nested";
  activeConnections: number;
  lastUsedAt: number;
  lastFailure?: string;
  failureCategory?: string;
  target?: string;
  targetState: "active" | "inactive" | "failed";
}

export interface WorkspaceIngress {
  initialize(): Promise<void>;
  publishPort(workspaceId: string, port: number, protocol?: "http" | "https", hostname?: string): Promise<string>;
  /** Origin serving the workspace filesystem; a file's URL is the origin plus its absolute path. */
  publishFiles(workspaceId: string): Promise<string>;
  openCanonical(app: WorkspaceAppRef, pathAndSearch: string): Promise<Response>;
  stopWorkspace(workspaceId: string): Promise<void>;
  stopAll(): Promise<void>;
  inspect(app?: WorkspaceAppRef): IngressStatus[];
}

interface AppSocketData {
  attach: ReturnType<typeof bufferUpstreamSocket>;
  lease: OriginLease;
  upstream: WebSocket;
}

interface PublicRequestContext {
  protocol: string;
  host: string;
  port: string;
}

interface IngressLogDetails {
  port?: number;
  scope?: "public" | "nested";
  error?: string;
  category?: string;
}

interface RecentFailure {
  app: WorkspaceAppRef;
  message: string;
  category: string;
  at: number;
}

interface OriginLease {
  key: string;
  app: WorkspaceAppRef;
  port: number;
  scope: "public" | "nested";
  server: ReturnType<typeof Bun.serve<AppSocketData>>;
  origin: string;
  origins: Set<string>;
  protocol: "http" | "https";
  activeConnections: number;
  lastUsedAt: number;
  lastFailure?: string;
  target?: string;
}

const originContextHeader = "x-kintsugi-origin-context";
const publicOriginHeader = "x-kintsugi-public-origin";
export * from "./parent.ts";
export * from "./workspace-sockets.ts";
export * from "./tailscale-serve.ts";
export { isSameLocalApp } from "./local-app.ts";
export { createFileOriginIdentityStore, createMemoryOriginIdentityStore, type OriginIdentityStore } from "./origin-identity.ts";

export function createWorkspaceIngress(options: WorkspaceIngressOptions): WorkspaceIngress {
  const publicRange = options.originPortRange ?? defaultPublicOriginPortRange;
  const publisher = options.parentOriginPublisher ?? createLocalOriginPublisher();
  const identityStore = options.originIdentityStore ?? createMemoryOriginIdentityStore();
  let stopping = false;
  const leases = new Map<string, OriginLease>();
  const pendingLeases = new Map<string, Promise<OriginLease>>();
  const recentFailures = new Map<string, RecentFailure>();

  function ingressError(error: Error, app: WorkspaceAppRef): Promise<Response> {
    return ingressErrorPage(error, options.workspaceName?.(app.workspaceId) ?? app.workspaceId);
  }

  function recordFailure(app: WorkspaceAppRef, error: Error): void {
    recentFailures.set(appIdentity(app), { app, message: error.message, category: errorCategory(error), at: Date.now() });
    while (recentFailures.size > 200) recentFailures.delete(recentFailures.keys().next().value!);
  }

  async function resolveBackend(app: WorkspaceAppRef, requestUrl: URL, protocol: "http" | "https" = "http"): Promise<WorkspaceAppBackend> {
    const port = parseWorkspacePortAppKey(app.appKey);
    const backend = port && options.resolvePort
      ? await options.resolvePort(app.workspaceId, port.port, protocol, requestUrl)
      : await options.resolveApp(app, requestUrl);
    if (!backend) throw new UnknownWorkspaceAppError(app);
    if (port?.host && backend.kind === "http") return { ...backend, appHost: port.host };
    return backend;
  }

  async function ensureLease(app: WorkspaceAppRef, protocol: "http" | "https" = "http"): Promise<OriginLease> {
    if (stopping) throw new Error("Workspace ingress is stopping");
    const key = appIdentity(app);
    // A listener exists before parent publication completes; callers must wait
    // for that publication rather than observe its not-yet-assigned origin.
    const pending = pendingLeases.get(key);
    const existing = pending ? await pending : leases.get(key);
    if (existing) {
      if (existing.protocol !== protocol) throw new Error("This workspace port is already published with a different protocol");
      if (publisher.refresh) { existing.origin = await publisher.publish(existing.port); existing.origins.add(existing.origin); }
      return existing;
    }
    const created = startLease(key, app, protocol).finally(() => pendingLeases.delete(key));
    pendingLeases.set(key, created);
    return await created;
  }

  async function startLease(key: string, app: WorkspaceAppRef, protocol: "http" | "https"): Promise<OriginLease> {
    const scope = publisher.kind === "kintsugi" ? "nested" : "public";
    const range = publicRange;
    const assignment = await identityStore.assignedPort(app, range, protocol);
    const port = assignment.port;
    let lease: OriginLease;
    try {
      const server = Bun.serve<AppSocketData>({
          hostname: options.hostname,
          port,
          idleTimeout: 255,
          async fetch(request, server) {
            if (!lease.origin) await pendingLeases.get(key);
            lease.lastUsedAt = Date.now();
            if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
              try {
                const backend = await resolveBackend(lease.app, new URL(request.url), lease.protocol);
                if (backend.kind !== "http") throw new Error("This workspace app does not support WebSockets");
                lease.target = backend.target.toString();
                const upstreamHeaders = await appRequestHeaders(lease, backend, request);
                for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]) upstreamHeaders.delete(name);
                const transport = backendTransport(backend, upstreamHeaders);
                const { upstream, attach } = await openUpstreamSocket(websocketTarget(transport.target), transport.headers, websocketProtocols(request));
                const headers = upstream.protocol ? { "sec-websocket-protocol": upstream.protocol } : undefined;
                if (server.upgrade(request, { data: { upstream, attach, lease }, headers })) return undefined;
                upstream.close(1011, "Downstream WebSocket upgrade failed");
                throw new Error("WebSocket upgrade failed");
              } catch (thrown) {
                const error = thrown instanceof Error ? thrown : new Error(String(thrown));
                lease.lastFailure = error.message;
                recordFailure(lease.app, error);
                logIngress("websocket_failed", lease.app, { port: lease.port, error: lease.lastFailure, category: errorCategory(error) });
                return ingressError(error, lease.app);
              }
            }
            return await dispatchRequest(lease, request);
          },
          websocket: {
            // RFB is an ordered byte stream: disconnect slow consumers rather
            // than drop updates or let a desktop exhaust ingress memory.
            backpressureLimit: maxSocketBufferedBytes,
            closeOnBackpressureLimit: true,
            open: openAppSocket,
            message: handleAppSocketMessage,
            close: closeAppSocket,
          },
        });
        lease = {
          key,
          app,
          port,
          scope,
          server,
          origin: "",
          origins: new Set(),
          protocol,
          activeConnections: 0,
          lastUsedAt: Date.now(),
        };
      leases.set(key, lease);
      lease.origin = await publisher.publish(port);
      lease.origins.add(lease.origin);
      logIngress("lease_started", app, { port, scope });
      return lease;
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      const started = leases.get(key);
      if (started?.port === port) {
        leases.delete(key);
        started.server.stop(true);
      }
      if (isAddressInUse(error) && assignment.fresh) {
        await identityStore.rejectFreshPort(app, port);
        return await startLease(key, app, protocol);
      }
      if (isAddressInUse(error)) throw new Error(`Retained browser origin ${port} for ${app.appKey} is currently unavailable because another process is using it`);
      throw error;
    }
  }

  async function dispatchRequest(lease: OriginLease, request: Request): Promise<Response> {
    lease.activeConnections += 1;
    try {
      // Preview reads need fresh bytes, not a 304 that reuses a browser's old
      // document or asset. Keep write preconditions and range validators intact.
      if (request.method === "GET" || request.method === "HEAD") {
        request.headers.delete("if-none-match");
        request.headers.delete("if-modified-since");
        request.headers.set("cache-control", "no-cache");
      }
      const backend = await resolveBackend(lease.app, new URL(request.url), lease.protocol);
      if (backend.kind === "fetch") {
        const response = adaptWorkspaceResponse(await backend.fetch(request));
        lease.lastFailure = undefined;
        recentFailures.delete(appIdentity(lease.app));
        return trackResponse(lease, response);
      }

      lease.target = backend.target.toString();
      const upstreamHeaders = await appRequestHeaders(lease, backend, request);
      const transport = backendTransport(backend, upstreamHeaders);

      const method = request.method.toUpperCase();
      const init: RequestInit & { duplex?: "half"; proxy?: string } = {
        method,
        headers: transport.headers,
        // Bun 1.4 ignores proxy: "" for fetch. Use the gateway as BOTH URL and
        // explicit proxy: whether NO_PROXY bypasses it or not, traffic can only
        // reach this gateway, never an environment-selected proxy or the app.
        proxy: backend.gateway?.url.toString(),
        signal: request.signal,
        body: method === "GET" || method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      };
      if (init.body) init.duplex = "half";
      let response = normalizeDecodedFetchResponse(await fetchWithStartupRetry(transport.target, init, transport.workspacePort));
      // Module response adapters need the public identity, not spoofable request
      // metadata or the local forwarded headers seen by the app.
      request.headers.set(publicOriginHeader, appPublicOrigin(lease, request));
      if (backend.adaptResponse) response = await backend.adaptResponse(response, request);
      response = adaptLocalAppResponse(backend, response, appPublicOrigin(lease, request));
      response = adaptWorkspaceResponse(response);
      lease.lastFailure = undefined;
      recentFailures.delete(appIdentity(lease.app));
      return trackResponse(lease, response);
    } catch (thrown) {
      finishRequest(lease);
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      lease.lastFailure = error.message;
      recordFailure(lease.app, error);
      logIngress("request_failed", lease.app, { port: lease.port, error: lease.lastFailure, category: errorCategory(error) });
      return ingressError(error, lease.app);
    }
  }

  async function releaseLease(lease: OriginLease): Promise<void> {
    if (leases.get(lease.key) !== lease) return;
    leases.delete(lease.key);
    lease.server.stop(true);
    await publisher.unpublish?.(lease.port);
    logIngress("lease_released", lease.app, { port: lease.port, scope: lease.scope });
  }

  return {
    async initialize() {
      for (const assignment of await identityStore.list()) {
        await ensureLease(assignment.app, assignment.protocol);
      }
    },

    async publishPort(workspaceId, port, protocol = "http", hostname) {
      if (!isWorkspaceAppPort(port)) throw new Error("port must be an integer from 1 to 65535, excluding the workspace gateway");
      if (protocol !== "http" && protocol !== "https") throw new Error("protocol must be http or https");
      await options.resolveWorkspace(workspaceId);
      return (await ensureLease({ workspaceId, appKey: workspacePortAppKey(port, hostname) }, protocol)).origin;
    },

    async publishFiles(workspaceId) {
      await options.resolveWorkspace(workspaceId);
      return (await ensureLease({ workspaceId, appKey: "file" })).origin;
    },

    async openCanonical(app, pathAndSearch) {
      try {
        await options.resolveWorkspace(app.workspaceId);
        const normalizedPath = pathAndSearch.startsWith("/") ? pathAndSearch : `/${pathAndSearch}`;
        const lease = await ensureLease(app);
        return Response.redirect(`${lease.origin}${normalizedPath}`, 302);
      } catch (thrown) {
        const error = thrown instanceof Error ? thrown : new Error(String(thrown));
        recordFailure(app, error);
        return ingressError(error, app);
      }
    },

    async stopWorkspace(workspaceId) {
      await Promise.all([...leases.values()].filter((lease) => lease.app.workspaceId === workspaceId).map(releaseLease));
      await identityStore.removeWorkspace(workspaceId);
    },

    async stopAll() {
      stopping = true;
      await Promise.allSettled(pendingLeases.values());
      for (const lease of leases.values()) lease.server.stop(true);
      leases.clear();
    },

    inspect(app) {
      const statuses: IngressStatus[] = [...leases.values()]
        .filter((lease) => !app || sameApp(lease.app, app))
        .map((lease) => ({
          workspaceId: lease.app.workspaceId,
          appKey: lease.app.appKey,
          port: lease.port,
          scope: lease.scope,
          activeConnections: lease.activeConnections,
          lastUsedAt: lease.lastUsedAt,
          lastFailure: lease.lastFailure,
          failureCategory: lease.lastFailure ? recentFailures.get(appIdentity(lease.app))?.category : undefined,
          target: lease.target,
          targetState: lease.lastFailure ? "failed" : "active",
        }));
      for (const failure of recentFailures.values()) {
        if ((app && !sameApp(failure.app, app)) || statuses.some((status) => status.workspaceId === failure.app.workspaceId && status.appKey === failure.app.appKey)) continue;
        statuses.push({ workspaceId: failure.app.workspaceId, appKey: failure.app.appKey, activeConnections: 0, lastUsedAt: failure.at, lastFailure: failure.message, failureCategory: failure.category, targetState: "failed" });
      }
      return statuses;
    },
  };
}

async function appRequestHeaders(lease: OriginLease, backend: WorkspaceHttpAppBackend, request: Request): Promise<Headers> {
  let headers = stripHopByHopHeaders(request.headers, ["host"]);
  // Give apps one coherent local origin, including frameworks that prefer
  // forwarded headers to Host. Public routing identity is Kintsugi metadata only.
  const localHost = localAppHost(backend);
  headers.set("host", localHost);
  headers.set("x-forwarded-host", localHost);
  headers.set("x-forwarded-proto", backend.target.protocol.slice(0, -1));
  headers.set("x-forwarded-port", backend.target.port || (backend.target.protocol === "https:" ? "443" : "80"));
  headers.delete("forwarded");
  headers.set(publicOriginHeader, appPublicOrigin(lease, request));
  headers.delete("x-kintsugi-parent-origin");
  headers.delete("x-kintsugi-parent-workspace");
  const receivingOrigin = receivingAppOrigin(lease, request);
  const sameOrigin = receivingOrigin !== undefined && headers.get("origin") === receivingOrigin;
  if (receivingOrigin !== undefined) translateLocalAppOrigin(backend, headers, receivingOrigin);
  // Attest the decision to nested Kintsugi. A foreign Origin could coincidentally
  // equal a nested listener's localhost address; it must stay foreign at that hop.
  headers.set(originContextHeader, sameOrigin ? headers.get("origin")! : "null");
  if (backend.adaptRequestHeaders) headers = await backend.adaptRequestHeaders(headers, request);

  return headers;
}

function receivingAppOrigin(lease: OriginLease, request: Request): string | undefined {
  // The parent has already translated the browser Origin to this listener's local
  // origin. Only a parent-connected instance consumes that attestation.
  if (lease.scope === "nested") {
    const context = request.headers.get(originContextHeader);
    if (context !== null) return context === "null" ? undefined : context;
  }
  return appPublicOrigin(lease, request);
}

function appPublicOrigin(lease: OriginLease, request: Request): string {
  const host = request.headers.get("host");
  return [...lease.origins].find(origin => new URL(origin).host === host) ?? lease.origin;
}

async function fetchWithStartupRetry(target: URL, init: RequestInit, workspacePort: number | undefined): Promise<Response> {
  const retryable = init.method === "GET" || init.method === "HEAD";
  for (let attempt = 0; ; attempt += 1) {
    try {
      let response: Response;
      try {
        response = await fetch(target, init);
      } catch (error) {
        if (workspacePort !== undefined) throw new WorkspaceConnectionError(error);
        throw error;
      }
      if (workspacePort !== undefined && response.headers.get(workspaceGatewayErrorHeader) === "authentication") {
        await response.body?.cancel();
        throw new WorkspaceAuthenticationError();
      }
      if (workspacePort !== undefined && response.headers.get(workspaceGatewayErrorHeader) === "upstream") {
        // Consume the failed response before retrying so its connection is reusable.
        const message = (await response.text()).trim();
        throw new WorkspaceUpstreamError(message || "Workspace app connection failed", workspacePort);
      }
      return response;
    } catch (error) {
      if (error instanceof WorkspaceAuthenticationError || !retryable || attempt >= 2 || init.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

function trackResponse(lease: OriginLease, response: Response): Response {
  if (!response.body) {
    finishRequest(lease);
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    finishRequest(lease);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (thrown) {
        finish();
        controller.error(thrown);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function finishRequest(lease: OriginLease): void {
  lease.activeConnections -= 1;
  lease.lastUsedAt = Date.now();
}

export function publicWorkspaceAppOrigin(request: Request): string {
  return publicKintsugiOrigin(request);
}

/** The Kintsugi URL for the current browser connection, not a guarantee of reachability from other devices. */
export function kintsugiUrl(request: Request): string {
  return publicKintsugiOrigin(request);
}

function publicKintsugiOrigin(request: Request): string {
  const context = publicRequestContext(request);
  return `${context.protocol}://${context.host}`;
}

function publicRequestHost(request: Request): string {
  return request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || new URL(request.url).host;
}

function publicRequestContext(request: Request): PublicRequestContext {
  const previewOrigin = request.headers.get(publicOriginHeader);
  if (previewOrigin) {
    const origin = new URL(previewOrigin);
    return { protocol: origin.protocol.slice(0, -1), host: origin.host, port: origin.port || (origin.protocol === "https:" ? "443" : "80") };
  }
  const url = new URL(request.url);
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
  const host = publicRequestHost(request);
  const port = new URL(`${protocol}://${host}`).port || (protocol === "https" ? "443" : "80");
  return { protocol, host, port };
}

function websocketTarget(target: URL): string {
  const url = new URL(target);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function websocketProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

async function openUpstreamSocket(target: string, headers: Headers, protocols: string[]): Promise<{ upstream: WebSocket; attach: ReturnType<typeof bufferUpstreamSocket> }> {
  // SAFETY: Bun supports the options constructor at runtime although DOM declarations omit it.
  const WebSocketWithOptions = WebSocket as typeof WebSocket & (new (url: string | URL, options: Bun.WebSocketOptions) => WebSocket);
  const upstream = new WebSocketWithOptions(target, { headers: Object.fromEntries(headers), protocols, proxy: "" });
  upstream.binaryType = "arraybuffer";
  const attach = bufferUpstreamSocket(upstream);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      upstream.close();
      reject(new Error("Workspace app WebSocket connection timed out"));
    }, 5_000);
    upstream.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    upstream.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Workspace app WebSocket connection failed"));
    }, { once: true });
  });
  return { upstream, attach };
}

function openAppSocket(ws: ServerWebSocket<AppSocketData>): void {
  ws.data.lease.activeConnections += 1;
  ws.data.lease.lastUsedAt = Date.now();
  ws.data.attach(ws);
}

function handleAppSocketMessage(ws: ServerWebSocket<AppSocketData>, message: string | Buffer): void {
  const payload = Buffer.isBuffer(message) ? new Uint8Array(message).buffer : message;
  forwardToUpstream(ws.data.upstream, ws, payload);
}

function closeAppSocket(ws: ServerWebSocket<AppSocketData>, code: number, reason: string): void {
  if (ws.data.upstream.readyState <= WebSocket.OPEN) closeWebSocket(ws.data.upstream, code, reason);
  ws.data.lease.activeConnections -= 1;
  ws.data.lease.lastUsedAt = Date.now();
}

function adaptWorkspaceResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  // Previews are live working surfaces. This covers documents and subresources,
  // including assets that the app marks as immutable or long-lived.
  headers.set("cache-control", "no-store");
  // Workspace content may be embedded or navigated to, but must never grant
  // another origin (especially the management app) permission to read its bytes.
  // Apply after all backend adapters, including redirects and preflight replies.
  for (const name of response.headers.keys()) {
    if (name === "x-frame-options" || name.startsWith("access-control-") || name.startsWith("cross-origin-") || name === "timing-allow-origin") {
      headers.delete(name);
    }
  }
  for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
    const policy = headers.get(name);
    if (!policy) continue;
    const directives = policy.split(";").map((directive) => directive.trim()).filter((directive) => directive && !directive.toLowerCase().startsWith("frame-ancestors"));
    if (directives.length) headers.set(name, directives.join("; "));
    else headers.delete(name);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function normalizeDecodedFetchResponse(response: Response): Response {
  const contentEncoding = response.headers.get("content-encoding");
  if (!contentEncoding || contentEncoding.toLowerCase() === "identity") return response;
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("content-md5");
  headers.delete("content-digest");
  headers.delete("repr-digest");
  const etag = headers.get("etag");
  if (etag && !etag.trimStart().startsWith("W/")) headers.delete("etag");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function appIdentity(app: WorkspaceAppRef): string {
  return `${app.workspaceId}\0${app.appKey}`;
}

function sameApp(left: WorkspaceAppRef, right: WorkspaceAppRef): boolean {
  return left.workspaceId === right.workspaceId && left.appKey === right.appKey;
}

function logIngress(event: string, app: WorkspaceAppRef, details: IngressLogDetails): void {
  console.info(JSON.stringify({ subsystem: "workspace-ingress", event, workspaceId: app.workspaceId, appKey: app.appKey, ...details }));
}

function isAddressInUse(error: Error): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

/** Canonical management URLs are redirect-only: workspace bytes belong on an
 * isolated origin, including direct navigation and new-tab artifact links. */
export async function handleCanonicalWorkspaceRequest(request: Request, ingress: Pick<WorkspaceIngress, "openCanonical">): Promise<Response | undefined> {
  const url = new URL(request.url);
  let app: WorkspaceAppRef;
  let path: string;
  const appMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/apps\/([^/]+)(\/.*)?$/);
  const portMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/ports\/(\d+)(\/.*)?$/);
  const fileMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/files(\/.*)$/);
  if (appMatch) {
    app = { workspaceId: decodeURIComponent(appMatch[1]!), appKey: decodeURIComponent(appMatch[2]!) };
    path = `${appMatch[3] || "/"}${url.search}`;
  } else if (portMatch) {
    app = { workspaceId: decodeURIComponent(portMatch[1]!), appKey: `port-${Number(portMatch[2])}` };
    path = `${portMatch[3] || "/"}${url.search}`;
  } else if (fileMatch) {
    app = { workspaceId: decodeURIComponent(fileMatch[1]!), appKey: "file" };
    path = `${decodeURIComponent(fileMatch[2]!)}${url.search}`;
  } else {
    return;
  }

  const response = await ingress.openCanonical(app, path);
  if (response.status !== 302) return response;
  const destination = new URL(response.headers.get("location")!);
  // Compare both the socket-facing and public identity: TLS termination and
  // nested ingress can make them different. Never fall back to same-origin HTML.
  if (destination.origin === url.origin || destination.origin === kintsugiUrl(request)) {
    await response.body?.cancel();
    return new Response("Workspace content must use an isolated origin", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
