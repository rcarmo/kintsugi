---
description: Review scoped changes with a fresh one-shot agent
argument-hint: "[which changes to review]"
---
Review the requested changes with a fresh agent, then report the findings.

Requested scope: $ARGUMENTS

If the scope is empty, identify the changes belonging to this task, including relevant uncommitted work and commits not on the tracking branch. Preserve unrelated local edits. Ask me if the scope is ambiguous; do not commit work to establish a review boundary.

## Run one explicit round

Read `.kintsugi/scripts/review.js` first. Call `codemode` with `// @path: .kintsugi/scripts/review.js` followed by JSON containing a non-empty `scope`. The script calls one fresh `tools.agent` reviewer. Its input is the review scope, prior pushbacks and existing fix commits; it does not receive this conversation or plan.

Example input:

```json
{"scope":"Uncommitted changes for the current task; exclude unrelated pre-existing edits","pushbacks":[],"fixes":[]}
```

The reviewer receives `read` and `bash` only. Bash can still change files: require safe existing tests or temporary reproductions outside the checkout. Follow repository instructions, including the prohibition on new UI, markup and snapshot tests. Do not start services, deploy or use production inference to reproduce a finding without separate approval.

## Report before changing anything

Explain blockers and majors with the reproduction attempted and whether it actually hit the issue. Distinguish an unverified suspicion from a reproduced failure. Include minors, all newly serialized state and all upgrade or migration risks, even when no code change is proposed.

Decide whether each finding is valid, but do not automatically apply fixes. Present proposed fixes and pushbacks for my approval unless the work is already explicitly authorised. A proposed fix does not change the agreed plan or grant access to user-delivered Review comments.

Never automatically stage, commit, push, stash, reset or switch branches as part of `/review`. Saving or opening these files starts no work.

## Further rounds

Run another round only when requested or covered by an explicit multi-round approval. Pass prior pushbacks as strings and existing fix commits as `{"commit":"<sha>","finding":"<original finding and repro>"}` entries in `fixes`. Do not create commits for the review script. For uncommitted fixes, describe them and their original findings in `scope` and omit commit entries.

Recheck the finding itself, not just the original reproduction. Treat `partial` and `unresolved` fix checks as findings at their original severity. Pause for judgement if a fix would alter the agreed scope, introduce a trade-off or affect stored data or upgrade compatibility.
