import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addWorkspaceTemplate, saveInstanceCredential, deleteInstanceCredential, listInstanceCredentials, type InstanceCredentialInput, type GitWorkspaceTemplateInitInstruction } from "@kintsugi/workspace-templates";
import { createWorkspaceSecretContext, getWorkspaceSecretContext, forgetWorkspaceSecretContext } from "../../src/secrets/workspace-secrets.ts";
let directory: string, template: string;
const original = process.env.KINTSUGI_DATA_DIR;
const values: InstanceCredentialInput = { name: "Test API", envName: "CATALOGUE_TOKEN", type: "token", description: "Fixture", hostPattern: "api.example.com", allowInPath: false, enabled: true, templateIds: [] };
function init(id = template): GitWorkspaceTemplateInitInstruction { return { type: "project.git", projectId: id, name: "Test", gitUrl: "https://example.com/repo.git", branch: null, sessionShareKey: "Test" }; }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "credential-proxy-")); process.env.KINTSUGI_DATA_DIR = directory;
  template = (await addWorkspaceTemplate("https://example.com/repo.git")).workspaceTemplate.id;
});
afterEach(async () => {
  forgetWorkspaceSecretContext("credential-proxy"); forgetWorkspaceSecretContext("credential-empty");
  if (original === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = original;
  await rm(directory, { recursive: true, force: true });
});
test("only explicitly granted workspaces receive opaque placeholders; HTTPS origins remain exact", async () => {
  await saveInstanceCredential(undefined, { ...values, templateIds: [template], secretValue: "proxy-fixture-secret" });
  const c = await createWorkspaceSecretContext("credential-proxy", init());
  const placeholder = c.env.CATALOGUE_TOKEN!;
  expect(placeholder).toStartWith("KINTSUGI_CREDENTIAL_");
  expect(JSON.stringify({ env: c.env, metadata: c.secrets })).not.toContain("proxy-fixture-secret");
  expect((await createWorkspaceSecretContext("credential-empty")).env.CATALOGUE_TOKEN).toBeUndefined();
  for (const url of ["http://api.example.com", "https://api.example.com:8443", "https://other.example.com"]) await expect(c.hooks.onRequest(new Request(url, { headers: { authorization: `Bearer ${placeholder}` } }))).rejects.toThrow();
  const request = await c.hooks.onRequest(new Request("https://api.example.com/test", { headers: { authorization: `Bearer ${placeholder}` } }));
  expect(request.headers.get("authorization")).toBe("Bearer proxy-fixture-secret");
  expect(c.hooks.scrubResponseHeader("proxy-fixture-secret", request)).not.toContain("proxy-fixture-secret");
  expect((await listInstanceCredentials()).credentials[0]?.lastUsedAt).toBeTruthy();
  expect(await c.hooks.isIpAllowed!({ hostname: "api.example.com", ip: "192.168.1.4", family: 4, port: 443, protocol: "https" })).toBe(false);
});
test("cached hooks resolve rotated values but cannot reuse revoked or deleted grants", async () => {
  const credential = await saveInstanceCredential(undefined, { ...values, templateIds: [template], secretValue: "old-fixture" });
  const c = await createWorkspaceSecretContext("credential-proxy", init());
  const request = () => new Request("https://api.example.com", { headers: { authorization: c.env.CATALOGUE_TOKEN! } });
  await saveInstanceCredential(credential.id, { ...values, templateIds: [template], secretValue: "new-fixture" });
  expect((await c.hooks.onRequest(request())).headers.get("authorization")).toBe("new-fixture");
  await saveInstanceCredential(credential.id, { ...values, templateIds: [] });
  await expect(c.hooks.onRequest(request())).rejects.toThrow("changed");
  expect((await getWorkspaceSecretContext("credential-proxy", async () => init())).env.CATALOGUE_TOKEN).toBeUndefined();
  await deleteInstanceCredential(credential.id);
  await expect(c.hooks.onRequest(request())).rejects.toThrow("not found");
});
test("query substitution stays prohibited and URL paths require separate explicit permission", async () => {
  const credential = await saveInstanceCredential(undefined, { ...values, templateIds: [template], secretValue: "path-fixture" });
  const c = await createWorkspaceSecretContext("credential-proxy", init());
  const placeholder = c.env.CATALOGUE_TOKEN!;
  const request = await c.hooks.onRequest(new Request(`https://api.example.com/${placeholder}?token=${placeholder}`));
  expect(request.url).not.toContain("path-fixture");
  await saveInstanceCredential(credential.id, { ...values, templateIds: [template], allowInPath: true, secretValue: "path-fixture" });
  const changed = await getWorkspaceSecretContext("credential-proxy", async () => init());
  const permitted = await changed.hooks.onRequest(new Request(`https://api.example.com/${placeholder}?token=${placeholder}`));
  expect(new URL(permitted.url).pathname).toBe("/path-fixture");
  expect(new URL(permitted.url).searchParams.get("token")).toBe(placeholder);
  await expect(c.hooks.onRequest(new Request("https://api.example.com", { headers: { authorization: placeholder } }))).rejects.toThrow("changed");
});
