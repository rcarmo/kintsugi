import { randomBytes } from "node:crypto";
import { PreviewSources } from "./preview-sources.ts";
import { previewSourceHost, previewSourcePrefix } from "../preview-source.ts";
import { PreviewInlinePolicy } from "./preview-inline-policy.ts";
import { CookieJar } from "tough-cookie";
import { escapeHtml, isWorkspaceAppPort, parseWorkspacePortAppKey, workspacePortAppKey, stripHopByHopHeaders, type WorkspaceAppBackend, type WorkspaceAppRef, type WorkspaceHttpAppBackend, type WorkspaceServerSocketSession } from "@kintsugi/shared";
import { backendTransport } from "./backend-transport.ts";
import { localAppHost } from "./local-app.ts";
import { bufferUpstreamSocket, closeWebSocket, forwardToUpstream, maxSocketBufferedBytes } from "./websocket.ts";
import { mapPreviewUrl, previewAppPath, previewProtocolHeader, previewProtocolVersion, type PreviewUrlContext } from "../preview-url.ts";
import { rewritePreviewGlobals } from "./preview-globals.ts";
import { previewWindowParameter } from "../preview-url.ts";
import { previewContentPolicy, previewSandbox, rewritePreviewCss, rewritePreviewHtml, rewritePreviewJavaScript, readNestedPreviewContext } from "./preview-rewrite.ts";

export const previewResourcePrefix = "/~preview/";
export const previewAssetPrefix = "/~preview-assets/";
const nestedPreviewPath = /^\/~preview\/[a-zA-Z0-9_-]{43}\//;

export interface WorkspacePathPreviewOptions {
  publicOrigin(request: Request): string;
  resolveWorkspace(workspaceId: string): Promise<void> | void;
  resolveApp(app: WorkspaceAppRef, url: URL): Promise<WorkspaceAppBackend | undefined> | WorkspaceAppBackend | undefined;
  resolvePort(workspaceId: string, port: number, protocol: "http" | "https", url: URL, host?: string): Promise<WorkspaceHttpAppBackend> | WorkspaceHttpAppBackend;
}
interface PreviewSession {
  workspaceId: string;
  token: string;
  cookies: Map<string, CookieJar>;
  sockets: Set<WebSocket>;
  scope?: { app: string; prefix: string };
}
interface PreviewResource {
  session: PreviewSession;
  app: string;
  path: string;
}
export interface PreparedPreviewSocket {
  session: WorkspaceServerSocketSession;
  headers: Headers;
  cancel(): void;
}

let assets: Promise<{ runtime: string; host: string; worker: string; source: string; state: string }> | undefined;
async function previewAssets() {
  return assets ??= (async () => {
    const build = await Bun.build({ entrypoints: [new URL("../client/preview-runtime.ts", import.meta.url).pathname, new URL("../client/preview-host.ts", import.meta.url).pathname, new URL("../client/preview-worker-network.ts", import.meta.url).pathname, new URL("../client/preview-source-host.ts", import.meta.url).pathname, new URL("../client/preview-state-worker.ts", import.meta.url).pathname], target: "browser", format: "iife", minify: true, naming: "[name].[ext]" });
    if (!build.success) throw new AggregateError(build.logs, "Could not build isolated preview runtime");
    const runtime = build.outputs.find(output => output.path.endsWith("preview-runtime.js"))!;
    const host = build.outputs.find(output => output.path.endsWith("preview-host.js"))!;
    const worker = build.outputs.find(output => output.path.endsWith("preview-worker-network.js"))!;
    const source = build.outputs.find(output => output.path.endsWith("preview-source-host.js"))!;
    const state = build.outputs.find(output => output.path.endsWith("preview-state-worker.js"))!;
    return { runtime: await runtime.text(), host: await host.text(), worker: await worker.text(), source: await source.text(), state: await state.text() };
  })();
}

/** Capability-checked transport for opaque browser documents; management is never a fallback. */
export function createWorkspacePathPreviews(options: WorkspacePathPreviewOptions) {
  const sources = new PreviewSources();
  const byWorkspace = new Map<string, PreviewSession>();
  const byToken = new Map<string, PreviewSession>();
  const delegated = new Map<string, PreviewSession>();
  const delegationCounts = new Map<string, number>();
  // A page can request hundreds of resources at once. Share only overlapping
  // ownership/readiness checks, never a completed check or a cached identity.
  const resolving = new Map<string, Promise<void>>();
  function resolve(workspaceId: string): Promise<void> {
    const pending = resolving.get(workspaceId);
    if (pending) return pending;
    const check = Promise.resolve().then(() => options.resolveWorkspace(workspaceId)).finally(() => resolving.delete(workspaceId));
    resolving.set(workspaceId, check);
    return check;
  }

  async function sessionFor(workspaceId: string): Promise<PreviewSession> {
    await resolve(workspaceId);
    let session = byWorkspace.get(workspaceId);
    if (!session) {
      session = { workspaceId, token: randomBytes(32).toString("base64url"), cookies: new Map(), sockets: new Set() };
      byWorkspace.set(workspaceId, session); byToken.set(session.token, session);
    }
    return session;
  }
  function resourceFor(url: URL): PreviewResource | undefined {
    const match = url.pathname.match(/^\/~preview\/([a-zA-Z0-9_-]{43})\/([^/]+)(\/.*)$/);
    if (!match) return;
    const session = byToken.get(match[1]!);
    if (!session) return;
    let app: string;
    try { app = decodeURIComponent(match[2]!); } catch { return; }
    if (app === "desktop" || app.includes("/") || app.includes("\0")) return;
    const key = app.startsWith("https~") ? app.slice(6) : app;
    const port = parseWorkspacePortAppKey(key);
    if (port ? !isWorkspaceAppPort(port.port) : !["vscode", "file"].includes(key)) return;
    if (session.scope && (app !== session.scope.app || !match[3]!.startsWith(session.scope.prefix))) return;
    const query = new URLSearchParams(url.search);
    if (!nestedPreviewPath.test(match[3]!)) { query.delete("__kintsugi_persist"); query.delete(previewWindowParameter); }
    return { session, app, path: `${match[3]}${query.size ? `?${query}` : ""}` };
  }
  function contextFor(request: Request, resource: PreviewResource, upstream: URL): PreviewUrlContext {
    return { publicOrigin: options.publicOrigin(request), root: `${previewResourcePrefix}${resource.session.token}/`, app: resource.app, upstream: upstream.href, windowGlobals: new URL(request.url).searchParams.get(previewWindowParameter) === "1" };
  }
  async function backendFor(resource: PreviewResource): Promise<WorkspaceAppBackend> {
    await resolve(resource.session.workspaceId);
    const secure = resource.app.startsWith("https~");
    const key = secure ? resource.app.slice(6) : resource.app;
    const port = parseWorkspacePortAppKey(key);
    const url = new URL("http://localhost");
    const split = resource.path.indexOf("?");
    url.pathname = split < 0 ? resource.path : resource.path.slice(0, split);
    url.search = split < 0 ? "" : resource.path.slice(split);
    if (port) {
      if (!isWorkspaceAppPort(port.port)) throw new Error("Unsupported workspace preview port");
      return options.resolvePort(resource.session.workspaceId, port.port, secure ? "https" : "http", url, port.host);
    }
    if (!["vscode", "file"].includes(key)) throw new Error("Unsupported workspace preview app");
    const backend = await options.resolveApp({ workspaceId: resource.session.workspaceId, appKey: key }, url);
    if (!backend) throw new Error("Unknown workspace preview app");
    return backend;
  }
  function jarFor(resource: PreviewResource): CookieJar {
    let jar = resource.session.cookies.get(resource.app);
    if (!jar) { jar = new CookieJar(); resource.session.cookies.set(resource.app, jar); }
    return jar;
  }
  function logicalUrl(backend: WorkspaceAppBackend, resource: PreviewResource): URL {
    if (backend.kind === "fetch") {
      const url = new URL("http://localhost");
      const split = resource.path.indexOf("?");
      url.pathname = split < 0 ? resource.path : resource.path.slice(0, split);
      url.search = split < 0 ? "" : resource.path.slice(split);
      return url;
    }
    const url = new URL(backend.target);
    url.host = localAppHost(backend);
    return url;
  }
  function requestHeaders(request: Request, logical: URL, jar: CookieJar): Headers {
    const nested = nestedPreviewPath.test(logical.pathname);
    const headers = stripHopByHopHeaders(request.headers, ["cookie", "authorization", "host", "referer", "accept-encoding", "if-none-match", "if-modified-since", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]);
    for (const name of [...headers.keys()]) if (/^(?:x-kintsugi-|x-atelier-|tailscale-|x-forwarded-|forwarded$|x-real-ip$)/i.test(name)) headers.delete(name);
    const explicitAuth = request.headers.get("x-kintsugi-preview-authorization");
    if (explicitAuth) headers.set(nested ? "x-kintsugi-preview-authorization" : "authorization", explicitAuth);
    const clientCookie = request.headers.get("x-kintsugi-preview-cookie");
    if (nested && clientCookie !== null) headers.set("x-kintsugi-preview-cookie", clientCookie);
    if (!nested && clientCookie) {
      for (const pair of clientCookie.split(";")) {
        const split = pair.indexOf("="); if (split <= 0) continue;
        const name = pair.slice(0, split).trim();
        if (name && !jar.getCookiesSync(logical.href).some(cookie => cookie.key === name && cookie.httpOnly)) jar.setCookieSync(`${pair.trim()}; Path=/`, logical.href, { ignoreError: true });
      }
    }
    const cookie = nested ? "" : jar.getCookieStringSync(logical.href);
    if (cookie) headers.set("cookie", cookie);
    headers.set("host", logical.host);
    headers.set("accept-encoding", "identity");
    if (request.headers.has("origin")) headers.set("origin", logical.origin);
    return headers;
  }
  function rejectOrigin(request: Request): Response | undefined {
    const origin = request.headers.get("origin");
    if (origin && origin !== "null" && origin !== options.publicOrigin(request)) return new Response("Forbidden preview origin", { status: 403 });
  }

  const api = {
    async canonical(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/workspaces\/([^/]+)\/(apps\/([^/]+)|ports\/(\d+)|files)(\/.*)?$/);
      if (!match) return;
      let workspaceId: string, key: string;
      try { workspaceId = decodeURIComponent(match[1]!); key = match[3] ? decodeURIComponent(match[3]) : match[4] ? `port-${match[4]}` : "file"; }
      catch { return new Response("Invalid preview path", { status: 400 }); }
      const appKey = key.startsWith("https~") ? key.slice(6) : key;
      const port = parseWorkspacePortAppKey(appKey);
      if (!["vscode", "file"].includes(appKey) && !port) return;
      if (port && !isWorkspaceAppPort(port.port)) return new Response("Unsupported preview port", { status: 400 });
      return api.entry(request, { workspaceId, appKey: key }, `${match[5] ?? "/"}${url.search}`);
    },
    async publishPort(workspaceId: string, port: number, protocol: "http" | "https" = "http", hostname = "localhost"): Promise<string> {
      await resolve(workspaceId);
      if (!isWorkspaceAppPort(port)) throw new Error("Unsupported preview port");
      const key = `${protocol === "https" ? "https~" : ""}${workspacePortAppKey(port, hostname)}`;
      return `/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(key)}`;
    },
    async publishFiles(workspaceId: string): Promise<string> {
      await resolve(workspaceId);
      return `/workspaces/${encodeURIComponent(workspaceId)}/files`;
    },
    async entry(request: Request, app: WorkspaceAppRef, path: string): Promise<Response> {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      const session = await sessionFor(app.workspaceId);
      const target = new URL(options.publicOrigin(request));
      const split = path.indexOf("?");
      target.pathname = `${previewResourcePrefix}${session.token}/${encodeURIComponent(app.appKey)}${split < 0 ? path : path.slice(0, split)}`;
      target.search = split < 0 ? "" : path.slice(split);
      target.searchParams.set("__kintsugi_persist", "1");
      const src = `${target.pathname}${target.search}`;
      const scope = `${app.workspaceId}:${app.appKey}`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace preview</title><style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column;background:#111;color:#eee;font:13px system-ui}iframe{display:block;flex:1;min-height:0;width:100%;border:0;background:white}[role=status]{position:absolute;top:0;right:0;font-size:11px;padding:2px 6px;pointer-events:none;opacity:.6}[role=alert]{position:relative;padding:8px;background:#5b1d24;opacity:1}</style><script src="${previewAssetPrefix}host.js" defer></script></head><body data-controller="preview-host" data-preview-host-scope-value="${escapeHtml(scope)}" data-action="message@window->preview-host#receive"><span role="status" data-preview-host-target="status">Loading preview</span><iframe title="Workspace content" sandbox="allow-scripts allow-forms allow-popups allow-downloads" allow="clipboard-read; clipboard-write; fullscreen" allowfullscreen referrerpolicy="no-referrer" data-preview-host-target="frame" data-action="load->preview-host#loaded" src="${escapeHtml(src)}"></iframe></body></html>`;
      return new Response(request.method === "HEAD" ? null : html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": `default-src 'none'; script-src ${options.publicOrigin(request)}${previewAssetPrefix}; style-src 'unsafe-inline'; worker-src ${options.publicOrigin(request)}${previewAssetPrefix}state-worker.js; frame-src ${options.publicOrigin(request)}${previewResourcePrefix}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'` } });
    },
    async asset(request: Request): Promise<Response | undefined> {
      const path = new URL(request.url).pathname;
      if (!path.startsWith(previewAssetPrefix) && !path.startsWith(previewSourcePrefix)) return;
      const generated = await sources.request(request, resolve); if (generated) return generated;
      if (path === previewSourceHost) return new Response(`<!doctype html><html><head><script src="${previewAssetPrefix}source-host.js"></script></head><body></body></html>`, { headers: { "content-type": "text/html", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": `sandbox allow-scripts; default-src \'none\'; script-src ${options.publicOrigin(request)}${previewAssetPrefix}source-host.js; connect-src ${options.publicOrigin(request)}${previewSourcePrefix}` } });
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const name = path.slice(previewAssetPrefix.length);
      if (!["runtime.js", "host.js", "worker.js", "source-host.js", "state-worker.js"].includes(name)) return new Response("Not found", { status: 404 });
      const bundle = await previewAssets();
      const headers = new Headers({ "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "access-control-allow-origin": "*" });
      if (name === "state-worker.js") headers.set("content-security-policy", "default-src 'none'");
      return new Response(name === "runtime.js" ? bundle.runtime : name === "worker.js" ? bundle.worker : name === "source-host.js" ? bundle.source : name === "state-worker.js" ? bundle.state : bundle.host, { headers });
    },
    async resource(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(previewResourcePrefix)) return;
      const rejected = rejectOrigin(request); if (rejected) return rejected;
      const resource = resourceFor(url);
      if (!resource) return new Response("Unknown preview capability", { status: 403 });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "null", "access-control-allow-credentials": "true", "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "", "cache-control": "no-store" } });
      const backend = await backendFor(resource);
      const logical = logicalUrl(backend, resource);
      const jar = jarFor(resource);
      let headers = requestHeaders(request, logical, jar);
      if (backend.kind === "http" && backend.adaptRequestHeaders) headers = await backend.adaptRequestHeaders(headers, request);
      const forwarded = new Request(logical, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, signal: request.signal });
      let response: Response;
      if (backend.kind === "fetch") response = await backend.fetch(forwarded);
      else {
        const transport = backendTransport(backend, headers);
        response = await fetch(transport.target, { method: request.method, headers: transport.headers, body: forwarded.body, redirect: "manual", signal: request.signal, proxy: "" });
        const basePath = `${previewResourcePrefix}${resource.session.token}/${encodeURIComponent(resource.app)}`;
        if (backend.adaptPreviewResponse) response = await backend.adaptPreviewResponse(response, request, basePath);
        else if (backend.adaptResponse) response = await backend.adaptResponse(response, request);
      }
      const type = response.headers.get("content-type")?.toLowerCase() ?? "";
      const protocol = response.headers.get(previewProtocolHeader);
      let html: string | undefined;
      if (type.includes("text/html") && protocol !== null && protocol !== previewProtocolVersion) throw new Error("Unsupported nested preview protocol");
      if (type.includes("text/html") && protocol === previewProtocolVersion && request.method !== "HEAD" && response.body) {
        html = await response.text();
        const inner = await readNestedPreviewContext(html);
        const current = contextFor(request, resource, logical);
        const root = new URL(mapPreviewUrl(`${inner.publicOrigin}${inner.root}`, current));
        const appPath = previewAppPath(current);
        const prefix = root.pathname.slice(appPath.length);
        if (root.origin !== current.publicOrigin || !root.pathname.startsWith(`${appPath}${previewResourcePrefix}`) || !nestedPreviewPath.test(prefix) || root.search || root.hash || !prefix.endsWith("/")) throw new Error("Invalid nested preview capability root");
        const key = JSON.stringify([resource.session.workspaceId, resource.app, prefix]);
        let scoped = delegated.get(key);
        if (!scoped) {
          const count = delegationCounts.get(resource.session.workspaceId) ?? 0;
          if (count >= 1024) throw new Error("Nested preview capability capacity exhausted for this workspace");
          delegationCounts.set(resource.session.workspaceId, count + 1);
          scoped = { workspaceId: resource.session.workspaceId, token: randomBytes(32).toString("base64url"), cookies: new Map(), sockets: new Set(), scope: { app: resource.app, prefix } };
          delegated.set(key, scoped); byToken.set(scoped.token, scoped);
        }
        if (scoped !== resource.session) {
          // Redirect before any child code runs: neither document.location nor
          // its assets/headers may reveal the parent's broader capability.
          const destination = new URL(request.url);
          destination.pathname = `${previewResourcePrefix}${scoped.token}/${encodeURIComponent(resource.app)}${url.pathname.slice(`${previewResourcePrefix}${resource.session.token}/${encodeURIComponent(resource.app)}`.length)}`;
          return new Response(null, { status: 302, headers: { location: destination.pathname + destination.search, "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": previewSandbox } });
        }
      }
      if (byToken.get(resource.session.token) !== resource.session) return new Response("Preview capability revoked", { status: 403 });
      const context = contextFor(request, resource, logical);
      for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, logical.href, { ignoreError: true });
      context.cookies = jar.getCookiesSync(logical.href).filter(cookie => !cookie.httpOnly).map(cookie => cookie.cookieString()).join("; ");
      // The transport URL has the management hostname even though documents are
      // opaque. Never let upstreams install or clear hostname-wide browser state.
      const out = stripHopByHopHeaders(response.headers, ["set-cookie", "set-cookie2", "clear-site-data", "strict-transport-security", "alt-svc", "accept-ch", "critical-ch", "report-to", "reporting-endpoints", "nel", "origin-trial", "service-worker-allowed", "www-authenticate", "proxy-authenticate", "link", "refresh", "content-length", "content-encoding", "etag", "last-modified", "x-frame-options", "content-security-policy-report-only"]);
      const location = out.get("location"); if (location) out.set("location", mapPreviewUrl(location, context));
      out.set("cache-control", "no-store"); out.set("x-content-type-options", "nosniff"); out.set("referrer-policy", "no-referrer");
      out.set("cross-origin-resource-policy", "cross-origin"); out.set("access-control-allow-origin", "null"); out.set("access-control-allow-credentials", "true");
      out.set("x-kintsugi-preview-cookie", nestedPreviewPath.test(logical.pathname) ? response.headers.get("x-kintsugi-preview-cookie") ?? "" : context.cookies);
      out.set("access-control-expose-headers", "content-range,content-disposition,x-kintsugi-preview-cookie");
      const nonce = randomBytes(18).toString("base64url");
      context.nonce = nonce;
      if (type.includes("text/html") && request.method !== "HEAD" && response.body && ![204, 205, 304].includes(response.status)) context.source = sources.create(resource.session.workspaceId, context);
      const originalPolicy = out.get("content-security-policy");
      out.set("content-security-policy", previewSandbox + (originalPolicy ? `, ${previewContentPolicy(originalPolicy, context, nonce)}` : ""));
      if (request.method === "HEAD" || !response.body || [204, 205, 304].includes(response.status)) return new Response(null, { status: response.status, headers: out });
      let body: BodyInit;
      context.policy = out.get("content-security-policy")!;
      if (context.source) sources.context(context.source, context);
      if (type.includes("text/html")) {
        context.windowGlobals = true;
        const rewritten = await rewritePreviewHtml(html ?? await response.text(), context, nonce, url.searchParams.get("__kintsugi_persist") === "1", protocol === previewProtocolVersion, { policy: new PreviewInlinePolicy(), depth: 0, recordContext: composed => sources.context(context.source!, composed) });
        body = rewritten.html;
        out.set("content-security-policy", rewritten.policy.rewrite(out.get("content-security-policy")!));
        out.set(previewProtocolHeader, previewProtocolVersion);
      }
      else if (type.includes("javascript")) {
        const source = await response.text();
        body = rewritePreviewJavaScript(context.windowGlobals && context.app !== "vscode" && protocol !== previewProtocolVersion ? await rewritePreviewGlobals(source) : source, context);
        out.set(previewProtocolHeader, previewProtocolVersion);
      }
      else if (type.includes("text/css")) body = rewritePreviewCss(await response.text(), context);
      else body = response.body;
      return new Response(body, { status: response.status, statusText: response.statusText, headers: out });
    },
    async websocket(request: Request): Promise<PreparedPreviewSocket | Response | undefined> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(previewResourcePrefix)) return;
      const rejected = rejectOrigin(request); if (rejected) return rejected;
      const resource = resourceFor(url);
      if (!resource) return new Response("Unknown preview capability", { status: 403 });
      const backend = await backendFor(resource);
      if (backend.kind !== "http") return new Response("App has no WebSocket transport", { status: 400 });
      const logical = logicalUrl(backend, resource);
      const transport = backendTransport(backend, requestHeaders(request, logical, jarFor(resource)));
      const target = new URL(transport.target); target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map(value => value.trim()).filter(Boolean);
      // SAFETY: Bun supports custom headers/protocols in its WebSocket constructor.
      const Client = WebSocket as typeof WebSocket & (new (url: string, options: Bun.WebSocketOptions) => WebSocket);
      const upstream = new Client(target.href, { headers: Object.fromEntries(transport.headers), protocols, proxy: "" });
      upstream.binaryType = "arraybuffer";
      resource.session.sockets.add(upstream);
      upstream.addEventListener("close", () => resource.session.sockets.delete(upstream), { once: true });
      const attach = bufferUpstreamSocket(upstream);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Workspace preview WebSocket timed out")), 5000);
          const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
          upstream.addEventListener("open", () => finish(), { once: true });
          upstream.addEventListener("error", () => finish(new Error("Workspace preview WebSocket failed")), { once: true });
          upstream.addEventListener("close", () => finish(new Error("Workspace preview WebSocket closed")), { once: true });
        });
      } catch (error) { upstream.close(); throw error; }
      const headers = new Headers(); if (upstream.protocol) headers.set("sec-websocket-protocol", upstream.protocol);
      return { headers, cancel() { upstream.close(); }, session: {
        open(socket) { attach({ send(data) { const bytes = data instanceof ArrayBuffer ? data.byteLength : Buffer.byteLength(data); if ((socket.getBufferedAmount?.() ?? 0) + bytes > maxSocketBufferedBytes) return 0; return socket.send(data instanceof ArrayBuffer ? new Uint8Array(data) : data) ?? bytes; }, close: (code, reason) => socket.close(code, reason) }); },
        message(socket, message) { forwardToUpstream(upstream, socket, message instanceof Uint8Array ? Uint8Array.from(message).buffer : message); },
        close() { closeWebSocket(upstream, 1000, "Preview closed"); },
      } };
    },
    removeWorkspace(workspaceId: string): void {
      sources.remove(workspaceId);
      for (const session of byToken.values()) {
        if (session.workspaceId !== workspaceId) continue;
        for (const socket of session.sockets) socket.close(1001, "Workspace removed");
        byToken.delete(session.token);
      }
      for (const [key, session] of delegated) if (session.workspaceId === workspaceId) delegated.delete(key);
      delegationCounts.delete(workspaceId);
      byWorkspace.delete(workspaceId);
    },
  };
  return api;
}
