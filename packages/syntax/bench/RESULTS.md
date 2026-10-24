# Highlighting results — 2026-10-24

Under Bun 1.4.4 on Linux ARM64, three runs passed 50, 49 and 49 of 52 cases.
Failures occurred in the Bash/heredoc path. All 156 cases completed their expected
updates without reaching the watchdog; all streaming replays passed their budgets.
No timing budgets were changed.

Host: Linux 6.6.89-cix, heterogeneous Cortex-A520/A720 CPU, 12 visible CPUs,
a four-core CPU quota and 4 GiB memory limit. Command:

```sh
GOMAXPROCS=2 bun test ./packages/syntax/bench/repro.perf.ts
```

Measurements use source 83d1f67c with the decoded-prefix count correction in
`measure.ts`. Each run starts a new process for every case. No browser or full
test suite ran concurrently. These are workspace measurements; no deployment
or installed-system restart occurred.

## Repeated runs

| Run | Cases passing | Max shared highlight (ms) | Longest streaming replay (ms) | Max Pierre first invocation (ms) |
|---|---:|---:|---:|---:|
| 1 | 50/52 | 19.7 | 245.3 | 22.3 |
| 2 | 49/52 | 22.9 | 238.9 | 19.5 |
| 3 | 49/52 | 10.1 | 242.0 | 22.5 |

- Run 1: `view.js / bash`, `board.js / bash`.
- Run 2: `style.css / bash`, `view.js / bash`, `board.js / bash`.
- Run 3: `view.js / bash`, `board.js / bash`, `constructor.js / bash`.

Cold Bash renders of view.js and board.js exceeded 50 ms in all three runs.
The slowest cold Bash render was 88.4 ms. The second run also exceeded the
20 ms shared-highlight budget for CSS (22.9 ms); the third exceeded the
50 ms cold-render budget for constructor.js (50.8 ms). The Bash path includes
display formatting, so these elapsed durations are not syntax-only measurements.
All full-case second and third invocations stayed below 23.9 ms.

The current Highlights-backed Pierre first invocations stayed below 22.6 ms;
its repeats stayed below 3 ms. The historical roughly 150 ms JavaScript cold
start was not reproduced. The existing 200 ms review/tool-diff cold allowance
is retained until other supported hardware is measured. No allowance was added
for the Bash failures, and this corpus is not fully within its current budgets.

## First invocation / third invocation (ms)

Run 1; [after.json](after.json) contains every sample from this run.

| Fixture | Syntax | Markdown | Write | Read | Bash | Review | Tool diff | Editor |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| style.css | 10.2 / 3.3 | 12.4 / 2.8 | 8.9 / 1.8 | 8.7 / 2.0 | 26.9 / 2.5 | 22.1 / 0.8 | 20.2 / 0.7 | 12.5 / 0.5 |
| view.js | 8.2 / 2.6 | 12.4 / 2.5 | 8.9 / 1.7 | 12.2 / 2.4 | 86.9 / 23.9 | 22.3 / 2.9 | 19.8 / 1.5 | 15.7 / 1.5 |
| board.js | 6.2 / 0.5 | 6.9 / 0.6 | 8.5 / 0.8 | 12.7 / 1.5 | 78.8 / 10.8 | 16.0 / 0.7 | 17.5 / 0.7 | 11.5 / 0.4 |
| constructor.js | 4.9 / 0.5 | 7.2 / 0.7 | 7.9 / 0.7 | 12.3 / 1.5 | 41.2 / 6.5 | 18.9 / 0.5 | 14.8 / 0.4 | 11.9 / 0.4 |
| index.html | 5.4 / 0.7 | 10.9 / 2.0 | 7.7 / 0.8 | 7.8 / 1.1 | 16.0 / 3.5 | 14.8 / 0.4 | 19.2 / 0.4 | 9.2 / 0.2 |

## Complete streaming replays

Run 1. Every decoded-content prefix is rendered, without runtime coalescing.

| Fixture | Path | Chunk UTF-16 units | Total work (ms) | Max update (ms) | Updates |
|---|---|---:|---:|---:|---:|
| style.css | write | 32 | 245.3 | 8.3 | 302 |
| style.css | write | 256 | 47.2 | 5.0 | 38 |
| style.css | write | 2048 | 15.1 | 8.3 | 5 |
| style.css | markdown | 32 | 236.3 | 4.3 | 302 |
| style.css | markdown | 256 | 47.2 | 4.9 | 38 |
| style.css | markdown | 2048 | 17.5 | 11.1 | 5 |
| view.js | write | 32 | 176.6 | 11.5 | 177 |
| view.js | write | 256 | 46.3 | 7.3 | 23 |
| view.js | write | 2048 | 13.8 | 9.7 | 3 |
| view.js | markdown | 32 | 157.1 | 4.8 | 177 |
| view.js | markdown | 256 | 34.8 | 5.1 | 23 |
| view.js | markdown | 2048 | 12.3 | 9.0 | 3 |

The write renderer now receives decoded arguments through `renderToolCard`.
Expected samples therefore count source prefixes, with the final prefix equal
to the complete source. The former serialized-JSON length counted extra escape
characters and could reject a complete replay. A regular regression test checks
this boundary. Partial-JSON parsing is outside this benchmark.

## Historical baseline

[BASELINE.md](BASELINE.md) and [baseline.json](baseline.json) preserve the original
September capture. The previous [results and after measurements](https://github.com/rcarmo/kintsugi/tree/83d1f67c160bc306f734d1cd3e266c306b165f7d/packages/syntax/bench)
used Bun 1.3.14 on an Apple M4 Max under macOS ARM64, before the migration to
Highlights, Pierre's editor renderer and decoded tool arguments. Their timings
cannot isolate a Bun-version effect from hardware and renderer changes.

See [README.md](README.md) for the commands, current implementation and measurement
boundaries. These runs cover the captured fixtures, without a wall-clock guarantee
for arbitrary input or a direct measurement of browser event-loop blocking.
