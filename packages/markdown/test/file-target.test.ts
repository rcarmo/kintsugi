import { expect, test } from "bun:test";
import { kintsugiFileHref, inlineCodeFileReference, workspaceFileImageSrc } from "../src/kintsugi-markdown.ts";

function target(href: string, sourcePath?: string): URL | undefined {
  const resolved = kintsugiFileHref("workspace", href, sourcePath);
  return resolved ? new URL(resolved, "http://localhost") : undefined;
}

test("resolves explicit local file references without filesystem access", () => {
  for (const href of ["/work/image.png", "image.png", "./image.png", "file:///work/image.png", "file://localhost/work/image.png", "kintsugi://file/work/image.png"]) {
    expect(target(href)?.searchParams.get("path")).toBe("/work/image.png");
  }
  expect(target("../image.png", "/work/docs/README.md")?.searchParams.get("path")).toBe("/work/image.png");
  expect(target("/tmp/image.png")?.searchParams.get("path")).toBe("/tmp/image.png");
});

test("decodes filenames and preserves explicit file positions", () => {
  expect(target("/work/a%20b%23c.png")?.searchParams.get("path")).toBe("/work/a b#c.png");
  const resolved = target("kintsugi://file/work/main.ts?line=42&column=3");
  expect(resolved?.searchParams.get("line")).toBe("42");
  expect(resolved?.searchParams.get("column")).toBe("3");
  expect(target("kintsugi://file/work/main.ts?line=no")?.searchParams.has("line")).toBe(false);
});

test("keeps page anchors on file links", () => {
  for (const href of ["docs/report.html#key%20results", "kintsugi://file/work/docs/report.html#key%20results", "file:///work/docs/report.html?v=2#key%20results"]) {
    expect(target(href)?.searchParams.get("fragment")).toBe("key%20results");
  }
  expect(target("/work/report.html")?.searchParams.has("fragment")).toBe(false);
});

test("does not treat external URLs, anchors, or invalid paths as local files", () => {
  for (const href of ["https://example.com/image.png", "javascript:alert(1)", "data:text/html,test", "file://remote/work/image.png", "//example.com/image.png", "#section", "?query=1", "/work/%ZZ.png", "/work/%00.png", "kintsugi://file/work/%00.png"]) {
    expect(target(href)).toBeUndefined();
  }
});

test("resolves workspace image files to proxy URLs independent of image format", () => {
  for (const extension of ["png", "jpg", "gif", "webp", "svg", "avif", "bmp"]) {
    for (const source of [`/work/image.${extension}`, `image.${extension}`, `file:///work/image.${extension}`, `kintsugi://file/work/image.${extension}`]) {
      expect(workspaceFileImageSrc("work 1", source)).toBe(`/workspaces/work%201/files/work/image.${extension}`);
    }
  }
  expect(workspaceFileImageSrc("workspace", "../image.svg", "/work/docs/README.md")).toBe("/workspaces/workspace/files/work/image.svg");
});

test("image proxy paths encode filenames and preserve query strings and SVG fragments", () => {
  for (const source of ["/work/a%20b%23c.svg?v=2#diagram", "file:///work/a%20b%23c.svg?v=2#diagram", "kintsugi://file/work/a%20b%23c.svg?v=2#diagram"]) {
    expect(workspaceFileImageSrc("workspace", source)).toBe("/workspaces/workspace/files/work/a%20b%23c.svg?v=2#diagram");
  }
});

test("image file resolution leaves non-file URLs and invalid paths untouched", () => {
  for (const source of ["https://example.com/image.svg", "http://localhost:4000/image.svg", "//example.com/image.png", "data:image/png;base64,aGVsbG8=", "javascript:alert(1)", "file://remote/work/image.svg", "#diagram", "?v=2", "/work/%ZZ.svg", "/work/%00.svg"]) {
    expect(workspaceFileImageSrc("workspace", source)).toBeUndefined();
  }
});

test("inline code file references resolve beside the document, then from the workspace", () => {
  expect(inlineCodeFileReference("src/main.ts:12:3", "/work/docs/guide.md")).toMatchObject({ candidates: ["/work/docs/src/main.ts", "/work/src/main.ts"], line: 12, column: 3 });
  expect(inlineCodeFileReference("README.md")?.candidates).toEqual(["/work/README.md"]);
  expect(inlineCodeFileReference("/etc/app.conf")?.candidates).toEqual(["/etc/app.conf"]);
  for (const code of ["npm install", "foo()", "--flag", "https://example.com/a.ts", "value", "...", "src/", "a = b.c"]) {
    expect(inlineCodeFileReference(code)).toBeUndefined();
  }
});
