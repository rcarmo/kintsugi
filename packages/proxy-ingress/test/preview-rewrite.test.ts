import { expect, test } from "bun:test";
import { previewContentPolicy, rewritePreviewJavaScript, rewritePreviewCss, rewritePreviewHtml } from "../src/ingress/preview-rewrite.ts";
import { decodeHTMLAttribute } from "entities";
import { escapeHtml } from "@kintsugi/shared";
import { rewritePreviewGlobals } from "../src/preview-globals.ts";
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

test("runtime authorization does not accidentally disable existing unsafe-inline permission", () => {
  const permissive = previewContentPolicy("default-src 'none'; script-src 'self' 'unsafe-inline'; script-src-elem 'unsafe-inline'; connect-src ws://localhost:3000/socket", context, "injected");
  expect(permissive).not.toContain("nonce-injected");
  expect(permissive).toContain("'unsafe-inline'");
  expect(permissive).toContain("https://dynamic.example/~preview-assets/runtime.js");
  expect(permissive).toContain(`connect-src ${prefix.replace("https:", "wss:")}/socket`);
  const restricted = previewContentPolicy("script-src 'unsafe-inline' 'nonce-original'", context, "injected");
  expect(restricted).toContain("'nonce-original' 'nonce-injected'");
});

test("computed and nested import expressions retain native syntax and import options", async () => {
  const { parse } = await import("es-module-lexer/js");
  for (const input of ["import(path)", "import(`./${name}.js`)", "import(import(path))", 'import(path /* comment */, { with: { type: "json" } })']) {
    const output = await rewritePreviewJavaScript(input, { ...context, cookies: "private-session=must-not-appear" });
    expect(output).toContain("__kintsugiPreviewImportSpecifier(");
    expect(output).not.toContain("private-session");
    expect(() => parse(output)).not.toThrow();
    expect(parse(output)[0].length).toBe(parse(input)[0].length);
  }
  expect(await rewritePreviewJavaScript('import(path, { with: { type: "json" } })', context)).toContain('with: { type: "json" }');
});

test("computed import coercion stays after option evaluation and errors remain native promise rejections", async () => {
  const { previewImportSpecifier } = await import("../src/client/preview-imports.ts");
  const output = await rewritePreviewJavaScript("return import(specifier, options())", context);
  const run = new Function("specifier", "options", "__kintsugiPreviewImportSpecifier", output);
  const events: string[] = [];
  const module = await run({ toString() { events.push("coerce"); return "data:text/javascript,export const imported=true"; } }, () => { events.push("options"); return {}; }, previewImportSpecifier);
  expect(events).toEqual(["options", "coerce"]);
  expect(module.imported).toBe(true);
  const rejected = run(Symbol("invalid"), () => ({}), previewImportSpecifier);
  expect(rejected).toBeInstanceOf(Promise);
  await expect(rejected).rejects.toBeInstanceOf(TypeError);
  expect(String(previewImportSpecifier("react", context))).toBe("react");
  expect(String(previewImportSpecifier("./chunk.js", context))).toBe(`${prefix}/src/chunk.js`);
});

test("nested computed imports recognize runtime capability URLs before applying an inner module base", async () => {
  const { previewImportSpecifier } = await import("../src/client/preview-imports.ts");
  const inner = { publicOrigin: "http://localhost:4915", root: "/~preview/inner/", app: "vscode", upstream: "http://localhost:24800/static/workbench.js" };
  const active = { publicOrigin: context.publicOrigin, root: "/~preview/delegated/port-4915/~preview/inner/", app: "vscode", upstream: inner.upstream, aliases: [{ origin: inner.publicOrigin, root: inner.root }] };
  const actual = `${active.root}vscode/static/layout.js`;
  expect(String(previewImportSpecifier(actual, inner, active))).toBe(`${active.publicOrigin}${actual}`);
  expect(String(previewImportSpecifier(`${active.publicOrigin}${actual}`, inner, active))).toBe(`${active.publicOrigin}${actual}`);
  expect(String(previewImportSpecifier("/~preview/inner/vscode/static/layout.js", inner, active))).toBe(`${active.publicOrigin}${actual}`);
  expect(String(previewImportSpecifier("./relative.js", inner, active))).toBe("http://localhost:4915/~preview/inner/vscode/static/relative.js");
});

test("parser-created data scripts translate globals and imports before execution without changing their CSP scheme", async () => {
  const script = 'import x from "/module.js"; window.result=location.pathname;';
  const source = `<html><head></head><body><script type="module" src="data:text/javascript;base64,${Buffer.from(script).toString("base64")}"></script></body></html>`;
  const result = await rewritePreviewHtml(source, { ...context, windowGlobals: true }, "adapter", false);
  let url = "";
  await new HTMLRewriter().on('script[type="module"]', { element(element) { url = decodeHTMLAttribute(element.getAttribute("src")!); } }).transform(new Response(result.html)).text();
  expect(url).toStartWith("data:text/javascript;charset=utf-8,");
  const code = decodeURIComponent(url.slice(url.indexOf(",") + 1));
  expect(code).toContain(`${prefix}/module.js`);
  expect(code).toContain("__kintsugiPreviewGlobals.window.result");
  expect(code).toContain("__kintsugiPreviewGlobals.location.pathname");
});

test("parser-created srcdoc frames route resources and install one opaque runtime at every level", async () => {
  const grandchild = '<html><head></head><body><img src="http://localhost:3000/grandchild.svg"></body></html>';
  const child = `<html><head></head><body><img src="/child.svg"><script>window.path=location.pathname;</script><iframe srcdoc="${escapeHtml(grandchild)}"></iframe></body></html>`;
  const source = `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"></head><body><iframe srcdoc="${escapeHtml(child)}"></iframe></body></html>`;
  const result = await rewritePreviewHtml(source, { ...context, nonce: "adapter", policy: "style-src 'none'", windowGlobals: true }, "adapter", false);
  const documents: string[] = [];
  await new HTMLRewriter().on("iframe", { element(element) { documents.push(decodeHTMLAttribute(element.getAttribute("srcdoc")!)); } }).transform(new Response(result.html)).text();
  expect(documents).toHaveLength(1);
  expect(documents[0]).toContain(`${prefix}/child.svg`);
  expect(documents[0]).toContain("__kintsugiPreviewGlobals.location.pathname");
  let configuration = "", nested = "";
  await new HTMLRewriter().on('meta[name="kintsugi-preview-context"]', { element(element) { configuration = decodeHTMLAttribute(element.getAttribute("content")!); } }).on("iframe", { element(element) { nested = decodeHTMLAttribute(element.getAttribute("srcdoc")!); } }).transform(new Response(documents[0]!)).text();
  expect(JSON.parse(configuration).policy).toContain("style-src 'none'");
  expect(JSON.parse(configuration).policy).toContain("script-src 'none'");
  expect(nested).toContain(`${prefix}/grandchild.svg`);
  const runtimes: string[] = [];
  await new HTMLRewriter().on('script[src]', { element(element) { runtimes.push(decodeHTMLAttribute(element.getAttribute("src")!)); } }).transform(new Response(nested)).text();
  expect(runtimes.map(source => new URL(source, context.publicOrigin).href)).toEqual(["https://dynamic.example/~preview-assets/runtime.js"]);
});

test("srcdoc source translations contribute only their already-authorised hashes to inherited headers", async () => {
  const script = 'window.path=location.pathname;';
  const digest = (source: string) => `'sha256-${new Bun.CryptoHasher("sha256").update(source).digest("base64")}'`;
  const child = `<html><head></head><body><script>${script}</script></body></html>`;
  const result = await rewritePreviewHtml(`<html><head></head><body><iframe srcdoc="${escapeHtml(child)}"></iframe></body></html>`, { ...context, windowGlobals: true }, "adapter", false);
  expect(result.policy.rewrite(`script-src ${digest(script)}`)).toContain(digest(rewritePreviewGlobals(script)));
  expect(result.policy.rewrite("script-src 'none'")).toBe("script-src 'none'");
});

test("already-instrumented nested srcdoc frames compose their context without a second bootstrap", async () => {
  const inner = await rewritePreviewHtml('<html><head></head><body><img src="/image.svg"></body></html>', { ...context, nonce: "inner", windowGlobals: true }, "inner", false);
  const outer = { publicOrigin: "https://outer.example", root: "/~preview/outer/", app: "port-3000", upstream: `${context.publicOrigin}/~preview/capability/port-3000/` };
  const result = await rewritePreviewHtml(`<html><head></head><body><iframe srcdoc="${escapeHtml(inner.html)}"></iframe></body></html>`, outer, "outer", false, true);
  let child = "";
  await new HTMLRewriter().on("iframe", { element(element) { child = decodeHTMLAttribute(element.getAttribute("srcdoc")!); } }).transform(new Response(result.html)).text();
  const runtimes: string[] = [];
  await new HTMLRewriter().on("script[src]", { element(element) { runtimes.push(decodeHTMLAttribute(element.getAttribute("src")!)); } }).transform(new Response(child)).text();
  expect(runtimes).toEqual(["https://outer.example/~preview-assets/runtime.js"]);
  expect(child).toContain("https://outer.example/~preview/outer/port-3000/~preview/capability/port-3000/image.svg");
});
