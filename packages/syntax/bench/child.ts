// Each case runs in its own process: a parent can stop a synchronous regex.
import { spyOn } from "bun:test";
import { performance } from "node:perf_hooks";
import * as realSyntax from "../src/index.ts";
import type { HighlightedCode, HighlightRequest } from "../src/highlight.ts";
import { prefixes, source, type Fixture, type HighlightPath, type Sample } from "./cases.ts";

// SAFETY: Only measure.ts launches this child, with typed fixture/path values.
const [path, fixture, chunkArg] = process.argv.slice(2) as [HighlightPath, Fixture, string];
const realHighlight = realSyntax.highlightCodeHtml;
const realHighlightForPath = realSyntax.highlightCodeHtmlForPath;
let calls = 0;
let characters = 0;
let maxHighlightMs = 0;
let observing = false;
function observe(code: string, operation: () => HighlightedCode): HighlightedCode {
  // Count the public request once if one observed entrypoint calls the other.
  if (observing) return operation();
  const start = performance.now();
  observing = true;
  try {
    const result = operation();
    maxHighlightMs = Math.max(maxHighlightMs, performance.now() - start);
    calls++;
    characters += code.length;
    return result;
  } finally { observing = false; }
}
function highlight(request: HighlightRequest): HighlightedCode {
  return observe(request.code, () => realHighlight(request));
}
// Observe the real implementation without changing production code or checking markup.
spyOn(realSyntax, "highlightCodeHtml").mockImplementation(highlight);
spyOn(realSyntax, "highlightCodeHtmlForPath").mockImplementation((code, path) => observe(code, () => realHighlightForPath(code, path)));

const code = source(fixture);
const language = realSyntax.languageFromPath(fixture)!;
const chunkSize = Number(chunkArg);
const ctx = { workspaceId: "highlight-repro", agentId: "highlight-repro" };
let run: (text: string) => void | Promise<void>;

switch (path) {
  case "syntax": run = (text) => { highlight({ code: text, path: fixture }); }; break;
  case "markdown": {
    const { renderMarkdown, StreamingMarkdownRenderer } = await import("../../markdown/src/index.ts");
    const renderer = new StreamingMarkdownRenderer(ctx.workspaceId);
    run = chunkSize
      ? (text) => { renderer.render(`\`\`\`${language}\n${text}`); }
      : (text) => { renderMarkdown(ctx.workspaceId, `\`\`\`${language}\n${text}\n\`\`\``); };
    break;
  }
  case "write":
  case "read": {
    const { renderToolCard } = await import("../../agent/src/server/render-tool.ts");
    run = path === "write"
      ? (text) => { renderToolCard(ctx, "repro", {
        name: "write", callId: "repro", status: chunkSize ? "streaming" : "running",
        args: { path: fixture, content: text },
      }); }
      : (text) => { renderToolCard(ctx, "repro", {
        name: "read", callId: "repro", status: "ok", args: { path: fixture }, resultText: text,
      }, { live: true }); };
    break;
  }
  case "bash": {
    const { embeddedBashCommand } = await import("../../agent/src/server/embedded-code.ts");
    run = (text) => { embeddedBashCommand(`cat > ${fixture} <<'KINTSUGI_REPRO_EOF'\n${text}\nKINTSUGI_REPRO_EOF`); };
    break;
  }
  case "review":
  case "tool-diff": {
    const { DiffHunksRenderer, parseDiffFromFile } = await import("@pierre/diffs");
    const { changesDiffOptions, toolDiffOptions } = await import("../src/pierre.ts");
    const options = path === "review" ? changesDiffOptions : toolDiffOptions;
    // Use the actual renderer defaults, including its long-line tokenization limit.
    run = async (text) => {
      const renderer = new DiffHunksRenderer(options);
      try {
        await renderer.asyncRender(parseDiffFromFile(null, { name: fixture, contents: text }));
      } finally { renderer.cleanUp(); }
    };
    break;
  }
  case "editor": {
    const { FileRenderer } = await import("@pierre/diffs");
    const { pierreHighlightOptions } = await import("../src/diff-options.ts");
    await import("../src/pierre.ts");
    run = async (text) => {
      const renderer = new FileRenderer(pierreHighlightOptions);
      try {
        await renderer.asyncRender({ name: fixture, contents: text });
      } finally { renderer.cleanUp(); }
    };
    break;
  }
  default: throw new Error(`Unknown highlighting path: ${path}`);
}

console.log(JSON.stringify({ ready: true, bun: Bun.version, path, fixture, chunkSize }));
let step = 0;
for (const text of chunkSize ? prefixes(code, chunkSize) : [code, code, code]) {
  calls = 0; characters = 0; maxHighlightMs = 0;
  const start = performance.now();
  await run(text);
  const sample: Sample = {
    step: ++step, inputCharacters: text.length, elapsedMs: performance.now() - start,
    highlightCalls: calls, highlightedCharacters: characters, maxHighlightMs,
  };
  console.log(JSON.stringify(sample));
}
