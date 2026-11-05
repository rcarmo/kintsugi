import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTemplateRoutes } from "../../../apps/web/src/server/workspace-template-routes.ts";
import { addWorkspaceTemplate, getWorkspaceTemplateConfiguration } from "../src/workspace-template.ts";

for (const [path, name] of [["privileged", "privileged"], ["seed-config", "seedConfigEnabled"]] as const) {
  test(`${name} defaults off, accepts explicit booleans and does not mutate on invalid input`, async () => {
    const previous = process.env.KINTSUGI_DATA_DIR;
    const directory = await mkdtemp(join(tmpdir(), "workspace-template-boolean-api-"));
    process.env.KINTSUGI_DATA_DIR = directory;
    try {
      const { workspaceTemplate } = await addWorkspaceTemplate("/tmp/example");
      const routes = createWorkspaceTemplateRoutes({
        referencingWorkspaces: () => [],
        invalidatePresentation: () => {},
        createAgentWorkspace: async () => new Response(),
      });
      const url = new URL(`http://localhost/workspace-templates/${workspaceTemplate.id}/${path}`);
      const request = (value: boolean | string | number | null | Record<string, never> | undefined) => new Request(url, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ [name]: value }),
      });
      expect((await getWorkspaceTemplateConfiguration(workspaceTemplate.id))[name]).toBe(false);
      const response = await routes.handle(request(true), url);
      expect(response!.status).toBe(200);
      expect((await response!.json()).workspaceTemplate[name]).toBe(true);
      for (const invalid of [null, "true", 1, {}, undefined]) {
        await expect(routes.handle(request(invalid), url)).rejects.toThrow(`${name} must be a boolean`);
      }
      expect((await getWorkspaceTemplateConfiguration(workspaceTemplate.id))[name]).toBe(true);
      for (const value of ["yes", "1", "", "TRUE"]) {
        const formRequest = new Request(url, { method: "POST", body: new URLSearchParams({ [name]: value }) });
        expect((await routes.handle(formRequest, url))!.status).toBe(422);
      }
      expect((await getWorkspaceTemplateConfiguration(workspaceTemplate.id))[name]).toBe(true);
      await routes.handle(request(false), url);
      expect((await getWorkspaceTemplateConfiguration(workspaceTemplate.id))[name]).toBe(false);
      for (const value of ["true", "false"]) {
        const formRequest = new Request(url, { method: "POST", body: new URLSearchParams({ [name]: value }) });
        expect((await routes.handle(formRequest, url))!.status).toBe(303);
        expect((await getWorkspaceTemplateConfiguration(workspaceTemplate.id))[name]).toBe(value === "true");
      }
    } finally {
      if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;
      else process.env.KINTSUGI_DATA_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
