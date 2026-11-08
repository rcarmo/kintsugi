import { mapPreviewUrl, type PreviewUrlContext } from "../preview-url.ts";

export interface PreviewCookies { read(): string; write(value: string): void; }

/** Shared native HTTP/socket transport for opaque documents and workers. */
export function installPreviewRequests(context: PreviewUrlContext, upstream: () => string, cookies: PreviewCookies): void {
  const map = (url: string) => mapPreviewUrl(url, { ...context, upstream: upstream() });
  const NativeRequest = Request;
  globalThis.Request = new Proxy(NativeRequest, { construct(target, [input, init], newTarget) {
    return Reflect.construct(target, [input instanceof NativeRequest ? input : map(String(input)), init], newTarget);
  } });
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : map(String(input)), init);
    const destination = map(request.url);
    const headers = new Headers(request.headers);
    const target = new URL(destination);
    if (target.origin === context.publicOrigin && target.pathname.startsWith(context.root)) {
      const authorization = headers.get("authorization");
      if (authorization) { headers.set("x-kintsugi-preview-authorization", authorization); headers.delete("authorization"); }
      headers.set("x-kintsugi-preview-cookie", cookies.read());
      // Cloning a Request preserves its native body source (FormData, files,
      // JSON, etc.), unlike rebuilding it from its exposed ReadableStream.
      // Only a preexisting, unmapped Request needs a retargeted body.
      const routed = destination === request.url ? request : new NativeRequest(destination, { method: request.method, headers: request.headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.blob(), signal: request.signal, redirect: request.redirect, cache: request.cache, keepalive: request.keepalive, integrity: request.integrity });
      return nativeFetch(new NativeRequest(routed, { headers, mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" })).then(response => {
        const updated = response.headers.get("x-kintsugi-preview-cookie");
        if (updated !== null) cookies.write(updated);
        return response;
      });
    }
    return nativeFetch(request);
  }, globalThis.fetch);
  const NativeSocket = WebSocket;
  globalThis.WebSocket = class extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) { super(map(String(url)), protocols); }
  };
  const NativeEventSource = EventSource;
  globalThis.EventSource = class extends NativeEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      const destination = map(String(url)), target = new URL(destination, context.publicOrigin + context.root);
      super(destination, target.origin === context.publicOrigin && target.pathname.startsWith(context.root) ? { ...init, withCredentials: false } : init);
    }
  };
  const scopedRequests = new WeakSet<XMLHttpRequest>();
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
    const destination = map(String(url));
    if (new URL(destination).origin === context.publicOrigin && new URL(destination).pathname.startsWith(context.root)) scopedRequests.add(this);
    else scopedRequests.delete(this);
    nativeOpen.call(this, method, destination, async, username, password);
  };
  const nativeHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) { nativeHeader.call(this, scopedRequests.has(this) && name.toLowerCase() === "authorization" ? "x-kintsugi-preview-authorization" : name, value); };
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body) {
    if (scopedRequests.has(this)) {
      nativeHeader.call(this, "x-kintsugi-preview-cookie", cookies.read());
      this.addEventListener("load", () => { const updated = this.getResponseHeader("x-kintsugi-preview-cookie"); if (updated !== null) cookies.write(updated); }, { once: true });
    }
    nativeSend.call(this, body);
  };
}
