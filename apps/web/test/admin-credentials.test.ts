import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKintsugiEventBus, type JsonObject } from "@kintsugi/core";
import { addWorkspaceTemplate } from "@kintsugi/workspace-templates";
import { createAdminStore } from "../src/server/admin/store.ts";
import { createAdminHandler } from "../src/server/admin/bindings.ts";
import { createWebApp } from "../src/server/app.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

// Management protocol tests only; no browser, rendered-markup or UI assertions.
test("instance credentials obey the secrets scope, strict schemas, write-only values and bounded secret-free audit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "admin-credentials-")), previous = process.env.KINTSUGI_DATA_DIR;
  process.env.KINTSUGI_DATA_DIR = directory;
  try {
    const template = (await addWorkspaceTemplate("https://example.com/repo.git")).workspaceTemplate;
    const store = createAdminStore(join(directory, "bindings.json"));
    const secretToken = (await store.issue({ name: "credential-admin", scopes: ["secrets"] })).secret;
    const configToken = (await store.issue({ name: "config-only", scopes: ["configuration"] })).secret;
    const app = createWebApp({ registry: createWorkspaceRegistry(), workspaceModules: [], events: createKintsugiEventBus(), provisionWorkspace: async () => {}, destroyWorkspace: async () => {}, persistWorkspaceParked: async () => {}, deletionReview: { inspect: async () => ({ status: "clear" }), renderEvidence: () => "" }, logError: () => {} });
    const handler = createAdminHandler({ store, app, auditPath: join(directory, "audit.jsonl") });
    async function call(path: string, method = "GET", body?: JsonObject, token = secretToken) {
      return handler(new Request(`http://admin.test${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    }
    const input = { name: "Service", envName: "INSTANCE_TOKEN", description: "Test service", type: "token", hostPattern: "api.example.com", allowInPath: false, enabled: true, templateIds: [template.id], secretValue: "http-test-fixture-not-real" };
    expect((await call("/settings/credentials", "GET", undefined, configToken)).status).toBe(403);
    expect((await call("/settings/credentials", "POST", input, configToken)).status).toBe(403);
    expect((await call("/settings/credentials", "POST", { ...input, reveal: true })).status).toBe(400);
    const created = await call("/settings/credentials", "POST", input);
    expect(created.status).toBe(200);
    const result = await created.json();
    expect(JSON.stringify(result)).not.toContain(input.secretValue);
    expect(result.credential).not.toHaveProperty("encryptedSecret");
    const path = `/settings/credentials/${result.credential.id}`;
    expect((await call(`${path}/reveal`)).status).toBe(404);
    expect((await call(path, "POST", { ...input, enabled: false })).status).toBe(200);
    const list = await (await call("/settings/credentials")).json();
    expect(list.credentials[0].enabled).toBe(false);
    expect(list.audit.map((event: { action: string }) => event.action)).toEqual(["created", "rotated"]);
    expect((await call(`${path}/delete`, "POST", {})).status).toBe(200);
    expect((await (await call("/settings/credentials")).json()).credentials).toEqual([]);
    expect(await readFile(join(directory, "audit.jsonl"), "utf8")).not.toContain(input.secretValue);
    expect(await readFile(join(directory, "projects.json"), "utf8")).not.toContain(input.secretValue);
    const spec = await (await call("/openapi.json")).json();
    expect(spec.paths["/settings/credentials"].post["x-admin-scopes-any-of"]).toEqual(["secrets"]);
    expect(spec.paths["/settings/credentials"].post.requestBody.content["application/json"].schema.properties.secretValue.writeOnly).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
