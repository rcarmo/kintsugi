import { expect, test } from "bun:test";
import { fileReferencesIn, parseFileReference, parseWorkspaceFileTarget, workspaceFileOpenUrl } from "../src/file-target.ts";

test("file links use the neutral endpoint and retain path and cursor information", () => {
  const url = new URL(workspaceFileOpenUrl("work 1", "/tmp/a b#c%.ts", { line: 42, column: 3 }), "http://localhost");
  expect(url.pathname).toBe("/workspaces/work%201/file/open");
  expect(parseWorkspaceFileTarget(url.searchParams)).toEqual({ path: "/tmp/a b#c%.ts", line: 42, column: 3 });
  expect(url.searchParams.has("filesView")).toBe(false);
});

test("file links carry a page anchor", () => {
  const url = new URL(workspaceFileOpenUrl("workspace", "/work/report.html", { fragment: "results" }), "http://localhost");
  expect(parseWorkspaceFileTarget(url.searchParams)).toEqual({ path: "/work/report.html", fragment: "results" });
  expect([...fileReferencesIn("See out/report.html#key-findings.")]).toEqual([
    { path: "out/report.html", line: undefined, column: undefined, fragment: "key-findings", start: 4, end: 32 },
  ]);
});

test("an explicit Files view uses its own endpoint", () => {
  const url = new URL(workspaceFileOpenUrl("workspace", "/work/example.ts", {}, "other-view"), "http://localhost");
  expect(url.pathname).toBe("/workspaces/workspace/files-view/open");
  expect(url.searchParams.get("filesView")).toBe("other-view");
});

test("link parsing leaves relative paths for the editor operation to resolve", () => {
  expect(parseWorkspaceFileTarget(new URLSearchParams("path=src/example.ts"))).toEqual({ path: "src/example.ts", line: undefined, column: undefined });
});

test("invalid cursor positions are omitted", () => {
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
    const target = parseWorkspaceFileTarget(new URLSearchParams({ path: "/work/example.ts", line: value, column: value }));
    expect(target.line).toBeUndefined();
    expect(target.column).toBeUndefined();
  }
});

test("file references are file-shaped paths with optional positions, in prose or on their own", () => {
  expect([...fileReferencesIn("See src/a.ts:4:2 and (../b.md).")]).toEqual([
    { path: "src/a.ts", line: 4, column: 2, start: 4, end: 16 },
    { path: "../b.md", line: undefined, column: undefined, start: 22, end: 29 },
  ]);
  expect(parseFileReference("docs/todo.md:3")).toMatchObject({ path: "docs/todo.md", line: 3 });
  for (const text of ["see a.ts", "Makefile", "a.ts()", "https://example.com/a.ts"]) expect(parseFileReference(text)).toBeUndefined();
});
