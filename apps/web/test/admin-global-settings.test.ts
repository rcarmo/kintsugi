import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKintsugiEventBus, type JsonObject } from "@kintsugi/core";
import { effectiveEnvironment, listWorkspaceTemplates, workspaceInitFromTemplate } from "@kintsugi/workspace-templates";
import { createAdminHandler } from "../src/server/admin/bindings.ts";
import { createAdminStore, adminScopes, type AdminScope } from "../src/server/admin/store.ts";
import { adminRoutes } from "../src/server/admin/routes.ts";
import { createWebApp } from "../src/server/app.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";
import { createWorkspaceSecretContext, forgetWorkspaceSecretContext, getWorkspaceSecretContext } from "../../../packages/proxy-egress/src/secrets/workspace-secrets.ts";

const base = "/global-workspace-settings";
async function fixture(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const previous = process.env.KINTSUGI_DATA_DIR;
  const context = await setup();
  process.env.KINTSUGI_DATA_DIR = context.directory;
  try { await run(context); }
  finally {
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(context.directory, { recursive: true, force: true });
  }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-admin-global-"));
  const store = createAdminStore(join(directory, "admin-bindings.json"));
  const issued = await store.issue({ name: "global-admin-test", scopes: [...adminScopes] });
  process.env.KINTSUGI_DATA_DIR = directory;
  const app = createWebApp({ registry: createWorkspaceRegistry(), workspaceModules: [], events: createKintsugiEventBus(), provisionWorkspace: async () => {}, destroyWorkspace: async () => {}, persistWorkspaceParked: async () => {}, deletionReview: { inspect: async () => ({ status: "clear" }), renderEvidence: () => "" }, logError: () => {} });
  const handler = createAdminHandler({ store, app, auditPath: join(directory, "audit.jsonl") });
  async function call(path: string, method = "GET", body?: JsonObject, token: string | null = issued.secret) {
    const headers = new Headers({ "content-type": "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    return handler(new Request(`http://admin.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  }
  return { directory, store, handler, call };
}

test("global settings JSON CRUD covers environment, secrets, SSH keys and server trust", () => fixture(async ({ directory, call }) => {
  const initial = await call(base);
  expect(initial.status).toBe(200);
  expect((await initial.json()).globalWorkspaceSettings).toEqual({ environment: [], secrets: [], sshKeys: [], sshKnownHosts: "" });
  const variable = await (await call(`${base}/environment`, "POST", { name: "MIGRATION_REGION", value: "first" })).json();
  expect(variable.environmentVariable).not.toHaveProperty("workspaceTemplateId");
  expect((await call(`${base}/environment/${variable.environmentVariable.id}`, "POST", { name: "MIGRATION_REGION", value: "second" })).status).toBe(200);
  expect((await effectiveEnvironment()).MIGRATION_REGION).toBe("second");
  const secret = await (await call(`${base}/secrets`, "POST", { envName: "MIGRATION_TOKEN", hostPattern: "api.example.com", secretValue: "first-fixture-value" })).json();
  expect(secret.secret.configured).toBe(true);
  expect(secret.secret).not.toHaveProperty("workspaceTemplateId");
  const secretPath = `${base}/secrets/${secret.secret.id}`;
  expect((await call(secretPath, "POST", { envName: "MIGRATION_TOKEN", hostPattern: "other.example.com" })).status).toBe(409);
  expect((await call(secretPath, "POST", { envName: "MIGRATION_TOKEN", hostPattern: "api.example.com", secretValue: "second-fixture-value" })).status).toBe(200);

  const keyPath = join(directory, "fixture-key");
  const generated = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", keyPath], { stdout: "pipe", stderr: "pipe" });
  expect(generated.exitCode).toBe(0);
  const privateKey = await readFile(keyPath, "utf8");
  const createdKey = await call(`${base}/ssh-keys`, "POST", { privateKey, name: "Migration key" });
  expect(createdKey.status).toBe(200);
  const { key } = await createdKey.json();
  expect(key).not.toHaveProperty("workspaceTemplateId");
  const publicResponse = await call(`${base}/ssh-keys/${key.id}/public-key`);
  expect(publicResponse.status).toBe(200);
  const { publicKey } = await publicResponse.json();
  expect(publicKey).toStartWith("ssh-ed25519");
  expect((await call(`${base}/ssh-keys/${key.id}`, "POST", { name: "Renamed" })).status).toBe(200);
  const knownHosts = `git.example.com ${publicKey}`;
  expect((await call(`${base}/ssh-known-hosts`, "POST", { knownHosts })).status).toBe(200);
  expect((await (await call(`${base}/ssh-known-hosts`)).json()).knownHosts).toContain("git.example.com");

  const detail = await (await call(base)).json();
  expect(detail.globalWorkspaceSettings.environment[0].value).toBe("second");
  expect(detail.globalWorkspaceSettings.sshKeys[0].name).toBe("Renamed");
  expect(JSON.stringify(detail)).not.toContain(privateKey);
  for (const value of ["first-fixture-value", "second-fixture-value"]) expect(JSON.stringify(detail)).not.toContain(value);
  for (const path of [`${base}/environment/${variable.environmentVariable.id}/delete`, `${secretPath}/delete`, `${base}/ssh-keys/${key.id}/delete`]) expect((await call(path, "POST", {})).status).toBe(200);
  expect((await call(`${base}/ssh-known-hosts`, "POST", { knownHosts: "" })).status).toBe(200);
  expect((await (await call(base)).json()).globalWorkspaceSettings).toEqual({ environment: [], secrets: [], sshKeys: [], sshKnownHosts: "" });
}));

test("shared settings obey scope permissions, strict bodies and deny-by-default exposure", () => fixture(async ({ call, store }) => {
  const tokens = new Map<AdminScope, string>();
  for (const scope of ["configuration", "secrets", "security", "workspaces", "host:read"] as const) tokens.set(scope, (await store.issue({ name: scope, scopes: [scope] })).secret);
  for (const [scope, token] of tokens) {
    expect((await call(base, "GET", undefined, token)).status).toBe(scope === "host:read" ? 403 : 200);
    expect((await call(`${base}/environment`, "POST", { name: `REGION_${scope.replace(/[^A-Za-z]/g, "_").toUpperCase()}`, value: "test" }, token)).status).toBe(scope === "configuration" ? 200 : 403);
    expect((await call(`${base}/secrets`, "POST", { envName: "SCOPED_TOKEN", hostPattern: "api.example.com" }, token)).status).toBe(scope === "secrets" ? 200 : 403);
    expect((await call(`${base}/ssh-known-hosts`, "POST", { knownHosts: "" }, token)).status).toBe(scope === "security" ? 200 : 403);
  }
  for (const route of adminRoutes.filter(route => route.path.startsWith(base))) {
    const response = await call(route.path, route.method, route.method === "GET" ? undefined : {}, null);
    expect(response.status).toBe(401);
  }
  expect((await call(`${base}/environment`, "POST", { name: "EXTRA", value: "test", extra: true })).status).toBe(400);
  expect((await call(`${base}/secrets`, "POST", { envName: "BAD", hostPattern: "api.example.com", allowInPath: "true" })).status).toBe(400);
  expect((await call(`${base}/ssh-known-hosts`, "POST", { knownHosts: "", extra: true })).status).toBe(400);
  for (const suffix of ["/privileged", "/dockerfile", "/preload-images", "/seed-config", "/settings", "/reset"]) expect((await call(`${base}${suffix}`, "POST", {})).status).toBe(404);
  const document = await (await call("/openapi.json")).json();
  expect(document.paths[base].get.security).toEqual([{ adminToken: [] }]);
  expect(document.paths[`${base}/secrets`].post["x-admin-scopes-any-of"]).toEqual(["secrets"]);
  expect(document.paths[`${base}/environment`].post["x-admin-scopes-any-of"]).toEqual(["configuration"]);
  expect(document.paths[`${base}/ssh-keys`].post["x-admin-scopes-any-of"]).toEqual(["security"]);
  expect(document.paths[`${base}/secrets`].post.parameters).toEqual([]); // No UI-only viewTemplate parameter.
}));

test("global API rotation reaches existing empty/template egress while local overrides win", () => fixture(async ({ call }) => {
  const emptyWorkspace = crypto.randomUUID(), templateWorkspace = crypto.randomUUID();
  try {
    const variable = await (await call(`${base}/environment`, "POST", { name: "REGION", value: "global" })).json();
    const { workspaceTemplate } = await (await call("/workspace-templates", "POST", { gitUrl: "https://github.com/example/admin-global-fixture.git" })).json();
    const prefix = `/workspace-templates/${workspaceTemplate.id}`;
    await call(`${prefix}/environment`, "POST", { name: "REGION", value: "local" });
    await call(`${prefix}/secrets`, "POST", { envName: "SHARED_TOKEN", hostPattern: "api.example.com", secretValue: "local-fixture" });
    const summary = (await listWorkspaceTemplates()).workspaceTemplates.find(template => template.id === workspaceTemplate.id)!;
    const init = workspaceInitFromTemplate(summary);
    const before = await createWorkspaceSecretContext(emptyWorkspace);
    expect(before.env.SHARED_TOKEN).toBeUndefined();
    await createWorkspaceSecretContext(templateWorkspace, init);
    const { secret } = await (await call(`${base}/secrets`, "POST", { envName: "SHARED_TOKEN", hostPattern: "api.example.com", secretValue: "global-first" })).json();
    async function outgoing(workspaceId: string) {
      const context = await getWorkspaceSecretContext(workspaceId, async () => workspaceId === templateWorkspace ? init : undefined);
      const request = new Request("https://api.example.com/", { headers: { authorization: "Bearer KINTSUGI_PROXY_READY_SHARED_TOKEN" } });
      return (await context.hooks.onRequest(request)).headers.get("authorization");
    }
    expect(await outgoing(emptyWorkspace)).toBe("Bearer global-first");
    expect(await outgoing(templateWorkspace)).toBe("Bearer local-fixture");
    expect((await call(`${base}/secrets/${secret.id}`, "POST", { envName: "SHARED_TOKEN", hostPattern: "api.example.com", secretValue: "global-second" })).status).toBe(200);
    expect(await outgoing(emptyWorkspace)).toBe("Bearer global-second");
    expect(await outgoing(templateWorkspace)).toBe("Bearer local-fixture");
    expect((await effectiveEnvironment()).REGION).toBe("global");
    expect((await effectiveEnvironment(workspaceTemplate.id)).REGION).toBe("local");
    await call(`${base}/environment/${variable.environmentVariable.id}?viewTemplate=${workspaceTemplate.id}`, "POST", { name: "REGION", value: "updated-global" });
    expect((await effectiveEnvironment()).REGION).toBe("updated-global");
    expect((await effectiveEnvironment(workspaceTemplate.id)).REGION).toBe("local");
    await call(`${base}/secrets/${secret.id}/delete`, "POST", {});
    expect(await outgoing(emptyWorkspace)).toBe("Bearer KINTSUGI_PROXY_READY_SHARED_TOKEN");
    expect(await outgoing(templateWorkspace)).toBe("Bearer local-fixture");
    expect(before.env.SHARED_TOKEN).toBeUndefined(); // Existing process environments are not rewritten.
  } finally {
    forgetWorkspaceSecretContext(emptyWorkspace);
    forgetWorkspaceSecretContext(templateWorkspace);
  }
}));
