# Kintsugi releases

The app’s **Update channel** follows either the published `latest` image or the image promoted to `stable`. Those image tags remain the publication boundary.

## GitHub Actions

`ci.yml` runs for code-changing pull requests and explicit manual checks; ordinary
branch pushes do not start CI. Version tags invoke it through `release.yml`.
It selects checks from the changed files. Documentation-only changes skip
runtime checks; unknown bases require them. Workflow validation, lint and types
run before browser setup and the full suite. Gateway changes also run cached Go
formatting checks and tests first; unchanged gateway code skips Go setup. Superseded runs are cancelled.
Bun downloads and Playwright browsers are cached; dependencies use frozen locks.
Selection and tests share one runner job to avoid another billed job/startup.
The full suite runs once on AMD64, including installer ownership checks.

`images.yml` builds workspace, System and app images on native `ubuntu-24.04`
and `ubuntu-24.04-arm` runners. It requires successful CI at the exact source
revision. The image workflow is reusable-only; there is no manual publisher. No SSH builder,
QEMU or package-write PAT is required by CI.

Contexts and System bundles are prepared once. Workspace and System builds run
in parallel; app builds follow verified workspace assembly and successful System
checks. Failed native stages cancel the remaining expensive work before promotion.
Published workspace signatures, System content hashes and app commit images are
verified before reuse, so unchanged images skip native jobs entirely. If all
verified images already match `latest`, the promotion job is also skipped.
Missing manifests trigger builds; authentication, network and invalid-manifest
errors fail the run. App dependency installation has its own cached Docker layer.

Dry runs use architecture-specific Actions layer caches with `mode=min` to limit
storage. Publication uses full registry layer caches with `mode=max`, also reading
the dry-run caches. Handoff artifacts preserve file modes and expire after one day.
Disposable Docker build records are removed after each run; logs and short-lived
verification receipts remain. Named jobs and step summaries show selection,
reuse, native builds and promotion.

`release.yml` runs only on `v*.*.*` tag pushes. It validates stable semver and main ancestry, runs full checks and invokes the native image workflow. Immutable version tags are published for all three images. The newest version advances `latest`; `stable` is unchanged. Ordinary branch pushes do not run CI. No package-write PAT or extra environment variables are needed.

Compatibility labels come from `packages/shared/src/system-version.ts`. Both native
slices must agree, and the candidate app/System pair must satisfy the app minimum
before any publication. Promotion advances workspace, System, then app images.
Local app-only publishing also checks the existing System on every target channel.
Publish new System support before making an app require it. Unversioned images are
version 0. Version 1 provides the compatibility foundation; version 2 adds optional
listed-host policies; version 3 adds persistent resource admission and OOM
containment; version 4 adds the optional installation-wide workspace RAM cap.
The app minimum stays at 0, with explicit capability-2, capability-3 and capability-4
gates for listed-host mode, resource controls and the global RAM cap. Version 5 adds editable task defaults and per-workspace process/thread limits. The
network-policy reader stays at 2; the resource-policy reader is now 3. Configured
inspector allocations require reader 1 and System 3; a saved global RAM cap
requires reader 2 and System 4. Configured task defaults or per-workspace task overrides require reader 3 and System 5. App-only and paired preparation/activation/rollback
and installer checks reject incompatible targets without resetting configuration.
Saved custom sources, pins and the retained image-pair protocol are unchanged.

Token telemetry is app-owned and opt-in. It introduces no new System operation or
compatibility-counter change of its own. The current counters, including the RAM
policy and task support above, are System 5, app minimum 0, network-policy reader 2 and
resource-policy reader 3. Updating source does not enable an
exporter or deploy an installation. Its private configuration/checkpoints live in
app data and survive app replacement. An app that predates this feature does not export telemetry;
image rollback is not a settings/checkpoint restore. Provider caching defaults,
custom release sources and pins remain authoritative. The native Pi adapters must
be reviewed when managed CLIs change their recorded accounting format. See the
[telemetry guide](token-telemetry.md), including its known native-record limitations.

Built-in code mode adds journal bookkeeping and executable task definitions to the
app, not a new System operation. Stop active code-mode scripts before downgrading
to an app that predates this tool: an older registry must not be assumed to resume
those tasks. Image rollback preserves journals; it does not restore old session
data.

The token optimizer is app-owned and off by default. It adds journal documents,
background tasks and a private settings file in app data, not a System operation
or compatibility-counter change. An older app opens journals written with it and
leaves its background tasks waiting. Older apps cannot restore tools the optimizer
has hidden from an Agent: restore them in **Settings → Token optimizer** before
downgrading.

`packages/shared/src/publishing.ts` also owns image source attribution. Standard
app, System, workspace and patched-runtime builders stamp its `imageSource` value;
source-checkout metadata wins when build tooling lives in another checkout.
Manifest reuse rejects missing or foreign source labels. Direct Dockerfile builds
must supply the same `org.opencontainers.image.source` label before publication.
Changing attribution does not alter the workspace runtime-content signature;
source labels are checked separately during reuse.

Both native slices must pass smoke tests before their receipts are merged.
Every combined manifest, source/signature label and pinned workspace dependency
is verified before any `latest` tag changes. Tagged source must remain on main;
only the newest semantic version advances `latest`. Promotion is serialised and never
cancelled halfway through. **Channel changes are not atomic:** an error after one
tag advances requires inspection or rerunning the same publication. `stable`
is never advanced automatically. The manual **Promote verified release to stable**
workflow requires a published release, successful tagged CI at its exact source,
and all three independently verified manifest digests. It verifies both native
slices, compatibility and the workspace pin before moving only `stable`, sharing
the publication lock without rebuilding or deploying. Complete clean-install,
update and rollback acceptance before promotion.

Automatic publication is enabled in `rcarmo/kintsugi` after successful native
builds, smoke tests and GHCR publication of all three dual-architecture manifests.
Re-running publication reuses verified images without native builds. This does
not deploy or restart an existing installation.

Verification on 10 October 2026: [full CI](https://github.com/rcarmo/kintsugi/actions/runs/38050978303)
passed 1,854 tests with 39 skips in one 2m26s job; [native image verification](https://github.com/rcarmo/kintsugi/actions/runs/38047362949)
passed on both architectures. [Unchanged publication](https://github.com/rcarmo/kintsugi/actions/runs/38051386289)
skipped all native builds, manifest assembly, promotion and the result/cleanup job.
These are observed runs, not timing guarantees.

## Local release command

The existing local command uses a two-daemon SSH builder. This requirement applies
to local release tooling only; GitHub Actions uses its own native runners.

```sh
bun run release             # latest
bun run release --stable    # latest and stable
bun run release --check     # validate the builder without publishing
bun run release --prepare   # upload/verify immutable images, change no channels
bun run release --revision <full-sha>  # publish a pinned main-branch revision
```

The release command targets `origin/main`, `ghcr.io/rcarmo/kintsugi:latest` and
immutable commit/staging tags. `--stable` also advances `stable`; complete VM
acceptance before using it. `--check` may be combined with `--stable` and never
publishes. `--prepare` builds and uploads verified commit/workspace images without
changing channels or creating a GitHub Release; it cannot be combined with
`--stable` or `--check`. `--revision` selects an explicit full SHA that must be an
ancestor of main. Upstream releases use their own repository. Kintsugi retains its
version-tagged GitHub Actions publication and does not adopt upstream's separate
`stable-<id>` release-tag scheme.

App, System and workspace images retain a pinned upstream runtime dependency.
`images/patched-docker/publish.sh` can publish a fork runtime separately; commit
any updated multi-platform digest pins before releasing.

For the VM test, publish this branch's app and separately publish its System image
as `ghcr.io/rcarmo/kintsugi-system:latest` (`images/system/publish.sh` moves latest); this release command
publishes only the app and its workspace dependency. Use the branch's installer
(which defaults to latest images) and record both tested image digests. The new
installation starts empty: do not mount Atelier storage or import its settings.
Test installation, workspace creation/parking, updates, restart and uninstall
before promoting to stable. Publishing to the renamed repositories does not
replace the public Atelier installer or advance Atelier's update tags.
`--uninstall` removes Kintsugi data. The fork installer refuses automatic removal
of a legacy Atelier installation.

Use `KINTSUGI_*` environment and build-argument names. Existing `ATELIER_*` names
remain compatibility aliases; an explicitly set Kintsugi name takes precedence.
Data locations, namespaces, labels and saved identities do not change, and Kintsugi
does not adopt upstream installation data.

Local publishing requires the existing `GH_PACKAGE_TOKEN` with GHCR package write access.
Docker, Buildx, Bun and Git are required and supplied by the Kintsugi workspace.
The release CLI runs on Linux and macOS; it calls the native OS locking API through
Bun rather than requiring a `flock` executable. No GitHub Actions or host Docker
socket is needed.

### Local builders

Set `KINTSUGI_RELEASE_HELPER=builder@hostname` (or an SSH config alias). The helper
must allow noninteractive SSH with an already trusted host key, and its SSH user
must have Docker access. It must run Linux on the opposite architecture from the
local Docker daemon: arm64 for an amd64 workstation, or amd64 for an ARM laptop.
Both daemons need registry access. Missing, unreachable, or wrong-architecture
helpers fail before publishing; there is no emulation fallback.

The command fetches `origin/main` and records its exact SHA. It uses the integrated
Docker BuildKit builders (`docker` driver) for the current Docker context and a
persistent SSH context derived from the helper destination. No separate BuildKit
container is created. Inside Kintsugi this preserves the patched daemon's EROFS
snapshotter and shared-cache configuration.

Every invocation checks both daemon architectures and builder drivers, then exercises
COPY, RUN (including `uname -m` verification), and local image export on each node.
The probe image is `kintsugi-release-probe:check` on each daemon. `--check` stops
here: it fetches Git and may pull the Ubuntu probe base, but never logs into or
writes to the registry. It does not prove write credentials or that a full
application build succeeds.

A real release builds an isolated detached worktree of that SHA, not your working
files, and removes the worktree afterward. Your branch and local edits are left
alone. It uses the existing image-building script to reuse/build the deterministic
workspace image and upload the app as `ghcr.io/rcarmo/kintsugi:sha-<full-sha>`.
Each image is built and pushed in two native slices, with `-amd64` and `-arm64`
staging tags, then combined by digest into a multi-platform manifest. The workspace
manifest is assembled first so both app slices pin the same workspace digest.
Channel tags are not passed to the build. An existing commit image is reused, not
overwritten, and its two architectures and revision labels must pass verification.
Rerunning after a completed upload therefore skips the application rebuild.

Before promotion, the local command fetches main again and verifies it still
contains the selected release commit. Fast-forward commits do not change the
pinned build; rewritten history stops promotion. The verified digest is promoted
to latest (and stable with `--stable`) and checked against the registry.
Channel updates are **not atomic**. Status records each channel separately. A
failed promotion may have reached the registry even if its response was lost;
there is no automatic rollback. Inspect the tag/digest or rerun the same release.

An OS lock prevents overlapping releases from the same Git common directory,
including linked worktrees. **It is not a distributed lock:** do not run releases
from two independent workspaces simultaneously. Do not run local publishers
concurrently with CI publication. Concurrent local publishers could promote out
of order and leave latest on an older commit. Tagged GitHub publication separately
serialises promotion and only lets the newest semantic version advance latest.

Build caches remain with each Docker daemon. SSH contexts and probe images are
retained for reuse. The script does not provision Docker or modify the helper's
storage configuration.

### Local progress

The script is an ordinary foreground CLI: stdout is live and simultaneously saved.
It needs neither tmux nor Kintsugi to function. For long runs in Kintsugi, start it
in a persistent tmux session, **present that session with Kintsugi's `present`
tool**, and read the status file periodically. Screenshots are unnecessary.

```sh
tmux new-session -d -s kintsugi-release 'cd /work; bun run release; result=$?; printf "\nRelease exited %s\n" "$result"; exec bash'
```

The agent then calls `present` with `kind: "tmux", session: "kintsugi-release"`.
For evaluation without publishing, use `bun run release --check` instead.
The interactive shell keeps the final transcript visible; the log/status files
remain the authoritative result if the session closes. Ctrl-C interrupts a running
release and forwards termination to its command group; rerun to recover.

At startup the CLI prints absolute log and status paths. Each run has a directory
under Git's common directory, `kintsugi-releases/<timestamp>-<pid>/`, containing:

- `release.log`: complete live command output (including ANSI phase headings).
- `status.json`: atomically updated phase, elapsed seconds, commit, builder,
  requested channels, individual promotion outcomes, digest and error. A heartbeat
  updates it every five seconds while a command is busy.
- `probe/`: build context for the non-publishing builder smoke checks.

Find the latest invocation without knowing its timestamp:

```sh
common=$(git rev-parse --path-format=absolute --git-common-dir)
run=$(cat "$common/kintsugi-releases/last-run.txt")
cat "$run/status.json"
tail -n 20 "$run/release.log"
```

A successful check ends in `state: checked`, a successful release in `published`,
and handled failures in `failed`. Channels stay `pending` in check mode. If the
process is forcibly killed, a stale heartbeat with `state: running` is not evidence
that it is still alive. Logs are local to the workspace; preserve them externally
if needed. Credentials go only to Docker login's stdin, never command arguments.
