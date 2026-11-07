import { expect, test } from "bun:test";
import { mapPreviewUrl, mapPreviewScriptUrl, type PreviewUrlContext } from "../src/preview-url.ts";

const context: PreviewUrlContext = { publicOrigin: "https://dynamic.example", root: "/~preview/capability/", app: "port-3152", upstream: "http://localhost:3152/src/main.js", windowGlobals: true };
const prefix = `${context.publicOrigin}${context.root}`;

test("HMR URLs built from the visible hostname stay on HTTPS443 and retain the app's backend transport", () => {
  expect(mapPreviewUrl("wss://dynamic.example:3152/hmr", context)).toBe(`${prefix.replace("https:", "wss:")}port-3152/hmr`);
  expect(mapPreviewUrl("wss://localhost:3152/hmr", context)).toBe(`${prefix.replace("https:", "wss:")}port-3152/hmr`);
  expect(mapPreviewUrl("http://dynamic.example:8000/api", context)).toBe(`${prefix}port-8000/api`);
});

test("only owned window-script URLs carry the compiler marker; worker and external URLs do not", () => {
  expect(mapPreviewScriptUrl("./chunk.js?v=1", context)).toBe(`${prefix}port-3152/src/chunk.js?v=1&__kintsugi_window=1`);
  expect(mapPreviewScriptUrl("./chunk.js", { ...context, windowGlobals: false })).toBe(`${prefix}port-3152/src/chunk.js`);
  expect(mapPreviewScriptUrl("https://external.example/chunk.js", context)).toBe("https://external.example/chunk.js");
  expect(mapPreviewScriptUrl("/~preview-assets/runtime.js", context)).toBe("https://dynamic.example/~preview-assets/runtime.js");
});
