import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, createWorkspaceTemplateSecret, getConfiguration, workspaceTemplateSecretAllowsPath, updateWorkspaceTemplateSecret } from "../src/index.ts";

test("default path permission requires exact known hosts, never broad wildcards or mixed destinations", () => {
  for (const hostPattern of ["api.telegram.org", " API.Telegram.Org ; api.telegram.org "]) {
    expect(workspaceTemplateSecretAllowsPath({ hostPattern })).toBe(true);
    expect(workspaceTemplateSecretAllowsPath({ hostPattern, allowInPath: false })).toBe(false);
  }
  for (const hostPattern of ["", "github.com", "api.github.com", "telegram.org", "*.telegram.org", "*", "api.telegram.org.evil.test", "api.telegram.org, github.com", "https://api.telegram.org"]) {
    expect(workspaceTemplateSecretAllowsPath({ hostPattern })).toBe(false);
    expect(workspaceTemplateSecretAllowsPath({ hostPattern, allowInPath: true })).toBe(true);
  }
});

test("path overrides persist, omitted updates preserve them, and older files get hostname defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-path-permissions-"));
  const file = join(directory, "projects.json");
  try {
    const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/example/permissions.git", file);
    const values = { envName: "BOT_TOKEN", hostPattern: "api.telegram.org" };
    const secret = await createWorkspaceTemplateSecret(workspaceTemplate.id, values, file);
    expect(secret.allowInPath).toBe(true);
    await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, allowInPath: false }, file);
    await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, annotation: "Keep permission" }, file);
    expect((await getConfiguration(workspaceTemplate.id, file)).secrets[0]?.allowInPath).toBe(false);
    const enabled = await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, allowInPath: true }, file);
    expect(enabled.allowInPath).toBe(true);
    const store = JSON.parse(await readFile(file, "utf8"));
    delete store.projects[0].secrets[0].allowInPath;
    await writeFile(file, JSON.stringify(store));
    expect(workspaceTemplateSecretAllowsPath((await getConfiguration(workspaceTemplate.id, file)).secrets[0]!)).toBe(true);
    await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, hostPattern: "github.com" }, file);
    expect(workspaceTemplateSecretAllowsPath((await getConfiguration(workspaceTemplate.id, file)).secrets[0]!)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured secret routing cannot reuse an unknown value, and failed updates are atomic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-secret-routing-"));
  const file = join(directory, "templates.json"), keyFile = join(directory, "key");
  try {
    const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/example/routing.git", file);
    const original = { envName: "TOKEN", hostPattern: "api.example.com", secretValue: "fixture-only-value" };
    const secret = await createWorkspaceTemplateSecret(workspaceTemplate.id, original, file, keyFile);
    const baseline = await readFile(file, "utf8");
    for (const changed of [
      { envName: "TOKEN", hostPattern: "attacker.example.com" },
      { envName: "RENAMED", hostPattern: "api.example.com" },
      { envName: "TOKEN", hostPattern: "api.example.com", allowInPath: true },
      { envName: "TOKEN", hostPattern: "api.example.com", placeholder: "NEW" },
    ]) {
      await expect(updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, changed, file, keyFile)).rejects.toMatchObject({ code: "workspace_template_secret_routing_changed" });
      expect(await readFile(file, "utf8")).toBe(baseline);
    }
    // Metadata edits and rotation at the same destination do not need to know the old value.
    await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { envName: "TOKEN", hostPattern: "api.example.com", annotation: "Metadata only" }, file, keyFile);
    await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...original, secretValue: "rotated-value" }, file, keyFile);
    const changed = await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...original, hostPattern: "new.example.com", secretValue: "new-destination-value" }, file, keyFile);
    expect(changed.hostPattern).toBe("new.example.com");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
