import { expect, test } from "bun:test";
import { createWorkspaceIngress, handleCanonicalWorkspaceRequest, managementOriginRejection } from "../src/server/index.ts";

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const paths = [
  ["/workspaces/one/files/work/host-demo.html?x=1", "file", "/work/host-demo.html?x=1"],
  ["/workspaces/one/ports/8377/demo?x=1", "port-8377", "/demo?x=1"],
  ["/workspaces/one/apps/vscode/demo?x=1", "vscode", "/demo?x=1"],
] as const;

for (const [path, appKey, target] of paths) {
  test(`canonical ${appKey} navigation redirects before serving workspace bytes`, async () => {
    const reads: string[] = [];
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1", resolveWorkspace() {},
      resolveApp(app) {
        return { kind: "fetch", fetch(request) {
          reads.push(app.appKey);
          return new Response(`workspace:${new URL(request.url).pathname}${new URL(request.url).search}`);
        } };
      },
    });
    const management = Bun.serve({ hostname: "127.0.0.1", port: 0,
      async fetch(request) { return await handleCanonicalWorkspaceRequest(request, ingress) ?? new Response("not found", { status: 404 }); },
    });
    const origin = `http://127.0.0.1:${management.port}`;
    try {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(await response.text()).toBe("");
      expect(reads).toEqual([]);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const location = new URL(response.headers.get("location")!);
      expect(location.origin).not.toBe(origin);
      expect(`${location.pathname}${location.search}`).toBe(target);
      expect(await (await fetch(location)).text()).toBe(`workspace:${target}`);
      expect(reads).toEqual([appKey]);
    } finally { management.stop(true); await ingress.stopAll(); }
  });
}

test("management-owned Desktop routes do not allocate or redirect to a public preview port", async () => {
  const ingress = createWorkspaceIngress({ hostname: "127.0.0.1",
    resolveWorkspace() { throw new Error("Desktop module must resolve its own workspace"); },
    resolveApp() { throw new Error("Desktop module must resolve its fixed display transport"); },
  });
  try {
    for (const path of ["/", "/status", "/desktop-client.js", "/websockify"]) {
      expect(await handleCanonicalWorkspaceRequest(new Request(`https://management.example/workspaces/one/apps/desktop${path}`), ingress)).toBeUndefined();
    }
  } finally { await ingress.stopAll(); }
});

test("publication failures and refreshed management-origin collisions fail closed", async () => {
  const port = freePort();
  let published = "http://localhost:3000";
  let fail = false;
  let reads = 0;
  const ingress = createWorkspaceIngress({
    hostname: "127.0.0.1", originPortRange: { start: port, end: port }, resolveWorkspace() {},
    parentOriginPublisher: { kind: "system", refresh: true, async publish() {
      if (fail) throw new Error("publication unavailable");
      return published;
    } },
    resolveApp() { reads++; return { kind: "fetch", fetch: () => new Response("untrusted") }; },
  });
  const request = new Request("http://localhost:3000/workspaces/one/files/work/demo.html", {
    headers: { "x-kintsugi-public-origin": "https://management.example" },
  });
  try {
    for (published of ["http://localhost:3000", "https://management.example"]) {
      const response = (await handleCanonicalWorkspaceRequest(request, ingress))!;
      expect(response.status).toBe(502);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).toBe("Workspace content must use an isolated origin");
    }
    published = `http://localhost:${port}`;
    expect((await handleCanonicalWorkspaceRequest(request, ingress))!.status).toBe(302);
    fail = true;
    const failure = (await handleCanonicalWorkspaceRequest(request, ingress))!;
    expect(failure.status).toBe(502);
    expect(failure.headers.get("location")).toBeNull();
    await failure.text();
    expect(reads).toBe(0);
  } finally { await ingress.stopAll(); }
});

test("canonical paths cannot replace the isolated redirect authority", async () => {
  const ingress = createWorkspaceIngress({ hostname: "127.0.0.1", resolveWorkspace() {}, resolveApp() { throw new Error("must not serve content"); } });
  try {
    for (const path of ["/workspaces/one/files/%2F%2Fmanagement.example/demo.html", "/workspaces/one/ports/8377//management.example/demo.html"]) {
      const response = (await handleCanonicalWorkspaceRequest(new Request(`https://management.example${path}`), ingress))!;
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location")!).hostname).toBe("localhost");
    }
    expect(await handleCanonicalWorkspaceRequest(new Request("https://management.example/host/sample"), ingress)).toBeUndefined();
  } finally { await ingress.stopAll(); }
});

test("published file origin cannot dispatch privileged POSTs or terminal WebSocket handshakes", async () => {
  const dispatched: string[] = [];
  const ingress = createWorkspaceIngress({ hostname: "127.0.0.1", resolveWorkspace() {}, resolveApp() { return { kind: "fetch", fetch: () => new Response("artifact") }; } });
  const management = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      const rejected = managementOriginRejection(request, server.requestIP(request)?.address);
      if (rejected) return rejected;
      const canonical = await handleCanonicalWorkspaceRequest(request, ingress);
      if (canonical) return canonical;
      dispatched.push(new URL(request.url).pathname);
      return new Response("accepted");
    },
  });
  const origin = `http://127.0.0.1:${management.port}`;
  try {
    const redirect = await fetch(`${origin}/workspaces/one/files/work/host-demo.html`, { redirect: "manual" });
    const artifactOrigin = new URL(redirect.headers.get("location")!).origin;
    await redirect.text();
    for (const headers of [new Headers({ origin: artifactOrigin }), new Headers({ origin: artifactOrigin, upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" })]) {
      const websocket = headers.has("upgrade");
      const response = await fetch(`${origin}${websocket ? "/terminal-processes/demo/ws" : "/host/sample"}`, { method: websocket ? "GET" : "POST", headers });
      expect(response.status).toBe(403);
      await response.text();
    }
    expect(dispatched).toEqual([]);
    const legitimate = await fetch(`${origin}/host/sample`, { method: "POST", headers: { origin } });
    expect(legitimate.status).toBe(200);
    await legitimate.text();
    expect(dispatched).toEqual(["/host/sample"]);
  } finally { management.stop(true); await ingress.stopAll(); }
});

test("two ingress hops preserve artifact-origin denial for terminal HTTP and WebSocket requests", async () => {
  let dispatched = 0;
  const denied: string[] = [];
  const management = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
    const rejected = managementOriginRejection(request, server.requestIP(request)?.address);
    if (rejected) { denied.push(request.headers.get("origin")!); return rejected; }
    dispatched++;
    return new Response("accepted");
  } });
  const outerPort = freePort();
  const innerPort = freePort();
  const outer = createWorkspaceIngress({
    hostname: "127.0.0.1", originPortRange: { start: outerPort, end: outerPort }, resolveWorkspace() {}, resolveApp() { return undefined; },
    resolvePort(_id, port, _protocol, url) { return { kind: "http", target: new URL(`http://127.0.0.1:${port}${url.pathname}${url.search}`) }; },
  });
  const inner = createWorkspaceIngress({
    hostname: "127.0.0.1", originPortRange: { start: innerPort, end: innerPort }, resolveWorkspace() {}, resolveApp() { return undefined; },
    parentOriginPublisher: { kind: "kintsugi", async publish(port) { return await outer.publishPort("nested", port); } },
    resolvePort(_id, port, _protocol, url) { return { kind: "http", target: new URL(`http://127.0.0.1:${port}${url.pathname}${url.search}`) }; },
  });
  const artifacts = createWorkspaceIngress({ hostname: "127.0.0.1", resolveWorkspace() {}, resolveApp() { return { kind: "fetch", fetch: () => new Response("artifact") }; } });
  try {
    const origin = await inner.publishPort("management", management.port!);
    const opened = (await handleCanonicalWorkspaceRequest(new Request(`${origin}/workspaces/one/files/work/host-demo.html`), artifacts))!;
    const artifactOrigin = new URL(opened.headers.get("location")!).origin;
    // Include a foreign Origin equal to the innermost local destination: it
    // must not become trusted merely by coinciding with a translated address.
    for (const browserOrigin of [artifactOrigin, `http://localhost:${management.port}`, "null"]) {
      for (const websocket of [false, true]) {
        const headers = new Headers({ origin: browserOrigin, "x-kintsugi-origin-context": origin });
        if (websocket) {
          headers.set("upgrade", "websocket");
          headers.set("connection", "Upgrade");
          headers.set("sec-websocket-version", "13");
          headers.set("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==");
        }
        const response = await fetch(`${origin}${websocket ? "/terminal-processes/demo/ws" : "/host/sample"}`, { method: websocket ? "GET" : "POST", headers });
        // Upstream rejected upgrades are reported as an ingress failure; the
        // management handler must still never dispatch them.
        expect(response.status).toBe(websocket ? 503 : 403);
        await response.text();
      }
    }
    expect(dispatched).toBe(0);
    expect(denied).toEqual([artifactOrigin, artifactOrigin, `http://localhost:${management.port}`, `http://localhost:${management.port}`, "null", "null"]);
    const legitimate = await fetch(`${origin}/host/sample`, { method: "POST", headers: { origin } });
    expect(legitimate.status).toBe(200);
    await legitimate.text();
    expect(dispatched).toBe(1);
  } finally { await artifacts.stopAll(); await inner.stopAll(); await outer.stopAll(); management.stop(true); }
});

for (const kind of ["fetch", "http"] as const) {
  test(`${kind} ingress strips workspace cross-origin grants from content, errors, redirects and preflights`, async () => {
    const grants = {
      "AcCeSs-CoNtRoL-AlLoW-OrIgIn": "https://management.example",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "X-Turbo-Request-Id, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Expose-Headers": "*",
      "Access-Control-Max-Age": "86400",
      "Access-Control-Allow-Private-Network": "true",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cross-Origin-Opener-Policy": "unsafe-none",
      "Cross-Origin-Embedder-Policy": "unsafe-none",
      "Timing-Allow-Origin": "*",
    };
    const serve = (request: Request) => {
      const status = Number(new URL(request.url).pathname.slice(1));
      const headers = new Headers({
        ...grants,
        "content-type": "text/html",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "x-workspace-header": "preserved",
      });
      if (status === 302) headers.set("location", "/200");
      return new Response(status === 204 ? null : "untrusted workspace bytes", { status, headers });
    };
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: serve });
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1", resolveWorkspace() {},
      resolveApp(_app, url) {
        return kind === "fetch" ? { kind, fetch: serve } : { kind, target: new URL(url.pathname, `http://127.0.0.1:${upstream.port}`) };
      },
    });
    try {
      for (const [method, status] of [["GET", 200], ["GET", 302], ["GET", 500], ["OPTIONS", 204]] as const) {
        const canonical = (await handleCanonicalWorkspaceRequest(new Request(`https://management.example/workspaces/one/apps/demo/${status}`), ingress))!;
        const response = await fetch(canonical.headers.get("location")!, {
          method, redirect: "manual",
          headers: { origin: "https://management.example", "access-control-request-headers": "X-Turbo-Request-Id", "access-control-request-method": "GET" },
        });
        expect(response.status).toBe(status);
        for (const name of Object.keys(grants)) expect(response.headers.get(name)).toBeNull();
        expect(response.headers.get("x-frame-options")).toBeNull();
        expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
        expect(response.headers.get("x-workspace-header")).toBe("preserved");
        expect(response.headers.get("content-type")).toBe("text/html");
        if (status === 302) expect(new URL(response.headers.get("location")!, response.url).pathname).toBe("/200");
        expect(await response.text()).toBe(status === 204 ? "" : "untrusted workspace bytes");
      }
    } finally { upstream.stop(true); await ingress.stopAll(); }
  });
}
