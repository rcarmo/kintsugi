import { Type } from "typebox";
import { Value } from "typebox/value";
import { mapPreviewUrl, mapPreviewScriptUrl, mapPreviewModuleUrl, previewUrlContextSchema, mapPreviewSrcset, rewritePreviewCss, type PreviewUrlContext } from "../preview-url.ts";
import { replacePreviewCookies } from "./preview-storage.ts";
import { installPreviewRequests } from "./preview-requests.ts";
import { previewImportSpecifier } from "./preview-imports.ts";
import { installPreviewGlobals } from "./preview-globals.ts";

const contextSchema = previewUrlContextSchema;

export function installPreviewNetwork(): PreviewUrlContext | undefined {
  const configuration = document.querySelector<HTMLMetaElement>('meta[name="kintsugi-preview-context"]');
  if (!configuration) return;
  const input: unknown = JSON.parse(configuration.content);
  if (!Value.Check(contextSchema, input)) throw new Error("Invalid workspace preview context");
  const context = input;
  globalThis.__kintsugiPreviewImportSpecifier = (value, module) => previewImportSpecifier(value, module, context);
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
  installPreviewGlobals(context, map);
  const nativeOpenWindow = window.open.bind(window);
  window.open = (url, target, features) => nativeOpenWindow(url === undefined || url === "" ? url : map(String(url)), target, features);
  installPreviewRequests(context, currentUpstream, { read: () => document.cookie, write: replacePreviewCookies });
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const attribute = String(name).toLowerCase();
    const text = String(value);
    if (this instanceof HTMLScriptElement && attribute === "src" && this.type.toLowerCase() === "module") { nativeSetAttribute.call(this, name, mapPreviewModuleUrl(text, { ...context, upstream: currentUpstream() })); return; }
    nativeSetAttribute.call(this, name, this instanceof HTMLScriptElement && attribute === "src" ? mapPreviewScriptUrl(text, { ...context, upstream: currentUpstream() }) : attribute === "srcset" ? mapPreviewSrcset(text, context) : ["src", "href", "action", "formaction", "poster", "data"].includes(attribute) ? map(text) : text);
  };
  for (const [prototype, property] of [[HTMLScriptElement.prototype, "src"], [HTMLImageElement.prototype, "src"], [HTMLImageElement.prototype, "srcset"], [HTMLSourceElement.prototype, "src"], [HTMLSourceElement.prototype, "srcset"], [HTMLIFrameElement.prototype, "src"], [HTMLLinkElement.prototype, "href"], [HTMLAnchorElement.prototype, "href"], [HTMLMediaElement.prototype, "src"], [HTMLFormElement.prototype, "action"]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property)!;
    Object.defineProperty(prototype, property, { ...descriptor, set(value: string) { descriptor.set!.call(this, this instanceof HTMLScriptElement && this.type.toLowerCase() === "module" ? mapPreviewModuleUrl(String(value), { ...context, upstream: currentUpstream() }) : this instanceof HTMLScriptElement ? mapPreviewScriptUrl(String(value), { ...context, upstream: currentUpstream() }) : property === "srcset" ? mapPreviewSrcset(String(value), context) : map(String(value))); } });
  }
  const css = (text: string, upstream = currentUpstream()) => rewritePreviewCss(String(text), { ...context, upstream });
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function(property, value, priority) { setProperty.call(this, property, css(value ?? ""), priority); };
  // Chromium exposes CSS names as exotic own properties; WebKit puts them on
  // CSSStyleProperties. Prototype setters alone do not cover direct assignments.
  const styles = new WeakMap<CSSStyleDeclaration, CSSStyleDeclaration>();
  for (const prototype of [HTMLElement.prototype, SVGElement.prototype, CSSStyleRule.prototype, CSSKeyframeRule.prototype, CSSPageRule.prototype, CSSFontFaceRule.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "style")!;
    const mappedDescriptor: PropertyDescriptor = { ...descriptor, get() {
      const style: CSSStyleDeclaration = descriptor.get!.call(this);
      let mapped = styles.get(style);
      if (!mapped) {
        mapped = new Proxy(style, {
          get(target, property) {
            // SAFETY: Proxy keys are requested native CSS declaration properties; access uses the real DOM receiver.
            const value = target[property as keyof CSSStyleDeclaration];
            return Value.Check(Type.Function([], Type.Unknown()), value) && property !== "constructor" ? value.bind(target) : value;
          },
          set(target, property, value) { return Reflect.set(target, property, Value.Check(Type.String(), property) && property in target ? css(String(value ?? ""), target.parentRule?.parentStyleSheet?.href ?? currentUpstream()) : value, target); },
        });
        styles.set(style, mapped);
      }
      return mapped;
    } };
    if (descriptor.set) mappedDescriptor.set = function(value: string) { descriptor.set!.call(this, css(value)); };
    Object.defineProperty(prototype, "style", mappedDescriptor);
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
