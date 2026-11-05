import { managementOriginRejection } from "@kintsugi/proxy-ingress/server";
import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createKintsugiEventBus, type JsonObject } from "@kintsugi/core";
import { tokenTelemetry } from "@kintsugi/llm/server";
import { createAdminHandler } from "../src/server/admin/bindings.ts";
import { createAdminStore } from "../src/server/admin/store.ts";
import { createWebApp } from "../src/server/app.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";
import { workspaceModules } from "../src/server/workspace-modules.generated.ts";

async function fixture(run: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const previous = process.env.KINTSUGI_DATA_DIR, value = await setup();
  try { await run(value); }
  finally {
    await tokenTelemetry().close();
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(value.directory, { recursive: true, force: true });
  }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-admin-telemetry-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  const store = createAdminStore(join(directory, "admin-bindings.json"));
  const issued = await store.issue({ name: "telemetry-admin", scopes: ["security"] });
  const app = createWebApp({ registry: createWorkspaceRegistry(), workspaceModules: workspaceModules.filter(module => module.id === "llm"), events: createKintsugiEventBus(), provisionWorkspace: async () => {}, destroyWorkspace: async () => {}, persistWorkspaceParked: async () => {}, deletionReview: { inspect: async () => ({ status: "clear" }), renderEvidence: () => "" }, logError: () => {} });
  const auditPath = join(directory, "audit.jsonl");
  const handler = createAdminHandler({ store, app, auditPath });
  function call(path: string, method = "GET", body?: JsonObject, secret: string | null = issued.secret) {
    const headers = new Headers({ "content-type": "application/json" });
    if (secret) headers.set("authorization", `Bearer ${secret}`);
    return handler(new Request(`http://admin.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  }
  return { directory, app, store, call, auditPath };
}
const config = { enabled: false, host: "graphite.example.net", port: 2003, instance: "telemetry-test", intervalMinutes: 15 };

test("telemetry defaults off, saves private settings and does not disclose request content to the audit", () => fixture(async ({ call, directory, auditPath }) => {
  const initial = await (await call("/settings/telemetry")).json();
  expect(initial.config.enabled).toBe(false); expect(initial.config.port).toBe(2003); expect(initial.config.intervalMinutes).toBe(15);
  expect(await Bun.file(join(directory, "telemetry/usage.sqlite")).exists()).toBe(false);
  const saved = await call("/settings/telemetry", "POST", config);
  expect(saved.status).toBe(200); expect((await saved.json()).config).toEqual(config);
  expect(JSON.parse(await readFile(join(directory, "telemetry/config.json"), "utf8"))).toEqual(config);
  expect(await readFile(auditPath, "utf8")).not.toContain(config.host);
  expect((await call("/settings/telemetry/discard", "POST", {})).status).toBe(400);
  expect((await call("/settings/telemetry/discard", "POST", { confirmed: true })).status).toBe(200);
}));

test("telemetry reads, writes, testing and discard require security scope; HTML remains excluded", () => fixture(async ({ call, store }) => {
  for (const [path, method] of [["/settings/telemetry", "GET"], ["/settings/telemetry", "POST"], ["/settings/telemetry/test", "POST"], ["/settings/telemetry/discard", "POST"]]) {
    expect((await call(path!, method, method === "POST" ? {} : undefined, null)).status).toBe(401);
    for (const scope of ["configuration", "workspaces", "host:read", "secrets"] as const) {
      const token = await store.issue({ name: scope, scopes: [scope] });
      expect((await call(path!, method, method === "POST" ? {} : undefined, token.secret)).status).toBe(403);
    }
  }
  expect((await call("/settings/sections/telemetry")).status).toBe(404);
  for (const body of [{}, { ...config, enabled: true, host: "" }, { ...config, host: "server\nmetric 1 1" }, { ...config, extra: true }, { ...config, intervalMinutes: 0 }]) expect((await call("/settings/telemetry", "POST", body)).status).toBe(400);
}));

test("telemetry mutations retain the normal app CSRF boundary", () => fixture(async ({ app }) => {
  const request = (origin: string) => new Request("http://test.local/settings/telemetry", { method: "POST", headers: { "content-type": "application/json", Accept: "application/json", Origin: origin }, body: JSON.stringify(config) });
  expect(managementOriginRejection(request("http://foreign.test"))?.status).toBe(403);
  expect(managementOriginRejection(request("http://test.local"))).toBeUndefined();
  expect((await app.fetch(request("http://test.local"))).status).toBe(200);
}));

test("admin OpenAPI describes the schema, authentication and scopes", () => fixture(async ({ call }) => {
  const document = await (await call("/openapi.json")).json();
  for (const [path, method] of [["/settings/telemetry", "get"], ["/settings/telemetry", "post"], ["/settings/telemetry/test", "post"], ["/settings/telemetry/discard", "post"]]) {
    expect(document.paths[path!][method!].security).toEqual([{ adminToken: [] }]);
    expect(document.paths[path!][method!]["x-admin-scopes-any-of"]).toEqual(["security"]);
  }
  const schema = document.paths["/settings/telemetry"].post.requestBody.content["application/json"].schema;
  expect(schema.required).toEqual(["enabled", "host", "port", "instance", "intervalMinutes"]);
  expect(schema.properties.port.maximum).toBe(65535); expect(schema.additionalProperties).toBe(false);
}));

test("connection testing uses unsaved input but writes no metrics and changes no settings", () => fixture(async ({ call }) => {
  const chunks: string[] = [], server = createServer(socket => socket.on("data", value => chunks.push(value.toString())));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || Value.Check(Type.String(), address)) throw new Error("No TCP fixture port");
  try {
    const before = (await (await call("/settings/telemetry")).json()).config;
    const result = await call("/settings/telemetry/test", "POST", { ...config, host: "127.0.0.1", port: address.port });
    expect(result.status).toBe(200); expect(chunks).toEqual([]);
    expect((await (await call("/settings/telemetry")).json()).config).toEqual(before);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}));
