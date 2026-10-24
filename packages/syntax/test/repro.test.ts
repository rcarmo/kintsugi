import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import manifest from "./fixtures/slay/manifest.json";
import { fixtures, prefixes, source } from "../bench/cases.ts";
import { measure } from "../bench/measure.ts";

describe("Slay highlighting reproducer", () => {
  test("keeps captured bytes and long lines intact", () => {
    for (const name of fixtures) {
      const code = source(name);
      expect(createHash("sha256").update(code).digest("hex"), name).toBe(manifest.files[name].sha256);
      expect(Math.max(...code.split("\n").map((line) => line.length)), name).toBe(manifest.files[name].longestLine);
    }
    expect(source("view.js").trimEnd().endsWith("const waveMat=new")).toBe(true);
  });

  test("replays every synthetic chunk, including the exact final prefix", () => {
    expect([...prefixes("abcdefgh", 3)]).toEqual(["abc", "abcdef", "abcdefgh"]);
    expect([...prefixes("abcdef", 3)]).toEqual(["abc", "abcdef"]);
  });

  test("counts decoded write prefixes rather than the obsolete serialized-JSON length", async () => {
    const code = source("style.css");
    const result = await measure("write", "style.css", 32);
    const expected = [...prefixes(code, 32)].length;
    expect(expected).not.toBe(Math.ceil(JSON.stringify({ path: "style.css", content: code }).length / 32));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.expectedUpdates).toBe(expected);
    expect(result.samples).toHaveLength(expected);
    expect(result.samples.at(-1)!.inputCharacters).toBe(code.length);
  }, 15_000);

  test("measures actual write highlighter invocations", async () => {
    const result = await measure("write", "board.js", 2048);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]!.highlightCalls).toBe(1);
    expect(result.samples[0]!.highlightedCharacters).toBe(source("board.js").length);
  }, 15_000);
});
