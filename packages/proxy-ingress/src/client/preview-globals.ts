import { Type } from "typebox";
import { Value } from "typebox/value";
import { previewAppPath, type PreviewUrlContext } from "../preview-url.ts";

interface PreviewGlobals {
  readonly window: typeof globalThis;
  readonly self: typeof globalThis;
  readonly globalThis: typeof globalThis;
  get location(): Location;
  set location(url: string | Location);
}
declare global { var __kintsugiPreviewGlobals: PreviewGlobals; }

/** URL compatibility only; the browser's opaque sandbox still owns all authority. */
export function installPreviewGlobals(context: PreviewUrlContext, map: (url: string) => string): void {
  const nativeGlobal = window;
  const nativeLocation = location;
  function navigate(url: string, replace = false): void {
    const target = new URL(map(url), nativeLocation.href);
    const current = new URL(nativeLocation.href);
    const sameQuery = (input: URL) => { const query = new URLSearchParams(input.search); query.delete("__kintsugi_persist"); return query.toString(); };
    if (target.origin === current.origin && target.pathname === current.pathname && sameQuery(target) === sameQuery(current)) target.search = current.search;
    else if (target.origin === context.publicOrigin && target.pathname.startsWith(previewAppPath(context) + "/") && document.querySelector('meta[name="kintsugi-preview-persistence"]')) target.searchParams.set("__kintsugi_persist", "1");
    nativeLocation[replace ? "replace" : "assign"](target.href);
  }
  let facade = nativeGlobal;
  let virtualLocation = nativeLocation;
  if (context.app !== "vscode") {
    const visible = () => {
      const physical = new URL(nativeLocation.href);
      const logical = new URL(context.upstream);
      const prefix = previewAppPath(context);
      if (physical.origin === context.publicOrigin && physical.pathname.startsWith(`${prefix}/`)) {
        logical.pathname = physical.pathname.slice(prefix.length); logical.search = physical.search; logical.hash = physical.hash;
      }
      logical.searchParams.delete("__kintsugi_persist"); logical.searchParams.delete("__kintsugi_window");
      const result = new URL(context.publicOrigin);
      result.pathname = logical.pathname; result.search = logical.search; result.hash = logical.hash;
      return result;
    };
    // SAFETY: this document-only object defines the complete Location surface below. It has no native origin authority.
    virtualLocation = Object.create(Object.getPrototypeOf(nativeLocation)) as Location;
    for (const field of ["href", "protocol", "host", "hostname", "port", "pathname", "search", "hash", "origin"] as const) {
      const descriptor: PropertyDescriptor = { enumerable: true, get: () => visible()[field] };
      if (field !== "origin") descriptor.set = (value: string) => {
        if (field === "href") { navigate(String(value)); return; }
        const next = visible(); next[field] = String(value); navigate(next.href);
      };
      Object.defineProperty(virtualLocation, field, descriptor);
    }
    Object.defineProperties(virtualLocation, {
      assign: { value: (url: string | URL) => navigate(String(url)) },
      replace: { value: (url: string | URL) => navigate(String(url), true) },
      reload: { value: nativeLocation.reload.bind(nativeLocation) },
      toString: { value: () => visible().href },
      ancestorOrigins: { get: () => nativeLocation.ancestorOrigins },
    });
    const nativeFunctionText = Function.prototype.toString;
    facade = new Proxy(nativeGlobal, {
      get(target, property) {
        if (property === "location") return virtualLocation;
        // SAFETY: Proxy keys address native global properties using their original DOM receiver.
        const value = target[property as keyof typeof globalThis];
        if (value === target) return facade;
        if (Value.Check(Type.Function([], Type.Unknown()), value) && !Object.hasOwn(value, "prototype") && nativeFunctionText.call(value).includes("[native code]")) return value.bind(target);
        return value;
      },
      set(target, property, value) {
        if (property === "location") { navigate(String(value)); return true; }
        return Reflect.set(target, property, value, target);
      },
    });
    const view = Object.getOwnPropertyDescriptor(Document.prototype, "defaultView")!;
    Object.defineProperty(Document.prototype, "defaultView", { ...view, get() {
      const window: Window | null = view.get!.call(this);
      return window === nativeGlobal ? facade : window;
    } });
  }
  Object.defineProperty(nativeGlobal, "__kintsugiPreviewGlobals", { value: {
    get window() { return facade; }, get self() { return facade; }, get globalThis() { return facade; },
    get location(): Location { return virtualLocation; }, set location(url: string | Location) { navigate(String(url)); },
  } satisfies PreviewGlobals });
}
