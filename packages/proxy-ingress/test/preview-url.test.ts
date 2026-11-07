import { expect, test } from "bun:test";
import { mapPreviewUrl, type PreviewUrlContext } from "../src/preview-url.ts";

const context: PreviewUrlContext = { publicOrigin: "https://dynamic-tailnet.example", root: "/~preview/unpredictable/", app: "port-3152", upstream: "http://localhost:3152/pages/index.html" };
const prefix = "https://dynamic-tailnet.example/~preview/unpredictable/";

test("preview URL mapping keeps relative, root and local-alias resources on the single public HTTPS authority", () => {
  expect(mapPreviewUrl("../image.png", context)).toBe(`${prefix}port-3152/image.png`);
  expect(mapPreviewUrl("/api?q=1#two", context)).toBe(`${prefix}port-3152/api?q=1#two`);
  expect(mapPreviewUrl("http://127.0.0.1:3152/api", context)).toBe(`${prefix}port-3152/api`);
  expect(mapPreviewUrl("https://dynamic-tailnet.example/admin", context)).toBe(`${prefix}port-3152/admin`);
  expect(mapPreviewUrl("ws://localhost:3152/hmr", context)).toBe(`wss://dynamic-tailnet.example/~preview/unpredictable/port-3152/hmr`);
  expect(mapPreviewUrl("http://localhost:8000/preview", context)).toBe(`${prefix}port-8000/preview`);
  expect(mapPreviewUrl("https://app.localhost:8443/demo", context)).toBe(`${prefix}https~port-8443%40app.localhost/demo`);
  expect(mapPreviewUrl(`${prefix}port-8000/demo`, context)).toBe(`${prefix}port-8000/demo`);
});

test("external origins, non-network URLs and opaque application data are not silently routed elsewhere", () => {
  for (const url of ["https://example.com/app", "data:text/plain,hello", "blob:https://dynamic-tailnet.example/id", "javascript:void(0)", "#section", "", "file://another-machine/file"]) expect(mapPreviewUrl(url, context)).toBe(url);
  expect(mapPreviewUrl("file:///work/notes.html", context)).toBe(`${prefix}file/work/notes.html`);
});

test("nested capabilities compose older HTTP and HTTPS authorities without publishing another port", () => {
  const nested: PreviewUrlContext = { ...context, root: `${context.root}port-4915/~preview/inner/`, app: "vscode", upstream: "http://localhost:24800/", aliases: [{ origin: "http://localhost:4915", root: "/~preview/inner/" }] };
  const root = `${nested.publicOrigin}${nested.root}`;
  for (const origin of ["http://localhost:4915", "https://localhost:4915", nested.publicOrigin]) expect(mapPreviewUrl(`${origin}/~preview/inner/vscode/static/main.js`, nested)).toBe(`${root}vscode/static/main.js`);
  expect(mapPreviewUrl("wss://localhost:4915/~preview/inner/vscode/socket", nested)).toBe(`${root.replace("https:", "wss:")}vscode/socket`);
  expect(mapPreviewUrl("http://localhost:4915/vscode-public-resources/chat.json", nested)).toBe(`${nested.publicOrigin}/vscode-public-resources/chat.json`);
  expect(mapPreviewUrl("https://localhost:4915/~preview-assets/runtime.js", nested)).toBe(`${nested.publicOrigin}/~preview-assets/runtime.js`);
  expect(mapPreviewUrl("https://unrelated.example/~preview/inner/vscode/", nested)).toBe("https://unrelated.example/~preview/inner/vscode/");
});
