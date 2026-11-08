import { expect, test } from "bun:test";
import { rewritePreviewScriptDataUrl } from "../src/preview-script-data.ts";

test("only translates script data URLs, retaining their CSP scheme", () => {
  const rewrite = (source: string) => source.replace("/old", "/new");
  for (const source of ['data:text/javascript,fetch("/old")', `data:application/javascript;base64,${btoa('fetch("/old")')}`, 'data:,fetch("/old")']) {
    const output = rewritePreviewScriptDataUrl(source, rewrite);
    expect(output.startsWith("data:")).toBe(true);
    expect(decodeURIComponent(output.slice(output.indexOf(",") + 1))).toBe('fetch("/new")');
  }
  expect(rewritePreviewScriptDataUrl("https://example.test/old.js", rewrite)).toBe("https://example.test/old.js");
  expect(rewritePreviewScriptDataUrl("data:image/svg+xml,<svg>/old</svg>", rewrite)).toBe("data:image/svg+xml,<svg>/old</svg>");
});

test("decodes UTF-8 and base64 bytes, excludes fragments and retains query text", () => {
  let received = "";
  const rewrite = (source: string) => { received = source; return source + ";"; };
  const source = 'const text="café ☕";fetch("/path?a=1&b=2")';
  const percent = rewritePreviewScriptDataUrl(`data:text/javascript,${encodeURIComponent(source)}#fragment`, rewrite);
  expect(received).toBe(source);
  expect(percent.endsWith("#fragment")).toBe(true);
  expect(rewritePreviewScriptDataUrl(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`, rewrite)).toStartWith("data:text/javascript;charset=utf-8,");
  expect(received).toBe(source);
  rewritePreviewScriptDataUrl('data:text/javascript,fetch("/path?a=1&b=2")', rewrite);
  expect(received).toBe('fetch("/path?a=1&b=2")');
});

test("honours a declared charset and emits translated source as UTF-8", () => {
  let received = "";
  const output = rewritePreviewScriptDataUrl('data:text/javascript;charset=windows-1252,%22caf%E9%22', source => { received = source; return source + ";"; });
  expect(received).toBe('"café"');
  expect(output).toBe(`data:text/javascript;charset=utf-8,${encodeURIComponent('"café";')}`);
});

test("leaves unchanged and malformed non-payload URLs alone", () => {
  expect(rewritePreviewScriptDataUrl("data:text/javascript,unchanged", source => source)).toBe("data:text/javascript,unchanged");
  expect(rewritePreviewScriptDataUrl("data:text/javascript", () => { throw new Error("must not compile"); })).toBe("data:text/javascript");
});
