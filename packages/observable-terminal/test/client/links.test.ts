import { expect, test } from "bun:test";
import { terminalUri, terminalTextLinkAt } from "../../src/client/links.ts";

test("OSC 8 destinations resolve files and web pages and reject other links", () => {
  expect(terminalUri("file:///work/src/a%20b.ts?line=42&column=3")).toEqual({ path: "/work/src/a b.ts", line: 42, column: 3 });
  expect(terminalUri("file://localhost/work/a.ts#L9C2")).toEqual({ path: "/work/a.ts", line: 9, column: 2 });
  expect(terminalUri("file://other-host/work/a.ts")).toBeUndefined();
  expect(terminalUri("kintsugi://file/work/a%20b.html?line=3")).toEqual({ path: "/work/a b.html", line: 3, column: undefined });
  expect(terminalUri("kintsugi://file/work/report.html#results%202")).toEqual({ path: "/work/report.html", line: undefined, column: undefined, fragment: "results%202" });
  expect(terminalUri("kintsugi://commit/abc123")).toBeUndefined();
  expect(terminalUri("https://example.com/a.ts")).toEqual({ url: "https://example.com/a.ts" });
  expect(terminalUri("javascript:alert(1)")).toBeUndefined();
  expect(terminalUri("file:///work/%00bad.ts")).toBeUndefined();
});

test("plain references require a file-shaped path and preserve line and column", () => {
  expect(terminalTextLinkAt("Look at src/example.ts:42:3, then", 13)).toEqual({ path: "src/example.ts", line: 42, column: 3 });
  expect(terminalTextLinkAt("/work/a.ts:7", 7)).toEqual({ path: "/work/a.ts", line: 7, column: undefined });
  expect(terminalTextLinkAt("Open /work/out/report.html#summary.", 8)).toEqual({ path: "/work/out/report.html", line: undefined, column: undefined, fragment: "summary" });
  expect(terminalTextLinkAt("hello world", 2)).toBeUndefined();
});

test("plain web URLs exclude surrounding prose punctuation", () => {
  const text = "Open (https://example.com/a.ts?x=1). Done";
  expect(terminalTextLinkAt(text, 10)).toEqual({ url: "https://example.com/a.ts?x=1" });
  expect(terminalTextLinkAt(text, 34)).toBeUndefined();
  expect(terminalTextLinkAt("Visit http://localhost:3000/", 6)).toEqual({ url: "http://localhost:3000/" });
});
