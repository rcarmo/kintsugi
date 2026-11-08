import { expect, test } from "bun:test";
import { rewritePreviewGlobals } from "../src/preview-globals.ts";

test("preview compilation maps global references and assignment targets, not lexical bindings or opaque data", async () => {
  const output = await rewritePreviewGlobals('"use strict"; const label="window.location"; function local(window,location){return window.location+location} location="/next"; ({location}=value); const path=window.location.pathname;');
  expect(output.startsWith('"use strict";')).toBe(true);
  expect(output).toContain('label = "window.location"');
  expect(output).toContain("return window.location + location");
  expect(output).toContain('__kintsugiPreviewGlobals.location = "/next"');
  expect(output).toContain("location: __kintsugiPreviewGlobals.location");
  expect(output).toContain("__kintsugiPreviewGlobals.window.location.pathname");
});

test("preview compilation never resolves or executes imported macros or project plugins", async () => {
  const output = await rewritePreviewGlobals('import {run} from "/does-not-exist/macro.ts" with {type:"macro"}; run();');
  expect(output).toContain('from "/does-not-exist/macro.ts" with { type: "macro" }');
  expect(output).toContain("run();");
});

test("event-handler compilation preserves return and bound event names", async () => {
  const output = await rewritePreviewGlobals('location.href="/next"; return event.defaultPrevented;', true);
  expect(output).toContain('__kintsugiPreviewGlobals.location.href = "/next"');
  expect(output).toContain("return event.defaultPrevented");
});

test("document location references respect document bindings", async () => {
  const output = await rewritePreviewGlobals('document.location.hash="#next"; function local(document){return document.location}');
  expect(output).toContain('__kintsugiPreviewGlobals.location.hash = "#next"');
  expect(output).toContain("return document.location");
});
