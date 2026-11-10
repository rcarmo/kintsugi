import { expect, test } from "bun:test";
import type { JsonValue } from "@earendil-works/chord/json";
import { assertOneShotJson } from "../../src/server/one-shot-limits.ts";

test("one-shot schemas reject regex execution and recursive references on the host", () => {
  const schemas: JsonValue[] = [{ pattern: "(a+)+$" }, { patternProperties: { "(a+)+$": {} } }, { $ref: "#" }, { $dynamicRef: "#" }];
  for (const schema of schemas) expect(() => assertOneShotJson(schema, true)).toThrow("do not support");
  expect(() => assertOneShotJson({ type: "object", properties: { pattern: { type: "string" } }, enum: [{ pattern: "ordinary data" }] }, true)).not.toThrow();
});

test("one-shot schemas and answers have separate size and node limits", () => {
  expect(() => assertOneShotJson({ description: "x".repeat(32768) }, true)).toThrow("characters");
  expect(() => assertOneShotJson("x".repeat(65536), false)).toThrow("characters");
  expect(() => assertOneShotJson(Array.from({ length: 4096 }, () => 0), false)).toThrow("node limit");
  let nested: JsonValue = 0;
  for (let index = 0; index < 34; index++) nested = [nested];
  expect(() => assertOneShotJson(nested, false)).toThrow("nesting");
  expect(() => assertOneShotJson({ count: 3 }, false)).not.toThrow();
});
