# Kintsugi

[![Kintsugi](docs/icon-256.png)](docs/icon.png)

Kintsugi runs coding agents on your own server, with your choice of model providers and tools for checking their work. It is an opinionated fork of [AgentsInTheCloud](https://github.com/lucasmeijer/AgentsInTheCloud), originally created by Lucas Meijer.

The name comes from **金継ぎ**, the Japanese art of repairing pottery with gold: the original project joined several components together well, and this fork honours that approach. [This blog post](https://taoofmac.com/space/blog/2026/10/10/1200#a-coding-environment) explains the motivation.

Kintsugi accepts direct pull requests without a prior issue. See [Contributing](CONTRIBUTING.md).

## What Kintsugi adds

- **Agents:** editable per-Agent plans shared through the `plan` tool; native code mode with slash templates, one-shot agents and subagents; a Background view for delegated work; full-text search over Agent history.
- **Token savings:** an opt-in [token optimizer](#token-optimizer); stable prompt prefixes, append-only plan context and Codex WebSocket delta reuse; cache-hit reporting; optional [Graphite telemetry](#token-telemetry).
- **Workspaces:** live RAM, swap, CPU and task limits; out-of-memory protection; usage and restart diagnostics; sidebar CPU, RAM and I/O charts, collected continuously for System and all unparked workspaces, even with no browser open. Home and Settings stay usable when a workspace hangs.
- **Networking:** trusted LAN access through Caddy TLS with 1,000 preview origins; opt-in private-network access with exact host and port grants; a scoped [management API](#management-api).
- **Credentials and Git:** an instance credential catalogue with per-template grants and proxy-side substitution, so Agents only see placeholders; a [Gitea](#git-hosting) connection.
- **Files:** Draw.io editing, CSV/TSV tables, and read-only DOCX, Excel/ODS and PPTX views.
- **Providers:** classifier-only credentials; Copilot, Codex and OpenCode Go usage tracking.
- **MCP:** HTTP/OAuth servers shared across selected or all workspaces, with per-workspace Agent restrictions; workspace-bound stdio servers and bounded result recall.
- **Updates:** a host updater with rollback, custom release sources and version pins; tag-only releases with native AMD64 and ARM64 images.
- **Browser connection:** WebSocket live updates with an SSE fallback, chosen per browser in Settings, for browsers that can't hold a WebSocket (for example iOS with a self-signed certificate).

## Install

The current release is [v0.7.1](https://github.com/rcarmo/kintsugi/releases/tag/v0.7.1) ([release notes](release_notes/v0.7.1.md)). Use a dedicated Linux server with Docker:

```sh
curl -fsSL https://raw.githubusercontent.com/rcarmo/kintsugi/main/scripts/install.sh -o /tmp/install-kintsugi.sh
bash /tmp/install-kintsugi.sh --action install
```

Setup asks for the app image repository (default `ghcr.io/rcarmo/kintsugi`) and your Tailscale machine name. On hosts without EROFS, add `--storage-driver overlayfs`; it uses more disk, and the driver can't be switched later. On Linux with systemd, setup also installs the host updater (skip it with `--no-updater`).

For local or private images, unattended setup and LAN access, see [automation](docs/automation.md). Releases publish images and advance `latest`; `stable` is promoted separately, and publishing never updates an installation.

## Update

Use **Settings → Check now → Download update → Restart to update**. Installation updates interrupt running workspaces, so finish active work first. Saved release sources and pins win; choose **Latest** to follow new releases.

A few changes need a one-time manual step. Older installations with the ten-port preview pool, external Caddy files or manually applied Docker caps should follow the [automation guide](docs/automation.md). Before downgrading, stop running code-mode scripts and restore any tools the token optimizer has hidden; older versions can't restore them. See [releases and downgrades](docs/releases.md).

## Token optimizer

The token optimizer provides context pruning, learned facts and loop detection for built-in Agents and their subagents. It is **off by default** and experimental. Turn it on in **Settings → Token optimizer**:

- **Watch only** records observations and proposals without automatically changing Agent context. **On** applies eligible facts on the next request, including during an ongoing session.
- **Basic** (recommended) remembers facts about each repository, nudges runs that keep repeating the same failures, and suggests hiding tools that never get used. It makes no extra model calls.
- **Model-assisted** adds a model that writes facts, judges stuck runs and picks tools for each task, within per-session and daily call limits.

Learning checks completed tool results between replies; you do not need to close the Agent. Model proposals have separate evidence and cooldown limits. Safe, grounded facts from either source become eligible automatically after independent evidence checks. Each completed user-request run is one evidence group; tool retries cannot add votes. Facts share count and estimated-token limits.

Inspect full claims, evidence and eligibility blockers directly in the transcript. **Confirm** is optional; **Wrong** and **Stale** exclude a fact from later requests. Held-fact rows open automatically; other optimizer rows start collapsed. Feedback applies to the next request, and negative feedback prevents rejected advice returning from an older learning result. Reviews survive journal compaction and reopening. Settings also lists accumulated facts and lets you mark them all stale.

Each Agent's composer footer shows a small status chip while the optimizer is on; click it for what was learned, hidden or nudged, and to restore hidden tools. The cost and quality effects of Model-assisted have not been measured yet. It is a TypeScript port of Microsoft [TokenEconomizer](https://github.com/microsoft/TokenEconomizer); see the [design checklist](docs/token-economizer.md).

## MCP connections and recall

In **Settings → MCP servers**, configure an HTTP server once and use the searchable picker to grant selected workspaces and their Agents access. **All workspaces** includes future workspaces and all their Agents. Stdio servers stay bound to one execution workspace.

Endpoint edits persist with a blank password field. Saved credentials stay bound to the old endpoint until you replace them or explicitly approve reuse; a changed connection may need enabling again. OAuth URL changes require a new sign-in.

Saving a connection writes MCP settings version 2, which v0.6.8 and earlier cannot read. Keep a pre-upgrade backup if you need to downgrade.

MCP connections support tool and resource discovery, including resource-only servers. Servers that advertise tool-list changes can refresh their tools without reconnecting or replaying calls.

Per-server recall settings control retained tool results: **Off** blocks capture and access, **Watch** retains originals, and **On** also shortens large MCP output sent to the model. Scripts keep full values. Sensitive tools and detected secrets are excluded; recall makes no model calls. Turning it off preserves unexpired copies. Retention and storage limits apply to each conversation's recall index; reads do not extend retention, and forgetting or expiry does not erase the source journal.

## Git hosting

Kintsugi adds Gitea alongside GitHub, GitLab.com and Bitbucket Cloud. In **Settings → Git hosting**, enter one server's HTTPS URL (custom ports and subpaths work) and a personal access token. The server certificate must be trusted by the host.

Tokens never enter Agent sandboxes: the egress proxy substitutes them only for the configured origin. Connecting a private server does not grant LAN access or SSH trust; configure [network permissions](docs/automation.md#exact-private-tcp-destinations) separately.

## Management API

An optional JSON management API supports host-local or LAN automation without Tailscale. It is **disabled by default**; configure listeners and scoped tokens with `apps/web/scripts/admin-bindings.ts`. Every request, including `GET /openapi.json`, needs `Authorization: Bearer <token>`. The `security` scope can issue tokens, so grant it sparingly.

Non-loopback listeners require TLS. The installer publishes no admin ports unless you pass `--admin-publish`; Docker publications can bypass host firewalls, so bind them to a trusted interface. Agent prompting, commands and terminals are not exposed. See [admin setup](docs/automation.md#optional-authenticated-admin-bindings).

## Token telemetry

**Settings → Token telemetry** exports token and cache counts, cache-hit percentages and available cost estimates to a trusted Graphite server over Carbon TCP (port `2003`, every 15 minutes). Metric paths follow [PiClaw](https://github.com/rcarmo/piclaw): `kintsugi.<instance>.usage.<provider>.<model>`. Prompts, replies and tool output are never sent, and estimates are not billing. See the [telemetry guide](docs/token-telemetry.md).

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run web
```

Internal packages use `@kintsugi/*`. Containers run as `agent:agent` (UID/GID 1000, aligned with the host at startup). Configuration uses `KINTSUGI_*` environment variables; the older `ATELIER_*` names still work, with Kintsugi names taking precedence.

## Attribution and licence

Kintsugi derives from [AgentsInTheCloud](https://github.com/lucasmeijer/AgentsInTheCloud) by Lucas Meijer, under the original copyright and [MIT licence](LICENSE). The token optimizer is a modified port of Microsoft [TokenEconomizer](https://github.com/microsoft/TokenEconomizer) under the Apache License 2.0. Classifier-only credentials, OpenCode Go usage tracking and microphone improvements come from [Larry Hudson's fork](https://github.com/larryhudson/AgentsInTheCloud), with his authorship retained. Other attributions are in [NOTICE](NOTICE).
