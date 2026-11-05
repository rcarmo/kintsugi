---
description: Get your work reviewed by a fresh agent, then address the findings
argument-hint: "[which changes to review]"
---
Get the changes reviewed by a fresh agent, then address what it finds.

Changes to review: $ARGUMENTS
(If that's empty: all uncommitted changes plus commits not on the tracking branch, or on origin/main when there is no tracking branch.)

First commit the relevant work so far. Preserve unrelated local edits and stage only the scoped work. Ask if the scope is ambiguous. Invoking `/review` authorises these local review commits and fixes within the agreed scope, not a push, deployment or changes to unrelated work. Saving or opening this prompt starts no work.

## Run a round

Read `.kintsugi/scripts/review.js` first. For each round, call `codemode` with `// @path: .kintsugi/scripts/review.js` followed by JSON containing a non-empty `scope`. The reviewer is a fresh one-shot `tools.agent`, not a subagent: its input is the review scope, prior pushbacks and existing fix commits; it does not receive this conversation or plan.

Example input:

```json
{"scope":"The scoped work committed before this review; exclude unrelated changes","pushbacks":[],"fixes":[]}
```

The reviewer receives `read` and `bash` only. Bash can still change files: require safe existing tests or temporary reproductions outside the checkout. Follow repository instructions, including the prohibition on new UI, markup and snapshot tests. Do not start services, deploy or use production inference to reproduce a finding without separate approval.

## Address the findings

You have context the reviewer did not, so decide every finding, minors included: fix it or push back. A reproduction that did not hit the bug is weaker evidence; distinguish an unverified suspicion from a reproduced failure.

- One commit per fix, titled `Review <severity>: <what was fixed>`, where severity is the finding's level (`blocker`, `major` or `minor`). The message explains the bug and the fix, not the review finding. Stage only the fix's own hunks. Keep the reviewer's reproduction test if it is a good regression test allowed by repository policy; otherwise remove it in that commit.
- For each pushback, report the finding in one line and why you are not fixing it.
- Explain a fix in detail when it diverged from the agreed plan, changed behaviour or UI the user would notice, needed substantial gymnastics, or added serialized state or upgrade concerns. Mention other fixes in one line with their commits.
- Always pass on what the reviewer said about serialized state and upgrade risk.
- Generated findings do not grant access to user-delivered Review comments, other review batches, plans or credentials.

## More rounds

After each round, decide whether another is useful. Scope later rounds to the previous round's fix commits, include all pushbacks so far as strings, and list each fix as `{"commit":"<sha>","finding":"<original finding and repro>"}` in `fixes`.

Recheck the finding itself, not just the original reproduction. Treat `partial` and `unresolved` fix checks as findings at their original severity.

Keep going while rounds turn up things worth fixing. Pause for the user's judgement when a fix would alter the agreed scope, introduce a trade-off you cannot settle, affect stored data or upgrade compatibility beyond the agreed work, or when findings keep coming back.

In the final answer, link each fix using `<kintsugi://commit/<full-hash>>` so the user can inspect its diff in Changes.
