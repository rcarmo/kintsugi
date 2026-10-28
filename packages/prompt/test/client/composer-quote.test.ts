import { describe, expect, test } from "bun:test";
import { formatComposerQuote } from "../../src/client/composer-editor.ts";

describe("composer quotes", () => {
  test("quote prose under its source, keeping blank lines inside the quote", () => {
    expect(formatComposerQuote({ source: "From your reply", text: "  First paragraph.\n\nSecond one.  \n", code: false }))
      .toBe("> From your reply:\n> First paragraph.\n>\n> Second one.");
  });

  test("fence code, keeping its indentation and longer backtick runs intact", () => {
    expect(formatComposerQuote({ source: "From the `bash` tool call", text: "\n  if (x) {\n    run(```)\n  }\n", code: true }))
      .toBe("> From the `bash` tool call:\n> ````\n>   if (x) {\n>     run(```)\n>   }\n> ````");
  });
});
