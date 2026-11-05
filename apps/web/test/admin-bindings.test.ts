import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKintsugiEventBus, type JsonObject } from "@kintsugi/core";
import { createAdminStore, adminScopes, validateBindings } from "../src/server/admin/store.ts";
import { createAdminHandler, startAdminBindings } from "../src/server/admin/bindings.ts";
import { adminRoutes } from "../src/server/admin/routes.ts";
import { kintsugiOpenApi } from "../src/server/openapi.ts";
import { createWebApp } from "../src/server/app.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";
import { workspaceModules } from "../src/server/workspace-modules.generated.ts";
import { adminBindingsCommand } from "../scripts/admin-bindings.ts";

function freeAdminPort(exclude: number[] = []): number {
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
    const port = probe.port!;
    probe.stop(true);
    if ((port < 41000 || port > 41999) && !exclude.includes(port)) return port;
  }
  throw new Error("No free non-preview admin port");
}

async function fixture(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const context = await setup();
  try { await run(context); } finally { await rm(context.directory, { recursive: true, force: true }); }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-admin-"));
  const store = createAdminStore(join(directory, "admin-bindings.json"));
  const auditPath = join(directory, "audit.jsonl");
  const issued = await store.issue({ name: "test", scopes: [...adminScopes] });
  const forwarded: { url: string; headers: Headers; body: string }[] = [];
  const handler = createAdminHandler({ store, auditPath, app: { async fetch(request) {
    forwarded.push({ url: request.url, headers: request.headers, body: await request.text() });
    if (new URL(request.url).pathname === "/openapi.json") return Response.json(kintsugiOpenApi([]));
    if (new URL(request.url).pathname.endsWith("/public-key")) return new Response("ssh-ed25519 public");
    return Response.json({ ok: true });
  } } });
  function request(path: string, method = "GET", body?: string, authorization: string | null = `Bearer ${issued.secret}`, headers: Record<string, string> = {}) {
    const normalized = new Headers(headers);
    if (authorization) normalized.set("authorization", authorization);
    if (body !== undefined && !normalized.has("content-type")) normalized.set("content-type", "application/json");
    return new Request(`http://127.0.0.1:3443${path}`, { method, headers: normalized, body });
  }
  return { directory, store, issued, handler, request, forwarded, auditPath };
}

describe("admin token store", () => {
  test("disabled by default, hashes only, private permissions, immediate revocation", () => fixture(async ({ directory, store, issued }) => {
    expect((await store.read()).bindings).toEqual([]);
    const path = join(directory, "admin-bindings.json");
    expect(await readFile(path, "utf8")).not.toContain(issued.secret);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await store.authenticate(`Bearer ${issued.secret}`))?.id).toBe(issued.token.id);
    expect(await store.revoke(issued.token.id)).toBe(true);
    expect(await store.authenticate(`Bearer ${issued.secret}`)).toBeUndefined();
    expect(await store.revoke(issued.token.id)).toBe(false);
  }));
  test("expired, unknown, malformed and non-bearer tokens are rejected", () => fixture(async ({ directory, store, issued }) => {
    for (const authorization of [null, "Basic test", issued.secret, "Bearer bad", `Bearer ${issued.secret}more`]) expect(await store.authenticate(authorization)).toBeUndefined();
    const value = await store.read(); value.tokens[0]!.expiresAt = "2000-01-01T00:00:00Z";
    await writeFile(join(directory, "admin-bindings.json"), JSON.stringify(value));
    expect(await store.authenticate(`Bearer ${issued.secret}`)).toBeUndefined();
  }));
  test("token input validates scopes, names and future expiry", () => fixture(async ({ store }) => {
    for (const input of [{ name: "", scopes: ["security"] }, { name: "x", scopes: ["root"] }, { name: "x", scopes: [] }, { name: "x", scopes: ["security"], expiresAt: "nonsense" }, { name: "x", scopes: ["security"], expiresAt: "2000-01-01T00:00:00Z" }]) await expect(store.issue(JSON.parse(JSON.stringify(input)))).rejects.toThrow();
  }));
  test("concurrent issuance does not lose tokens", () => fixture(async ({ store }) => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.issue({ name: `token-${i}`, scopes: ["host:read"] })));
    expect((await store.read()).tokens).toHaveLength(9);
  }));
  test("loopback HTTP allowed; LAN requires TLS; reserved ports and invalid paths rejected", () => {
    expect(validateBindings([{ host: "127.0.0.1", port: 3443 }])).toHaveLength(1);
    expect(validateBindings([{ host: "::1", port: 3443 }])).toHaveLength(1);
    expect(validateBindings([{ host: "0.0.0.0", port: 3443, tls: { cert: "/cert.pem", key: "/key.pem" } }])).toHaveLength(1);
    for (const input of [[{ host: "0.0.0.0", port: 3443 }], [{ host: "192.168.1.2", port: 3443 }], [{ host: "localhost", port: 3443 }], [{ host: "127.0.0.1", port: 3001 }], [{ host: "127.0.0.1", port: 41001 }], [{ host: "0.0.0.0", port: 3443, tls: { cert: "relative.pem", key: "/key.pem" } }]]) expect(() => validateBindings(input)).toThrow();
  });
  test("malformed persisted configuration fails closed", () => fixture(async ({ directory, store }) => {
    await writeFile(join(directory, "admin-bindings.json"), '{"bindings":[],"tokens":[{}]}');
    await expect(store.read()).rejects.toThrow("Invalid admin configuration");
  }));
});

describe("admin request boundary", () => {
  test("every route, including reads and OpenAPI, requires authentication", () => fixture(async ({ handler, request, forwarded }) => {
    for (const route of adminRoutes) {
      const response = await handler(request(route.path, route.method, route.method === "GET" ? undefined : "{}", null));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(response.headers.get("content-type")).toContain("application/json");
    }
    expect(forwarded).toHaveLength(0);
  }));
  test("token scopes govern dispatch", () => fixture(async ({ store, handler, request, forwarded }) => {
    const token = await store.issue({ name: "diagnostics", scopes: ["host:read"] });
    expect((await handler(request("/host", "GET", undefined, `Bearer ${token.secret}`))).status).toBe(200);
    expect((await handler(request("/workspace-templates", "GET", undefined, `Bearer ${token.secret}`))).status).toBe(403);
    expect((await handler(request("/workspaces", "POST", "{}", `Bearer ${token.secret}`))).status).toBe(403);
    expect(forwarded).toHaveLength(1);
  }));
  test("cookies, query tokens and forged forwarded headers cannot authenticate", () => fixture(async ({ handler, request }) => {
    expect((await handler(request("/workspaces?token=bogus", "GET", undefined, null, { cookie: "adminToken=bogus", "x-admin-token": "bogus", "x-forwarded-for": "127.0.0.1" }))).status).toBe(401);
  }));
  test("UI, execution, MCP, terminals, previews and undocumented routes are unavailable", () => fixture(async ({ handler, request, forwarded }) => {
    for (const path of ["/", "/settings", "/models", "/settings/reset", "/host/terminals", "/host/terminals/host-id/terminate", "/workspaces/one/commands/terminal.create", "/workspaces/one/agents/a/messages", "/workspaces/one/file/open", "/agent-mcp", "/debug/connections", "/workspaces/new"]) {
      const response = await handler(request(path, "POST", "{}"));
      expect(response.status).toBe(404);
    }
    expect((await handler(request("/host", "GET", undefined, undefined, { upgrade: "websocket" }))).status).toBe(403);
    expect(forwarded).toHaveLength(0);
  }));
  test("reserved UI destinations and creation-time prompting cannot bypass the allowlist", () => fixture(async ({ handler, request, forwarded }) => {
    for (const path of ["/workspaces/new", "/workspace-templates/new", "/workspace-templates/github-search", "/workspace-templates/repository-search", "/settings/git-hosting/github/connect", "/settings/git-hosting/gitlab/connect", "/settings/git-hosting/bitbucket/connect", "/settings/git-hosting/gitea/connect"]) expect((await handler(request(path))).status).toBe(404);
    expect((await handler(request("/workspaces", "POST", '{"agent":{"initialPrompt":"execute this"}}'))).status).toBe(403);
    expect((await handler(request("/workspaces", "POST", '{"agent":{"attachmentDraft":"draft"}}'))).status).toBe(403);
    expect(forwarded).toHaveLength(0);
  }));
  test("rejects encoded delimiters before app dispatch", () => fixture(async ({ handler, request, forwarded }) => {
    for (const path of ["/workspaces/one%2fcommands", "/workspace-templates/%252f", "/workspaces/one%5c", "/workspaces/%00"]) expect((await handler(request(path))).status).toBe(400);
    expect(forwarded).toHaveLength(0);
  }));
  test("JSON objects required; forms, arrays and invalid JSON rejected", () => fixture(async ({ handler, request, forwarded }) => {
    for (const body of ["", "[]", "null", "{invalid"]) expect((await handler(request("/workspaces", "POST", body))).status).toBe(400);
    expect((await handler(request("/workspaces", "POST", "name=x", undefined, { "content-type": "application/x-www-form-urlencoded" }))).status).toBe(415);
    expect(forwarded).toHaveLength(0);
  }));
  test("body limit is enforced before dispatch", () => fixture(async ({ handler, request, forwarded }) => {
    expect((await handler(request("/workspaces", "POST", JSON.stringify({ title: "x".repeat(1024 * 1024) })))).status).toBe(413);
    expect(forwarded).toHaveLength(0);
  }));
  test("JSON dispatch needs no Origin and drops UI, forwarded, auth and cookie headers", () => fixture(async ({ handler, request, forwarded }) => {
    const response = await handler(request("/workspaces?host=attacker", "POST", '{"title":"one"}', undefined, { cookie: "session=bad", "turbo-frame": "shell", "x-forwarded-host": "attacker", origin: "https://foreign.example" }));
    expect(response.status).toBe(200);
    const routed = forwarded[0]!;
    expect(routed.url).toBe("http://admin.internal/workspaces");
    expect(routed.headers.get("accept")).toBe("application/json");
    for (const name of ["origin", "cookie", "authorization", "turbo-frame", "x-forwarded-host"]) expect(routed.headers.has(name)).toBe(false);
  }));
  test("forced deletion needs a second scope", () => fixture(async ({ store, handler, request, forwarded }) => {
    const issued = await store.issue({ name: "lifecycle", scopes: ["workspaces"] });
    const auth = `Bearer ${issued.secret}`;
    expect((await handler(request("/workspaces/one/delete", "POST", '{"force":true}', auth))).status).toBe(403);
    expect((await handler(request("/workspaces/one/delete", "POST", "{}", auth))).status).toBe(200);
    expect(forwarded).toHaveLength(1);
  }));
  test("public keys are JSON wrapped", () => fixture(async ({ handler, request }) => {
    const response = await handler(request("/workspace-templates/one/ssh-keys/key/public-key"));
    expect(await response.json()).toEqual({ publicKey: "ssh-ed25519 public" });
  }));
  test("OpenAPI contains only allowlisted JSON routes and bearer security", () => fixture(async ({ handler, request }) => {
    const document = await (await handler(request("/openapi.json"))).json();
    expect(Object.keys(document.paths).sort()).toEqual([...new Set(adminRoutes.map(route => route.path))].sort());
    expect(document.components.securitySchemes.adminToken).toEqual({ type: "http", scheme: "bearer" });
    expect(document.paths["/workspaces"].post.requestBody.content["application/json"]).toBeDefined();
    expect(document.paths["/admin/tokens"].post.responses["201"]).toBeDefined();
    expect(JSON.stringify(document)).not.toContain('"text/html"');
    expect(document.info.description).not.toContain("No origin allowlist");
  }));
  test("audit never records bearer secrets, payloads or query values", () => fixture(async ({ handler, request, auditPath, issued }) => {
    await handler(request("/workspace-templates/one/secrets?token=query-private", "POST", '{"secretValue":"body-private"}'), "127.0.0.1");
    const audit = await readFile(auditPath, "utf8");
    for (const value of [issued.secret, "body-private", "query-private"]) expect(audit).not.toContain(value);
    expect(JSON.parse(audit.trim().split("\n").at(-1)!).operation).toBe("/workspace-templates/{workspaceTemplateId}/secrets");
    expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
  }));
  test("System bridge strips logs but exposes sign-in URL only to security scope", () => fixture(async ({ store, auditPath, request }) => {
    const calls: string[] = [];
    const handler = createAdminHandler({ store, auditPath, app: { fetch: async () => Response.json({}) }, systemAvailable: () => true, systemFetch: async (path, req) => {
      calls.push(path);
      expect(req.headers.has("authorization")).toBe(false);
      return Response.json({ healthy: true, busy: false, mode: "localhost", logs: ["private"], authUrl: "private", origin: "http://local" });
    } });
    const status = await (await handler(request("/host/status"))).json();
    expect(status).toEqual({ healthy: true, busy: false });
    const access = await handler(request("/settings/access", "POST", '{"mode":"localhost"}'));
    expect(access.status).toBe(200);
    expect((await access.json()).authUrl).toBe("private");
    expect((await handler(request("/settings/access", "POST", '{"localPort":3000}'))).status).toBe(400);
    expect(calls).toEqual(["/status", "/access"]);
  }));
  test("token issuance and revocation use JSON and apply immediately", () => fixture(async ({ handler, request, issued }) => {
    const created = await handler(request("/admin/tokens", "POST", '{"name":"observer","scopes":["host:read"]}'));
    expect(created.status).toBe(201);
    const value = await created.json();
    const metadata = await (await handler(request("/admin/tokens"))).json();
    expect(JSON.stringify(metadata)).not.toContain(value.secret);
    expect(JSON.stringify(metadata)).not.toContain('"hash"');
    expect((await handler(request(`/admin/tokens/${value.token.id}`, "DELETE", "{}"))).status).toBe(200);
    expect((await handler(request("/host", "GET", undefined, `Bearer ${value.secret}`))).status).toBe(401);
    expect((await handler(request(`/admin/tokens/${issued.token.id}`, "DELETE", "{}"))).status).toBe(200);
  }));
  test("binding configuration is validated and marks restart required", () => fixture(async ({ handler, request, store }) => {
    expect((await handler(request("/admin/bindings", "PUT", '{"bindings":[{"host":"0.0.0.0","port":3443}]}'))).status).toBe(400);
    const response = await handler(request("/admin/bindings", "PUT", '{"bindings":[{"host":"127.0.0.1","port":3443}]}'));
    expect((await response.json()).restartRequired).toBe(true);
    expect((await store.read()).bindings).toHaveLength(1);
  }));
});

test("real HTTP listener enforces auth and revoked tokens without reload", () => fixture(async ({ store, auditPath, issued }) => {
  const port = freeAdminPort();
  await store.setBindings([{ host: "127.0.0.1", port }]);
  const servers = await startAdminBindings({ store, auditPath, app: { fetch: async () => Response.json({ workspaces: [] }) } });
  try {
    const url = `http://127.0.0.1:${port}/workspaces`;
    expect((await fetch(url)).status).toBe(401);
    const headers = { authorization: `Bearer ${issued.secret}` };
    expect((await fetch(url, { headers })).status).toBe(200);
    await store.revoke(issued.token.id);
    expect((await fetch(url, { headers })).status).toBe(401);
  } finally { for (const server of servers) server.stop(true); }
}));

test("missing configuration starts no listeners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-admin-disabled-"));
  try { expect(await startAdminBindings({ store: createAdminStore(join(directory, "admin.json")), auditPath: join(directory, "audit"), app: { fetch: async () => Response.json({}) } })).toEqual([]); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI bootstraps JSON bindings, issues metadata and locally revokes tokens", () => fixture(async ({ directory }) => {
  const file = join(directory, "input.json");
  const args = ["--data-dir", directory, "--file", file];
  await writeFile(file, '{"bindings":[{"host":"127.0.0.1","port":3443}]}');
  expect(await adminBindingsCommand(["configure", ...args])).toEqual({ bindings: [{ host: "127.0.0.1", port: 3443 }], restartRequired: true });
  await writeFile(file, '{"name":"cli","scopes":["host:read"]}');
  const value = await adminBindingsCommand(["issue", ...args]);
  expect(value).toHaveProperty("secret");
  const shown = await adminBindingsCommand(["show", "--data-dir", directory]);
  expect(shown).not.toHaveProperty("secret");
  if (!("token" in value)) throw new Error("CLI did not issue a token");
  expect(await adminBindingsCommand(["revoke", value.token.id, "--data-dir", directory])).toEqual({ revoked: true });
  expect(await createAdminStore(join(directory, "admin-bindings.json")).authenticate(`Bearer ${value.secret}`)).toBeUndefined();
}));

test("real app JSON template, environment, secret and security operations", () => fixture(async ({ directory, store, issued, auditPath }) => {
  const previous = process.env.KINTSUGI_DATA_DIR;
  process.env.KINTSUGI_DATA_DIR = directory;
  const registry = createWorkspaceRegistry();
  const modules = workspaceModules.splice(0, workspaceModules.length);
  await writeFile(join(directory, "default-agent-type.json"), JSON.stringify("admin-fixture"));
  workspaceModules.push({ id: "admin-fixture", agentType: { id: "admin-fixture", label: "Fixture", iconHtml: "", tabs: { list: async () => [], render: async () => ({html: ""}), close: async () => {} }, create: async () => "fixture-agent", launch: { renderFooter: async () => "", prepare: async () => undefined, submit: async () => { throw new Error("not used"); }, prepareWorkspace: async () => {} } } });
  try {
    const app = createWebApp({ registry, events: createKintsugiEventBus(), provisionWorkspace: async () => {}, persistWorkspaceParked: async () => {}, destroyWorkspace: async () => {}, deletionReview: { inspect: async () => ({ status: "clear" }), renderEvidence: () => "" }, logError: () => {} });
    const handler = createAdminHandler({ store, auditPath, app });
    async function call(path: string, method = "GET", body?: JsonObject) {
      return handler(new Request(`http://admin.test${path}`, { method, headers: { authorization: `Bearer ${issued.secret}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    }
    const created = await call("/workspace-templates", "POST", { gitUrl: "https://github.com/example/admin-fixture.git" });
    expect(created.status).toBe(200);
    const { workspaceTemplate } = await created.json();
    const prefix = `/workspace-templates/${workspaceTemplate.id}`;
    const environment = await call(`${prefix}/environment`, "POST", { name: "REGION", value: "test" });
    expect(environment.status).toBe(200);
    const secret = await call(`${prefix}/secrets`, "POST", { envName: "API_TOKEN", hostPattern: "api.example.com", secretValue: "fixture-value-only" });
    expect(secret.status).toBe(200);
    const { secret: metadata } = await secret.json();
    expect(metadata.configured).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain("fixture-value-only");
    expect((await call(`${prefix}/secrets/${metadata.id}`, "POST", { envName: "API_TOKEN", hostPattern: "api.example.com", secretValue: "rotated-fixture" })).status).toBe(200);
    expect((await call(`${prefix}/privileged`, "POST", { privileged: true })).status).toBe(200);
    expect((await call(`${prefix}/seed-config`, "POST", { seedConfigEnabled: true })).status).toBe(200);
    const detail = await (await call(prefix)).json();
    expect(detail.workspaceTemplate.privileged).toBe(true);
    expect(detail.workspaceTemplate.seedConfigEnabled).toBe(true);
    expect(detail.workspaceTemplate.environment[0].value).toBe("test");
    expect(JSON.stringify(detail)).not.toContain("rotated-fixture");
    expect((await call(`${prefix}/ssh-keys`, "POST", { privateKey: "not-a-key" })).status).toBe(400);
    const keyPath = join(directory, "fixture-key");
    expect(Bun.spawnSync(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", keyPath], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    const privateKey = await readFile(keyPath, "utf8");
    const keyResponse = await call(`${prefix}/ssh-keys`, "POST", { privateKey, name: "Fixture" });
    expect(keyResponse.status).toBe(200);
    const { key } = await keyResponse.json();
    expect(key.name).toBe("Fixture");
    expect(JSON.stringify(key)).not.toContain(privateKey);
    expect((await (await call(`${prefix}/ssh-keys/${key.id}/public-key`)).json()).publicKey).toStartWith("ssh-ed25519");
    expect((await call(`${prefix}/ssh-keys/${key.id}`, "POST", { name: "Renamed" })).status).toBe(200);
    expect((await call(`${prefix}/ssh-keys/${key.id}/delete`, "POST", {})).status).toBe(200);
    const launched = await call("/workspaces", "POST", { source: { type: "workspace-template", workspaceTemplate: workspaceTemplate.id }, agent: { agentTypeId: "admin-fixture" } });
    expect(launched.status).toBe(202);
    const { workspace: createdWorkspace } = await launched.json();
    await app.provisioning.drain();
    const workspacePrefix = `/workspaces/${createdWorkspace.id}`;
    expect((await call(workspacePrefix)).status).toBe(200);
    expect((await call(`${workspacePrefix}/park`, "POST", {})).status).toBe(200);
    expect(registry.get(createdWorkspace.id)?.parked).toBe(true);
    expect((await call(`${workspacePrefix}/unpark`, "POST", {})).status).toBe(200);
    expect(registry.get(createdWorkspace.id)?.parked).toBe(false);
    expect((await (await call("/workspaces")).json()).workspaces).toHaveLength(1);
    expect((await call(`${workspacePrefix}/delete`, "POST", {})).status).toBe(200);
    await Bun.sleep(10);
    expect(registry.get(createdWorkspace.id)).toBeUndefined();
  } finally {
    workspaceModules.splice(0, workspaceModules.length, ...modules);
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous;
  }
}));


test("LAN-style HTTPS binding requires a trusted certificate and token", () => fixture(async ({ directory, store, auditPath, issued }) => {
  const cert = join(directory, "cert.pem"), key = join(directory, "key.pem");
  const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdout: "pipe", stderr: "pipe" });
  expect(generated.exitCode).toBe(0);
  const port = freeAdminPort();
  await store.setBindings([{ host: "0.0.0.0", port, tls: { cert, key } }]);
  const servers = await startAdminBindings({ store, auditPath, app: { fetch: async () => Response.json({ workspaces: [] }) } });
  try {
    const url = `https://127.0.0.1:${port}/workspaces`;
    const tls = { ca: await readFile(cert, "utf8") };
    expect((await fetch(url, { tls })).status).toBe(401);
    expect((await fetch(url, { tls, headers: { authorization: `Bearer ${issued.secret}` } })).status).toBe(200);
  } finally { for (const server of servers) server.stop(true); }
}));

test("TLS listener setup failure rolls back already-started bindings", () => fixture(async ({ directory, store, auditPath }) => {
  const port = freeAdminPort();
  await store.setBindings([{ host: "127.0.0.1", port }, { host: "0.0.0.0", port: freeAdminPort([port]), tls: { cert: join(directory, "missing-cert"), key: join(directory, "missing-key") } }]);
  await expect(startAdminBindings({ store, auditPath, app: { fetch: async () => Response.json({}) } })).rejects.toThrow();
  const replacement = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({}) });
  replacement.stop(true);
}));

describe("transactional admin bootstrap",()=>{
 test("commits listener and token together, hashes only and preserves existing tokens",()=>fixture(async({store,directory})=>{
  const delivered:string[]=[];
  const result=await store.bootstrap({bindings:[{host:"127.0.0.1",port:3443}],token:{name:"bootstrap",scopes:["host:read"]}},async issued=>{delivered.push(issued.secret);return async()=>{};});
  expect(result.restartRequired).toBe(true);expect((await store.read()).tokens).toHaveLength(2);
  expect(await store.authenticate("Bearer "+delivered[0])).toMatchObject({name:"bootstrap"});expect(await readFile(join(directory,"admin-bindings.json"),"utf8")).not.toContain(delivered[0]!);
 }));
 test("invalid binding or failed delivery leaves configuration and tokens unchanged",()=>fixture(async({store})=>{
  const before=await store.read();
  await expect(store.bootstrap({bindings:[{host:"0.0.0.0",port:3443}],token:{name:"bad",scopes:["host:read"]}},async()=>{throw Error("must not deliver");})).rejects.toThrow("TLS");
  await expect(store.bootstrap({bindings:[{host:"127.0.0.1",port:3443}],token:{name:"bad",scopes:["host:read"]}},async()=>{throw Error("delivery failed");})).rejects.toThrow("delivery failed");
  expect(await store.read()).toEqual(before);
 }));
 test("CLI refuses existing token output and creates private new output",()=>fixture(async({store,directory})=>{
  const input=join(directory,"bootstrap.json"), output=join(directory,"issued.json");
  await writeFile(input,JSON.stringify({bindings:[{host:"127.0.0.1",port:3443}],token:{name:"cli",scopes:["host:read"]}}));
  await adminBindingsCommand(["bootstrap","--data-dir",directory,"--file",input,"--token-output",output]);
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  const before=await store.read();await expect(adminBindingsCommand(["bootstrap","--data-dir",directory,"--file",input,"--token-output",output])).rejects.toThrow();expect(await store.read()).toEqual(before);
 }));
});

test("resource inspection and allocation changes require security scope; property HTML is never an admin route", () => fixture(async ({store,handler,request}) => {
  for(const scope of ["workspaces","host:read","configuration"] as const){const token=await store.issue({name:scope,scopes:[scope]});expect((await handler(request("/workspaces/fixture/resources","GET",undefined,`Bearer ${token.secret}`))).status).toBe(403);}
  const token=await store.issue({name:"resource operator",scopes:["security"]});
  expect((await handler(request("/workspaces/fixture/resources","GET",undefined,`Bearer ${token.secret}`))).status).toBe(200);
  expect((await handler(request("/workspaces/fixture/resources","POST",JSON.stringify({memory:1024**3,additionalSwap:0,cpus:1}),`Bearer ${token.secret}`))).status).toBe(200);
  expect((await handler(request("/workspaces/fixture/resources","POST",JSON.stringify({memory:0,additionalSwap:-1,cpus:1}),`Bearer ${token.secret}`))).status).toBe(400);
  expect((await handler(request("/workspaces/fixture/properties","GET",undefined,`Bearer ${token.secret}`))).status).toBe(404);
}));
