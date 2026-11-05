import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTemplateRoutes } from "../../../apps/web/src/server/workspace-template-routes.ts";
import { addWorkspaceTemplate, getWorkspaceTemplateConfiguration } from "../src/workspace-template.ts";

test("project preload API updates future creation settings and rejects malformed requests without mutation", async () => {
  const previous = process.env.KINTSUGI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), "workspace-template-preload-api-"));
  process.env.KINTSUGI_DATA_DIR = dir;
  try {
    const { workspaceTemplate } = await addWorkspaceTemplate("/tmp/example");
    const routes = createWorkspaceTemplateRoutes({
      referencingWorkspaces: () => [],
      invalidatePresentation: () => { throw new Error("preload changes must not invalidate existing workspaces"); },
      createAgentWorkspace: async () => new Response(),
    });
    const url = new URL(`http://localhost/workspace-templates/${workspaceTemplate.id}/preload-images`);
    const request = (preloadImages: string | (string | number)[] | null) => new Request(url, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ preloadImages }),
    });
    const response = await routes.handle(request(["postgres:17"]), url);
    expect(response!.status).toBe(200);
    expect((await response!.json()).workspaceTemplate.preloadImages).toEqual(["postgres:17"]);
    for (const invalid of [null, "postgres:17", [42], ["https://registry/image"]]) {
      await expect(routes.handle(request(invalid), url)).rejects.toThrow();
    }
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplate.id)).preloadImages).toEqual(["postgres:17"]);
  } finally {
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
