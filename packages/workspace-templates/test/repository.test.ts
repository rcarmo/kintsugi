import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { setWorkspaceTemplateSeedConfigEnabled, addWorkspaceTemplate, createWorkspaceTemplateEnvironmentVariable, createWorkspaceTemplateSecret, deleteWorkspaceTemplate, deleteWorkspaceTemplateEnvironmentVariable, getCommitIdentity, getStoredCommitIdentity, createWorkspaceTemplateSshKey, deriveWorkspaceTemplateSshPublicKey, listWorkspaceTemplates, parseWorkspaceTemplateSpec, revealWorkspaceTemplateSecrets, revealWorkspaceTemplateSshKeys, renameWorkspaceTemplateSshKey, setCommitIdentity, updateWorkspaceTemplate, updateWorkspaceTemplateEnvironmentVariable, updateWorkspaceTemplateSecret, getConfiguration } from "@kintsugi/workspace-templates";
import { commitIdentitySettingsFile, hasCommitIdentity } from "../src/commit-identity.ts";

describe("Workspace templates", () => {
  test("parseWorkspaceTemplateSpec supports an optional #branch suffix", () => {
    expect(parseWorkspaceTemplateSpec("https://github.com/org/repo.git#main")).toEqual({ gitUrl: "https://github.com/org/repo.git", branch: "main" });
    expect(parseWorkspaceTemplateSpec("git@github.com:org/repo.git")).toEqual({ gitUrl: "git@github.com:org/repo.git", branch: null });
    expect(parseWorkspaceTemplateSpec("github.com/octocat/Hello-World")).toEqual({ gitUrl: "https://github.com/octocat/Hello-World", branch: null });
    expect(parseWorkspaceTemplateSpec("github.com/octocat/Hello-World#main")).toEqual({ gitUrl: "https://github.com/octocat/Hello-World", branch: "main" });
  });

  test("rejects malformed persisted Workspace templates", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kintsugi-projects-")), "projects.json");
    await writeFile(file, JSON.stringify({ projects: [{ id: 42 }] }));

    expect(listWorkspaceTemplates(file)).rejects.toThrow();
  });

  test("addWorkspaceTemplate records a remote URL without cloning it", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kintsugi-projects-")), "projects.json");

    const result = await addWorkspaceTemplate("https://github.com/org/repo.git#feature", file);
    expect(result.workspaceTemplate.name).toBe("repo");
    expect(result.workspaceTemplate.gitUrl).toBe("https://github.com/org/repo.git");
    expect(result.workspaceTemplate.branch).toBe("feature");

    expect(await listWorkspaceTemplates(file)).toEqual({ workspaceTemplates: [result.workspaceTemplate] });
  });

  test("addWorkspaceTemplate accepts a GitHub URL without a scheme and matches its HTTPS equivalent", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kintsugi-projects-")), "projects.json");
    const workspaceTemplate = (await addWorkspaceTemplate("github.com/octocat/Hello-World", file)).workspaceTemplate;
    expect(workspaceTemplate.gitUrl).toBe("https://github.com/octocat/Hello-World");
    expect(addWorkspaceTemplate("https://github.com/octocat/Hello-World", file)).rejects.toThrow("template already exists");
  });

  test("addWorkspaceTemplate includes the branch in the name only for an existing repository", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kintsugi-projects-")), "projects.json");
    const first = (await addWorkspaceTemplate("https://github.com/org/repo.git#main", file)).workspaceTemplate;
    const second = (await addWorkspaceTemplate("https://github.com/org/repo.git#feature/search", file)).workspaceTemplate;
    const defaultBranch = (await addWorkspaceTemplate("https://github.com/org/repo.git", file)).workspaceTemplate;
    const otherRepo = (await addWorkspaceTemplate("https://github.com/other/repo.git#feature/search", file)).workspaceTemplate;

    expect(first.name).toBe("repo");
    expect(second.name).toBe("repo (feature/search)");
    expect(defaultBranch.name).toBe("repo (default branch)");
    expect(otherRepo.name).toBe("repo");
    expect(second.sessionShareKey).toBe(first.sessionShareKey);
    expect((await listWorkspaceTemplates(file)).workspaceTemplates).toEqual(expect.arrayContaining([first, second, defaultBranch, otherRepo]));
    expect(addWorkspaceTemplate("https://github.com/org/repo.git#feature/search", file)).rejects.toThrow("template already exists");
  });

  test("updateProject edits project fields without changing id", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kintsugi-projects-")), "projects.json");
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/repo.git", file)).workspaceTemplate;

    const result = await updateWorkspaceTemplate(workspaceTemplate.id, { name: "Renamed", spec: "https://github.com/org/renamed.git#main" }, file);

    expect(result.workspaceTemplate).toMatchObject({ id: workspaceTemplate.id, name: "Renamed", gitUrl: "https://github.com/org/renamed.git", branch: "main", sessionShareKey: "Renamed" });
  });

  test("custom swatch colors persist, survive unrelated updates, and can be cleared", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "template-colors-")), "projects.json");
    const template = (await addWorkspaceTemplate("https://github.com/org/colors.git", file)).workspaceTemplate;
    const values = { name: template.name, spec: template.gitUrl };
    expect(template.swatchColor).toBeUndefined();
    await updateWorkspaceTemplate(template.id, { ...values, swatchColor: "#Ab12Cd" }, file);
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.swatchColor).toBe("#ab12cd");
    expect((await updateWorkspaceTemplate(template.id, values, file)).workspaceTemplate.swatchColor).toBe("#ab12cd");
    await expect(updateWorkspaceTemplate(template.id, { ...values, swatchColor: "red" }, file)).rejects.toThrow("six-digit hex color");
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.swatchColor).toBe("#ab12cd");
    await updateWorkspaceTemplate(template.id, { ...values, swatchColor: "" }, file);
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.swatchColor).toBeUndefined();
  });

  test("Workspace template secrets are encrypted at rest and decryptable by the host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kintsugi-workspace-template-secrets-"));
    const file = join(dir, "projects.json");
    const keyFile = join(dir, "workspace-template-secrets.key");
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/secret-project.git", file)).workspaceTemplate;

    const created = await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "API_TOKEN", hostPattern: "api.example.com", placeholder: "sk-test-placeholder", secretValue: "real-secret" }, file, keyFile);
    expect(created.workspaceTemplateId).toBe(workspaceTemplate.id);
    expect(created).not.toHaveProperty("projectId");
    await updateWorkspaceTemplateSecret(workspaceTemplate.id, created.id, { envName: "API_TOKEN", hostPattern: "*.example.com", secretValue: "real-secret" }, file, keyFile);

    const rawStore = await readFile(file, "utf8");
    expect(rawStore).toContain("API_TOKEN");
    expect(rawStore).toContain("sk-test-placeholder");
    expect(rawStore).not.toContain("real-secret");
    expect(JSON.parse(rawStore).projects[0].secrets[0].projectId).toBe(workspaceTemplate.id);
    expect(rawStore).not.toContain("workspaceTemplateId");
    expect(await revealWorkspaceTemplateSecrets(workspaceTemplate.id, file, keyFile)).toMatchObject([{ id: created.id, envName: "API_TOKEN", hostPattern: "*.example.com", placeholder: "sk-test-placeholder", secretValue: "real-secret" }]);

    await updateWorkspaceTemplateSecret(workspaceTemplate.id, created.id, { envName: "API_TOKEN", hostPattern: "*.example.com", placeholder: "", secretValue: "real-secret" }, file, keyFile);
    expect((await revealWorkspaceTemplateSecrets(workspaceTemplate.id, file, keyFile))[0]).not.toHaveProperty("placeholder");
  });

  test("secrets can be saved, annotated, and filled later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kintsugi-secret-requirements-"));
    const file = join(dir, "projects.json");
    const keyFile = join(dir, "key");
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/requirements.git", file)).workspaceTemplate;
    const values = { envName: "API_TOKEN", hostPattern: "api.example.com" };
    const secret = await createWorkspaceTemplateSecret(workspaceTemplate.id, { ...values, annotation: " Integration tests " }, file, keyFile);
    expect(secret).toMatchObject({ annotation: "Integration tests", configured: false });
    expect(await revealWorkspaceTemplateSecrets(workspaceTemplate.id, file, keyFile)).toEqual([]);
    expect(await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, annotation: "Upload reports" }, file, keyFile))
      .toMatchObject({ configured: false, annotation: "Upload reports" });
    expect(await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, secretValue: "real-value" }, file, keyFile))
      .toMatchObject({ configured: true, annotation: "Upload reports" });
    await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, annotation: "", secretValue: "" }, file, keyFile);
    expect((await getConfiguration(workspaceTemplate.id, file)).secrets).toMatchObject([{ annotation: "", configured: true }]);
    expect(await revealWorkspaceTemplateSecrets(workspaceTemplate.id, file, keyFile)).toMatchObject([{ secretValue: "real-value" }]);
    expect(await readFile(file, "utf8")).not.toContain("real-value");
  });

  test("older persisted secrets remain configured with no annotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kintsugi-old-secrets-"));
    const file = join(dir, "projects.json");
    const keyFile = join(dir, "key");
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/old.git", file)).workspaceTemplate;
    await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "TOKEN", hostPattern: "example.com", secretValue: "value" }, file, keyFile);
    const store = JSON.parse(await readFile(file, "utf8"));
    delete store.projects[0].secrets[0].annotation;
    store.projects[0].secrets[0].optional = true;
    await writeFile(file, JSON.stringify(store));
    const [secret] = (await getConfiguration(workspaceTemplate.id, file)).secrets;
    expect(secret).toMatchObject({ annotation: "", configured: true });
    expect(secret).not.toHaveProperty("optional");
  });

  test("Workspace template SSH private keys are encrypted at rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kintsugi-workspace-template-ssh-key-"));
    const file = join(dir, "projects.json");
    const keyFile = join(dir, "workspace-template-secrets.key");
    const workspaceTemplate = (await addWorkspaceTemplate("git@example.com:org/repo.git", file)).workspaceTemplate;
    const privateKeyPath = join(dir, "id_ed25519");
    expect(await Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", privateKeyPath]).exited).toBe(0);
    const privateKey = await readFile(privateKeyPath, "utf8");

    const first = await createWorkspaceTemplateSshKey(workspaceTemplate.id, privateKey, file, keyFile);
    const second = await createWorkspaceTemplateSshKey(workspaceTemplate.id, privateKey, file, keyFile);
    expect(first.workspaceTemplateId).toBe(workspaceTemplate.id);
    expect(first).not.toHaveProperty("projectId");

    expect((await getConfiguration(workspaceTemplate.id, file)).sshKeys).toEqual([first, second]);
    const publicKey = await deriveWorkspaceTemplateSshPublicKey(workspaceTemplate.id, first.id, file, keyFile);
    expect(publicKey).toMatch(/^ssh-ed25519 /);
    expect(await deriveWorkspaceTemplateSshPublicKey(workspaceTemplate.id, second.id, file, keyFile)).toBe(publicKey);
    expect(await renameWorkspaceTemplateSshKey(workspaceTemplate.id, first.id, "  GitHub deploy key  ", file)).toEqual({ ...first, name: "GitHub deploy key" });
    expect((await getConfiguration(workspaceTemplate.id, file)).sshKeys[0]?.name).toBe("GitHub deploy key");
    const oldStore = JSON.parse(await readFile(file, "utf8"));
    expect(oldStore.projects[0].sshKeys[0].projectId).toBe(workspaceTemplate.id);
    delete oldStore.projects[0].sshKeys[1].name;
    oldStore.projects[0].sshKeys[1].publicKey = publicKey;
    oldStore.projects[0].sshKeys[1].fingerprint = "SHA256:legacy";
    await writeFile(file, JSON.stringify(oldStore));
    expect(await deriveWorkspaceTemplateSshPublicKey(workspaceTemplate.id, second.id, file, keyFile)).toBe(publicKey);
    expect((await getConfiguration(workspaceTemplate.id, file)).sshKeys[1]).not.toHaveProperty("publicKey");
    expect((await getConfiguration(workspaceTemplate.id, file)).sshKeys[1]).not.toHaveProperty("fingerprint");
    expect((await getConfiguration(workspaceTemplate.id, file)).sshKeys[1]?.name).toBeUndefined();
    await renameWorkspaceTemplateSshKey(workspaceTemplate.id, second.id, "Legacy key", file);
    expect(await readFile(file, "utf8")).not.toContain('"publicKey"');
    expect(await readFile(file, "utf8")).not.toContain('"fingerprint"');
    expect(await readFile(file, "utf8")).not.toContain("OPENSSH PRIVATE KEY");
    expect(await revealWorkspaceTemplateSshKeys(workspaceTemplate.id, file, keyFile)).toEqual([privateKey, privateKey]);
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]).toEqual({ ...workspaceTemplate, configurationFingerprint: expect.any(String) });
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.configurationFingerprint).toBe(workspaceTemplate.configurationFingerprint);

    const encryptedKeyPath = join(dir, "encrypted-key");
    expect(await Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "password", "-f", encryptedKeyPath]).exited).toBe(0);
    await expect(createWorkspaceTemplateSshKey(workspaceTemplate.id, await readFile(encryptedKeyPath, "utf8"), file, keyFile)).rejects.toThrow("incorrect passphrase");
  });

  test("Workspace template environment variables support empty values", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kintsugi-workspace-template-environment-")), "projects.json");
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/environment-project.git", file)).workspaceTemplate;

    const created = await createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "API_URL", value: "https://api.example.com" }, file);
    expect(created.workspaceTemplateId).toBe(workspaceTemplate.id);
    expect(created).not.toHaveProperty("projectId");
    expect(JSON.parse(await readFile(file, "utf8")).projects[0].environment[0].projectId).toBe(workspaceTemplate.id);
    await createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "EMPTY", value: "" }, file);
    await updateWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, created.id, { name: "SERVICE_URL", value: "https://service.example.com" }, file);

    expect((await getConfiguration(workspaceTemplate.id, file)).environment).toMatchObject([
      { name: "EMPTY", value: "" },
      { name: "SERVICE_URL", value: "https://service.example.com" },
    ]);
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]).toEqual({ ...workspaceTemplate, configurationFingerprint: expect.any(String) });
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.configurationFingerprint).not.toBe(workspaceTemplate.configurationFingerprint);

    await deleteWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, created.id, file);
    expect((await getConfiguration(workspaceTemplate.id, file)).environment).toHaveLength(1);
  });

  test("deleteWorkspaceTemplate removes a Workspace template by id", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kintsugi-projects-")), "projects.json");
    const first = (await addWorkspaceTemplate("https://github.com/org/first.git", file)).workspaceTemplate;
    const second = (await addWorkspaceTemplate("https://github.com/org/second.git", file)).workspaceTemplate;

    expect(await deleteWorkspaceTemplate(first.id, file)).toEqual({ workspaceTemplate: first });

    expect(await listWorkspaceTemplates(file)).toEqual({ workspaceTemplates: [second] });
  });

  test("Settings Commit identity is stored by the workspace-templates module", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kintsugi-workspace-template-settings-")), "project-settings.json");

    expect(await hasCommitIdentity(file)).toBe(false);
    await setCommitIdentity({ name: " Ada Lovelace ", email: " ada@example.com " }, file);

    expect(await hasCommitIdentity(file)).toBe(true);
    expect(await getCommitIdentity(file)).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ gitIdentity: { name: "Ada Lovelace", email: "ada@example.com" } });
  });

  test("Commit identity reads the existing serialized gitIdentity field", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kintsugi-commit-identity-")), "project-settings.json");
    await writeFile(file, JSON.stringify({ gitIdentity: { name: "Grace Hopper", email: "grace@example.com" } }));
    expect(await getStoredCommitIdentity(file)).toEqual({ name: "Grace Hopper", email: "grace@example.com" });
  });

  test("Commit identity adopts the host global git config when Settings has no saved Commit identity", async () => {
    const previousDataDir = process.env.KINTSUGI_DATA_DIR;
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    const dataDir = await mkdtemp(join(tmpdir(), "kintsugi-workspace-template-settings-"));
    const gitConfig = join(await mkdtemp(join(tmpdir(), "kintsugi-git-config-")), ".gitconfig");
    process.env.KINTSUGI_DATA_DIR = dataDir;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    try {
      await writeFile(gitConfig, "[user]\n\tname = Grace Hopper\n\temail = grace@example.com\n", "utf8");

      expect(await getStoredCommitIdentity()).toBeUndefined();
      expect(await getCommitIdentity()).toEqual({ name: "Grace Hopper", email: "grace@example.com" });
      expect(JSON.parse(await readFile(commitIdentitySettingsFile(), "utf8"))).toEqual({ gitIdentity: { name: "Grace Hopper", email: "grace@example.com" } });
    } finally {
      if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
      else process.env.KINTSUGI_DATA_DIR = previousDataDir;
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    }
  });
});

test("seeding permission defaults off for older templates and persists an explicit opt-in", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "kintsugi-seed-permission-")), "projects.json");
  const template = (await addWorkspaceTemplate("https://github.com/org/nested.git", file)).workspaceTemplate;
  expect(template.seedConfigEnabled).toBe(false);
  const original = template.configurationFingerprint;
  const enabled = (await setWorkspaceTemplateSeedConfigEnabled(template.id, true, file)).workspaceTemplate;
  expect(enabled.seedConfigEnabled).toBe(true);
  expect(enabled.configurationFingerprint).not.toBe(original);
  expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.seedConfigEnabled).toBe(true);
  const disabled = (await setWorkspaceTemplateSeedConfigEnabled(template.id, false, file)).workspaceTemplate;
  expect(disabled.seedConfigEnabled).toBe(false);
  expect(disabled.configurationFingerprint).toBe(original);
});
