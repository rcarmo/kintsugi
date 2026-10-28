import { expect, test } from "bun:test";
import { listWorkspaceBrowserViews, normalizeBrowserUrl } from "../src/server/state.ts";
import { openFileInBrowser } from "../src/server/web.ts";

test("workspace file URLs are accepted, but not files on another host or other schemes", () => {
  expect(normalizeBrowserUrl("file:///work/out/a b.html")).toBe("file:///work/out/a%20b.html");
  expect(normalizeBrowserUrl("file://server/work/report.html")).toBe("");
  expect(normalizeBrowserUrl("ftp://example.com/report.html")).toBe("");
  expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000/");
});

test("HTML browser targets retain literal filename characters and encoded anchors", async () => {
  const workspaceId = "browser-file-target";
  const path = "/work/100%20 literal\\name #1.html";
  await openFileInBrowser(workspaceId, path, async () => new Response(), "key%20results");
  const target = new URL(listWorkspaceBrowserViews(workspaceId)[0]!.targetUrl!);
  expect(decodeURIComponent(target.pathname)).toBe(path);
  expect(target.hash).toBe("#key%20results");
});
