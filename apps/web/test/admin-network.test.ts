import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKintsugiEventBus, type JsonObject } from "@kintsugi/core";
import { createAdminHandler } from "../src/server/admin/bindings.ts";
import { createAdminStore } from "../src/server/admin/store.ts";
import { createWebApp } from "../src/server/app.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

async function fixture(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const previous = process.env.KINTSUGI_DATA_DIR;
  const context = await setup();
  try { await run(context); }
  finally {
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(context.directory, { recursive: true, force: true });
  }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-admin-network-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  const store = createAdminStore(join(directory, "admin-bindings.json"));
  const issued = await store.issue({ name: "network-admin", scopes: ["security"] });
  const registry = createWorkspaceRegistry();
  registry.add("network-one", "One");
  registry.add("network-two", "Two");
  const app = createWebApp({ registry, workspaceModules: [], events: createKintsugiEventBus(), provisionWorkspace: async () => {}, destroyWorkspace: async () => {}, persistWorkspaceParked: async () => {}, deletionReview: { inspect: async () => ({ status: "clear" }), renderEvidence: () => "" }, logError: () => {} });
  const auditPath = join(directory, "audit.jsonl");
  const handler = createAdminHandler({ store, app, auditPath });
  function call(path: string, method = "GET", body?: JsonObject, token: string | null = issued.secret) {
    const headers = new Headers({ "content-type": "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    return handler(new Request(`http://admin.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  }
  return { directory, auditPath, call, store };
}
const config = { cidrs: ["192.168.10.0/24", "fd12:3456::/64"], dns: ["192.168.10.53"], search: ["home.arpa"] };

test("admin network settings persist CIDR groups and forwarders, with independent off-by-default workspaces", () => fixture(async ({ call, directory, auditPath }) => {
  expect(await (await call("/settings/network")).json()).toEqual({ network: { cidrs: [], dns: [], search: [] } });
  expect((await call("/settings/network", "POST", config)).status).toBe(200);
  expect(await (await call("/settings/network")).json()).toEqual({ network: config });
  expect(JSON.parse(await readFile(join(directory, "network.json"), "utf8"))).toEqual(config);
  const initial = await (await call("/workspaces/network-one/network")).json();
  expect(initial.network.mode).toBe("off");
  expect(initial.network.applied.mode).toBe("off");
  expect(initial.network.restartRequired).toBe(false);
  for (const mode of ["lan", "private"]) {
    const result = await call("/workspaces/network-one/network", "POST", { mode });
    expect(result.status).toBe(200);
    const { network } = await result.json();
    expect(network.mode).toBe(mode);
    expect(network.applied.mode).toBe("off");
    expect(network.restartRequired).toBe(true);
  }
  expect((await (await call("/workspaces/network-two/network")).json()).network.mode).toBe("off");
  expect((await (await call("/workspaces/network-one/network", "POST", { mode: "off" })).json()).network.restartRequired).toBe(false);
  expect((await call("/workspaces/missing/network")).status).toBe(404);
  const audit = await readFile(auditPath, "utf8");
  expect(audit).toContain("/settings/network");
  expect(audit).toContain("/workspaces/{id}/network");
}));

test("all network reads and writes require security scope and reject malformed payloads", () => fixture(async ({ call, store }) => {
  const paths = ["/settings/network", "/workspaces/network-one/network"];
  for (const path of paths) for (const method of ["GET", "POST"]) {
    expect((await call(path, method, method === "POST" ? {} : undefined, null)).status).toBe(401);
    for (const scope of ["configuration", "workspaces", "host:read", "secrets"] as const) {
      const token = await store.issue({ name: scope, scopes: [scope] });
      expect((await call(path, method, method === "POST" ? {} : undefined, token.secret)).status).toBe(403);
    }
  }
  for (const body of [{}, { ...config, extra: true }, { ...config, dns: "192.168.10.53" }, { ...config, cidrs: ["192.168.10.0/33"] }, { ...config, cidrs: ["0.0.0.0/0"] }, { ...config, dns: ["dns.home"] }, { ...config, dns: ["127.0.0.1"] }]) expect((await call("/settings/network", "POST", body)).status).toBe(400);
  const invalidWorkspaceBodies: JsonObject[] = [{}, { mode: "temporary" }, { mode: "lan", runtime: true }, { mode: "lan", cidrs: ["0.0.0.0/0"] }];
  for (const body of invalidWorkspaceBodies) expect((await call("/workspaces/network-one/network", "POST", body)).status).toBe(400);
  // Missing CIDRs cannot grant Local LAN access.
  expect((await call("/workspaces/network-one/network", "POST", { mode: "lan" })).status).toBe(400);
  expect((await (await call("/workspaces/network-one/network")).json()).network.mode).toBe("off");
}));

test("admin OpenAPI exposes exact network mutation schemas, scopes and bearer authentication", () => fixture(async ({ call }) => {
  const document = await (await call("/openapi.json")).json();
  for (const path of ["/settings/network", "/workspaces/{id}/network"]) for (const method of ["get", "post"]) {
    expect(document.paths[path][method].security).toEqual([{ adminToken: [] }]);
    expect(document.paths[path][method]["x-admin-scopes-any-of"]).toEqual(["security"]);
  }
  const global = document.paths["/settings/network"].post.requestBody.content["application/json"].schema;
  expect(global.required).toEqual(["cidrs", "dns", "search"]);
  expect(global.additionalProperties).toBe(false);
  expect(global.properties.dns.maxItems).toBe(3);
  const workspace = document.paths["/workspaces/{id}/network"].post.requestBody.content["application/json"].schema;
  expect(workspace.properties.mode.anyOf.map((option: { const: string }) => option.const)).toEqual(["off", "lan", "private", "hosts"]);
  expect(workspace.additionalProperties).toBe(false);
}));

test("private host lists require security scope and saving them does not enable any workspace", () => fixture(async ({ call, store }) => {
  const path = "/global-workspace-settings/private-network-access";
  expect((await call(path)).status).toBe(200);
  expect(await (await call(path)).json()).toEqual({ privateNetworkAccess: [] });
  for (const method of ["GET", "POST"]) {
    expect((await call(path, method, method === "POST" ? { privateNetworkAccess: [] } : undefined, null)).status).toBe(401);
    for (const scope of ["configuration", "workspaces", "host:read", "secrets"] as const) {
      const token = await store.issue({ name: scope, scopes: [scope] });
      expect((await call(path, method, method === "POST" ? { privateNetworkAccess: [] } : undefined, token.secret)).status).toBe(403);
    }
  }
  const saved = await call(path, "POST", { privateNetworkAccess: ["DB.INTERNAL.:05432", "db.internal:5432", "192.168.1.20:22"] });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ privateNetworkAccess: ["db.internal:5432", "192.168.1.20:22"] });
  const network = await (await call("/workspaces/network-one/network")).json();
  expect(network.network).toMatchObject({ mode: "off", applied: { mode: "off" }, restartRequired: false });
  expect((await (await call("/global-workspace-settings")).json()).globalWorkspaceSettings).not.toHaveProperty("privateNetworkAccess");
  const invalidLists: JsonObject[] = [{}, { privateNetworkAccess: "db.internal:22" }, { privateNetworkAccess: ["*.internal:22"] }, { privateNetworkAccess: ["127.0.0.1:3000"] }, { privateNetworkAccess: [], extra: true }, { privateNetworkAccess: ["db.internal:22\nother.internal:443"] }];
  for (const body of invalidLists) expect((await call(path, "POST", body)).status).toBe(400);
  expect(await (await call(path)).json()).toEqual({ privateNetworkAccess: ["db.internal:5432", "192.168.1.20:22"] });
  const api = await (await call("/openapi.json")).json();
  expect(api.paths[path].post["x-admin-scopes-any-of"]).toEqual(["security"]);
}));

test("template host-list API validates template identity and keeps scopes separate", () => fixture(async ({ call, store }) => {
  const issued = await store.issue({ name: "template-create", scopes: ["configuration", "security"] });
  const created = await call("/workspace-templates", "POST", { gitUrl: "https://example.com/private-host-template.git" }, issued.secret);
  expect(created.status).toBe(200);
  const { workspaceTemplate } = await created.json();
  const path = `/workspace-templates/${workspaceTemplate.id}/private-network-access`;
  expect((await call(path, "POST", { privateNetworkAccess: ["db.internal:5432"] })).status).toBe(200);
  expect(await (await call(path)).json()).toEqual({ privateNetworkAccess: ["db.internal:5432"] });
  expect(await (await call("/global-workspace-settings/private-network-access")).json()).toEqual({ privateNetworkAccess: [] });
  expect((await call("/workspace-templates/missing/private-network-access", "POST", { privateNetworkAccess: ["db.internal:22"] })).status).toBe(404);
  expect((await (await call("/workspace-templates")).json()).workspaceTemplates[0]).not.toHaveProperty("privateNetworkAccess");
}));
