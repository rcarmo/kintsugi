# Kintsugi

[![Kintsugi](docs/icon-256.png)](docs/icon.png)

Kintsugi is an opinionated fork of [AgentsInTheCloud](https://github.com/lucasmeijer/AgentsInTheCloud), originally created by Lucas Meijer. It runs coding agents on your own infrastructure, with your choice of model providers and tools for evaluating their work.

## Features

Kintsugi adds the following to upstream AgentsInTheCloud:

### Direct contributions welcome

**Kintsugi accepts direct pull requests**, without a prior issue or invitation. We respect [upstream’s separate contribution policy](https://github.com/lucasmeijer/AgentsInTheCloud#contributing); this fork welcomes external PRs for review and possible merge. See [Contributing](CONTRIBUTING.md) for scope, verification and attribution guidance.

### Plans, credentials and history

- Editable per-Agent plans in a Work pane, shared with the agent through the `plan` tool. Live updates preserve drafts; saving does not start work.
- An instance credential catalogue with explicit template grants, write-only values and proxy-side substitution. Agents receive only granted metadata and placeholders.
- Native FTS search over committed history and completed output, with bounded saved-log indexing and source references.

### Workspace controls and safety

- Workspace Properties with usage/peaks, desired/effective limits, OOM/restart diagnostics, live RAM/additional-swap/CPU edits and staged network settings.
- Finite installation/workspace limits, shared workload boundaries, host/management headroom and persistent OOM circuit breaking. Workspace caps may overlap; they are not memory reservations.
- Home and Settings remain accessible with stopped or hung workspaces. Pane failures stay local, and deliberately stopped workspaces stay stopped.
- Bounded Changes reads and on-demand repository scans, so closed Changes views do not block workspace startup.

### Networking and deployment

- Trusted LAN proxy access with Caddy TLS, persistent publications and a configurable pool of 1,000 retained preview origins (`41000–41999`).
- Opt-in LAN/private-network access, exact private TCP host/port grants, CIDR groups and DNS/mDNS forwarders, with management/peer exclusions, DNS pinning and security-scoped settings.
- Unattended installation, OverlayFS support for kernels without EROFS, and a scoped token-authenticated management API with private bootstrap-token delivery.
- Custom Docker release sources, private GHCR authentication, version pins and retained-pair rollback. The host updater coordinates app/System updates; installer replacements preserve finite resource caps.
- Tag-only releases with verified native AMD64/ARM64 images, staged checks, shared build caches and selective CI.

### Tools and provider extensions

- A configurable Gitea HTTPS connection, including custom ports and installation subpaths, with credentials restricted to its exact origin.
- An embedded Draw.io editor and diagram previews with page tabs.
- Code mode slash templates, bounded one-shot agents and a unified Background view for delegated work and Claude workflows.
- CSV/TSV table previews with filtering and source editing.
- Read-only Work panes for DOCX, Excel/ODS and PPTX files.
- Extended Copilot quota reporting and corrected Copilot/Codex calendar-month pacing, plus OpenCode Go five-hour/weekly usage and monthly-exhaustion availability checks.
- Opt-in [Graphite token-consumption telemetry](#token-consumption-telemetry) with per-provider/model counts, cache percentages and available cost estimates, using PiClaw-compatible metric paths.
- Classifier-only provider credentials for code mode and Pi, and microphone release when dictation stops, adapted from Larry Hudson’s fork.

The name comes from **金継ぎ**, the Japanese art of repairing pottery with gold, because the original project was a brilliant way to glue together several components and I wanted to honor that approach.

> You can read [this blog post](https://taoofmac.com/space/blog/2026/10/10/1200#a-coding-environment) for the motivation behind this fork.

## Installation

The current release is [v0.4.9](https://github.com/rcarmo/kintsugi/releases/tag/v0.4.9); see the [release notes](release_notes/v0.4.9.md). Releases publish app, System and workspace images and advance `latest`; `stable` is promoted separately. Publishing does not update or restart an installation.

Use a dedicated Linux server with Docker. The installer defaults to `ghcr.io/rcarmo/kintsugi` and `ghcr.io/rcarmo/kintsugi-system`; matching images must be available before installation.

```sh
curl -fsSL https://raw.githubusercontent.com/rcarmo/kintsugi/main/scripts/install.sh -o /tmp/install-kintsugi.sh
bash /tmp/install-kintsugi.sh --action install
```

EROFS is the default. For a fresh installation on a host without EROFS support, use OverlayFS:

```sh
bash /tmp/install-kintsugi.sh --action install --storage-driver overlayfs
```

OverlayFS uses more disk space and initial provisioning I/O. Updates retain the selected driver; in-place switching is unsupported. See [storage requirements](docs/automation.md#installer-setup-update-and-rollback) for kernel and image compatibility.

On Linux with systemd, setup installs the private host updater by default. Settings uses **Check now → Download update → Restart to update** for System, the app and workspace image dependencies. Existing installations need one host-installer update from a release containing the service. `--no-updater` skips it; macOS and older installations retain app-only updates.

Setup asks for the app image repository and Tailscale machine name. System defaults to the app repository with `-system` appended. For locally built or separately named images, use `--app-image` and `--system-image`. Private GHCR sources accept `--registry-config FILE`. See [automation](docs/automation.md) for source selection, updates and rollback.

For unattended setup and LAN access, follow the [deployment instructions](docs/automation.md#trusted-lan-proxy-deployment-v002). Use the installer from the selected release tag, with matching app and System version tags. Cloning the repository does not install a running service.

## Upgrading an existing installation

Use **Settings → Check now → Download update → Restart to update** for a normal update. Saved release sources and explicit pins remain authoritative; select **Latest** if you want to follow new releases instead of a pinned version. Installation updates interrupt running workspaces, so finish active work first.

An app or normal installation update cannot rewrite an external Caddyfile. Installations still using the old ten-port preview pool need a one-time coordinated [installer and Caddy update](docs/automation.md#recover-an-exhausted-preview-range) to expand their saved range to `41000–41999`. Keep the existing origin assignments; origins are not recycled.

Generated Caddy configuration keeps TCP preview port 41641 available while disabling HTTP/3 on that listener, leaving UDP 41641 for Tailscale. Merge its listener options into your existing global Caddy block, preserve unrelated sites and settings, then validate and reload. An app update does not apply this change to an existing Caddyfile.

For installations with manually applied Docker resource caps, use the new release’s host installer once to preserve those settings through the first replacement; an older installed updater may still use its older installer. See [workspace properties and resource protection](docs/automation.md#workspace-properties-and-resource-protection). Subsequent updates preserve finite limits. Saved inspector allocations require resource-aware images; unsafe downgrades are refused without resetting them.

Stop active code-mode scripts before downgrading to an app that predates code mode. Image rollback preserves journals; it does not restore old session data. See [release and downgrade guidance](docs/releases.md).

## Git hosting

Kintsugi adds Gitea alongside upstream’s GitHub, GitLab.com and Bitbucket Cloud connections. Open **Settings → Git hosting** to configure it.

For Gitea, enter one server's HTTPS URL and personal access token. Custom ports and installation subpaths are supported, and the Git username comes from the validated account. The certificate must be trusted by the host. No additional Gitea CLI is installed.

Provider tokens stay outside Agent sandboxes. Workspaces receive placeholders that the egress proxy substitutes only for permitted destinations; Gitea credentials are restricted to the configured HTTPS origin, including its port. Connecting a private server does not grant workspace LAN access or automatically trust its SSH key. Configure [network permissions](docs/automation.md#exact-private-tcp-destinations) and SSH trust separately.

## Management API

Kintsugi provides an optional token-authenticated JSON management API for host-local or LAN automation without Tailscale. It is **disabled by default**. Configure listeners and issue scoped tokens with `apps/web/scripts/admin-bindings.ts`.

Scopes cover workspace lifecycle, templates and shared configuration, secrets, SSH configuration, host diagnostics, and release/update management. Every request, including `GET /openapi.json`, requires `Authorization: Bearer <token>`. The `security` scope grants administrative power, including issuing tokens; grant it sparingly.

Non-loopback listeners require TLS, including listeners published through Docker. The installer publishes no admin ports unless explicitly requested with `--admin-publish IP:HOST_PORT:ADMIN_PORT`. Docker publications can bypass host firewall rules: bind to a trusted interface and enforce network filtering. See [admin setup and permissions](docs/automation.md#optional-authenticated-admin-bindings) for configuration, certificates, token storage and revocation.

The normal app also supports JSON representations of UI operations for agents and Work views. Those use the app's existing access boundary and require a matching `Origin` on mutations; this CSRF check is not authentication. Agent prompting, arbitrary commands and terminal access are not exposed through admin listeners.

## Token consumption telemetry

Available from v0.3.5. **Settings → Token telemetry** configures opt-in Carbon plaintext TCP export (default port `2003`, 15-minute intervals) to a trusted Graphite server. Only new recorded consumption is collected; provider caching defaults remain unchanged.

[PiClaw](https://github.com/rcarmo/piclaw)-compatible paths under `kintsugi.<instance>.usage.<provider>.<model>` carry token/cache counts, token-weighted cache percentages and available API-equivalent cost estimates. Estimates are not subscription charges. Prompts, replies and tool output are not exported. Pi tools, compaction and branch summaries without reliable model attribution retain their counts in explicitly labelled `unattributed.pi_*` buckets, never under the parent model.

See the [telemetry guide](docs/token-telemetry.md) for the metric schema, agent/accounting coverage, Graphite aggregation, private storage, API permissions and bounded retry behaviour. Missing native records cannot be reconstructed; this is not complete billing reconciliation.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run web
```

Internal packages use `@kintsugi/*`. Container accounts are `agent:agent`, with `/home/agent` as their home. The app uses UID/GID 1000; workspace startup aligns the numeric IDs with the host process to preserve shared-volume ownership. Existing `ATELIER_*` environment variables keep their names for compatibility.

## Attribution and licence

Kintsugi derives from [AgentsInTheCloud](https://github.com/lucasmeijer/AgentsInTheCloud), originally created by Lucas Meijer. The original copyright and [MIT licence](LICENSE) are retained. Third-party attributions are in [NOTICE](NOTICE).

Classifier-only provider credentials, OpenCode Go usage tracking and microphone lifecycle improvements were adapted from [Larry Hudson’s fork](https://github.com/larryhudson/AgentsInTheCloud). His authorship is retained in the imported commits.
