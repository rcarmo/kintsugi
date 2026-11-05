import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addWorkspaceTemplate, saveInstanceCredential } from "@kintsugi/workspace-templates";
import { createCredentialCatalogueTool } from "../../src/server/credential-catalogue.ts";
test("agent catalogue returns only granted metadata and placeholders, never values or other grants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-credential-catalogue-")), previous = process.env.KINTSUGI_DATA_DIR;
  process.env.KINTSUGI_DATA_DIR = directory;
  try {
    const a = (await addWorkspaceTemplate("https://example.com/a.git")).workspaceTemplate;
    const b = (await addWorkspaceTemplate("https://example.com/b.git")).workspaceTemplate;
    const input = { name: "Allowed", envName: "CATALOGUE_TOKEN", description: "Read-only service access", type: "token" as const, hostPattern: "api.example.com", allowInPath: false, enabled: true, templateIds: [a.id], secretValue: "agent-fixture-secret" };
    await saveInstanceCredential(undefined, input);
    await saveInstanceCredential(undefined, { ...input, name: "Foreign credential", envName: "FOREIGN_TOKEN", templateIds: [b.id] });
    const tool = createCredentialCatalogueTool("viewer", async () => ({ type: "project.git", projectId: a.id, name: a.name, gitUrl: a.gitUrl, branch: null, sessionShareKey: a.sessionShareKey }));
    const result = await tool.execute("call", {});
    const rendered = JSON.stringify(result);
    expect(rendered).toContain("KINTSUGI_CREDENTIAL_");
    expect(rendered).toContain("Read-only service access");
    for (const value of ["agent-fixture-secret", "Foreign credential", "encryptedSecret", "templateIds"]) expect(rendered).not.toContain(value);
    expect((await createCredentialCatalogueTool("empty", async () => undefined).execute("call", {})).content).toEqual([{ type: "text", text: '{"credentials":[]}' }]);
  } finally {
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
