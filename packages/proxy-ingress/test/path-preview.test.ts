import { expect, test } from "bun:test";
import { createWorkspacePathPreviews } from "../src/ingress/path-preview.ts";

async function root(previews: ReturnType<typeof createWorkspacePathPreviews>, id: string) {
  const response = await previews.entry(new Request(`https://dynamic.example/workspaces/${id}/ports/3152/`), { workspaceId: id, appKey: "port-3152" }, "/");
  expect(response.headers.get("location")).toBeNull();
  const body = await response.text();
  // Read the capability returned by the entry operation, not its UI structure.
  return new URL(body.match(/\/~preview\/[a-zA-Z0-9_-]{43}\//)![0], "https://dynamic.example");
}

test("HTTPS preview capabilities bind all backend selection to one workspace and never fall back to management", async () => {
  const reads: Array<{ workspaceId: string; path: string }> = [];
  const previews = createWorkspacePathPreviews({
    publicOrigin: () => "https://dynamic.example", resolveWorkspace() {},
    resolveApp(app) { reads.push({ workspaceId: app.workspaceId, path: "file" }); return { kind: "fetch", fetch: () => new Response(app.workspaceId) }; },
    resolvePort(workspaceId, _port, _protocol, url) {
      reads.push({ workspaceId, path: url.pathname });
      return { kind: "http", target: new URL(url.pathname + url.search, backend.url) };
    },
  });
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("workspace bytes") });
  try {
    const one = await root(previews, "one"), two = await root(previews, "two");
    expect(one.pathname).not.toBe(two.pathname);
    const response = (await previews.resource(new Request(new URL("port-3152/workspaces/two/settings", one), { headers: { origin: "null" } })))!;
    expect(await response.text()).toBe("workspace bytes");
    expect(reads).toEqual([{ workspaceId: "one", path: "/workspaces/two/settings" }]);
    for (const path of ["/~preview/not-a-token/port-3152/", `${one.pathname}desktop/`, `${one.pathname}port-2999/`, `${one.pathname}unknown/`]) {
      expect((await previews.resource(new Request(`https://dynamic.example${path}`)))!.status).toBe(403);
    }
    expect((await previews.resource(new Request(new URL("port-3152/", one), { headers: { origin: "https://foreign.example" } })))!.status).toBe(403);
    previews.removeWorkspace("one");
    expect((await previews.resource(new Request(new URL("port-3152/", one))))!.status).toBe(403);
    expect(await previews.resource(new Request("https://dynamic.example/settings"))).toBeUndefined();
  } finally { backend.stop(true); }
});

test("preview HTTP strips management identity, keeps app cookies private and maps redirects without public ports", async () => {
  const seen: Array<{ headers: Headers; body: string }> = [];
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    seen.push({ headers: request.headers, body: await request.text() });
    const path = new URL(request.url).pathname;
    if (path === "/login") return new Response("signed in", { headers: { "set-cookie": "session=app-secret; HttpOnly; Path=/", "clear-site-data": '"*"', "strict-transport-security": "max-age=0", "alt-svc": 'h3=":41020"', "accept-ch": "Sec-CH-UA-Model", "report-to": '{"url":"https://untrusted.example"}', "reporting-endpoints": 'attacker="https://untrusted.example"', "nel": '{"report_to":"attacker"}', "service-worker-allowed": "/", "www-authenticate": 'Basic realm="management"', "link": '</settings>; rel="preload"', "refresh": "0;url=http://localhost:41020/" } });
    if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "http://localhost:8000/next" } });
    return new Response("app", { headers: { "set-cookie": "csrf=readable; Path=/" } });
  } });
  const previews = createWorkspacePathPreviews({ publicOrigin: () => "https://dynamic.example", resolveWorkspace() {}, resolveApp() {}, resolvePort: (_id, _port, _protocol, url) => ({ kind: "http", target: new URL(url.pathname + url.search, backend.url) }) });
  try {
    const one = await root(previews, "one"), two = await root(previews, "two");
    const login = (await previews.resource(new Request(new URL("port-3152/login", one), { headers: { cookie: "management=private", authorization: "Bearer management", "x-kintsugi-gateway-token": "forged", "tailscale-user-login": "private@example", "x-forwarded-host": "private.example", origin: "null" } })))!;
    await login.text();
    for (const name of ["set-cookie", "clear-site-data", "strict-transport-security", "alt-svc", "accept-ch", "report-to", "reporting-endpoints", "nel", "service-worker-allowed", "www-authenticate", "link", "refresh"]) expect(login.headers.get(name)).toBeNull();
    expect(login.headers.get("x-kintsugi-preview-cookie")).toBe("");
    for (const name of ["cookie", "authorization", "x-kintsugi-gateway-token", "tailscale-user-login", "x-forwarded-host"]) expect(seen[0]!.headers.get(name)).toBeNull();
    expect(login.headers.get("content-security-policy")).toStartWith("sandbox allow-scripts");
    expect(login.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(login.headers.get("referrer-policy")).toBe("no-referrer");
    expect(login.headers.get("access-control-allow-origin")).toBe("null");
    const post = (await previews.resource(new Request(new URL("port-3152/submit", one), { method: "POST", body: "literal-body", headers: { origin: "null", "x-kintsugi-preview-authorization": "Bearer app", "x-kintsugi-preview-cookie": "session=forged; client=readable" } })))!;
    await post.text();
    expect(seen[1]!.headers.get("cookie")).toBe("session=app-secret; client=readable");
    expect(seen[1]!.headers.get("authorization")).toBe("Bearer app");
    expect(seen[1]!.body).toBe("literal-body");
    const isolated = (await previews.resource(new Request(new URL("port-3152/", two))))!; await isolated.text();
    expect(seen[2]!.headers.get("cookie")).toBeNull();
    const redirect = (await previews.resource(new Request(new URL("port-3152/redirect", one))))!;
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(new URL("port-8000/next", one).href);
    const preflight = (await previews.resource(new Request(new URL("port-3152/", one), { method: "OPTIONS", headers: { origin: "null", "access-control-request-headers": "content-type,x-requested-with" } })))!;
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type,x-requested-with");
  } finally { backend.stop(true); }
});

test("concurrent preview reads share in-flight ownership checks but never cache a completed identity", async () => {
  let checks = 0;
  let held: Promise<void> | undefined;
  let release!: () => void;
  let stopped = false;
  const previews = createWorkspacePathPreviews({ publicOrigin: () => "https://dynamic.example", resolveWorkspace() { checks++; if (stopped) throw new Error("Workspace stopped"); return held; }, resolvePort() { throw new Error("Not a port resource"); }, resolveApp: () => ({ kind: "fetch", fetch: () => new Response("file bytes") }) });
  const capability = await root(previews, "one");
  held = new Promise(resolve => { release = resolve; });
  const reads = Array.from({ length: 30 }, () => previews.resource(new Request(new URL("file/work/example.txt", capability))));
  await Promise.resolve(); await Promise.resolve();
  expect(checks).toBe(2);
  held = undefined; release();
  for (const response of await Promise.all(reads)) expect(await response!.text()).toBe("file bytes");
  const next = (await previews.resource(new Request(new URL("file/work/example.txt", capability))))!;
  expect(await next.text()).toBe("file bytes"); expect(checks).toBe(3);
  stopped = true;
  await expect(previews.resource(new Request(new URL("file/work/example.txt", capability)))).rejects.toThrow("Workspace stopped");
  expect(checks).toBe(4);
});

test("nested documents receive prefix-bound delegated capabilities, not parent workspace or management authority", async () => {
  const childRoot = `/~preview/${"b".repeat(43)}/`;
  const seen: Headers[] = [];
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
    const path = new URL(request.url).pathname;
    seen.push(request.headers);
    if (path === "/login") return new Response("signed in", { headers: { "set-cookie": "parent-session=secret; HttpOnly; Path=/" } });
    if (path === `${childRoot}vscode/`) {
      const context = { publicOrigin: `http://localhost:${backend.port}`, root: childRoot, app: "vscode", upstream: "http://localhost:24800/", cookies: "child=readable" };
      const content = JSON.stringify(context).replaceAll('"', "&quot;");
      return new Response(`<html><head><meta name="kintsugi-preview-context" content="${content}"></head></html>`, { headers: { "content-type": "text/html", "x-kintsugi-preview-protocol": "1", "content-security-policy": "default-src 'self'" } });
    }
    return new Response("child API bytes", { headers: { "x-kintsugi-preview-cookie": "child=updated" } });
  } });
  const previews = createWorkspacePathPreviews({ publicOrigin: () => "https://dynamic.example", resolveWorkspace() {}, resolveApp: () => ({ kind: "fetch", fetch: () => new Response("parent workspace file") }), resolvePort: (_id, _port, _protocol, url) => ({ kind: "http", target: new URL(url.pathname + url.search, backend.url) }) });
  try {
    const parent = await root(previews, "outer");
    await (await previews.resource(new Request(new URL("port-3152/login", parent))))!.text();
    const entry = (await previews.resource(new Request(new URL(`port-3152${childRoot}vscode/?__kintsugi_persist=1`, parent))))!;
    expect(entry.status).toBe(302);
    expect(entry.headers.get("referrer-policy")).toBe("no-referrer");
    const destination = new URL(entry.headers.get("location")!, parent);
    expect(destination.pathname).not.toStartWith(parent.pathname);
    const scopedRoot = new URL(destination.pathname.match(/^\/~preview\/[^/]+\//)![0], parent);
    const document = (await previews.resource(new Request(destination)))!;
    expect(document.status).toBe(200);
    const { readNestedPreviewContext } = await import("../src/ingress/preview-rewrite.ts");
    const context = await readNestedPreviewContext(await document.text());
    expect(context.root).toBe(`${scopedRoot.pathname}port-3152${childRoot}`);
    for (const value of document.headers.values()) expect(value).not.toContain(parent.pathname);
    expect(JSON.stringify(context)).not.toContain(parent.pathname);
    expect(seen[1]!.get("cookie")).toBeNull(); expect(seen[2]!.get("cookie")).toBeNull();
    const api = (await previews.resource(new Request(new URL(`port-3152${childRoot}vscode/api`, scopedRoot), { method: "POST", body: "child body", headers: { origin: "null", "x-kintsugi-preview-cookie": "child=client", "x-kintsugi-preview-authorization": "Bearer child" } })))!;
    expect(await api.text()).toBe("child API bytes");
    expect(api.headers.get("x-kintsugi-preview-cookie")).toBe("child=updated");
    expect(seen.at(-1)!.get("cookie")).toBeNull(); expect(seen.at(-1)!.get("authorization")).toBeNull();
    expect(seen.at(-1)!.get("x-kintsugi-preview-cookie")).toBe("child=client");
    expect(seen.at(-1)!.get("x-kintsugi-preview-authorization")).toBe("Bearer child");
    for (const path of ["file/work/secret", "vscode/", "port-8000/", "port-3152/settings", `port-3152/~preview/${"c".repeat(43)}/file/work/secret`, `port-3152${childRoot}vscode/%2e%2e/%2e%2e/settings`]) {
      const request = new Request(new URL(path, scopedRoot), { headers: { origin: "null" } });
      expect((await previews.resource(request))!.status).toBe(403);
      const socket = await previews.websocket(request);
      expect(socket instanceof Response ? socket.status : undefined).toBe(403);
    }
    previews.removeWorkspace("outer");
    expect((await previews.resource(new Request(destination)))!.status).toBe(403);
  } finally { backend.stop(true); }
});

test("a backend reply arriving after suspension cannot mint a fresh generated-code capability", async () => {
  let reply!: (response: Response) => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const previews = createWorkspacePathPreviews({ publicOrigin: () => "https://dynamic.example", resolveWorkspace() {}, resolvePort() { throw new Error("Not a port"); }, resolveApp: () => ({ kind: "fetch", fetch: () => { started(); return new Promise<Response>(resolve => { reply = resolve; }); } }) });
  const capability = await root(previews, "one");
  const pending = previews.resource(new Request(new URL("file/work/generated.html", capability)));
  await waiting; previews.removeWorkspace("one");
  reply(new Response("<html><head></head><body>old</body></html>", { headers: { "content-type": "text/html" } }));
  expect((await pending)!.status).toBe(403);
});
