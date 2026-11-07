import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("image requests stay on the management connection with strict SVG isolation and no preview redirect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-image-endpoint-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "docker"), '#!/bin/sh\n[ "$1" = exec ] && [ "$2" = kintsugi-fixture ] || exit 2\nshift 2\nexec "$@"\n', { mode: 0o755 });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><script>document.documentElement.setAttribute("data-script-ran", "true")</script><rect width="20" height="20"/></svg>';
    const imagePath = join(directory, "chart #1 & notes.SVG");
    await writeFile(imagePath, svg);
    const videoPath = join(directory, "clip #1.mp4");
    const audioPath = join(directory, "audio.mp3");
    const htmlPath = join(directory, "document.html");
    const prototypePath = join(directory, "document.constructor");
    const linkPath = join(directory, "linked.svg");
    await writeFile(videoPath, "0123456789");
    await writeFile(audioPath, "audio fixture");
    await writeFile(htmlPath, "<script>parent.localStorage.clear()</script>");
    await writeFile(prototypePath, "download fixture");
    await symlink(imagePath, linkPath);
    const script = `
      import { expect, mock, spyOn } from "bun:test";
      const resolved = [];
      const workspace = await import("@kintsugi/workspace");
      mock.module("@kintsugi/workspace", () => ({ ...workspace,
        resolveWorkspace: async id => { expect(id).toBe("fixture"); resolved.push(id); return id; },
        workspaceContainerName: id => "kintsugi-" + id,
      }));
      const { handleWorkspaceResourceRequest } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/workspace-files.ts"))});
      const { workspaceImageUrl, workspaceMediaUrl, workspaceDownloadUrl } = await import(${JSON.stringify(join(import.meta.dir, "../../../shared/src/file-metadata.ts"))});
      const request = async (path, method = "GET", headers = {}) => {
        const url = new URL(path, "https://management.example");
        return await handleWorkspaceResourceRequest(new Request(url, { method, headers }), url);
      };
      for (const extension of ["html", "js", "css", "txt", "constructor", "__proto__"]) {
        const rejected = await request("/workspaces/fixture/images/work/file." + extension);
        expect(rejected.status).toBe(415);
        expect((await request("/workspaces/fixture/media/work/file." + extension)).status).toBe(415);
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
      expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'");
      expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
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
      const linked = await request(workspaceImageUrl("fixture", ${JSON.stringify(linkPath)}));
      expect(linked.status).toBe(200);
      expect(linked.headers.get("content-length")).toBe(String(${JSON.stringify(svg)}.length));
      expect(await linked.text()).toBe(${JSON.stringify(svg)});
      for (const [path, mime] of [[${JSON.stringify(videoPath)}, "video/mp4"], [${JSON.stringify(audioPath)}, "audio/mpeg"]]) {
        const media = await request(workspaceMediaUrl("fixture", path));
        expect(media.status).toBe(200);
        expect(media.headers.get("location")).toBeNull();
        expect(media.headers.get("content-type")).toBe(mime);
        expect(media.headers.get("x-content-type-options")).toBe("nosniff");
        expect(media.headers.get("content-security-policy")).toStartWith("sandbox;");
        expect(media.headers.get("cross-origin-resource-policy")).toBe("same-origin");
        await media.arrayBuffer();
      }
      const mediaUrl = workspaceMediaUrl("fixture", ${JSON.stringify(videoPath)});
      for (const [range, body, contentRange] of [["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=8-", "89", "bytes 8-9/10"]]) {
        const response = await request(mediaUrl, "GET", { range });
        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe(contentRange);
        expect(await response.text()).toBe(body);
      }
      const invalid = await request(mediaUrl, "GET", { range: "bytes=50-" });
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get("content-range")).toBe("bytes */10");
      const spawn = spyOn(Bun, "spawn");
      const head = await request(mediaUrl, "HEAD", { range: "bytes=0-1" });
      expect(head.status).toBe(206);
      expect(head.headers.get("content-length")).toBe("2");
      expect(head.body).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
      spawn.mockRestore();
      for (const path of [${JSON.stringify(htmlPath)}, ${JSON.stringify(prototypePath)}]) {
        const file = await request(workspaceDownloadUrl("fixture", path));
        expect(file.status).toBe(200);
        expect(file.headers.get("location")).toBeNull();
        expect(file.headers.get("content-type")).toBe("application/octet-stream");
        expect(file.headers.get("content-disposition")).toStartWith("attachment;");
        expect(file.headers.get("x-content-type-options")).toBe("nosniff");
        expect(file.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        await file.text();
      }
      expect((await request("/workspaces/fixture/downloads/dev/zero")).status).toBe(404);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
