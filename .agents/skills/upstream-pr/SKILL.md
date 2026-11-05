---
name: upstream-pr
description: Prepares a pull request that upstreams a fix to a third-party project, optimized for the upstream maintainers' convenience. It includes a minimal user-level repro, before/after videos where useful, and a fix written in upstream's own style, and leaves the PR's intro for a human to write. The PR is opened on the user's own fork first for review. Use when upstreaming a fix or patch to a dependency or open-source project, or when the user asks to open a PR or report a bug upstream.
---

# Upstream PR

Optimize everything in the PR for the upstream maintainers' convenience.

- **Follow upstream's rules first.** Read their contributing guidelines, PR template, and AI-contribution policy, and look at what recently merged PRs do. Where they conflict with this skill, they win.
- **Repro.** Make it minimal, and keep it as close as possible to how a normal user would use the product. Confirm it still fails on their latest version. Put it inline in the PR if it fits reasonably. Otherwise, use a mini public repo.
- **Videos.** If it makes sense for this repro, record one that feels like a person showing a maintainer the bug, with subtitles at the top so they don't overlap GitHub's playback controls. After the fix, record the same repro again in the same style.  The video should feel like there's a human walking you through a repro case.
- **Fix.** Follow upstream's code guidelines, and adopt the surrounding code's style, comment verbosity, and naming patterns. Add tests only where their codebase would, following their patterns.

## PR description

In this order:

1. **Optional human intro.** Leave any personal introduction for the human author to write. No fixed introduction is required; do not invent one or speak in the user's name.

2. A short description of the bug from the user's point of view.
3. The videos, if any. Reference each one in the body file as `![](./before.mp4)` and pass `--attach ./before.mp4` to `gh pr create` or `gh pr edit`. gh uploads the file and replaces the reference with the video's URL, which GitHub shows as a player.
4. As much detail as is useful for the maintainer and their coding agent.

If it's true, say that we're running with this patch and it's working for us.

## Where the PR goes

Open the PR on the user's own GitHub fork first (within the fork, against its default branch), so a human can review it and edit the intro. Never open anything against the upstream repository without an explicit request.
