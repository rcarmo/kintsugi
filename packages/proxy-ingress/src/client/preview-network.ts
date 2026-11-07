import { Type } from "typebox";
import { Value } from "typebox/value";
import { mapPreviewUrl, mapPreviewSrcset, rewritePreviewCss, type PreviewUrlContext } from "../preview-url.ts";
import { replacePreviewCookies } from "./preview-storage.ts";

const contextSchema = Type.Object({ publicOrigin: Type.String(), root: Type.String(), app: Type.String(), upstream: Type.String(), cookies: Type.Optional(Type.String()) });

export function installPreviewNetwork(): PreviewUrlContext | undefined {
  const configuration = document.querySelector<HTMLMetaElement>('meta[name="kintsugi-preview-context"]');
  if (!configuration) return;
  const input: unknown = JSON.parse(configuration.content);
  if (!Value.Check(contextSchema, input)) throw new Error("Invalid workspace preview context");
  const context = input;
  const map = (url: string) => mapPreviewUrl(url, { ...context, upstream: currentUpstream() });
  function currentUpstream(): string {
    const current = new URL(document.baseURI);
    const prefix = `${context.root}${encodeURIComponent(context.app)}`;
    const target = new URL(context.upstream);
    if (current.pathname.startsWith(`${prefix}/`)) { target.pathname = current.pathname.slice(prefix.length); target.search = current.search; target.searchParams.delete("__kintsugi_persist"); }
    return target.href;
  }
  // Retain the browser's real history stack and structured-cloned state while
  // keeping root-relative SPA navigation inside this workspace capability.
  for (const method of ["pushState", "replaceState"] as const) {
    const native = History.prototype[method];
    History.prototype[method] = function(data, unused, url) { native.call(this, data, unused, url === undefined || url === null ? url : map(String(url))); };
  }
  const nativeOpenWindow = window.open.bind(window);
  window.open = (url, target, features) => nativeOpenWindow(url === undefined || url === "" ? url : map(String(url)), target, features);
  const NativeRequest = Request;
  window.Request = new Proxy(NativeRequest, { construct(target, [input, init], newTarget) {
    return Reflect.construct(target, [input instanceof NativeRequest ? input : map(String(input)), init], newTarget);
  } });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : map(String(input)), init);
    const destination = map(request.url);
    const headers = new Headers(request.headers);
    if (new URL(destination).pathname.startsWith(context.root)) {
      const authorization = headers.get("authorization");
      if (authorization) { headers.set("x-kintsugi-preview-authorization", authorization); headers.delete("authorization"); }
      headers.set("x-kintsugi-preview-cookie", document.cookie);
      // Cloning a Request preserves its native body source (FormData, files,
      // JSON, etc.), unlike rebuilding it from its exposed ReadableStream.
      // Only a preexisting, unmapped Request needs a retargeted body.
      const routed = destination === request.url ? request : new NativeRequest(destination, { method: request.method, headers: request.headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.blob(), signal: request.signal, redirect: request.redirect, cache: request.cache, keepalive: request.keepalive, integrity: request.integrity });
      return nativeFetch(new NativeRequest(routed, { headers, mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" })).then(response => {
        const cookies = response.headers.get("x-kintsugi-preview-cookie");
        if (cookies !== null) replacePreviewCookies(cookies);
        return response;
      });
    }
    return nativeFetch(request);
  }, window.fetch);
  const NativeSocket = WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) { super(map(String(url)), protocols); }
  };
  const NativeEventSource = EventSource;
  window.EventSource = class extends NativeEventSource {
    constructor(url: string | URL, init?: EventSourceInit) { super(map(String(url)), { ...init, withCredentials: false }); }
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
      nativeHeader.call(this, "x-kintsugi-preview-cookie", document.cookie);
      this.addEventListener("load", () => { const cookies = this.getResponseHeader("x-kintsugi-preview-cookie"); if (cookies !== null) replacePreviewCookies(cookies); }, { once: true });
    }
    nativeSend.call(this, body);
  };
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const attribute = String(name).toLowerCase();
    const text = String(value);
    nativeSetAttribute.call(this, name, attribute === "srcset" ? mapPreviewSrcset(text, context) : ["src", "href", "action", "formaction", "poster", "data"].includes(attribute) ? map(text) : text);
  };
  for (const [prototype, property] of [[HTMLScriptElement.prototype, "src"], [HTMLImageElement.prototype, "src"], [HTMLImageElement.prototype, "srcset"], [HTMLSourceElement.prototype, "src"], [HTMLSourceElement.prototype, "srcset"], [HTMLIFrameElement.prototype, "src"], [HTMLLinkElement.prototype, "href"], [HTMLAnchorElement.prototype, "href"], [HTMLMediaElement.prototype, "src"], [HTMLFormElement.prototype, "action"]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property)!;
    Object.defineProperty(prototype, property, { ...descriptor, set(value: string) { descriptor.set!.call(this, property === "srcset" ? mapPreviewSrcset(String(value), context) : map(String(value))); } });
  }
  const css = (text: string, upstream = currentUpstream()) => rewritePreviewCss(String(text), { ...context, upstream });
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function(property, value, priority) { setProperty.call(this, property, css(value ?? ""), priority); };
  for (const [property, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(CSSStyleDeclaration.prototype))) {
    if (descriptor.set) Object.defineProperty(CSSStyleDeclaration.prototype, property, { ...descriptor, set(value: string | null) { descriptor.set!.call(this, css(value ?? "")); } });
  }
  const nativeText = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
  Object.defineProperty(Node.prototype, "textContent", { ...nativeText, set(value: string | null) { nativeText.set!.call(this, this instanceof HTMLStyleElement ? css(value ?? "") : value); } });
  const insertRule = CSSStyleSheet.prototype.insertRule;
  CSSStyleSheet.prototype.insertRule = function(rule, index) { return insertRule.call(this, css(rule, this.href ?? currentUpstream()), index); };
  const replace = CSSStyleSheet.prototype.replace;
  CSSStyleSheet.prototype.replace = function(text) { return replace.call(this, css(text, this.href ?? currentUpstream())); };
  const replaceSync = CSSStyleSheet.prototype.replaceSync;
  CSSStyleSheet.prototype.replaceSync = function(text) { replaceSync.call(this, css(text, this.href ?? currentUpstream())); };
  const NativeFontFace = FontFace;
  window.FontFace = class extends NativeFontFace {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) { super(family, Value.Check(Type.String(), source) ? css(source) : source, descriptors); }
  };
  return context;
}
