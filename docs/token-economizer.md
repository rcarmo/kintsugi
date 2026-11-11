# TokenEconomizer: implementation checklist

Port TokenEconomizer to a reusable TypeScript package for pi-durable, then add Kintsugi Settings and status. Build the complete upstream live lifecycle before enabling statistical shortcuts. The standalone stage is a separate reference for optional per-task tool judging; do not substitute its timing or counters for live hooks. Lifecycle parity applies to the selected reference path; the explicit native differences at the end must not be mistaken for upstream behaviour. **This is an implementation plan; no TokenEconomizer runtime has been implemented.** Leave a milestone unchecked until its exit tests pass.

Use [TokenEconomizer `81e32e56bb3c4c1b4c9756b429be91e3960116ca`](https://github.com/microsoft/TokenEconomizer/tree/81e32e56bb3c4c1b4c9756b429be91e3960116ca), checked out at `/work/TokenEconomizer`, and the installed pi-durable/pi-ai **1.5.2** contracts. This replaces the earlier [`cb42207e3e0937f191bf1ca4897a54b07a23a92c`](https://github.com/microsoft/TokenEconomizer/tree/cb42207e3e0937f191bf1ca4897a54b07a23a92c) baseline. The inspected Kintsugi baseline is [`7d0ce3d8ae5bf911248d4650cd9616f8eb3fea01`](https://github.com/rcarmo/kintsugi/tree/7d0ce3d8ae5bf911248d4650cd9616f8eb3fea01).

## Milestone index

Follow this order. M4–M6 share M3 but should still be implemented and tested separately. The source map at the end identifies the upstream files; filenames below are proposed unless linked.

- [x] **M0 — SDK feasibility:** committed nested observations and run-bound steering.
- [x] **M1 — Package and policy:** pure core, public contracts, defaults and fixtures.
- [x] **M2 — Durable state:** observations, sessions, replay and privacy.
- [x] **M3 — Inference and accounting:** isolated jobs, budgets and usage.
- [x] **M4 — Micro-skills:** environment facts, generative distillation and stable snapshots.
- [x] **M5 — Loop guard:** rules, asynchronous judge, writer and redirect budget (default one).
- [x] **M6 — Tool pruning:** evidence, generative judging, masks and restoration.
- [x] **M7 — Classifier guardrails:** labels, splits, action thresholds and test vectors.
- [x] **M8 — Local loop classifier:** bounded features and logistic regression.
- [x] **M9 — Tool prefilter:** BM25 and Bernoulli naive Bayes.
- [x] **M10 — Decision routing and call savers:** text classification, templates, exact reuse, novelty and compaction.
- [ ] **M11 — Kintsugi controls:** implementation/backend gates pass; operator UX acceptance unrecorded.
- [ ] **M12 — Acceptance:** recovery, cache, quality, cost and distribution checks.

### Current implementation evidence

M0–M10 pass their automated implementation gates. Native Kintsugi lifecycle binding, persisted Settings, overrides, status and actions are implemented and backend-tested. M11 still needs operator UX acceptance. M12 still needs authorised real-model checks, actual warm-cache measurements and held-out paired cost/quality evaluation. No production classifier or net inference saving is accepted.

| Gate | Passing evidence |
|---|---|
| Portable core and privacy | `packages/token-economizer/test/`: policy, observations/redaction, lifecycle, all six environment families, detector security, loop rules/turns, pruning and classifier/saver fixtures |
| Public SDK boundary | `token-economizer-sdk.test.ts`: committed nested observations, retirement/reopen recovery and atomic run-bound steering; Stop/answer/reset/later-run rejection |
| Installed coordinator | `token-economizer-controller.test.ts`: 45 nested calls, all four mocked generative paths, Off/Observe, template writer suppression, novelty/compaction/reuse and 40-call SDK generation handovers with one whole-turn redirect budget |
| Native runtime | `token-optimizer-native.test.ts`: memory/SQLite/JSONL receipts and folds; JSONL reopen/raw-close distinction; all four paths through actual SDK transport; provider serialization with zero network calls; visible-branch fork/rewind fact text and IDs; real compaction; reset while an old fold is blocked; running-mask freeze and idle publication |
| Classifier execution | Bounded one-at-a-time fitting, checkpointed gradient chunks, chunked BM25 rebuild, held-out consumption, reviewed invalidation and sticky clear semantics. BM25 indexes only fit-split positives, at most 16 distinct recent tasks per tool and 4,096 documents. Drop acceptance excludes lexical keeps, incomplete/OOV inputs and scores on the fixed keep path |
| Settings/actions | Native backend tests cover master Off → Observe → explicit Active, ancestor veto, model validation, Apply/Restore/Retry/Clear/Review/refit refusals, rendered status and zero model/Agent starts on settings changes |
| Distribution | Public core/durable exports, SDK 1.5.2 peers, import boundaries, Apache licence equality, modified-port notices and a local package tarball with licence/entry points; no publication |

The latest sequential bounded run passed **1,554 tests across 125 files** (0 failures), including existing built-in runtime/assembly, Agent, subagent, codemode, workspace and LLM regressions and Settings/browser-transport app tests. Peak measured subprocess RSS was **293 MiB**. `bun run check` and `git diff --check` pass. The focused pinned upstream run passed **420 tests, 2 skipped**. Re-harvesting all **724 top-level differential cases** preserved every fixture byte. Current native regression receipts: `/tmp/te-live-learning-regression/summary.json` and its `batch-*.log` files. Earlier upstream receipts remain under `/work/token-economizer-audit/`; those runs predate incremental learning.

The isolated preview on port 3118 renders the actual Settings contribution with a synthetic idle SDK session. HTTP/component/backend checks pass; no browser automation/Desktop, operator UX acceptance, paid-provider checks or real cache-hit tests ran. Production settings/runtime, releases, commits and pushes were untouched. Internal optimisation uses the SDK model runtime directly and does not occupy codemode workers. Local fit/prediction figures are elapsed timings; per-thread CPU and production-quality cost comparisons are unmeasured.

The safe detector dialect uses RE2JS and rejects lookarounds, backreferences, oversized patterns and Python Unicode shorthand/boundary forms (`\\w`, `\\d`, `\\s`, `\\b` and complements). Generated proposer guidance describes these restrictions; admission diagnostics are tested.

Release hardening since the first push: Off makes no per-entry writes; workspace open, session start and end read only the newest entry, a backwards search for a carried snapshot, or the session's entry range; a known session skips the context read on reopen. A journal written with the optimizer On reopens and runs on a build without it (tested). Kintsugi imports only the package's `./core` and `./pi-durable` entry points. Settings shows learned facts, tool reasons and nudge history, saved overrides for workspaces that aren't running, and a per-Agent Remove facts action. Optional prompt-time tool picks run before admission while idle, include attachment types and never block a prompt for more than 20 seconds. Subagents are covered as described in M2. When the optimizer is on for an Agent, its composer footer shows a compact status chip (mode, facts in this session, hidden tools, and a dot for waiting suggestions or a nudge this run) that opens that Agent's row in Settings; it is the first footer item to drop on narrow screens.

### Native incremental learning (post-v0.6.0)

Kintsugi also checkpoints facts after a root prompt-run completes. The background job scans only entries after a durable cursor, commits that cursor with its learned state, and coalesces completions while another checkpoint runs. Empty tool-evidence deltas make no learning call. Basic remains model-free. Live model-assisted proposals require at least three evidence-bearing checkpoints (or the configured longer cadence), a ten-minute per-session cooldown, changed digest content, and the existing auth/spend/call gates. Session end retains the original proposer cadence if there has been no live attempt; it cannot bypass the cooldown after an attempt.

This host adaptation differs from the upstream once-per-session fact update. Each fact gets at most one confirmation, contradiction and exercise per logical session; bounded digests merge under that same session ID, and duplicate citations cannot supply grounding. A run is never another independent pruning session. Tool use protects tools immediately; the first eligible checkpoint counts one pruning session, later checkpoints add only new prompts, and final folding reconciles the total without counting the session again. The active session's fact prefix remains frozen. Resumed, previously folded sessions can checkpoint new evidence without another final-fold/session vote; legacy journals conservatively withhold another vote for existing facts.

### Implementation rules

- Deliver all four generative paths: **proposer, loop judge, redirect writer and tool judge**. Local classifiers are selectable alternatives, not substitutes for implementing those paths.
- Keep inference provider-independent. The host resolves models, authentication, transport and prices. Do not hard-code provider names, model IDs or provider-specific parsing.
- Default master Off is the requested Kintsugi opt-in policy; upstream defaults enabled with pruning/guard on. Observe mirrors upstream shadow: compute and record proposed decisions and learning, with no new injection, mask publication, redirect or notice to the main Agent. It does not undo context/rules already applied. Inference in Observe requires explicit consent and a budget.
- Preserve host permissions, protected tools, user Stop and the configured per-run redirect budget (upstream default one). Unknown evidence or an unready classifier must not authorise an action.
- Reuse pi-durable storage, Kintsugi Settings and native codemode. No new CLI, service, environment variables, agent tools, inference framework or codemode worker for internal TE work.
- Keep BM25 and statistics. V1 uses exact bounded signatures and grouping; it does not need approximate hashes, embeddings, trees, a feature store, online weight updates or an automated hyperparameter search.
- Test each checkbox before moving to the next milestone. Record intentional upstream differences in fixtures. Do not hide a missing path behind a passing mock or a "coming later" setting.
- Do not add browser/UI test files. Use backend and serializer tests; manual UX and live-model checks require a suitable authorised environment. Do not launch local browser/Desktop workloads in this constrained workspace.

## M0 — Prove the SDK boundary

**Depends on:** nothing. **Work:** a small test-only extension in `packages/builtin-agent/test/server/`.

- [x] Read the installed SDK's `dist/harness/{types,tool,live,usage}.d.ts` and README. Use public APIs, never raw journal parsing or private codemode documents.
- [x] In one still-running codemode script, observe at least two committed nested results. `ToolTaskResult` contains only `{ kind: "nested" }`; the output is in the caller's `NestedCallDoc`, which retires with its caller.
- [x] Test persistence of a bounded observation before that source retires, including a crash between result commit and receipt creation. Kintsugi's `kintsugi.codemode-call` receipts are a host input; the generic package must not import their Kintsugi type. Define a small optional receipt adapter.
- [x] Bind a redirect to the original prompt-run in one transaction. Check live inputs, run identity and absence of `afterRun` state; call `Conversation.submit` before the transaction's first table write, then commit the deduplication marker. `whenIdle: "reject"` alone is insufficient.
- [x] Reject a late result after answer, Stop, reset or a new run. It records an undelivered decision and cannot start work.

**Exit:** passing nested-observation, crash and stale-steering tests. If public APIs cannot meet this, record the smallest required SDK change and block the dependent path. Do not substitute top-level round handling for nested coverage.

## M1 — Establish the package, policy and fixtures

**Depends on:** M0 for the adapter contract. **Work:** `packages/token-economizer`.

```text
src/core/
  types.ts, config.ts, observations.ts, accounting.ts
  microskills/{envfacts,lifecycle,distiller,render}.ts
  loopguard/{rules,envelope,judge,writer}.ts
  toolprune/{evidence,catalogue,judge}.ts
  classify/{contracts,samples,thresholds,loop-features,logistic,text,bm25,bernoulli}.ts
  savers.ts
src/pi-durable/
  index.ts, documents.ts, observations.ts, lifecycle.ts
  sidecall.ts, steering.ts, catalogue.ts
```

- [x] Export `./core` and `./pi-durable`; initially pin SDK peers to 1.5.2. Core functions accept data and return state/effects. Pass cadence/thresholds as per-scope inputs; do not reproduce Python's process-local module-global rebinding in a shared TS process. No filesystem, network, clock, SDK or Kintsugi imports in core; no Kintsugi imports anywhere in the package.
- [x] Supply `createTokenEconomizer({ harness, domain, policy, sideCall, decisionClassifier, onNotice })`, an installable `extension`, and typed `sessionStarted`, `sessionEnded`, `status`, `proposals`, `apply`, `restore` and `updatePolicy` operations. These are new APIs to implement, not existing SDK functions. Avoid an abstract plugin/stage framework.
- [x] Define host-supplied scope IDs, semantic tool mappings, protected capabilities, catalogue provenance and environment revision. Derive identities from trusted host state, never model arguments. Other pi-durable hosts supply the same contract.
- [x] Give every policy a version. Use the same `off | observe | active` enum throughout code and UI. Install document/task definitions even when disabled so existing work can settle. Gate each live mechanism's own lifecycle: micro-skills Off skips its update/new injection; live tool-pruning Off skips its fold; guard Off skips ordinary prompt/tool/Stop handling. Retain stored state: do not reset a turn, its redirect count or learned facts merely because a switch changed. Session-end still closes any retained turn using the host completion signal, as `session_end` does. Do not copy `ToolingStage.after_task`'s independent per-task/off bookkeeping into the live path.
- [x] Harvest development-only Python fixtures from the pinned source with a fixed clock, IDs and fake model replies. Include live `plugin/` policies as well as core mechanisms. Do not add a Python runtime dependency.
- [x] Record source revision, policy, observations, catalogue, prior state, expected effects/text and accounting in each fixture. Compare exact rendered text/order, semantic state and explicit floating-point tolerances. Include Unicode, shell-tokenisation, regex and sorting differences.

Use these source-mapped defaults; do not copy benchmark defaults instead:

| Mechanism | Required live/reference values |
|---|---|
| Micro-skills | Off; environment-fact block cap 4 facts/about 150 tokens; live cadence 3 with initial `now=0,last_propose=-1`: first attempt after update 2, then every 3 since the last attempt |
| Fact lifecycle | Promote at 3 qualifying confirmations; inject only after at least 4 exercises and firing rate ≥ 0.40; decay 0.8; contradiction weight 5; immediate retirement for a clean high-stakes contradiction |
| Tool evidence | Never-used tools only; `(sessions ≥ 2 && prompts ≥ 10*k) || sessions ≥ 5*k`, where `k=3` for high-risk tools, otherwise 1 |
| Loop rules | Minimum 20 calls, churn 4 or scattered files 3, errors 6, stagnation 0.20; preserve the full conjunction |
| Envelope | p90, margin 1.25, at least 5 ended-green-proxy turns, backstop multiplier 2.5; last 500 accepted turns; update on turn close, not session fold |
| Generative judge | Confidence 0.7; no judgement before envelope warm-up; repeat/dense-error cheap gate; 5-call gap, productive backoff +5 up to 20; pending expiry 300 s |
| Redirect budget | `loopguard_nudges=1` per prompt-turn by default; preserve the validated configurable budget and issue the notice only after that budget is spent |
| Automatic pruning publication | Repository-wide inactivity 60 minutes (configurable down to 0), or pending age 24 hours; waiter polls at most every 600 s |

**Exit:** import-boundary tests, default-policy validation and initial fixture parity pass. Off performs no optimisation inference and makes no request transformation. Thresholds for local classifiers are specified in M7; **0.7 must not be copied to them**.

## M2 — Commit observations and lifecycle state

**Depends on:** M1. **Work:** `core/observations.ts`, `pi-durable/{documents,observations,lifecycle}.ts` and a host mapping in `packages/builtin-agent`.

### State and scope

- [x] Use SDK documents for **knowledge** (repository + environment), **session** (frozen facts/mask and folding cursor), **run** (window/rate/redirect state), **job** (reservation/result/usage), and **classifier artifact** (weights, vocabulary, thresholds and provenance). Store bounded training samples by stable decision ID. Use the Harness store; add no second database.
- [x] Distinguish a **prompt-run** (one admitted input batch through answer/failure/Stop), a **learning session** (the host's logical Agent session spanning several runs, identified by a stable session ID), and the Harness lifetime. Reopen, reload, resume and turn completion do not create a new logical session ID. Pin repository/environment identity at session start even if the Agent later changes directory.
- [x] Wire host session lifecycle automatically: `sessionStarted` restores/creates the stable logical session; `sessionEnded` records its end and enqueues background folding without waiting for learning or inference. In Kintsugi, `/new` ends the old logical session and starts a fresh ID; an actual Agent-session shutdown also ends it. A graceful runtime shutdown must emit the logical session-end event, just as the upstream bridge emits it for exit/reload/switch. A raw storage close, crash or browser disconnect alone supplies no such event; use recovery for missed endings. Persist pending fold jobs before graceful shutdown and resume them with the workspace. No manual sealing or Finish learning session action is required.
- [x] At every host session start, recover earlier unfolded sessions in the same repository/environment that have an end marker **or at least 600 seconds of transcript inactivity**. Exclude the starting/resuming session ID. Use committed transcript activity for this 600-second test, not browser connectivity or a global all-sessions-idle condition. This selects a candidate; if its host adapter cannot yet supply the completed trajectory (the upstream `FoldLater` contract), leave it pending. Use oldest-session-first order; do not add a periodic idle-fold timer or an idle-triggered context reset.
- [x] Fold once per stable session ID, using a durable claim/job and an atomic folded marker with its evidence updates. Duplicate end events, crash/replay and concurrent starts cannot double-count. A resumed folded session retains the same ID and carried fact snapshot; it reads the currently published tool policy as upstream host starts do (M6). It is not folded again, even if later turns append evidence. This matches upstream's first-end behaviour. Record appended-but-not-refolded coverage rather than manufacturing another independent session.
- [x] Ignore a session-end event with neither an existing session record nor a source trajectory; it must not create phantom learning evidence. A recorded zero-prompt session can still be folded/accounted once, but contributes no pruning-session count.
- [x] Use the host's active visible branch for the fold trajectory and user-prompt count, as the Pi trace reader does. Do not merge abandoned branches into learning or count tool results/custom optimizer steering as user prompts; actual spend on abandoned branches remains charged once. A queued follow-up is not a new turn until the host starts processing it.
- [x] Keep prompt-run completion separate: an answer or Stop closes guard state and accounting, not the learning session. Do not split a long-running session into one independent confirmation per message. Sessions with no admitted prompt do not count as tool-pruning evidence.
- [x] Match the Pi bridge's source classification: visible message history forces `resume` even when the event says startup; otherwise startup/new map to fresh/clear, and resume/fork/reload remain resume. Do not infer fresh solely from a new ID or an empty branch. A genuinely fresh/cleared start gets the cached render; a carried session keeps its inherited section byte-for-byte, including an originally empty section. Compaction preserves the session ID, but section replay follows `carriedSection`: a compaction restates the full section map, so a missing TE key clears the prior section; an ordinary system patch lacking that key leaves it unchanged. An explicit null also removes it. Never resurrect a removed section from repository cache on resume. A host that actually discards start context must explicitly restore the originally injected text, not the newest render.
- [x] Map host fork/switch/reset events to explicit stable logical IDs. A host-created fork with a new session ID is folded once over its visible trajectory, as upstream does; reopening an existing fork is not a new session. Do not invent global entry-level deduplication that strips inherited history from a genuinely distinct session's mechanism fold. Keep related branches grouped for classifier validation (M7), and keep incurred spend by actual call identity.
- [x] Scope knowledge by host integration, repository and environment: root Agents in that scope share the envelope/facts/pruning state; do not key knowledge by individual Agent tab. Use one transactional Harness store in v1. Upstream shares repository knowledge across checkouts through its global host store; cross-store sharing requires an explicit future adapter. This storage boundary must not change fold cadence or session counting.
- [x] Subagents receive their root session's frozen facts and their own loop guard and redirect budget. Their turns do not change the root envelope. Subagent and one-shot tool results within the root session's entry range count in the root's fold evidence; prompts do not. Neither has its own learning session, fold or tool mask: Kintsugi copies the parent's tool settings when creating a subagent. One-shot and read-only Agents receive no facts or nudges. Model-free codemode templates keep distinct provenance and zero provider usage.

### Observations and privacy

- [x] Record `success | failure | aborted | timedOut | unknown`, nullable exit code, diagnostics, raw tool name, semantic class, parent call, committed source IDs and coverage. A missing exit code is not success.
- [x] Map Kintsugi bash's `structuredOutput.exitCode`, `timedOut` and `aborted`; nonzero exit need not set `isError`. Port runner-verdict/exit-coverage handling for pipelines, trailing commands, heredocs, here-strings, `bash -lc`, `sed`/`perl` edits, Windows paths and expected negative tests.
- [x] Keep `afterTool` fast and return the result unchanged: it runs before commitment, including aborts/errors. Use `afterTools` for committed top-level IDs and M0's adapter for nested results. Order by committed source order and deduplicate `(origin conversation, outer call, nested key, phase)`. Do not count wrapper and nested work twice.
- [x] Separate a complete bounded window from missing evidence. A deliberate last-32-call window can be complete; missing results within it cannot. Lost output needed by a feature makes that feature unknown.
- [x] Redact before storing samples or sending digests. Allowlist safe environment facts; never learn credentials, sensitive URL parameters or arbitrary variable values. Learned facts remain fallible data and grant no permission.
- [x] For the optional classifier/digest savers' exact failure identity, use semantic tool, normalised command, relative targets, outcome, exit code and diagnostic text after redaction/ANSI removal. Keep this identity separate from upstream `SpiralState`'s reference failure signature and basename-based counters (M5); it must not change reference stagnation or churn. Preserve error codes, meaningful numbers and relative paths. Strip only explicitly recognised volatile fields. Do not collapse filenames to basenames or merge different failures with fuzzy hashes. Hash keys must still verify canonical-data equality.
- [x] Keep schema versions and reject unsupported stored versions visibly. Expected external parsing failures produce diagnostics/no effect; storage corruption propagates. Never rerun tools to reconstruct evidence.

### Fold outcomes and ordering

- [x] Distinguish: **claim busy** / **host FoldLater** → leave pending without advancing mechanisms or marking folded; **permanently unreadable trajectory** → record the upstream terminal error and folded ID without inventing fact/tool evidence; **mechanism/storage exception** → report failure, never mark successful. A deferred snapshot is not an empty successful transcript.
- [x] Serialize mechanism folds per host/repository scope, not just per session. Recovery batches are oldest-first; an explicit live end can fold immediately under that lock. Upstream does not globally hold every live fold until all older silent sessions are found. Persist the chosen order and a frozen source cutoff through native job recovery.
- [x] Native atomic documents/effects must prevent partial fold replay from double-advancing clocks. Upstream uses a lock followed by several file writes, so its crash behaviour is not an exactly-once transaction. Treat stronger native atomicity as an explicit storage adaptation, and reconcile uncertain inference attempts separately; do not claim provider billing is exactly once.
- [x] History import is default-off upstream and outside this port's selected scope; do not automatically treat pre-install journal history as live sessions. If a future importer is enabled, it must use a separate imported provenance, chronological plan, running/partial barrier before **and after** acquiring the fold claim, no inference or policy publication/restoration during import, and live-only evidence for Auto. Import recovery must not block live folding indefinitely.

**Exit:** memory, SQLite and JSONL tests pass in both Kintsugi and a minimal non-Kintsugi host, including crash/replay, concurrent roots, reset, Stop, fork and compaction. Test automatic end-to-fold; recovery at exactly 600 seconds but not 599; exclusion of the current/resuming session; persistence across shutdown; duplicate end events; concurrent fold claims; and resume after folding without a second confirmation or proposer tick.

## M3 — Implement isolated inference and accounting

**Depends on:** M2. **Work:** `core/accounting.ts`, `pi-durable/sidecall.ts`.

- [x] Implement provider-independent generation (`SideCall`) and classification (`DecisionClassifier`) through the host's existing `Models` and authentication. Missing classification capability is unsupported, not an instruction to install or call another backend.
- [x] Give each job a purpose, origin run/session, input digest, policy revision, resolved model, deadline, output cap and budget reservation. Use only a redacted bounded digest and the mechanism prompt: no agent tools, skills, project instructions, MCP or recursive TE.
- [x] Generate constrained text and validate locally; use structured output only through a host-declared capability. Never evaluate generated code. Make model selection and optional classifier→generative escalation explicit.
- [x] Reserve shared budgets atomically before starting work. Default the per-call deadline to upstream's 180 seconds, with explicit host budget overrides and cancellation. Start with one optimisation inference job at a time per workspace and one pure training job; give live guard jobs priority over background learning. Bound queues and timeouts. Do not keep an answered Agent busy through `afterRun` child tasks.
- [x] Persist a provider-independent auth-pause state for the host's inference account scope after an explicit signed-out/auth-unavailable response. Ordinary timeout, rate-limit or empty reply is a failed call, not an auth pause. While paused, environment facts/ordinary fact observation continue without a proposer runner, and the reference generative guard uses no-verdict plus its existing backstop. Explicitly selected local/rule alternatives may continue under their own policy; pause must never silently select one. Report the pause once per pause revision.
- [x] Match upstream pause recovery: an explicit micro-skills/loopguard setting write clears the relevant pause (including setting Off, which still starts no call); expose the equivalent Retry model calls action. Do not automatically clear it on session start or timer. The host can translate an explicit credential-repair event into this action without hard-coding a provider.
- [x] Reconcile pending work after restart. A crash between provider reply and saved result has unknown billing; retain its reservation until reconciled and do not blindly retry. Use provider idempotency only when the host exposes it.
- [x] Deduplicate usage by actual call/job identity, including nested and descendant calls. Reuse SDK `UsageDoc` and Kintsugi model-tool attribution; never add SDK aggregate totals to their constituent charges.
- [x] Record execution/compaction separately from proposer, loop-judge, writer, tool-judge, classifier and audit overhead. Preserve provider/model identity, request counts, tokens, latency, local fit/prediction time and unknown coverage.

Use non-overlapping usage buckets:

```text
cost = input * rate.input + cacheRead * rate.cacheRead
     + Σ_t(cacheWrite[t] * rate.cacheWrite[t]) + output * rate.output
```

Tier counts partition total writes. Subtract a reported longer-TTL subset from the default bucket before pricing it separately. Missing tier detail uses only a host-declared applicable rate; otherwise mark that portion unpriced. Reasoning already included in output is not added again. Unknown price/usage is not zero; known-zero monetary price still has compute and latency. Prices come from the registry; subscription/API-equivalent estimates are labelled estimates. Always impose a call/time limit; add monetary/quota limits where applicable.

**Exit:** fake-provider tests cover isolated requests, cancellation, stale results, auth/time/budget failure, concurrent reservations, exact attribution and unresolved restart costs. Stop remains responsive.

## M4 — Port complete micro-skills

**Depends on:** M3. **Work:** `core/microskills/`, named-section integration.

- [x] Port environment facts, observation and `Lifecycle` state transitions exactly. Advance decay on the mechanism's session/task clock, not wall time or each tool call. Code-fact promotion uses the upstream disjoint edited-file-set test over edited **basenames** (including empty sets); environment facts disable that drift requirement. Candidates promote at 3 qualifying confirms; ACTIVE facts require ≥4 exercises and firing rate ≥0.40 to inject. A low firing rate hides an ACTIVE fact without retiring it; rendering changes no observation counters or clock. There is no added wall-clock expiry. Retirement is terminal for that ID. A classifier's agreement never earns an independent confirmation.
- [x] Preserve envfact exceptions: a high-stakes CANDIDATE retires on a clean contradiction too; `form_repair` requires two consecutive exercised contradictions before recording one, with the upstream streak-reset behaviour. Seed the recorded session `injected_ids` before the environment layer update; an explicit empty list clears credit, and missing IDs must not be inferred from current rendered text. Clear that per-update credit afterwards, including parse failure. Count prevented failures only under the upstream family's exercise/confirmation conditions. Preserve the existing CANDIDATE/ACTIVE `if/elif` branch order: do not promote and then apply an extra retirement pass in the same core update.
- [x] Port `Distiller.update`'s clock exactly, including initial `now=0,last_propose=-1`: observe existing facts, append the bounded digest window, increment `now`, and attempt proposal when `now - last_propose ≥ configuredCadence` (live default 3). With readable input and a runner, attempts occur on updates **2, 5, 8, …**; do not replace this with `sessionCount % 3 == 0`. A parse/missing-digest early return advances `now` without immediately proposing. No runner/empty window makes no call and does not consume `last_propose`; an attempted call that fails still consumes the cadence tick, so it is not retried at every fold. Ordinary answers, polling and repeated end events never advance this clock.
- [x] Keep the rolling window of 8 digests, at most 4 candidates per tick, at least 2 confirming citations and at most 12 authored extractors. A proposer tick does not clear the rolling window. In the composed profile, update environment facts **before** distillation and supply its current injectable claims to the proposer, then save both and build the cached render. Keep envfact parameter/working-form evidence updates under the same ID; the immutable-claim rule below applies to generative facts, not to envfact parameter accumulation.
- [x] Implement proposer digests, candidate facts and detector/extractor specifications, citation grounding and retrospective observation. Add new extractors append-only, re-featurise the existing window, then replay an admitted fact over that window exactly once. For an existing fact ID permit only the upstream contradiction-detector revision: preserve claim, confirmation/scope, earned counters and state; apply the changed contradiction condition prospectively. Compose with envfacts without duplicates and account for rejected proposals.
- [x] Support only the ported detector DSL. Use a linear-time/safe regex engine or an explicitly bounded supported dialect; reject unsupported patterns with a reason. Truncating input does not make an unsafe regex safe. Test adversarial detectors and secret/completion-advice rejection.
- [x] Render/cache after the fold and inject at a fresh host session start before scheduling recovery of older sessions. A background fold completing later does not rewrite that session's prefix. Apply caps to the corresponding upstream profile; any additional cap on the generative/composed render needs a named policy fixture. Store raw fact text separately from tagged rendering, reuse exact bytes/order on resume and restate the same non-empty named section before every prompt so accidental omission cannot remove it. An empty/removed snapshot uses the SDK's actual removal delta; do not wrap it into a non-empty empty-tag section.
- [x] Apply configuration at the same lifecycle boundary as upstream: a new proposer cadence affects the next fold without resetting `now`/`last_propose`; changing profiles keeps each profile's saved state and observes only future folds while that profile is selected. Neither a model/profile change nor re-enable clears earned counters or reprocesses sessions already marked folded under another policy. Caps change the cached render only after a subsequent enabled fold, not immediately on save or on resume.
- [x] Preserve provider cache/session options. Contradictions retire future selection without silently replacing the active early prefix. Explicit urgent removal reports its cache boundary.

**Exit:** envfact and fake-proposer parity, composition/lifecycle/security tests and stable serialized prefixes pass. Include render-without-clock-advance, low-fire ACTIVE suppression, per-update injected-credit cleanup, dynamic envfact working form, and no automatic re-fold on profile/model change. Resume, fork and compaction preserve the correct snapshot without double-wrapping.

## M5 — Port complete loop guard

**Depends on:** M3. **Work:** `core/loopguard/`, `pi-durable/steering.ts`.

- [x] Serialize prompt/tool/Stop/end events per session. Map committed native event IDs to idempotent effects instead of copying upstream lock-file queues; a replayed tool event may hold a decision but cannot spend its delivery count or reset its segment before a live boundary consumes it.
- [x] Open guard state at the host's actual new prompt-run boundary (`UserPromptSubmit`/`before_agent_start` equivalent), not at every queued submission or same-run steer. Custom optimizer steering never starts a turn or restores its budget. If the previous turn never reached Stop, close it as interrupted/unknown first; a changed turn key seen on a tool event does the same. If the prompt hook was missed (for example, help was enabled mid-turn), the first tool event lazily opens that turn using its trusted input identity. Re-enable in the same turn preserves its old budget/state; it does not create a new turn. Normal answer/Stop closes the turn once; ignore recursive/synthetic Stop callbacks marked `stop_hook_active` where the host exposes them; session end closes any remaining turn using the host's `completed_at_end` signal (false by default). User cancellation is not normal completion.
- [x] Port `TurnGuard.resolved_proxy`: a normally completed nonempty turn not marked guard-aborted is green unless a failed verification occurred **after its last edit**. A passing check is **not required**; no verification, or a failed verification followed by a later edit, can still be proxy-green. Preserve that proxy and its limits instead of replacing it with a stricter success gate. Missing native evidence needed to compute it is an adapter coverage error, not an invented positive outcome.
- [x] Preserve reference `SpiralState` counting: edit churn/targets use upstream basenames; repeated-failure identity uses the first matching error line with upstream number/address/path removal. Do not feed M2's stricter full-command/relative-path classifier signature back into reference stagnation, learnt gates or fact confirmation sets. Fixture-test both identities and their different purposes.
- [x] Preserve shadow/Observe reducer state: it simulates `after_nudge`, segment resets, spent redirect count, terminal-notice state and learning even though no message reaches the Agent. Switching Observe→Active within the same turn does not refund that simulated budget. Record simulated/proposed counts separately from actual delivered counts; do not make Observe a no-op reducer or reset on mode change.
- [x] Update the shared envelope on every normally closed eligible prompt-turn, without waiting for session folding. Use cumulative whole-turn calls and the whole-turn snapshot, including pre-redirect work; keep the last 500 samples. A turn's own outcome affects later decisions only. Port `EnvelopeTracker.thresholds()` and pinned-override ordering, including learned lower turn gates and signal floors; 20 is the base minimum, not a permanent minimum. Distinguish direct, nested and template call coverage without inventing new reference presets.
- [x] Port the live envelope path specifically: `thresholds(tracker, overrides)` uses `max_turns=None`, no benchmark frozen-envelope shortcut, Python-compatible rounding, then pinned values, and finally the controller's live gate overrides. The benchmark 90%-of-turn-cap clamp must not leak into this path.
- [x] Before envelope warm-up there is no judge call or guard intervention. Once warm, the live cheap judge gate is **repeated failure OR dense errors**, with `gate_min_turns=max(learned gate_min_turns, learned min_turns)` and `gate_over_envelope=false`. The strict churn/error/stagnation conjunction belongs to rule fallback/backstop; do not require it before every generative judgement. Length alone never wakes the live judge. Rule-only remains an explicit alternative policy; the reference live path uses the async judge.
- [x] Implement async `productive | stuck | ambiguous` judgement with pending/poll state and turn/segment IDs. Start at a 5-call gap, add 5 after productive verdicts up to 20, reset to 5 otherwise; expire unanswered pending jobs after 300 seconds. At an eligible tool event, `_background` **polls a matching pending result before checking the gap for starting a new job**. A ready result can be consumed inside that gap; a result behind a closed cheap gate waits. A found empty verdict clears pending, resets backoff and returns for that event; it does not immediately start a replacement. The 300-second expiry is checked on eligible events, not an autonomous expiry-triggered model call. Job completion alone cannot deliver or start a turn.
- [x] Preserve the async worker pipeline: a confident stuck verdict attempts the writer **in that background job**, then records incurred usage before publishing the combined verdict/text. The reference worker does this even if the turn has since ended or its redirect budget is exhausted; that text may be undelivered but its cost remains. Native explicit cancellation/budget gates can prevent unstarted work, but all-off parity must not invent a writer-call saving.
- [x] At delivery use already-written text, else the reference count template. A rule/backstop redirect with no prepared text uses that template **without a new writer call**. The worker digest uses `live_digest`'s actual verification state (none, passed, failed, edits since), not the benchmark's unconditional not-green assertion. Bound text and preserve process-only lint.
- [x] Check the cumulative hard backstop before the judge; a productive verdict cannot veto it. It still requires the strict stuck signature. An unspent redirect goes first; only after a fresh post-redirect segment becomes stuck again may the controller issue the one still-stuck notice. After redirect, reset segment state, judge gap/last-call state, pending verdict and ready writer text; preserve whole-turn counters, verification tracking and the spent redirect budget. Use M0's atomic per-run count and per-decision deduplication marker, adapted to durable steering admission; steering never replenishes the configured budget. Default one matches upstream; test a configured budget of two as well.
- [x] Pending/throttled/failed/unavailable or ambiguous judgement spares the decision except for the existing backstop. A paused/unavailable configured judge must remain a no-verdict judge, never silently become rule-only fallback. Preserve the selected upstream preset's explicit ambiguous-nudge option if that preset is offered. Held/replayed tool decisions are undelivered until a live tool-result boundary can consume them; close discards an unconsumed decision without incrementing delivered nudge/notice counts, and retains incurred accounting. After the still-stuck notice, the guard is terminal for further decisions in that turn, although whole-turn outcome/call tracking continues.
- [x] Discard effects after Stop, a new session/segment, newer verdict or completed run; charge incurred usage. After continued failure following a redirect, issue one notice with the existing Stop control, never automatic Stop.
- [x] Test a long codemode script that continues after detection. Report decision, notice, steer queued and steer consumed separately. Steering cannot rewrite running JavaScript; consumption waits for a model boundary. Do not interrupt/restart a script to simulate it.

**Exit:** live-controller and fake judge/writer parity includes cold-start no-call, length-only no-call, adaptive gates, productive backoff, 300-second expiry, pending/no-verdict, whole-turn green proxy, turn interruption, cumulative backstop, post-redirect reset, held-undelivered close, Observe→Active with a spent simulated budget, the default one/configured two admitted redirects and stale/long-script behaviour.

## M6 — Port complete tool pruning

**Depends on:** M3. **Work:** `core/toolprune/`, `pi-durable/catalogue.ts`.

- [x] Capture eligible and exposed catalogues, schema revision, source and ordering, including direct tools, callable tools, discovery and generated codemode declarations. Missing catalogue provenance blocks pruning; a legitimate empty catalogue is distinct.
- [x] Port M1's live high-risk formula and the actual stage progression: every tool in the retained catalogue resets its streak on use, otherwise increments when the stage folds; the used-ever set persists. This includes retained catalogue entries under a prior mask—do not silently substitute an exposure-only counter. Record actual exposure separately; neither these streaks nor masked non-use supplies a classifier's negative relevance label. Preserve the upstream protection for any tool used in the relevant knowledge scope. A schema/environment change invalidates affected evidence; do not reset protection merely to make a statistical drop possible.
- [x] Protect host file/shell work, interaction, planning, recovery/discovery, delegation controls and explicit manual retains. Match real registrations and semantic classes. Recheck protection at application.
- [x] Implement the optional generative tool judge against the actual interactive task text and its remaining unprotected, never-used catalogue. Validate returned IDs and decisions. Missing text, malformed output, unavailable judgement or uncertain relevance adds no task-judge exclusion; independently valid live evidence exclusions remain effective.
- [x] Preserve upstream composition: the live fold produces evidence exclusions. If the optional per-task judge is enabled at task/session preparation, judge the remaining unprotected, never-used tools and **union** its valid drop decisions with evidence exclusions. Do not require both evidence and judge approval or restrict the judge to tools the evidence path already excludes. Keep two explicit entry points: live fold → evidence proposal → delayed repository publication; optional `ToolingStage.build_tools(task,i)` → per-task selection. The latter unions its trace exclusions with judge drops and returns a task-local mask, not a globally published deny policy. It must not publish a pending live proposal early or be described as an existing live hook. Native Auto may apply this explicitly selected task policy at preparation; Propose records it without effects until explicit approval. Classifier alternatives preserve those same candidate sets.
- [x] Preserve catalogue/streak update boundaries: the generic stage refreshes catalogue descriptions only on an unexcluded run, retains old catalogue data otherwise, and updates its known-tool streaks. The live fold skips pruning entirely for prompt count 0, uses one prompt for an unknown count, and skips it while pruning Off. Optional stage re-audit (`evidence_reaudit`, default 0; `i>0 && i%cadence==0`) temporarily loads the full catalogue and skips the judge/mask for that selected task without inventing a new session. In the standalone stage, `after_task` still records used-ever names when evidence is off, but the live wrapper's Off early return never calls that stage; test the two entry points separately.
- [x] After a live fold, Auto records a pending repository-scoped proposal and its original `since` time; it does not publish it at every new session. Publish when **all sessions in that host/repository scope have been quiet for `toolprune_quiet_minutes` (default 60), OR the proposal has waited 24 hours**. For this timer use the latest **session-record write or transcript write**, whichever is later, across the scope; this includes writing the session's folded marker and differs from the transcript-only 600-second missed-end test. Keep explicit native activity timestamps: unrelated global journal commits, job/waiter heartbeats, ledger/artifact writes and passive status reads do not themselves count as session-record activity. Later session/transcript activity delays the quiet condition; refreshing proposal contents does not reset `since`. A durable waiter rechecks at most every 600 seconds (or the remaining deadline). This is distinct from the 10-minute missed-session fold rule.
- [x] Use one recoverable waiter per host/repository; a second attaches/exits instead of polling independently. Refresh policy while waiting. A refusal to apply records its reason, clears automatic pending application and leaves the proposal inspectable; do not create a tight retry loop. Completion/withdrawal clears the pending batch; a later new batch has a new age, while refresh of an existing batch keeps its original age.
- [x] Recheck current Auto/Observe/master policy, protection, owned-applied items and user-kept items at publication. Off/Propose/Observe cannot publish; leaving Auto clears its automatic pending application without erasing the proposal. A tool becoming protected while pending is removed; a previously TE-excluded tool newly protected is restored at the next relevant fold.
- [x] A running session keeps the mask it prepared. A fresh, resumed or reloaded host session reads the **published** policy, not a proposal still waiting; a carried-fact snapshot never pins an obsolete tool policy. After publication, resume can legitimately rebuild a previously warm cache. The 24-hour limit explicitly permits that trade-off. Prepare before the first model request, report optional judge latency, and apply per conversation rather than unregistering shared tools.
- [x] Filter both direct model exposure and nested callable/discovery surfaces. `modelTools.remove` alone does not remove a callable tool. Check `ALL_TOOLS`, namespaces, search, inline declarations and descriptions. Keep codemode and recovery available.
- [x] Apply/Restore are explicit user actions and do not wait for the Auto quiet timer or create a synthetic new learning session. Publish the owned policy change now; ordinary running masks change on the next host start/resume. Restore only TE-owned exclusions and persist a **kept** marker so Auto and future proposals cannot remove the restored tool again. Only an explicit named Apply clears that kept marker, while protection and permissions still win.
- [x] Preserve ordering/registrations for byte-identical restoration at the same catalogue revision. Off stops new pruning proposals/publications but does **not** automatically restore already-applied exclusions. Offer Restore separately. Do not force `/new` merely to approve or restore a proposal.

**Exit:** serializer tests remove/restore a previously visible non-protected schema from every relevant surface; another running conversation stays unchanged, while a later start/resume reads the published policy. Cover 60-minute quiet/zero-quiet/24-hour deadlines, activity postponement, original pending age, mode changes, protection while pending, sticky Restore, named Apply, no-candidate and changed-schema cases.

## M7 — Build classifier contracts and safety gates first

**Depends on:** M3, M5 and M6 for real decision records. **Work:** `core/classify/{contracts,samples,thresholds}.ts`.

### Result contract and authority

- [x] Use a discriminated result; abstention is a real state, never a zero score or false label:

```ts
type Abstention = "not_ready" | "insufficient_evidence" | "out_of_domain"
  | "stale" | "invalid_output" | "unsupported" | "drift";

type Decision<L extends string> =
  | { kind: "label"; label: L; rawScore: number; artifactId: string; reasonCodes: string[] }
  | { kind: "abstain"; reason: Abstention };
// Loop labels: "productive" | "stuck". Tool labels: "keep" | "drop_candidate".
```

- [x] Keep prediction pure. Only the mechanism coordinator may steer or mask tools, after checking mode, freshness, protection, evidence, budget and the fitted action band's approval. A local `stuck` label still needs the separate authorisation switch.
- [x] Treat BM25 as a non-negative ranking score, and logistic/NB/SDK scores as backend-specific model scores. None is automatically a calibrated probability of correctness. V1 calibrates **action thresholds**; it does not add a separate probability-calibration model.
- [x] Reject NaN, infinity, malformed labels and mismatched input/feature revisions. Expected out-of-domain input abstains; corrupted saved artifacts raise a diagnostic/error rather than becoming an empty model.

### Labels and datasets

- [x] Capture each frozen input **before** its reference judge call. Store scope, root session/branch lineage, decision ID, catalogue/feature/prompt revisions, model identity, evidence coverage, label source and sampling reason. Future successes, fixes and Stop are evaluation outcomes, not prediction features.
- [x] For loops, train on explicit reference `stuck`/`productive` judgements; exclude ambiguous/error/stale inputs. These are teacher labels, not ground truth. Never feed local predictions back as training labels or include the teacher's verdict/confidence in prediction features. Review disagreement cases and use independently reviewed examples for effect-enabling acceptance.
- [x] For tool relevance, train on the reference tool judge's explicit `keep`/`drop` recommendations for a frozen task/catalogue. Keep actual use as a hard protection veto. **Unused is not a negative relevance label.** A hidden tool, incomplete trace or task that never exercised a tool supplies no negative label.
- [x] Separate the lifetime never-used evidence rule from the relevance classifier. A per-tool used/not-used model would have no positive examples for precisely the tools eligible for pruning. Do not fabricate positives, relax protection, or silently pool other tools/workspaces to solve this. A one-class relevance dataset abstains.
- [x] Deduplicate classifier samples across replay and inherited histories, and group related forks for statistical validation. This classifier-only sampling rule must not change M2's upstream once-per-logical-session mechanism fold. Fit per repository/environment and label-policy revision; do not automatically share samples across repositories.
- [x] Freeze a chronological, grouped **60% fit / 20% threshold selection / 20% untouched acceptance** split by independent root learning session; related forks stay in the same group. Fit vocabulary, IDF, scaling and weights only on the fit split. The current task and held-out task texts must not enter the index or fitting statistics.
- [x] Fit can use several loop windows per session with equal total weight per session. For risk counts, use at most one preselected decision per root session, selected by stable decision-ID hashing before looking at labels/scores. Use complete reference or uniformly sampled audit records, not only uncertain/escalated examples. Missing labels contribute no acceptance evidence.
- [x] Store split membership and candidate versions. Choose thresholds on the middle split; confirm once on the final split. A failed final check disables that band. Do not search another threshold on the same final split; a later candidate needs fresh untouched acceptance data.

### Threshold selection

A band is an empirically checked action rule, not a threshold copied from another classifier. Fix these initial maximum error targets in versioned code before evaluation; do not silently loosen them to obtain coverage:

| Band | Selection rule | Error counted among selected cases | Initial upper-bound limit |
|---|---|---|---|
| Spare loop judge | `stuckScore ≤ low` | Reference/review label is stuck | 5% |
| Local stuck authorisation | `stuckScore ≥ high` | Reference/review label is productive | 1% |
| Local tool drop | `keepScore ≤ drop` | Independent review says the tool is needed | 0.5% |
| Tool keep | Strong lexical match or high `keepScore` | Extra retained tool | No destructive action; use raw keep cutoff 0.5 initially |

- [x] Count errors **over cases receiving that action**, not all examples or all members of a label. Report conventional miss/false-positive rates separately. For tool drops, evaluate the actual selected evidence or task-judge path plus protection and classifier policy; a band with zero eligible examples cannot pass.
- [x] Use the upper endpoint of a two-sided 95% Wilson interval (`z=1.96`), with `n` independent selected sessions and `e` erroneous actions:

```text
p = e/n
upper = (p + z²/(2n) + z*sqrt(p*(1-p)/n + z²/(4n²))) / (1 + z²/n)
upper(0 samples) = 1
```

- [x] Enumerate finite observed scores on the threshold-selection split. Choose the widest band meeting its error target: largest `low`/`drop`, smallest `high`. Require `low < high`. Use explicit inclusive comparisons and deterministic tie handling; otherwise leave a band empty.
- [x] Lock the chosen bands, then require the same bounds on the untouched acceptance split. Teacher-only results may support Observe experiments and bounded judge-sparing trials; any classifier-backed redirect or tool drop, whether local or inference-backed, requires reviewed acceptance labels. Too little data means an empty band, even if training succeeded.
- [x] Keep these readiness states distinct: `collecting`, `fitted`, `observe_only`, `active_bands`, `invalidated`. An enabled switch can legitimately report "Collecting data". Never manufacture a working threshold to satisfy the UI.

The limits are engineering risk targets, not guarantees under arbitrary drift. With zero errors, 20 independent cases still have an upper bound about 16.1%; 100 have about 3.70%. Tight destructive-action bands may need hundreds of independent sessions. Default to the reference path while collecting them.

### Artifact lifecycle and audit

- [x] Store model/feature/tokeniser/label-policy versions, tool schema, fit statistics, weights, dataset ranges, split IDs, action thresholds, sample counts and validation results. Publish an artifact atomically after validation; freeze its identity for each decision/job.
- [x] Refit in bounded background work after automatic session folding and at least 20% more labelled groups, or explicit Refit. No fitting in a tool hook or synchronous request path. Refit is deterministic and makes no inference calls by itself.
- [x] Invalidate affected artifacts on environment, feature, catalogue/label-policy or teacher-model changes. Cosmetic Settings changes need not invalidate weights; changing action/risk policy invalidates its thresholds.
- [x] Start with fixed resource limits in code: 4,096 loop samples, 4,096 tool task records shared across tools, vocabulary ≤ 2,000, one fit at a time and a 64 MiB retained working-data budget. Evict old groups as units; if bounds cannot be met, skip training visibly. Never shorten required evidence and call it complete.
- [x] Sample local decisions for audit with a versioned hash of stable scope/decision IDs. Default 5%, optional 0–20%, selected before knowing the outcome. Every audit inference requires the normal budget; its result cannot emit a second effect.
- [x] Track audit disagreement, actual false actions, abstentions, coverage, selected-band counts and local CPU/time. Invalidate a band after a reviewed unsafe action; require a fresh fit/acceptance before reactivation. Missing audits are labelled missing, never counted as agreement.

**Exit — mandatory tests:**

- [x] `upper(0,20) ≈ 0.1611301255`, `upper(0,100) ≈ 0.0369948075`; no samples never passes. Reject impossible counts (`e<0`, `e>n`).
- [x] Twenty correlated windows from one session count as one independent risk sample, not twenty. Fork duplicates and unlabelled rows add none.
- [x] Altering held-out labels or text leaves fit weights/scalers/vocabulary/IDF unchanged. Threshold search cannot read the final split.
- [x] All-one-class, empty-band, unknown-score, stale-version and failed-validation cases abstain. Off/Observe cannot authorise an effect even with a deliberately confident fake classifier.

## M8 — Implement the local loop classifier

**Depends on:** M7. **Work:** `core/classify/{loop-features,logistic}.ts`.

### Feature extraction

- [x] At the existing warmed-envelope cheap judge gate, freeze the most recent **32 committed semantic tool results actually processed by this guard** in the current segment (clear this feature window after redirect, while retaining whole-turn counters for reference backstop/outcome). Do not silently insert online calls skipped while guard Off; the later full-session fact fold is a different consumer. Count actual nested work once; retain wrapper/model-turn counts separately. Abort/unknown results or missing required diagnostics make this classifier abstain.
- [x] Use this fixed feature order, version `loop-v1`. `n` is the window size; `f` is failures including timeouts/harness failures; `edits` counts calls that changed a known target. A documented zero denominator with no such events yields 0; unknown data does not.

| Index | Feature |
|---|---|
| 0 | `log1p(calls since verified green result, or run start)` |
| 1–3 | failure fraction `f/n`, timeout fraction, harness-error fraction |
| 4–5 | distinct exact failure signatures / `f`; largest exact-signature repetition count / `f` |
| 6–8 | edit calls / `n`; largest per-target edit count / edit calls; `log1p(distinct edited targets)` |
| 9 | `log1p(calls since last new failure signature)`; 0 when there has been no failure |
| 10–11 | calls / matching-mode p90 envelope; envelope-missing indicator; use ratio 0 when missing |
| 12–13 | nested-call fraction; read-only-call fraction |

- [x] Count each edited target at most once per call. Keep read-only, successful verification and mere exit-zero outcomes distinct. The signature extraction is M2's exact form, not a text classifier of the word "error".
- [x] Compute means and population deviations on the fit split using equal session weights. Standardise with those saved values. For zero-variance dimensions use 0; a different inference value is out-of-domain. A non-finite feature or standardised value outside `[-8,8]` abstains instead of clipping it into confidence. Envelopes must use the same execution-mode/count definition as training.

### Fit logistic regression without a numerical framework

- [x] Encode `y=1` for stuck, `0` for productive. Require at least 200 fit windows and 30 of each class before fitting; these are fit minima, not acceptance evidence. Use `a_i = 1/(G*m_g)`, where `G` is fit sessions and `m_g` their row count, so weights sum to 1.
- [x] Fit `score = sigmoid(b + w·x)` with L2 coefficient `λ=0.1`, zero initial weights/intercept and the following objective. Do not regularise the intercept or reweight classes in v1.

```text
z_i = b + w·x_i
loss = Σ_i a_i * (softplus(z_i) - y_i*z_i) + λ/2 * Σ_j w_j²
g_b = Σ_i a_i * (sigmoid(z_i) - y_i)
g_w[j] = Σ_i a_i * (sigmoid(z_i) - y_i) * x_i[j] + λ*w_j

softplus(z) = max(z,0) + log1p(exp(-abs(z)))
sigmoid(z) = z >= 0 ? 1/(1+exp(-z)) : exp(z)/(1+exp(z))
step = 1 / (0.25 * max_i(1 + Σ_j x_i[j]²) + λ)
```

- [x] Use deterministic full-batch gradient descent; update all parameters from the same gradient. Stop when maximum absolute gradient ≤ `1e-6`, with a hard cap of 2,000 iterations. Treat only loss increases larger than `1e-10 * max(1, abs(previousLoss))` as numerical failure. Yield in the durable runner between bounded iteration chunks so Stop remains responsive. Non-finite/loss-increasing/non-converged fits produce no new active artifact; never publish partial weights as success.
- [x] Select M7's low/high action bands on raw sigmoid scores; do not label them calibrated probabilities. Start with only judge-sparing enabled. A local stuck action additionally requires the explicit authorisation toggle, reviewed high-band acceptance and the normal guard/redirect gates.
- [x] Re-evaluate on later evidence. A productive prediction spares one decision; it cannot permanently exempt a run from later checks or backstop rules. With audit disabled, show reduced drift visibility rather than claiming current measured accuracy.

**Exit — mandatory tests:**

- [x] `sigmoid(0)=0.5`, `sigmoid(log(3))=0.75`, and values at ±1,000 are finite. `softplus` and loss stay finite at those extremes.
- [x] Symmetric fixture `x=[-1,-1,1,1]`, `y=[0,0,1,1]`, equal weights and `λ=0.1` converges to intercept ≈ 0 and weight ≈ 1.6335 (tolerance `1e-3`).
- [x] Compare analytic gradients with central finite differences (step `1e-5`, tolerance `1e-6`). Check the bias is unpenalised, a constant feature stays finite, and training order/replay gives the same artifact.
- [x] Productive changes, expected negative tests, read-heavy codemode batches, missing outputs, warm-up, non-convergence and stale verdicts cannot create false authorisation in fixtures.

## M9 — Implement BM25 and the statistical tool prefilter

**Depends on:** M6–M7. **Work:** `core/classify/{text,bm25,bernoulli}.ts`.

### Text and BM25

- [x] Use the user's admitted task prose at session preparation and attachment type metadata. Exclude fenced code from lexical indexing; bound pasted material. Retain the full bounded task digest for the generative judge. If meaningful task content is omitted, local keep hints remain allowed but local drops abstain.
- [x] Redact first. Apply NFKC, split camelCase before lower-casing, then split snake_case/kebab-case and Unicode word boundaries. Preserve negation words (`not`, `no`, `without`, `except`). Use no stemming or locale-specific confidence assumption. Empty or unfamiliar text is not evidence that tools are irrelevant.
- [x] Emit safe structural tokens such as `<url>`, `<path>`, `<ext:xlsx>` from attachment/path metadata. Never store URL credentials, secret substrings or full private paths as tokens. Pin the tokeniser version; use identical code in fit and prediction.
- [x] Bound each document to 256 tokens and current task prose to 4 KiB; mark omissions. Build one catalogue document per tool and up to 16 distinct, recent **fit-split** task documents per tool with positive relevance/use evidence. Deduplicate identical documents, freeze the index revision and bound total documents. Held-out and current task text is query-only.
- [x] Implement BM25 with `k1=1.2`, `b=0.75`, unique query tokens and document-frequency counts (one count per document):

```text
idf(t) = ln(1 + (N - df(t) + 0.5)/(df(t) + 0.5))
score(q,d) = Σ_{t in unique(q) ∩ d} idf(t) *
             tf(t,d)*(k1+1) / (tf(t,d) + k1*(1-b+b*len(d)/avgLen))
```

- [x] Empty corpus/query scores 0. For a tool, take the best matching document. Keep the top 3 tools **with positive scores**, including ties, in addition to hard protections. More examples still give more matching opportunities; caps/dedup limit this bias but do not remove it. BM25 is a keep-only hint, never a probability or a drop signal.

### Bernoulli naive Bayes

- [x] Use M7's explicit task-relevance labels per tool/schema: `y=1` means keep recommended, `0` means drop recommended. Count one frozen task record per tool/session. Require at least 20 fit sessions of each class; otherwise abstain. Never use "not called" as `y=0` or infer relevance from a failed/missing model response.
- [x] Select the 2,000 most frequent fit-split tokens by document frequency, with deterministic token-order ties. Store this vocabulary and class counts. It is fixed for prediction; do not rebuild it from incoming requests.
- [x] Use binary presence, not token frequency. With Laplace smoothing `α=1`:

```text
prior_c = (n_c + 1)/(n_0 + n_1 + 2)
theta[c,t] = (documents in class c containing t + 1)/(n_c + 2)
logP_c = ln(prior_c) + Σ_{t in V} [x_t*ln(theta[c,t])
                                 + (1-x_t)*log1p(-theta[c,t])]
keepScore = sigmoid(logP_1 - logP_0)
```

- [x] Include **absent-token terms**. Efficient equivalent: precompute `base_c = ln(prior_c)+Σ log1p(-theta)` and add log-odds only for present tokens. Work in log space; no product of thousands of probabilities. Smoothing keeps `theta` strictly between 0 and 1; it does not make a one-class model valid.
- [x] Return a raw score; NB's conditional-independence assumption often makes it overconfident. Set action thresholds only through M7. For destructive decisions, require at least 3 in-vocabulary task tokens and at most 50% unique lexical tokens out of vocabulary, plus complete required task content. A drifted task abstains without erasing a valid model for other tasks.

### Partition and execution

- [x] Apply checks in this order:
  1. Protected, manually retained/restored or ever-used tools are kept. Compute reference evidence exclusions separately; do not confuse lacking evidence eligibility with task relevance.
  2. BM25 positive top matches or NB `keepScore ≥ 0.5` keep a tool. Retaining an extra tool does not require a destructive-action band.
  3. A tool becomes a local **task-judge drop candidate** only with the Allow local tool drops switch on, complete compatible input, an approved per-tool drop band and `keepScore ≤ drop`. Apply the task-judge protection/domain gates; it need not already be evidence-eligible. Keep evidence-based exclusions on their separate M6 path. A low/zero BM25 score contributes nothing to this decision.
  4. Remaining task-judge candidates are uncertain. Send those to the configured judge and union valid task drops with the separately computed evidence exclusions. Missing/failed judge output adds no task drops; it does not cancel already valid evidence exclusions or invent new ones. With no task judge selected, use only the explicit evidence policy.
- [x] Train from the recorded reference path or explicit audits; do not generate model calls merely to fill the minimum class count. A never-used tool may have no positive relevance labels and remain unclassifiable indefinitely. Keep it uncertain; never invent cross-tool pseudo-labels.
- [x] Report how many candidates were protected, lexically kept, statistically kept, locally approved, uncertain and actually masked. Do not report hypothetical schema savings.

**Exit — mandatory tests:**

- [x] For `N=2`, `df=1`, `tf=1`, document length = average length, one matching query term scores `ln(2)`. Repeating a query term does not increase this implementation's score; empty docs cause no division by zero.
- [x] A zero BM25 match never by itself changes a tool from uncertain to drop; a positive top match always vetoes a task-judge drop. Include synonyms with no overlap, unrelated-language tasks and an empty task.
- [x] Tiny NB corpus: keep rows `{red},{red}`, drop rows `{blue},{blue}` gives `prior=0.5`, `theta_keep=(0.75,0.25)`, `theta_drop=(0.25,0.75)`. Query `{red}` scores 0.9 and `{blue}` scores 0.1. Repeating `red` leaves 0.9. Test this scorer directly; production fit/coverage minima still apply.
- [x] Dense and sparse/log-odds scorers agree. An absent, excluded or unobserved tool creates no negative label. One-class/OOV/truncated input abstains; held-out text cannot change vocabulary or IDF.
- [x] Evaluate only actually eligible tools. No eligible validation drops means no approved drop band. Previously used tools remain protected even if the classifier says drop.

## M10 — Wire classifiers and bounded call savers

**Depends on:** M8–M9. **Work:** classifier adapter, `core/savers.ts` and mechanism coordinators.

### Provider-independent text classifier and routing

- [x] Implement `Models.classify()` through the host adapter, without a model-callable TE tool or another Agent. Loop questions use `productive/stuck/uncertain`; tool questions use `keep/drop/uncertain`. Validate answer keys, label membership, finite values and score semantics. For choice probabilities require all expected keys, values in `[0,1]` and sum within `1e-6` of 1; do not silently repair malformed output.
- [x] Map `uncertain`, error, abort, missing usage and unsupported capability explicitly. Unknown usage stays unknown. One SDK request containing several questions may issue several inference requests; count the actual transport work where reported and label missing fan-out data.
- [x] Version thresholds by task, model and prompt. Use M7's gates on the chosen raw score (`P(stuck)` or `P(keep)` from the supplied label distribution); the provider's separate `confidence` field is not interchangeable. Lack of accepted thresholds means Observe-only or abstain.
- [x] Implement this routing without moving reference lifecycle gates; test every route. M5's cumulative backstop runs before any predictive judge and can override a productive label:

```text
Off/disabled -> no optimisation job/effect
Rules mode -> reference deterministic policy; no classifier/generative judge
Judge mode -> require warmed reference envelope and open trouble gate
           -> consume matching ready result / resolve held decision first
           -> if no ready result: pending/expiry/new-attempt rate checks
           -> identical-decision reuse, if enabled and valid
           -> local loop classifier, if enabled and ready
           -> selected text classifier, if configured
           -> generative judge ONLY if directly selected or escalation is enabled
           -> reference no-verdict/backstop policy if still undecided
Reference authorised redirect -> ready worker text or count template -> atomic run gate
Local authorised stuck -> explicitly selected writer/template pipeline -> atomic run gate
Observe -> apply simulated reducer/budget transitions and learning, never deliver or mask
```

- [x] Feed local/text verdicts through the same attempt/backoff coordinator: a complete local productive result advances the productive backoff; an abstention continues the same decision attempt, not a new reference tick per backend. Audit calls have separate usage and cannot advance the live turn or consume its redirect budget. Never let a new-attempt rate limit suppress polling of an existing reference result.
- [x] Do not run all judges and vote. Stop at an actionable result; a local stuck result with its authorisation switch off is non-actionable and falls through like abstention. Uncertain falls through only to explicitly enabled, budgeted paths. A local classifier returning productive saves only this decision's judge call. The tool route follows M9, with text/generative selection applied only to uncertain candidates.

### Independent Settings toggles

All switches default **off**. Durable idempotency is mandatory even when call-saving switches are off. These savers never bypass lifecycle, coverage or authority checks.

- [x] **Reuse identical judgements:** cache only a successfully validated decision for the same scope/run/segment, frozen input, policy, selected model and artifact. The key includes evidence source range, counters, threshold crossings and envelope revision. Any new failure/repetition count, edit, success or gate change invalidates reuse. Omitting counters could spare an endless loop. Replay job deduplication remains separate and always on.
- [x] **Template redirects:** in this explicit alternative, skip the async writer after a confident stuck judgement and prepare the deterministic text instead; do not first pay for a writer and discard its result. Rule/backstop paths already use a template and save no writer call. Choose a fixed template from measured rule reason codes (repeated identical failure, edit churn, scattered edits, tool errors, over-envelope). Fill bounded redacted counts; no inferred next solution, completion advice or automatic Stop. Do not present regression coefficients as a causal explanation.
- [x] **Novelty gate:** this explicitly selected alternative policy may defer only proposer inference, never the normal per-session fact observation/decay clock or cached rendering. Track its skipped cadence separately from reference `last_propose`. At proposer cadence, compare bounded exact signal tuples (failure→success pairs, uncovered command/runner, contradiction, environment revision) against previously processed evidence, including evidence counts and detector/fact revisions. Missing coverage, contradiction or environment change forces the normal proposer path. Skip only a fully unchanged batch; retain deferred source ranges and run after at most 3 skipped cadences, subject to budget. No inference bypass to force that run.
- [x] **Compact digests:** run-length encode only consecutive identical failures with matching command, targets, status and diagnostic content. Preserve order, first/last IDs, counts, all edits, successes and verification events. Never merge across a progress event, reorder the trace, alter observations/training labels or compact tool definitions. Apply the ordinary output cap afterwards and report coverage.
- [x] Audit samples run the reference judgement without producing extra effects. For a novelty skip, an explicitly budgeted Observe audit may run the proposer to measure missed admitted facts. For digest compaction, compare full/compact judgements on paired frozen cases. Include audit calls in overhead.

**Exit:** with master enabled, Active mode and optional classifiers/savers off, fixtures match the selected reference path and declared host adaptations. Master Off and Observe have separate lifecycle fixtures. Test every switch alone and combined, including no budget, stale cached results, changed counters, non-emitting audits, writer failure and no hidden escalation. Classifier settings never cause a call when the parent mechanism is disabled.

## M11 — Add Settings, overrides and visible status

**Depends on:** M4–M10. **Work:** built-in integration, existing Settings contribution/routes and Agent presentation. Use server-rendered forms and existing persistence/model selectors; add no environment variables or independent configuration system.

### Master switch and policy

- [x] Add **Settings → Token economizer → Enable token optimizer**, default **off**. This installation-wide master switch is an execution gate, not merely a default for new Agents. It overrides workspace/Agent settings and affects existing Agents as well as future ones.
- [x] Keep saved mechanism options while disabled. Enabling defaults to **Observe**, with **Active** requiring explicit selection. Mode remains `off | observe | active` internally; effective mode is always `off` when the master switch is off. Do not silently restore Active on first enable.
- [x] Add workspace and Agent choices **Inherit / Off / Observe / Active** through existing settings layers. Workspace Off also constrains its Agents; an Agent cannot bypass an ancestor's Off. Show effective mode and the source of each override.
- [x] On master Off, immediately prohibit new optimisation jobs, training/folding effects and steering. Cancel queued jobs and request cancellation of in-flight inference where supported. Preserve their reservations/actual usage and recovery definitions; no retries or background "training calls" after disable. Ordinary SDK accounting continues. Off collects no new TE learning samples synchronously. Ordinary SDK transcript recording continues: if that same tracked session is later folded while enabled, upstream learns from its full visible trajectory, including intervals when hooks were disabled. Do not silently filter those intervals or call them new sessions; a permanent do-not-learn interval would be a separately requested privacy policy. Only recovery bookkeeping and accounting for already-started jobs may write automatic TE state while Off. Explicit user Apply/Restore remain available while disabled; these deliberate host policy changes do not start optimizer inference or count as new sessions. Preserve retryable pre-disable fold records without executing them until policy allows; do not silently mark cancelled folds successful.
- [x] Off stops new learning/effects but does not retroactively remove a carried fact section or restore an already-published tool exclusion. Show **Off — previously applied context/tool policy retained**, with explicit Restore controls and cache consequences. Fresh sessions while disabled receive no new fact injection; existing conversations preserve their committed context. Do not reset context or start/restart work merely to disable. An explicit context-removal request uses a safe preparation boundary and is distinct from Off.
- [x] Recheck current policy immediately before every effect transaction; a job created while enabled cannot deliver a redirect or mask after disabling. Persist toggle state across app/workspace reopen.

### Individual controls

| Control | Choices / default | Takes effect |
|---|---|---|
| Micro-skills | Off / Environment / Distilled / Both; Off | Select profile for subsequent folds/fresh injection; carried context retained |
| Proposer cadence | Positive integer, default 3 | Next fold uses current cadence against retained `now`/`last_propose` |
| Environment-fact caps | Facts/tokens, defaults 4/150 | Cached render after next enabled fold; never rewrite a carried section |
| Tool pruning | Off / Propose / Auto; Off | Stop new proposals/publication on Off; existing exclusions remain until explicit Restore |
| Auto quiet window | Minutes, default 60, minimum 0 | Repository-wide quiet condition; pending age still capped at 24 hours |
| Instruction-aware tool judge | None / Generative / Text classifier / Text → Generative; None | Host start/resume preparation; None leaves the live evidence path intact |
| Loop help | Off / Rules / Judge-assisted; Off | Next decision; Off blocks emissions immediately |
| Loop judge | Generative / Text classifier / Text → Generative | Next new job; pending results keep their originating identity; reference confidence is checked against current thresholds on consumption |
| Guard thresholds | Upstream preset and validated pinned overrides | Next eligible tool event, without clearing turn state; no benchmark cap-aware shortcut |
| Redirects per prompt-turn | Positive integer, default 1 | Same upstream per-turn budget; lowering it never refunds already spent redirects |
| Local loop classifier | On/off; Off | Next eligible decision; unready means abstain |
| Allow local stuck authorisation | On/off; Off | Requires an approved high band and active loop help |
| Statistical tool prefilter | On/off; Off | Next session; BM25/statistical keep hints plus approved drop bands |
| Allow local tool drops | On/off; Off | Requires an approved per-tool band; otherwise keep hints only |
| Reuse identical judgements | On/off; Off | Next decision; mandatory replay dedup stays enabled |
| Template redirects | On/off; Off | Next authorised redirect; rule-only mode keeps its reference template |
| Proposer novelty gate | On/off; Off | Next cadence |
| Compact digests | On/off; Off | Next side-call input; never changes the main Agent's history |
| Audit sampling | Enabled at 5% with local classifiers; configurable 0–20% | Only when parent mechanism, master gate and inference budget allow |

- [x] Persist each control independently; disabled parent mechanisms suppress child classifiers/audits regardless of saved child switches. Turning a classifier off returns future decisions to the selected reference path; it does not restore an existing mask or reset learning/session identity.
- [x] Offer compatible **generative** and **text-classifier** model selectors from any configured provider, with per-purpose overrides. A local predictor shows its artifact/feature version, not an inference model selector. Require a backend and call/time budget before enabling any model-backed path, including Observe audits.
- [x] Read effective mechanism configuration at each handler/fold/waiter boundary; a Settings save does not reset clocks, budgets, pending result identity or retained turn state. Show per-session/day limits, reservations, actual/estimated/unpriced usage and job failures. Include Refit and Clear learned classifier controls. Refit requires master enablement and schedules local fitting only; Clear invalidates active weights/indexes without promising erasure of already committed journal history.
- [x] Changing settings never initiates an Agent run, provider probe, reset or deployment. Validate configuration server-side and display pending next-session changes. Do not expose every fit hyperparameter as a Settings field.

### Status and notices

- [x] Register through `registerBuiltinAgentIntegration`; pass host scope, semantic catalogue, environment identity and ordinary model runtime. External CLI agents are outside this integration.
- [x] Show effective mode, session/last fold, facts selected, proposals/applied tools, redirect decisions/queued/consumed counts, inference overhead and unpriced coverage. Distinguish no evidence, waiting for session end/10-minute recovery, Auto awaiting repository quiet/24-hour publication, user approval, no eligible tools and unavailable catalogue.
- [x] Match notice triggers as well as durable delivery IDs: fact injection notices deduplicate by rendered digest within the host/repository; Auto-pending quiet wait is status, not a recurring proposal announcement; changed applied lists, explicit refusals and manual proposals are announced with their reasons. Guard reducer/simulated nudge counts advance at the eligible consumption boundary even in Observe; actual delivered counts remain zero in Observe. No held/replayed decision counts as consumed until such a boundary exists. Auth-pause notices deduplicate by pause revision.
- [x] Show classifier state, label/group counts, active/empty action bands, last fit/version, abstention reasons, skipped/escalated/audit calls and observed disagreement. No "accuracy" badge from training loss or a tiny regression set.
- [x] Provide Apply, Restore and Disable actions with their publication/cache consequences; Restore is sticky and disabling is not restoration. Provide explicit Remove learned context separately if requested; it is never implied by Off. Learning follows host lifecycle automatically; no manual finish/seal control is needed. Deduplicate notices by durable ID. A continued-failure notice offers the existing Stop control; TE never presses it.

**Exit — Settings tests:**

- [x] Fresh master Off without previous effects produces baseline-equivalent requests/tool exposure and **zero optimisation generation, classification, training or audit work** even if child switches were saved on. Disabling an already-modified conversation retains those committed effects; assert no new transformations instead of falsely expecting retroactive baseline equivalence.
- [x] Toggle Off during queued inference, in-flight inference, a pending redirect, a long codemode script and an active pruned session. No new effect is admitted; accounting settles; existing facts/exclusions remain and are reported accurately. Explicit Restore touches only owned exclusions, survives reopen and is not undone by Auto. Reopen preserves Off.
- [x] Test installation/workspace/Agent precedence, all individual switches, invalid model/budget selections, and Off→Observe→Active→Off without implicit turn resets. Include simulated budget consumption, cap/profile changes at fold time and learning from a later enabled fold of the full tracked session. Saving settings alone starts no work.
- [x] Backend/route tests pass without adding UI-test files.
- [ ] Record operator UX acceptance of the Settings/forms/status surface. The isolated preview is available; no browser automation or Desktop workload ran.

## M12 — Verify completion and measured benefit

**Depends on:** all earlier milestones. Passing core fixtures alone does not complete the port.

### Recovery and cache

- [x] Run the upstream focused tests and grow differential fixtures by behaviour coverage (target 200–400 cases). Keep named host adaptations for redaction, pricing provenance, public-API exposure evidence and storage/steering delivery. Each optional saver has its own alternative-policy fixtures. No manual session boundary, stricter green proxy, evidence-and-judge intersection, immediate Auto publication or automatic restoration on Off may hide as an adaptation.
- [x] Exercise every generative/reference path in the generic host and Kintsugi: proposer, loop judge, writer and tool judge. Add classifier contract/cancellation tests, fake-model fault injection and public-API compatibility tests.
- [x] Capture actual provider serialization with network blocked. With unchanged facts, tools and session identity, requests two and three must have byte-identical early prefixes and valid cache-marker placement. This tests request construction, not a real cache hit.
- [x] Close/reopen, fork, rewind and compact. Carried fact snapshots survive correctly; running masks stay stable and start/resume masks follow published policy. Compaction/fork or a published mask change may rebuild caches. Refresh learned fact text only on a fresh start unless context removal is explicit. Test reset during end/fold processing and concurrent scope updates.
- [x] Verify direct and nested tool exposure/restoration, replay-deduplicated codemode receipts, template provenance and long-script detection-to-consumption delay. Codemode is already native; it needs no installation and does not automatically hide direct tool schemas.
- [ ] Run authorised small real-model checks with operator-selected models for every inference path. Verify auth reuse, isolation, output validation and usage. Test actual warm-cache behaviour separately on each supported configuration, above its cache threshold. Unsupported/unverified cache behaviour keeps affected micro-skills opt-in/off.

### Quality and resource evaluation

- [ ] Evaluate rules, generative reference and classifier variants on frozen observations, then held-out repositories/tasks/later sessions. Independently review unsafe/disagreement cases. Include rare needed tools, synonyms without overlap, code/log-heavy prompts, languages outside fit data, intentional retries, changing failures, missing output, secrets and injection attempts.
- [ ] Measure action-band errors with correct denominators/sample counts, recall/delay, abstention/coverage, calibration of action thresholds and restore/task failure rates. A good overall accuracy score cannot excuse a rare destructive drop.
- [ ] Compare paired workloads: **existing codemode-enabled Kintsugi with TE Off**, the same with full reference TE, and the same with each saver/combination. Keep source state, provider/model, cache policy, catalogue, resource limits and verification requirements fixed. A direct-tool-only run is optional counterfactual analysis, not the current baseline.
- [ ] Report execution plus all optimisation/audit/escalation usage, actual inference request fan-out, schema bytes, p50/p95 latency, local CPU/peak memory and task verification quality. `net inference cost reduction = baseline total - candidate total`; unpriced compute is reported separately. Smaller prompts or skipped-call counters alone are not causal savings.
- [x] Test resource caps on representative catalogues and long sessions. TE does not occupy Kintsugi's two interactive 256 MiB codemode workers. Keep bounded sequential execution in constrained workspaces.
- [x] Keep a classifier band inactive if held-out quality, coverage or net benefit is not established. Implementation tests can pass with an unready workspace model; status must say why. Do not auto-enable a band or weaken its safety target to complete the checklist.

### Shipping gate

- [x] Preserve Apache-2.0 attribution and modified-file notices in ported source and distributed artifacts. Record the pinned upstream revision and all native differences. No automatic upstream code/state migration.
- [x] Run focused backend tests, `bun run check` (includes workspace-module generation), and `git diff --check`. Run wider suites in bounded batches. Do not substitute newly written tests for existing regressions.
- [x] Record passing receipts and explicit acceptance limits beside the milestone index before marking it complete. Keep model-backed paths implemented even when users choose inference-free modes. Default remains master Off.
- [ ] Obtain separate approval for commits/pushes, release publication, production changes or real-model spending beyond the agreed checks. This checklist does not perform those actions.

## Source map and verification

Upstream links are pinned to the inspected revision:

- [Stage](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/stage.py), [DomainAdapter](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/domain.py), [live configuration](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/config.py).
- [Fact lifecycle](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/microskills/lifecycle.py), [envfacts](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/microskills/envfacts.py), [observation](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/microskills/observe.py).
- [Live fold/pruning evidence](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/fold.py), [live controller](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/controller.py), [deny-list host support](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/denylist.py).
- [Model-backed distiller](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/microskills/distiller.py), [async judge controller](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/judge.py), [judge/writer prompts](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/loopguard/judge.py) and [tool judge](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/toolprune/tools.py).
- [Loop rules](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/loopguard/rules.py), [turn guard](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/loopguard/turn.py), [Pi bridge](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/plugin/pi/tokeneconomizer.ts).
- [Pricing](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/pricing.py), [ledger](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/ledger.py), [fixture builders](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tests/fixtures/__init__.py).

Kintsugi references: [system prompts](../packages/agent/src/server/system-prompt.ts), [assembly](../packages/builtin-agent/src/server/durable-assembly.ts), [workspace lifecycle](../packages/builtin-agent/src/server/durable-workspace.ts), [runtime reset/Stop](../packages/builtin-agent/src/server/durable-runtime.ts), [bash results](../packages/builtin-agent/src/server/durable-bash.ts), [plan context](../packages/builtin-agent/src/server/durable-plan.ts), [cache projection](../packages/builtin-agent/src/server/durable-prompt-cache.ts), [model-tool accounting](../packages/builtin-agent/src/server/durable-model-tool-usage.ts) and [telemetry](../packages/builtin-agent/src/server/durable-telemetry.ts).

Classifier references: installed pi-ai 1.5.2 `dist/types.d.ts` (`ClassifierContext`, answer/result types) and `dist/models.d.ts` (`Models.classify`). Kintsugi already selects classifier models through its runtime in [provider validation](../packages/llm/src/server/pi-config-models.ts). These establish available interfaces, not classifier quality for TokenEconomizer.

Codemode references: [Kintsugi extension and nested receipts](../packages/codemode/src/server/extension.ts), [worker limits](../packages/codemode/src/server/integration.ts), [call entry types](../packages/builtin-agent/src/server/codemode-call.ts) and [model-free templates](../packages/builtin-agent/src/server/durable-codemode-templates.ts). SDK 1.5.2 `dist/codemode/{codemode,describe}.{d.ts,js}` defines catalogue generation, replay and sandbox inputs; `dist/harness/agent.js` defines direct versus nested-call selection. These establish capabilities and limits, not combined cost savings.

Before implementation, consult the installed SDK 1.5.2 `dist/harness/types.d.ts`, `dist/harness/usage.d.ts`, `dist/harness/live.d.ts`, `dist/types.d.ts` and README. Resolve them through `packages/builtin-agent/node_modules/@earendil-works/pi-durable`; do not assume a newer upstream main has the same contracts.

### Lifecycle conformance audit — fresh second pass

The audit plan was reset before this pass. The following source contracts were checked independently of the earlier review. Apply the live wrapper's guards before its underlying reducer; the standalone stage and optional policies have separate entry points. The implementation receipts above supersede this pre-implementation source audit.

| Area | Required contract, including edge paths | Pinned source |
|---|---|---|
| Session source/identity | Message history forces resume; startup/new without history can be fresh; an empty fork/reload is not automatically fresh. Stable ID survives reopen; new host ID is a distinct fold unit | [Pi bridge](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/plugin/pi/tokeneconomizer.ts) `SOURCE`, `session_start` |
| Context replay | Ordinary section patches retain unrelated keys; null removes TE; compaction replaces the whole section map, so an omitted TE key clears it. Resume never resurrects cached newer facts | Pi bridge `carriedSection`, `before_agent_start` |
| Branch/prompt accounting | Fold only the active visible branch; ignore abandoned user entries and custom optimizer steering in prompt counts; queued follow-up and same-run steer do not open a fresh guard turn | [Pi trace](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/trace/pi.py) `pi_active_branch`, `pi_prompt_count`; Pi bridge `before_agent_start` |
| End/recovery | End schedules a background fold; unknown end with no record/trajectory is ignored; a later start recovers ended/600-second-quiet sessions oldest-first, excluding its own/folded IDs | [Controller](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/controller.py) `session_start`, `session_end`; [fold](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/fold.py) `pending_sessions` |
| Fold outcomes | Busy claim or FoldLater defers without a folded marker; permanently unreadable trajectory records terminal error plus folded marker; exceptions are not successful completion. A resumed folded ID is not re-folded | Fold `fold_session`, `fold_locked` |
| Fold ordering/import | Recovery batches are chronological, not a new global watermark blocking normal ends. Upstream imports block live folds before/after claim acquisition, distinguish imported evidence and avoid inference/automatic policy writes | Fold; [history](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/history.py) `run`, `maybe_start` |
| Live vs stage Off | Live wrapper skips its disabled mechanism; standalone tool-stage `after_task` still records used-ever names with evidence off. Later enabled session folding reads the complete tracked trajectory, not silently filtered Off intervals | Controller `handle`, fold wrappers; [tool stage](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/toolprune/stage.py) `after_task` |
| Fact observation | One mechanism clock tick per update; injected-ID credit is per update and cleared; composition updates environment before distiller. Profile changes preserve stored state; cap changes reach cached render only after a subsequent fold | [Prefix stage](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/microskills/stage.py); [envfacts](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/microskills/envfacts.py) `update`, `seed_injected`, `render` |
| Fact transitions | Disjoint basename sets for code facts, no drift requirement for envfacts; exact CANDIDATE/ACTIVE branch order; firing is separate from promotion, low firing hides without retirement, rendering advances no clocks; retirement terminal; FormRepair contradiction streak survives unexercised gaps | [Lifecycle](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/microskills/lifecycle.py) `update`; envfacts `fold` |
| Proposer | Default live cadence 3 with initial -1 means attempts 2/5/8; parse early return advances clock; absent runner consumes no attempt; failed attempted call does. Retain rolling window, replay admitted facts once, revise contradiction only | [Distiller](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/microskills/distiller.py) `update`, `_maybe_propose`, `_admit`, `_build_fact` |
| Turn opening/closing | Changed input closes interrupted prior turn; missed prompt permits lazy opening on tool result; recursive Stop is ignored where provided; session end closes retained state using host completion signal | Controller `user_prompt`, `post_tool`, `stop`, `session_end` |
| Envelope/signals | Normal nonempty turn needs no passing verifier to be proxy-green; failed verification after last edit disqualifies. Whole-turn snapshot updates on close, not fold. Live path has no benchmark frozen envelope or turn-cap clamp | [Turn guard](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/loopguard/turn.py) `resolved_proxy`; [envelope](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/loopguard/envelope.py) `thresholds`, `record_turn`; [signal state](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/loopguard/state.py) |
| Guard scheduling | No cold-start judgement; adaptive trouble gate, not length alone or fixed 20-call floor. Once gated, poll ready result before new-call gap; empty result returns without replacement; 300-second expiry is event-driven | Controller `_judge`, `post_tool`; turn guard `_background`; [rules](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/loopguard/rules.py) `assess_abort` |
| Writer/results | Reference confident-stuck job attempts writer before publishing, even if budget later spent or turn ended; charge stale/unused output. A backstop/rule redirect without prepared text uses count template, without a new writer call | [Async judge](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/judge.py) `run_job`; turn guard `nudge_body` |
| Redirect/notice | Cumulative backstop precedes judge; reset only segment/pending text/rate state after consumed nudge; retain whole-turn outcome and configured budget. Held decisions spend nothing before consumption; terminal notice stops further decisions, not user work | Turn guard `fold`, `after_nudge`; controller; [hook sequencing](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/hookqueue.py) |
| Observe/shadow | Reducers, learning, simulated nudge budget and terminal state advance without outbound messages. Observe→Active does not reset the turn or refund its simulated budget; distinguish actual delivery counters | Controller `post_tool`, `session_start`; fold |
| Auth failure/recovery | Explicit signed-out response pauses calls; generic errors do not. Pause survives starts; setting micro-skills/guard clears it without initiating work; paused proposer retains observation, reference guard gets no-verdict/backstop | [Side calls](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/sidecall.py) `_no_reply`, `paused`, `resume`; [CLI](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/cli.py) `cmd_config` |
| Live pruning evidence | Zero prompts skips pruning; unknown prompt count contributes one to prompt streak. Used-ever protection persists; known-catalogue streaks advance even under masks. Refresh catalogue only at the reference stage boundary | Fold `_fold_toolprune`; tool stage `after_task` |
| Task pruning/re-audit | Optional stage selection unions trace and judge exclusions for that task; its periodic re-audit returns full catalogue and skips judgement. It is separate from delayed live repository publication | Tool stage `build_tools` |
| Auto waiting | 60-minute quiet uses max of session-record writes (including fold completion) and transcript activity; 600-second fold recovery uses transcript activity. Preserve original pending age until batch ends; 24-hour maximum, one waiter, refresh settings, retain refusal but clear pending | Fold `_hold`, `last_activity`, `apply_pending`; CLI `_wait_and_apply` |
| Explicit Apply/Restore | No Auto wait; restore only owned rules, keep restored items sticky until named Apply. Off retains applied policy/context. Upstream explicit CLI can override names; native hard protection still constrains authorised host changes | CLI; [denylist](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/tokeneconomizer/plugin/denylist.py) `apply`, `restore` |
| Classifier/saver integration | Use the same warm-up, attempt/backoff, pending poll, segment and simulated-budget boundaries; audit work cannot advance live counters. Novelty can skip proposer inference only, not fact-clock/observation updates | M7–M10 are explicit opt-in additions, not upstream classifier implementations |

### Explicit native boundaries — do not label these upstream parity

- **Durability:** SDK commits, idempotent observations and atomic fold effects replace a file-lock/write sequence and a queue that may lose an event on crash. This improves crash guarantees; exactly-once provider billing is still unavailable.
- **Host binding:** new/resume/fork/shutdown/compaction use native Kintsugi logical-session events and public SDK state, with native and M0 conformance tests. A raw Harness close is not automatically a fresh session. Workspaces that cannot run while shut down resume durable jobs later instead of pretending an external worker kept running.
- **Requested controls:** master Off-by-default, an ancestor Off veto, per-call budgets and explicit cancellation of unstarted work are native policies. Upstream layered configuration can override a global default and detached jobs can outlive disabling. Tests must distinguish these policies from unmodified live worker behaviour.
- **Host safety/scope:** provider-independent runtime/auth, hard-protected capabilities, interactive task prompts, redaction, safe detector execution, known catalogue schema checks and one-store/environment isolation replace CLI-specific assumptions. Do not infer benchmark headless tool exclusions or claim cross-store sharing.
- **Task preparation:** the native Settings/API exposes the optional standalone task-judge stage for explicit idle preparation using operator-supplied task prose. It does not infer an admitted task at startup or silently run a benchmark stage on every prompt. Live pruning remains automatic evidence folding and delayed publication.
- **Optional extensions:** local/text classifiers, rule-only selection, templates and saver switches deliberately change call/decision policy when enabled. Every enabled alternative needs named fixtures and accounting. With them off, use the exact selected reference path, not a hybrid of live/benchmark stages.
- **Excluded integrations:** legacy/Python state migration, history import, repository maps, external CLI writers and global clone-state migration are outside this package's current scope. They are not implicitly implemented by replaying a journal. Future imports must obey the source barrier/provenance rules in M2.

### Pre-implementation source-audit receipts

- **365 upstream tests passed, 2 skipped:** an expanded 364-pass lifecycle suite plus the Pi section-replay test. It covers live hooks/config/repos, productive turns, environment/generic micro-skills, hook queues, import barriers and threshold validation.
- **24 additional offline edge probes passed** against real upstream functions, including ready-result polling inside a gap, deferred vs terminal folds, shadow budget persistence, writer call order/cost, two activity clocks, masked-catalogue streaks, active-branch prompt counting and render-vs-retirement state. Calls and worker spawns are faked; no inference was made.
- **11 document/formula checks, 64 lifecycle-clause checks and all 56 source references passed.** Milestone ordering/exit gates and unchanged runtime-file hashes were checked. Receipts are in `/tmp/tokeneconomizer-brief-audit/lifecycle-audit-2/` (`document-checks.log`, `lifecycle-checks.log`, XML test results). These validate the source audit/spec, not a completed TypeScript optimizer.

### Existing evidence — not implementation completion

Earlier investigation recorded 86 focused upstream tests passing and 36 Kintsugi assembly/cache/accounting/codemode tests passing, plus generation/lint/TypeScript checks. Receipts are in `/tmp/tokeneconomizer-brief-audit/`; these test existing foundations, not the proposed port. Upstream collection found 911 core and 397 experiment tests; collection is not execution.

The built-in-only system prompt already states native codemode availability. Existing committed Agent prompts are not rewritten on reopen; external-agent prompts are unchanged.

An offline lexical probe over 13 tool descriptions and 7 hand-written tasks exposed failures on needed tools without word overlap. It supports the keep-only use of lexical matching; it does not benchmark BM25 or the proposed classifiers. Synthetic classifier artifacts have since been fitted in implementation tests. No production classifier or combined TE/codemode saving has been accepted.

This revision changes the design to bounded exact matching, fixed logistic regression, action-threshold validation, and explicit tool-relevance labels. The earlier checklist revision passed eleven offline checks for numeric vectors, classifier gradients, TypeScript contract syntax, milestone structure, authority guardrails and its then-37 source references. The lifecycle audit above adds pinned source links and separate current verification receipts. The logistic fixture converged in 25 iterations to weight 1.633502475. Receipts are in `/tmp/tokeneconomizer-brief-audit/streamline/{verification.log,report.json}`. These are document/formula checks, not runtime acceptance. No live inference, browser workload, deployment or Settings change is part of this documentation revision.

TokenEconomizer is [Apache-2.0](https://github.com/microsoft/TokenEconomizer/blob/81e32e56bb3c4c1b4c9756b429be91e3960116ca/LICENSE). Preserve its licence and applicable copyright/attribution, identify modified ported files and include third-party licence material in distributed package/image artefacts. The checkout contains no separate upstream NOTICE file. Review compatibility with Kintsugi's existing distribution notices before shipping copied/adapted code; do not label the ported material solely as MIT.
