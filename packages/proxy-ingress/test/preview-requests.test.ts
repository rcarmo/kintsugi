import { expect, test } from "bun:test";
import { installPreviewRequests } from "../src/client/preview-requests.ts";

// Transport unit test only: no browser, network or DOM emulation.
test("external requests retain native credentials and headers; workspace SSE omits ambient credentials", async () => {
  const names = ["Request", "fetch", "WebSocket", "EventSource", "XMLHttpRequest"];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const events: Array<{ url: string; init?: EventSourceInit }> = [];
  const requests: Request[] = [];
  const nativeExternal = new Request("https://external.example/api", { referrerPolicy: "origin" });
  class Source {
    constructor(url: string, init?: EventSourceInit) { events.push({ url, init }); }
  }
  class Xhr { open() {} setRequestHeader() {} send() {} }
  try {
    Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: Source });
    Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, writable: true, value: Xhr });
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (request: Request) => { requests.push(request); return new Response("external"); } });
    const context = { publicOrigin: "https://management.example", root: "/~preview/token/", app: "port-3152", upstream: "http://localhost:3152/page" };
    let cookieReads = 0;
    installPreviewRequests(context, () => context.upstream, { read() { cookieReads++; return "workspace=private"; }, write() { throw new Error("External responses must not update workspace cookies"); } });
    const options = { withCredentials: true };
    new EventSource("https://external.example/events", options);
    new EventSource("https://external.example/default");
    new EventSource("/events", options);
    expect(events[0]).toEqual({ url: "https://external.example/events", init: options });
    expect(events[0]!.init).toBe(options);
    expect(events[1]).toEqual({ url: "https://external.example/default", init: undefined });
    expect(events[2]).toEqual({ url: "https://management.example/~preview/token/port-3152/events", init: { withCredentials: false } });
    await fetch("https://external.example/api", { credentials: "include", referrerPolicy: "origin", headers: { authorization: "Bearer external" } });
    expect(requests[0]!.url).toBe("https://external.example/api");
    expect(requests[0]!.credentials).toBe("include");
    expect(requests[0]!.referrerPolicy).toBe(nativeExternal.referrerPolicy);
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer external");
    expect(requests[0]!.headers.has("x-kintsugi-preview-authorization")).toBe(false);
    expect(requests[0]!.headers.has("x-kintsugi-preview-cookie")).toBe(false);
    expect(cookieReads).toBe(0);
  } finally {
    names.forEach((name, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});
