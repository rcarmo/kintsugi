/** Opaque frames keep real browser isolation; only null target origins are adapted. */
export function installPreviewMessages(): void {
  const frameWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow")!;
  const messageSource = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "source")!;
  const nativeParent = window.parent;
  const proxies = new WeakMap<object, Window>();
  function wrap(target: Window | null): Window | null {
    if (!target || target === window) return target;
    const existing = proxies.get(target);
    if (existing) return existing;
    const proxy = new Proxy(target, {
      get(object, key) {
        if (key === "postMessage") return (data: Parameters<Window["postMessage"]>[0], origin: string | WindowPostMessageOptions = "*", transfer?: Transferable[]) => {
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Native postMessage has string and options overloads at this DOM boundary.
          if (typeof origin === "string") object.postMessage(data, origin === "null" ? "*" : origin, transfer);
          else object.postMessage(data, { ...origin, targetOrigin: origin.targetOrigin === "null" ? "*" : origin.targetOrigin });
        };
        // SAFETY: Proxy keys are the browser's requested Window properties; native access still enforces SOP.
        return object[key as keyof Window];
      },
    });
    proxies.set(target, proxy);
    return proxy;
  }
  // Opaque origins all serialize to "null". Never treat that string as proof of
  // ownership: messages must come from this document's parent or child frames.
  window.addEventListener("message", event => {
    const source = messageSource.get!.call(event);
    if (event.origin !== "null" || source === window || source === nativeParent) return;
    if (![...document.querySelectorAll("iframe")].some(frame => frameWindow.get!.call(frame) === source)) event.stopImmediatePropagation();
  }, { capture: true });
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", { configurable: true, get() { return wrap(frameWindow.get!.call(this)); } });
  Object.defineProperty(MessageEvent.prototype, "source", { configurable: true, get() {
    const source = messageSource.get!.call(this);
    if (!source || source === window) return source;
    if (proxies.has(source)) return proxies.get(source);
    if (source === nativeParent || [...document.querySelectorAll("iframe")].some(frame => frameWindow.get!.call(frame) === source)) return wrap(source);
    return source;
  } });
  for (const name of ["parent", "top", "opener"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    if (!descriptor?.configurable) continue;
    const target = window[name];
    const proxy = wrap(target);
    Object.defineProperty(window, name, { configurable: true, get: () => proxy });
  }
}
