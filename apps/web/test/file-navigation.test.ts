import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as browser from "@kintsugi/browser/server";
import * as files from "@kintsugi/files/server";
import * as vscode from "@kintsugi/vscode/server";
import { createTestApp } from "./support/test-web-app.ts";

const listVSCode = spyOn(vscode, "listWorkspaceVSCodeViews");
const openVSCode = spyOn(vscode, "openFileInVSCode");
const openFiles = spyOn(files, "openFileInFiles");
const openBrowser = spyOn(browser, "openFileInBrowser");

afterEach(() => {
  listVSCode.mockReset();
  openVSCode.mockReset();
  openFiles.mockReset();
  openBrowser.mockReset();
});
afterAll(() => {
  listVSCode.mockRestore();
  openVSCode.mockRestore();
  openFiles.mockRestore();
  openBrowser.mockRestore();
});

test("neutral file links prefer the workspace's existing VS Code", async () => {
  listVSCode.mockReturnValue([{ title: "VS Code" }]);
  openVSCode.mockResolvedValue(new Response(null, { status: 204 }));
  const { app } = createTestApp();
  const response = await app.fetch(new Request("http://localhost/workspaces/navigation/file/open?path=src/example.ts&line=42&column=3"));
  expect(response.status).toBe(204);
  expect(listVSCode).toHaveBeenCalledWith("navigation");
  expect(openVSCode).toHaveBeenCalledWith("navigation", "VS Code", { path: "/work/src/example.ts", line: 42, column: 3 }, expect.any(Function));
  expect(openFiles).not.toHaveBeenCalled();
});

test("neutral file links use Files when no VS Code is open", async () => {
  listVSCode.mockReturnValue([]);
  openFiles.mockResolvedValue(new Response(null, { status: 204 }));
  const { app } = createTestApp();
  const response = await app.fetch(new Request("http://localhost/workspaces/navigation/file/open?path=/tmp/example.ts&line=2"));
  expect(response.status).toBe(204);
  expect(openFiles).toHaveBeenCalledWith("navigation", { path: "/tmp/example.ts", line: 2, column: undefined }, expect.any(Function));
  expect(openVSCode).not.toHaveBeenCalled();
});

test("explicit Files navigation never consults VS Code", async () => {
  listVSCode.mockReturnValue([{ title: "VS Code" }]);
  openFiles.mockResolvedValue(new Response(null, { status: 204 }));
  const { app } = createTestApp();
  const response = await app.fetch(new Request("http://localhost/workspaces/navigation/files-view/open?path=/work/example.ts&filesView=workspace"));
  expect(response.ok).toBe(true);
  expect(listVSCode).not.toHaveBeenCalled();
  expect(openVSCode).not.toHaveBeenCalled();
});

test("neutral navigation rejects missing paths and unsupported methods before choosing an editor", async () => {
  const { app } = createTestApp();
  const missing = await app.fetch(new Request("http://localhost/workspaces/navigation/file/open"));
  expect(missing.status).toBe(400);
  const post = await app.fetch(new Request("http://localhost/workspaces/navigation/file/open?path=/work/example.ts", { method: "POST" }));
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET");
  expect(listVSCode).not.toHaveBeenCalled();
  expect(openFiles).not.toHaveBeenCalled();
  expect(openVSCode).not.toHaveBeenCalled();
});

test("neutral links to HTML files open the page in the Browser", async () => {
  listVSCode.mockReturnValue([{ title: "VS Code" }]);
  openBrowser.mockResolvedValue(new Response(null, { status: 204 }));
  const { app } = createTestApp();
  const response = await app.fetch(new Request("http://localhost/workspaces/navigation/file/open?path=out/Report.HTM"));
  expect(response.status).toBe(204);
  expect(openBrowser).toHaveBeenCalledWith("navigation", "/work/out/Report.HTM", expect.any(Function), undefined);
  expect(openVSCode).not.toHaveBeenCalled();
  expect(openFiles).not.toHaveBeenCalled();
});

test("HTML links keep their anchor in the Browser", async () => {
  listVSCode.mockReturnValue([]);
  openBrowser.mockResolvedValue(new Response(null, { status: 204 }));
  const { app } = createTestApp();
  const response = await app.fetch(new Request("http://localhost/workspaces/navigation/file/open?path=/work/report.html&fragment=results"));
  expect(response.status).toBe(204);
  expect(openBrowser).toHaveBeenCalledWith("navigation", "/work/report.html", expect.any(Function), "results");
});

test("neutral links to a line of an HTML file open its source", async () => {
  listVSCode.mockReturnValue([]);
  openFiles.mockResolvedValue(new Response(null, { status: 204 }));
  const { app } = createTestApp();
  const response = await app.fetch(new Request("http://localhost/workspaces/navigation/file/open?path=/work/index.html&line=12"));
  expect(response.status).toBe(204);
  expect(openFiles).toHaveBeenCalledWith("navigation", { path: "/work/index.html", line: 12, column: undefined }, expect.any(Function));
  expect(openBrowser).not.toHaveBeenCalled();
});
