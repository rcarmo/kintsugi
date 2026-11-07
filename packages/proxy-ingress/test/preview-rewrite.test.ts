import { expect, test } from "bun:test";
import { previewContentPolicy, rewritePreviewJavaScript, rewritePreviewCss } from "../src/ingress/preview-rewrite.ts";
import { mapPreviewSrcset } from "../src/preview-url.ts";
const context = { publicOrigin: "https://dynamic.example", root: "/~preview/capability/", app: "port-3000", upstream: "http://localhost:3000/src/main.js" };
const prefix = `${context.publicOrigin}${context.root}port-3000`;

test("module rewriting handles static/re-export/dynamic specifiers without changing bare imports or import.meta", async () => {
  const input = `import x from '/root.js'; export * from './nested.js'; const d=import('/dynamic.js'); import 'react'; const m=import.meta.url;`;
  const output = await rewritePreviewJavaScript(input, context);
  expect(output).toContain(`import x from '${prefix}/root.js'`);
  expect(output).toContain(`export * from '${prefix}/src/nested.js'`);
  expect(output).toContain(`import("${prefix}/dynamic.js")`);
  expect(output).toContain("import 'react'"); expect(output).toContain("import.meta.url");
  const escaped = await rewritePreviewJavaScript(`import "./it's.js";`, context);
  expect(escaped).toContain("it\\'s.js");
});

test("CSS and srcset resources preserve data URLs and route workspace paths", () => {
  expect(rewritePreviewCss(`@import '/theme.css'; .hero{background:url('../image.png')}`, context)).toBe(`@import "${prefix}/theme.css"; .hero{background:url("${prefix}/image.png")}`);
  expect(mapPreviewSrcset("/small.png 1x, /large.png 2x", context)).toBe(`${prefix}/small.png 1x, ${prefix}/large.png 2x`);
  expect(rewritePreviewCss("url(data:image/png;base64,abc)", context)).toBe("url(data:image/png;base64,abc)");
});

test("CSP translation retains existing restrictions and authorizes only the injected nonce and opaque workers", () => {
  const output = previewContentPolicy("default-src 'none'; script-src 'self' 'nonce-original'; style-src 'self'; connect-src 'self'; form-action 'none'", context, "injected");
  expect(output).toContain("default-src 'none'");
  expect(output).toContain(`script-src https://dynamic.example/~preview/capability/ 'nonce-original' 'nonce-injected' data: blob:`);
  expect(output).toContain("form-action 'none'");
  expect(output).not.toContain("allow-same-origin");
});

test("CSS token rewriting understands escaped URLs, comments and parentheses without touching opaque strings", () => {
  const source = String.raw`@import /* keep */ "/theme.css"; .icon{src:url(http\:\/\/localhost\:3000/font.woff);background:URL("/image(1).png");content:"url(/not-a-resource)"}`;
  const result = rewritePreviewCss(source, context);
  expect(result).toContain(`@import /* keep */ "${prefix}/theme.css"`);
  expect(result).toContain(`src:url("${prefix}/font.woff")`);
  expect(result).toContain(`background:URL("${prefix}/image(1).png")`);
  expect(result).toContain('content:"url(/not-a-resource)"');
  expect(rewritePreviewCss('a{background:url("unterminated\n)}', context)).toBe('a{background:url("unterminated\n)}');
});

test("nested CSP lists retain independent restrictions and compose local resource origins", () => {
  const policy = previewContentPolicy("sandbox allow-scripts, default-src 'none'; connect-src http://localhost:3000/api/; frame-ancestors 'self'; form-action 'none'", context, "nested");
  expect(policy).toContain("sandbox allow-scripts");
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain(`connect-src ${prefix}/api/`);
  expect(policy).toContain("form-action 'none'");
  expect(policy).not.toContain("frame-ancestors");
  expect(policy).not.toContain("allow-same-origin");
});
