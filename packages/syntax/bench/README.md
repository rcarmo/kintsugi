# Captured highlighting performance regression

Run from the repository root:

```sh
bun run generate:workspace-modules
bun test packages/syntax/test/repro.test.ts
bun test ./packages/syntax/bench/repro.perf.ts
```

The opt-in performance suite checks **20 ms per shared server highlight**,
**50 ms per render**, and **1 second per complete streaming replay**, with a
**10-second external watchdog**. Review and tool-diff first renders retain the
existing **200 ms cold allowance**; their repeats use 50 ms. The Bun 1.4.4
measurements do not justify raising any budget. The current Highlights-backed
Pierre paths fit within 50 ms on the measured Linux ARM64 host; the cold allowance
has not been requalified across supported hardware.

Timing gates are opt-in (`.perf.ts` rather than `.test.ts`) because their results
depend on the machine. See [RESULTS.md](RESULTS.md) for the current measurements
and failures. [BASELINE.md](BASELINE.md) records the original implementation.

Select a smaller case by test name:

```sh
bun test ./packages/syntax/bench/repro.perf.ts -t 'style.css / write'
bun test ./packages/syntax/bench/repro.perf.ts -t 'view.js / syntax'
bun test ./packages/syntax/bench/repro.perf.ts -t 'editor'
```

To inspect one case without a timing assertion, call the child directly. This
command has no external timeout:

```sh
bun packages/syntax/bench/child.ts syntax constructor.js 0
```

## What is exercised

| Path | Production code exercised |
| --- | --- |
| syntax | `highlightCodeHtml`, using Highlights and the design-system syntax palette |
| markdown | Markdown fenced code; `StreamingMarkdownRenderer` for prefix cases |
| write | `renderToolCard` with decoded `path` and `content` arguments |
| read | `renderToolCard` with actual read result text |
| bash | Heredoc detection, display formatting and highlighting via `embeddedBashCommand` |
| review | Pierre `DiffHunksRenderer` with `changesDiffOptions` |
| tool-diff | Pierre `DiffHunksRenderer` with `toolDiffOptions` |
| editor | Pierre `FileRenderer` with `pierreHighlightOptions`, without a DOM |

Every path uses all five captured fixtures. Full cases run three times in a
fresh process: first use and two repeats. Stream cases use CSS and view.js with
32-, 256-, and 2,048-character prefixes, measured in JavaScript UTF-16 units.
Write cases pass decoded content prefixes directly to the actual renderer;
they do not parse partial JSON. Markdown cases split fenced-code contents.
The expected update count is `ceil(source.length / chunkSize)` for both paths.

Every synthetic prefix is rendered, bypassing runtime coalescing. This measures
repeated-prefix cost independently of provider timing. It does not measure
provider JSON decoding, delta arrival rates or end-to-end Agent streaming.
There are no UI, markup or screenshot assertions.

Function spies count calls while executing the real syntax implementation.
The counters cover the shared server highlighter. Pierre uses its own renderer
entrypoints and reports zero shared-server calls; it still performs tokenisation.
Counts describe public highlighter requests and characters submitted, not
internal lexer operations. Both public entrypoints execute their original
implementation; nested calls count once.

## Interpreting output

Each test prints a JSON record with runtime/platform, per-update duration, total
time, maximum update duration, highlighter call count, total characters passed to
the shared highlighter, and maximum single highlight duration. Import/setup is
outside sample timing; lazy initialisation during the first invocation is included.
The three full samples include first use and both repeats, without an unmeasured
warm-up. The current shared Highlights implementation has no result cache;
repeat timings must not be attributed to the historical bounded cache.

The parent process owns the watchdog. A timer inside the highlighting process
cannot interrupt synchronous work. When killed, only completed samples are
reported: totals are lower bounds and exclude the unfinished call. The
10-second watchdog includes process startup and is a harness safety limit,
not a production timeout. These assertions are regression budgets for this
corpus and machine class, without a guarantee for arbitrary input or hardware.

The Bash path includes shell and embedded-language display formatting as well
as syntax highlighting. A render-budget failure can therefore occur while
individual shared highlighter calls remain within budget.

The Pierre cases include awaited rendering and initialisation; elapsed time
does not directly measure browser event-loop blocking. They use the production
Highlights preference and the renderer's default long-line tokenisation limit.
These tests execute under Bun without a browser, workers or browser layout.
