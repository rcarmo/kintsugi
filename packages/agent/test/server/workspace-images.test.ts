import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("image requests stay on the management connection with strict SVG isolation and no preview redirect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-image-endpoint-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "docker"), '#!/bin/sh\n[ "$1" = exec ] && [ "$2" = kintsugi-fixture ] || exit 2\nshift 2\nexec "$@"\n', { mode: 0o755 });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><script>throw new Error("must not execute")</script><rect width="20" height="20"/></svg>';
    const imagePath = join(directory, "chart #1 & notes.SVG");
    await writeFile(imagePath, svg);
    const script = `
      import { expect, mock } from "bun:test";
      const resolved = [];
      const workspace = await import("@kintsugi/workspace");
      mock.module("@kintsugi/workspace", () => ({ ...workspace,
        resolveWorkspace: async id => { expect(id).toBe("fixture"); resolved.push(id); return id; },
        workspaceContainerName: id => "kintsugi-" + id,
      }));
      const { handleWorkspaceImageRequest } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/workspace-files.ts"))});
      const { workspaceImageUrl } = await import(${JSON.stringify(join(import.meta.dir, "../../../shared/src/file-metadata.ts"))});
      const request = async (path, method = "GET") => {
        const url = new URL(path, "https://management.example");
        return await handleWorkspaceImageRequest(new Request(url, { method }), url);
      };
      for (const extension of ["html", "js", "css", "txt", "constructor", "__proto__"]) {
        const rejected = await request("/workspaces/fixture/images/work/file." + extension);
        expect(rejected.status).toBe(415);
      }
      expect(resolved).toEqual([]);
      expect((await request("/workspaces/fixture/images/work/%ZZ.svg")).status).toBe(400);
      expect((await request("/workspaces/fixture/images/work/%00.svg")).status).toBe(400);
      expect((await request("/workspaces/fixture/images/work/chart.svg", "POST")).status).toBe(405);
      expect(await request("/workspaces/fixture/files/work/file.html")).toBeUndefined();
      const url = workspaceImageUrl("fixture", ${JSON.stringify(imagePath)});
      const response = await request(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe(${JSON.stringify(svg)});
      expect(resolved).toEqual(["fixture"]);
      const download = await request(url + "?download=1");
      expect(download.status).toBe(200);
      expect(download.headers.get("location")).toBeNull();
      expect(download.headers.get("content-disposition")).toStartWith("attachment;");
      await download.body.cancel();
      const missing = await request(workspaceImageUrl("fixture", ${JSON.stringify(join(directory, "missing.svg"))}));
      expect(missing.status).toBe(404);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
