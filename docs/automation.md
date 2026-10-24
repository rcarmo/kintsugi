# Automating Kintsugi

Kintsugi's web UI operations also provide compact JSON representations for agents and scripts. They are the same operations used by the Turbo UI, not a separate REST implementation.

## Discovery

The authoritative contract for the running instance is:

```http
GET /openapi.json
```

Discover available Agent types with `GET /agent-types`; the response contains `agentTypes` and `defaultAgentTypeId`. Agent summaries identify their implementation with `agentTypeId`.

Inspect it without loading the whole document into context:

```sh
curl -s http://localhost:3000/openapi.json | jq -r '.paths | keys[]'
curl -s http://localhost:3000/openapi.json | jq '.paths["/workspaces/{id}/commands/{commandId}"]'
```

Send these headers for JSON operations:

```http
Accept: application/json
Content-Type: application/json
Origin: http://localhost:3000
```

Mutations and WebSocket upgrades require `Origin` to match the destination's public origin (scheme, hostname, and port). Use `http://localhost:3000` when accessing localhost, or your actual Tailscale URL, such as `https://machine.tailnet.ts.net`. Origins are resolved per request; no allowlist is needed. Missing, foreign, and `null` origins return a plain-text `403` before dispatch. Other application errors use `{ "error": { "code": "...", "message": "..." } }`.

The check uses the request URL's hostname and port, not forwarded-host/public-origin metadata. Only loopback connections may supply `X-Forwarded-Proto` (`http` or `https`) for TLS termination. Nested ingress translates same-origin requests and preserves foreign-origin denials.

This is CSRF protection, not authentication. Keep management unreachable from untrusted containers and untrusted HTML on separate origins or opaque-origin sandboxes. Token-authenticated agent MCP and turn-boundary endpoints retain their separate policy.

## Installation networking

UI access and workspace outbound permissions are configured separately. Localhost access limits UI entry to the installation computer; Tailscale provides tailnet access; proxy mode trusts clients that can reach the configured LAN reverse proxy. Optional admin bindings use their own bearer-token and scope checks.

See the [ingress and egress diagrams for each LAN setting](workspace-network.md#ingress-and-egress-by-lan-setting): Off, Local LAN and Routed private networks. Each has its own editable Draw.io source and shows UI/preview ingress alongside workspace outbound access and DNS. Admin port publication does not enable workspace LAN egress.

## Optional authenticated admin bindings

Admin bindings are a separate JSON-only management API for host-local or LAN automation without Tailscale. They are disabled by default. Every request, including `GET /openapi.json`, requires `Authorization: Bearer <token>`. These listeners do not use browser `Origin` authentication; the existing UI ingress retains its CSRF policy.

### Direct host process

Run the CLI as the **same OS user and with the same data directory as the app**:

```sh
umask 077
# /secure/bindings.json: {"bindings":[{"host":"127.0.0.1","port":3443}]}
bun apps/web/scripts/admin-bindings.ts configure --file /secure/bindings.json
# /secure/token-input.json: {"name":"automation","scopes":["configuration","secrets","workspaces","host:read","security"]}
bun apps/web/scripts/admin-bindings.ts issue --file /secure/token-input.json > /secure/issued-token.json
```

`--data-dir PATH` selects another app data directory. `admin-bindings.json` contains listener configuration and only token hashes, with mode `0600`. `show` lists metadata; `revoke TOKEN_ID` applies to subsequent requests without restarting. The issued bearer secret is returned once: capture it privately, never put it in a URL or commit it. Optional expiry must be a future UTC ISO timestamp such as `2030-01-01T00:00:00Z` or `2030-01-01T00:00:00.000Z`. Other date formats, timezone offsets and impossible dates are rejected.

Direct process loopback listeners may use HTTP. Every non-loopback listener requires TLS. Use a certificate whose SAN matches the hostname/IP clients use, issued by a CA those clients trust. For a private/self-signed CA, use the client's explicit CA trust option (e.g. curl `--cacert`), not disabled certificate verification.

### System installation: nested Docker and TLS

The app container is managed by **System's inner Docker daemon**, not the host daemon. From the installation host, use:

```sh
docker exec kintsugi-system docker exec --user 1000:1000 \
  kintsugi bun /app/apps/web/scripts/admin-bindings.ts show
```

Place input JSON and TLS files under the app's persisted `/data/app`. On the host, that directory is inside System's `kintsugi-system` volume. Commands executed in System can access `/data/app` directly. Files should belong to UID/GID `1000:1000`; use `0700` for the TLS directory and `0600` for the private key and configuration. The CLI refuses a different UID in the managed app container. Listener startup also rejects private keys readable by group/others. Certificate files must be readable by the app; `0600` is suitable. Do not print key contents.

A container binding for either host-only or LAN publication is:

```json
{"bindings":[{"host":"0.0.0.0","port":3443,"tls":{"cert":"/data/app/admin-tls/cert.pem","key":"/data/app/admin-tls/key.pem"}}]}
```

Host-only and LAN publication are separate from that inner binding:

- **Host-only:** `--admin-publish 127.0.0.1:3443:3443`
- **LAN:** `--admin-publish 192.168.1.10:3443:3443` (replace with the host's LAN IP)

Use those repeatable options with the installer **only for `--action install` or `--action update`**. The format is explicit IPv4 `HOST_IP:HOST_PORT:ADMIN_PORT`. Updates preserve existing publications from Docker's persistent `HostConfig.PortBindings`, even if System is stopped. Supply replacement mappings to replace the set, or `--no-admin-publish` to remove all admin publications. Removal and replacement cannot be combined. `open`/`connect` reject publication options rather than silently ignoring them.

Both System publication modes require TLS: the inner listener is non-loopback within **System's** network namespace even when the host publishes only on loopback. This differs from direct-process localhost HTTP. There is no plaintext exception for Docker publication.

**Exposure warning:** Docker publications can bypass host firewall policies such as ufw. Bind to a specific trusted interface and enforce network filtering; do not rely solely on an ordinary host firewall rule. Publishing to `0.0.0.0` covers every host IPv4 interface, possibly including public interfaces, and requires `--allow-admin-all-interfaces`. No admin port is published by default. Reserved UI, supervisor and preview ports cannot be published through this option.

### Restart, certificate renewal and recovery

Binding changes return `restartRequired: true` and apply on the next app startup. An empty bindings array disables the API then. Certificates are read at startup; renewal also requires an app restart. **In System, restart only the inner app**:

```sh
docker exec kintsugi-system docker restart --time 30 kintsugi
```

This interrupts UI/API connections and in-flight management/provisioning work; it does not replace workspace containers. Check active operations first. Restarting/updating **System** is broader and interrupts running workspaces too. Docker publication changes need System container replacement through installation/update, not merely an app restart. Do not update a live installation to experiment.

Invalid configuration, missing/unreadable TLS files, bad certificates or bind failures disable the admin listener set and produce a local error, while leaving normal UI startup available. Correct configuration through the local CLI and restart the app. If an older/root-owned or corrupt configuration cannot be read, back it up locally without displaying it, correct ownership/mode (`1000:1000`, `0600` in System), or move the corrupt file aside and bootstrap fresh. Fresh configuration invalidates previous tokens. If the app is stopped, start it without usable admin configuration so the UI is available, then use the CLI; the CLI is not an API dependency. Keep local Docker/OS administration available as the recovery path.

### Contracts and permissions

Send `Content-Type: application/json` for all mutations, including `{}` for operations without fields. Unknown fields and invalid nested payloads are rejected before dispatch. `/openapi.json` documents the same runtime body schemas and scopes. UI routes, previews, arbitrary commands, agent prompting and terminal WebSockets are excluded. SSH public-key responses are `{ "publicKey": "..." }`.

| Scope | Operations |
| --- | --- |
| `configuration` | Template creation/update/deletion and preload images; template and global environment variables |
| `secrets` | Template and global secret creation/update/deletion |
| `workspaces` | List/inspect/create/rename/park/unpark/delete, provisioning recovery, warning dismissal |
| `workspaces:force-delete` | Additional permission for explicit forced deletion; also requires `workspaces` |
| `host:read` | Host availability, bounded diagnostic samples and System status; no terminals or raw supervisor logs |
| `security` | Privileged mode, credential seeding, Dockerfiles, template/global SSH keys and trust, System access mode, installation/workspace network settings, admin binding/token management |

Template and global configuration reads are shared by `configuration`, `secrets`, `security` and `workspaces` tokens and include environment values, never plaintext managed secrets/private keys. Changing an existing configured secret's environment name, placeholder, host destination or path policy requires a nonempty `secretValue` to be supplied again, atomically replacing the value; otherwise the operation returns `409 workspace_template_secret_routing_changed` without altering storage. Annotation-only edits and rotation at the same destination do not require knowledge of the old value. These restrictions also apply to the normal UI's secret edits. A supplied replacement may differ from the old value: this prevents rerouting an unknown existing credential, not authorized replacement of it.

`security` remains administrative power: it can mint any scopes and enable privileged containers. Scope separation does not sandbox repository setup, Dockerfiles or code run during workspace creation. Do not give lifecycle/configuration tokens to parties who must not launch repository code.

Shared workspace settings are also available on admin listeners under `/global-workspace-settings`:

| Method | Path suffix | Permission |
| --- | --- | --- |
| GET | (none) | Any of `configuration`, `secrets`, `security`, `workspaces` |
| POST | `/environment`, `/environment/{variableId}`, `/environment/{variableId}/delete` | `configuration` |
| POST | `/secrets`, `/secrets/{secretId}`, `/secrets/{secretId}/delete` | `secrets` |
| POST | `/ssh-keys`, `/ssh-keys/{keyId}`, `/ssh-keys/{keyId}/delete` | `security` |
| GET | `/ssh-keys/{keyId}/public-key`, `/ssh-known-hosts` | `security` |
| POST | `/ssh-known-hosts` | `security` |

Use the same JSON bodies as the corresponding template routes. A GET on the base returns `{ "globalWorkspaceSettings": { "environment": [...], "secrets": [...], "sshKeys": [...], "sshKnownHosts": "..." } }`; use those record IDs to update/delete entries. This read includes environment values and SSH/secret metadata, never private keys or secret values. UI editor paths and `viewTemplate` query parameters are not part of the admin API. Global Dockerfiles, privileged mode, image preloads and credential seeding are deliberately not exposed: upstream defines these per template, not globally.

These settings include empty/non-template workspaces. Template-local environment variables and secrets override global entries with the same name; rotating a global secret does not overwrite such overrides. Global secret rotation affects subsequent proxied requests from existing workspaces, and global SSH keys are authorised live. Environment variables and trusted SSH server configuration are applied during workspace preparation; ordinary updates do not rewrite existing container environments. For a bulk migration, inspect global settings, update records by ID, then separately create/retire workspaces as required. There is no atomic bulk migration operation, and deleting a template-local entry reveals any inherited global value; deleting a global entry leaves template-local entries unchanged.

Additional operations: `GET/PUT /admin/bindings`, `GET/POST /admin/tokens`, `DELETE /admin/tokens/{tokenId}`, `GET /host/status`, `GET/POST /settings/access`. Token issuance returns `{ token, secret }` once; revocation requires `{}`. System access reads/changes require `security` and return `authUrl` when Tailscale sign-in is needed. Treat that URL as sensitive; open it manually and poll access status to complete login. `host:read` status never returns it or raw logs. Standalone instances return `503` for System-only operations. Diagnostic probes are read-only and bounded, but their output is operationally sensitive.

### Workspace network settings

`GET/POST /settings/network` manages installation LAN CIDRs, external DNS forwarders and search domains. `GET/POST /workspaces/{id}/network` reads or saves a persistent `off`, `lan`, `private` or `hosts` mode. All four operations require `security`. Workspace responses distinguish desired mode, applied policy and `restartRequired`; changes apply after parking and unparking the workspace, which closes terminal and VS Code views.

See the internal [workspace network policy](workspace-network.md) documentation for payloads, DNS/mDNS requirements, enforcement, state files and regression commands. Runtime LAN permissions require System and default to Off; enabling them does not change admin/UI exposure or Tailscale routing.

### Workspace properties and resource protection

Open the gear beside a workspace to inspect its **Properties**, including a stopped workspace. Inspection does not start its container. The dialog shows desired/Docker/effective cgroup limits, current/peak memory, additional swap, CPU use/quota, OOM and exit/restart history, capacity/headroom, network policy, addresses and declared/published ports. Container environment variables and command arguments are omitted.

Resource controls require System compatibility 3. The normal UI uses the private System management path; the browser never receives a Docker socket. Admin JSON reads and writes both require `security` scope:

```http
GET /workspaces/{id}/resources
POST /workspaces/{id}/resources
Content-Type: application/json

{"memory":1073741824,"additionalSwap":0,"cpus":1.5,"acknowledgeMemoryReduction":false}
```

The UI uses MiB; JSON uses bytes and CPU cores. `additionalSwap` is extra swap, not Docker’s total RAM-plus-swap value. Zero disables it. Legacy unlimited values are labelled; each new limit must be finite and fit the installation's per-workspace maximum. RAM, additional swap and CPU caps may overlap across workspaces; they are limits, not reservations. Other-workspace limit sums are informational, not subtracted from available capacity. A reduction below current or unknown usage needs explicit acknowledgement because it can kill processes. Supported changes apply live without a restart. Failed applies retain desired settings, report actual settings separately and wait for an explicit retry or a stopped-workspace apply.

Network changes use the existing Off/LAN/private/listed-host model. Saving changes desired state only. Park/unpark applies policy and closes terminal/VS Code views. Installation-wide LAN CIDR, DNS-forwarder and search-domain edits have a separate confirmation and can affect other workspaces on their next park/unpark. Private hosts, management/peer exclusions and DNS pinning retain their existing checks.

New installation defaults leave a quarter of allocatable host RAM/CPU outside System. Initial System sizing accounts for other host services already using memory. System preserves management memory and a hard aggregate workload boundary; the per-workspace RAM maximum leaves room for source reads and image builds. Individual defaults are up to 2 GiB RAM, no additional swap, up to four CPU cores and 1,024 PIDs, reduced on smaller installations. Each additional swap limit must fit the shared finite workload swap capacity, but their sum may exceed it. Workspaces are not refused or parked merely because summed caps exceed shared capacity. Actual usage remains bounded by the parent cgroup. These caps do not reserve memory against unrelated unlimited host services growing later.

Finite Docker limits are retained through installer replacement and rollback. New System also establishes and records a finite runtime boundary when an older installer supplied none. If an existing installation has manual `docker update` caps, run the current release’s host installer once rather than relying on an older installed updater to preserve the exact prior settings. This interrupts workspaces and follows saved repositories/pins:

```sh
curl -fsSL https://raw.githubusercontent.com/rcarmo/kintsugi/v0.3.3/scripts/install.sh \
  -o /tmp/install-kintsugi-v0.3.3.sh
bash /tmp/install-kintsugi-v0.3.3.sh --action update
```

The updater also installs its owned early tmpfiles rule on startup, so an older installer copying a new updater does not leave the boot-directory race unresolved. No fresh physical-host reboot acceptance is implied by the isolated tmpfiles/boot tests.

OOM or repeated child OOM observations stop and park the workspace, disable automatic Docker relaunch and persist the failure across service/container recreation. Explicit unpark after a 60-second cooldown acknowledges a retry. Deliberately stopped workspaces stay parked during recovery; inspection and home-page loading do not restart them. Other workspaces and Settings remain reachable when one workspace is stopped or unresponsive.

Configured inspector limits carry resource-policy reader version 1. App-only preparation/activation, paired planning/rollback and the installer refuse images that cannot honour them; System 3 is required. Missing labels mean reader zero. This does not change the network-policy reader format (2), the default app minimum (0), release sources or pins. Image rollback preserves configuration; it does not restore old settings. Use compatible images rather than deleting desired limits to force a downgrade.

### Audit and request limits

`admin-audit.jsonl` uses admission/completion records joined by `requestId`. It records token ID, **transportPeer** (the socket peer, possibly Docker's proxy rather than the original client), method, route template and status. Forwarded client headers are never trusted. Payloads, raw URLs, bearer secrets, sign-in URLs and diagnostic output are omitted.

Audit storage is bounded to about 1 MiB plus one 1 MiB `.1` backup; rotation serializes concurrent writes. Rejections are aggregated per status, at most once a minute (suppression counts are included when the next sample is written). Requests are limited to 120/minute per transport peer and 600/minute per process, with a bounded peer map; `429` includes `Retry-After: 60`. A Docker proxy can cause clients to share one peer budget. These are application resource bounds, not protection against network-level denial of service.

If admission logging fails, the API returns `503 audit_unavailable` **without executing the operation**. If completion logging fails after execution, the original response is preserved with `X-Admin-Audit-Warning: completion-record-unavailable` and a local error is reported: do not retry a successful mutation merely because of this warning. Server errors retain their machine-readable code while replacing sensitive diagnostic messages. Mutations accept at most 1 MiB of JSON.

For reproducible integration verification on a development machine with Docker, build local app/System/workspace images, then run `bun scripts/verify-admin-bindings-system.ts --app APP_IMAGE --system SYSTEM_IMAGE --workspace WORKSPACE_IMAGE`. It creates a uniquely named disposable System, tests a separate client container, nested CLI, TLS, real System endpoints, startup isolation and stopped-container port persistence, then removes its containers/volume. It never targets an existing installation. It needs several GiB of free disk for the inner image store. This verifies Docker network access, not reachability or firewall policy from a separate physical LAN machine; verify that deployment-specific boundary separately.

Template environment changes still apply to new containers. Existing secret placeholders resolve to rotated credentials on subsequent proxied requests; existing connections may need reconnecting.
## Tagged releases

Ordinary pushes to `main` or other branches do not start CI. Code-changing pull requests run checks; docs-only and `.github`-only pull requests are skipped. Version tags always run the full checks through the Tagged release workflow, even when their commit only changes documentation or workflows. Manual CI remains available for deliberate validation checkpoints.

Create the first release from a committed, verified `main` revision:

```sh
git push origin main
git tag -a v0.0.1 -m "Kintsugi v0.0.1"
git push origin v0.0.1
```

The Tagged release workflow validates a `vMAJOR.MINOR.PATCH` tag on main, runs full lint/types/tests, then builds and smoke-tests native AMD64/ARM64 images. It publishes all three images with the version tag and creates a GitHub Release only after successful verification. Existing version tags cannot be overwritten with different image digests. Only the newest version tag advances `latest`; `stable` is unchanged. No deployment occurs. Re-run a failed tagged workflow rather than moving its tag.

Release [`v0.0.1`](https://github.com/rcarmo/kintsugi/releases/tag/v0.0.1) passed [tagged CI](https://github.com/rcarmo/kintsugi/actions/runs/38062757227): 1,905 tests passed, 39 skipped, and native AMD64/ARM64 image checks passed. All three versioned images and matching `latest` manifests are anonymously pullable and declare EROFS/OverlayFS support. Full OverlayFS lifecycle acceptance on an EROFS-free ARM host has not been verified.

## Exact private TCP destinations

Global and per-template settings expose a **Listed private hosts** editor. The JSON
endpoints are `GET/POST /global-workspace-settings/private-network-access` and
`GET/POST /workspace-templates/{workspaceTemplateId}/private-network-access`, with
`{"privateNetworkAccess":["db.internal:5432","192.168.1.20:22"]}`. Admin bindings
require `security` scope for both reads and writes. Lists are kept separately from
legacy template records and are omitted from general discovery summaries.

Saving a list grants nothing. Select workspace network mode `hosts` (**Listed hosts
only**) explicitly, then park/unpark the workspace to apply it. This optional mode
requires System compatibility version 2. The app minimum remains 0 because this
is an optional, explicitly gated feature. App images advertise network-policy
format support separately with `org.kintsugi.network-policy-version`. Existing
Off, Local LAN and routed-private
modes retain their previous semantics. Off permits public internet only.

The applied snapshot combines global and template entries and resolves names
through the workspace DNS view. Addresses are pinned until the next park/unpark;
list, forwarder and search-domain edits remain pending. Protected ranges, local
control services and peer bridges override all entries. Public internet remains
available. Tailnet, metadata, loopback and multicast destinations remain blocked.

The firewall enforces exact private IP/TCP-port tuples. The proxy additionally
checks the hostname and uses the same pinned addresses. Native applications can
reach another service name on an allowed IP/port; the kernel cannot enforce a
hostname. A DNS failure leaves the previous policy authoritative and does not
partially apply the new grants.

Listed-host snapshots are a newer stored policy format. Image rollback does not
restore settings: turn Off and park/unpark **every affected workspace** before
selecting images that cannot read this format. New planners, activation and
rollback checks refuse incompatible images while desired/applied listed-host
state remains. The matching installer also checks this before replacement; use
the current installer for recovery. No release or deployment is implied by
saving settings or pushing source code.

## App and installation compatibility

`packages/shared/src/system-version.ts` defines the installation API contract. The
System image advertises `org.kintsugi.system-version`; app images advertise
`org.kintsugi.required-system-version`. Missing labels identify existing version-0
images. Malformed version labels fail validation. The numeric compatibility
version is separate from the image tag or digest in `releaseSource.systemVersion`.

The initial support release advertises version 1 while the app still requires
version 0. System version 2 adds optional listed-host policies; app images advertise
`org.kintsugi.network-policy-version` for reading that stored format. Publish support before raising the app minimum. These counters do not
claim upstream's private-network operations or its saved repository format.

Paired updates check candidate versions before download and inspect the prepared
images again before replacement or retained-pair rollback. App-only updates check
the running installation. An older metadata API that cannot report an app's
requirement leaves it unknown and directs the user to the installer; it does not
claim the target requires version zero. The app and supervisor also check
requirements before activation. No check rewrites saved repositories or pins.

Publication verifies both native architectures and candidate compatibility before
writing version or channel tags. Channel promotion advances installation services
before the app. Local app-only publication checks the selected channel's existing
System image first. The stored update-plan protocol remains unchanged.

## Fork release sources

The updater and host installer consume the persisted release selection below. Only pushed version tags publish verified app, System and workspace manifests; ordinary branch CI never publishes images. Upstream-sync automation is not configured. Installer install/update requires a System image carrying `kintsugi.installer-config=1`, built from this branch; an incompatible image is rejected before the existing System is stopped. A retained older System image can still be restored with installer rollback.

System-managed installations store release selection in `/data/app/update.json`. Stable and Latest follow the configured repositories using their corresponding tags. Choosing either replaces active version pins without resetting the repositories. Custom shows the repository and version fields; these fields are hidden for Stable and Latest. Existing saved version pins remain unchanged until a channel is explicitly selected. Custom never silently falls back to the default source. Invalid settings disable updates without preventing the app from starting.

Update settings endpoints (also available on admin listeners with the `security` scope):

- `GET/POST /settings/release-source`: read or replace both GHCR or Docker Hub repositories and optional pins. Saving selects Custom.
- `POST /settings/update-channel`: select `{"channel":"stable"}`, `{"channel":"latest"}`, or `{"channel":"custom"}`.
- `GET/POST/DELETE /settings/release-registry`: inspect credential availability, store package read credentials, or remove them. POST takes `{"username":"github-user","token":"package-read-token"}`; no read operation returns credentials.
- `GET /update/status`: inspect update state and `updateScope` (`installation` or `app`).
- `POST /update/check-now`, `/update/start`, `/update/restart`: check, download, then restart to apply the selected update. Send `{}` for these mutations.
- `POST /update/rollback`: with the host updater, restore the recorded System/app image pair after validating it against installer history. Without it, restore only the previous locally retained app image. Workspace dependencies must still be present. Custom images with mutable dependency tags do not restore old aliases; use immutable dependency references for reliable rollback. Neither operation rolls back stored app data.

A release-source body contains:

```json
{
  "appRepository": "ghcr.io/example/kintsugi",
  "systemRepository": "ghcr.io/example/kintsugi-system",
  "appVersion": "v1.2.3"
}
```

`appVersion` and `systemVersion` accept a tag or `sha256:` digest. Omit a custom version to follow Latest. Public Docker Hub sources use an explicit `docker.io/owner/name` repository; private authentication currently supports GHCR only. Source changes invalidate the prepared installation plan. A successful save remains successful even when the subsequent registry check fails; `/update/status` reports that failure. System resolves the app and its declared dependency metadata before pulling immutable references; it retains the previous app image before replacement for recovery.

Private GHCR credentials live in System's `/data/supervisor/docker-auth/config.json` (mode `0600`, directory `0700`), outside the app/workspace bind mounts. Registry token requests cannot redirect. Recognised signed blob-storage redirects receive no registry bearer token. The installer reuses saved GHCR auth for host pulls from its private configuration on the physical host when running as root; explicitly supplied credential files remain supported. It never sends those credentials to workspace containers.

### Default host updater

On Linux with systemd, the installer enables `kintsugi-updater.service` by default. The existing **Check now → Download update → Restart to update** controls resolve immutable app and System images, prepare workspace image dependencies, and replace the whole installation. Downloads do not replace running containers. Restart interrupts workspaces but retains their saved data, storage driver, proxy configuration and published ports. Dependency downloads do not rewrite user-installed workspace packages or explicit workspace image/template selections.

The root service owns physical-host Docker. System receives only the private `/run/kintsugi-updater/control.sock` directory, mounted read-only; neither System nor the app receives physical-host Docker's socket. State is root-private in `/var/lib/kintsugi-updater`. Packaged code lives in `/usr/local/lib/kintsugi-updater`. Interrupted operations are reported as failed rather than resumed blindly. A failed replacement attempts recovery only when installer history matches the recorded previous image pair. Recovery restores images, not data; incompatible persisted data may still require host intervention.

Existing installations need one reviewed host-installer update from a release containing this service, with matching app/System images and `--confirm-replace`. This change is not present in previously published releases. Do not point an old installer at an unpublished version. The Host terminal in Kintsugi is inside System, not the physical OS; run this one-time enablement through the physical host's terminal or SSH.

Use `--no-updater` to skip service installation and its socket mount, for example in disposable fixtures or non-systemd environments. macOS remains app-only. Without the service, Settings explicitly reports that web updates replace only the app. An installed but unavailable service fails closed rather than silently using app-only replacement.

Inspect the physical host with `sudo systemctl status kintsugi-updater.service` and `sudo journalctl -u kintsugi-updater.service`. Subprocess failures are recorded in root-private `/var/lib/kintsugi-updater/diagnostics.log`; do not copy this file into public bug reports without reviewing it for secrets. Normal unattended setup also needs permission for the service's file installation and systemd commands, not just module loading.

The disposable native updater fixture exercises the existing JSON controls, real System/app replacement, reconnect, retained-pair rollback, saved data/storage/source selection, proxy publications and the private read-only socket boundary:

```sh
bun scripts/verify-installation-updater.ts --app LOCAL_APP --system LOCAL_SYSTEM \
  --workspace LOCAL_WORKSPACE --out updater-receipts.json
```

Use matching locally built images. Registry resolution/pulls are mapped to preloaded local image IDs; this is not a private-registry network or systemd installation test. Native AMD64 replacement/reconnect/rollback passed locally. Default service installation, root-private file permissions, app discovery and socket relay after unit restart also passed in a disposable native Linux/systemd host analogue. Physical ARM acceptance remains unverified.

### Installer setup, update and rollback

Fresh installations default to shared EROFS layers, requiring host-kernel EROFS and OverlayFS support. Use `--storage-driver overlayfs` when EROFS is unavailable. This selects containerd's OverlayFS snapshotter for System, workspaces and the isolated repository builder. The installer attempts to load only the selected mode's filesystem modules; containers cannot supply missing host-kernel drivers. OverlayFS also needs compatible backing storage and working nested mounts.

```sh
bash scripts/install.sh --action install --storage-driver overlayfs
```

OverlayFS preloads stream complete native-platform OCI archives, then register the native image manifest using a small metadata archive. Only containerd starts during preloading. Existing native images skip repeat transfers, and builds/runs can work offline after preparation. Each daemon stores its own image layers; the shared EROFS cache is not mounted in this mode. Expect more disk use and initial provisioning I/O.

Selection is persisted in `/data/supervisor/storage.json` and the host System container's `kintsugi.storage-driver` label. Updates and rollback retain it. Changing an installed backend is rejected; there is no snapshot conversion or error-triggered fallback. OverlayFS requires matching images labelled `kintsugi.storage-drivers=erofs,overlayfs`; incompatible replacement images fail before existing services are stopped. No new environment variables or Btrfs backend are introduced.

Fresh setup prompts for a **release image repository** and a **Tailscale hostname**, including when localhost access is selected. The repository is an app Docker repository, not a Git URL. System defaults to the matching repository with `-system` appended. For example, `ghcr.io/example/kintsugi` selects `ghcr.io/example/kintsugi-system`. Use `--system-image` when the two repositories have different names. The hostname is a short machine name: 1–63 lowercase letters, digits or hyphens, without a tailnet domain.

```sh
bash scripts/install.sh --action install
# Or supply the setup answers:
bash scripts/install.sh --action install \
  --source-repository ghcr.io/example/kintsugi \
  --tailscale-hostname cloud-home
```

These selections are persisted in `/data/app/update.json` and `/data/supervisor/state.json`. Tailscale receives the hostname on login; an already connected node is updated with `tailscale set --hostname`. Setup does not connect to a tailnet without the existing sign-in flow.

For private GHCR setup, add `--registry-config /secure/docker-config.json`. The file must contain an inline `auths["ghcr.io"].auth` entry (base64 of `username:package-read-token`) and no credential helper configuration. Keep the original file private (`0600`); base64 is not encryption. The installer copies only the GHCR auth entry into System. Subsequent updates reuse that saved entry, or an explicitly supplied replacement file. Existing host Docker authentication remains available when no System/explicit registry configuration is present.

```sh
bash scripts/install.sh --action update
bash scripts/install.sh --action rollback
```

Update reads the saved source even when the app is unavailable. It downloads and pins System, validates its installer capability, and pulls/inspects the selected app and its declared workspace dependencies before stopping the existing System. An existing stopped System is started only to prepare images. A preparation failure does not replace the container. The prepared immutable app ID is handed to the new System for startup and retained until health succeeds.

Explicit `--app-image` and `--system-image` overrides also work on existing installations. GHCR/Docker Hub overrides update the saved Custom source and tag/digest pin; local image references are deliberate one-off overrides and must already be available to the corresponding Docker daemon. A local app override must exist in System's inner daemon, not merely in the host daemon.

`/data/supervisor/installer.json` retains the previous host System ID and app ID. Rollback uses those local images without registry pulls; it fails if the pair is not retained. It preserves the current hostname, settings, data and admin publications. It does not roll back stored data or restore mutable dependency aliases; release images should declare content-addressed workspace dependencies. No automatic upstream fallback or automatic rollback is performed.

Verification: `bun run check`, focused server tests, and `bun scripts/verify-admin-bindings-system.ts --app LOCAL_APP --system LOCAL_SYSTEM --release-updates`. Add `--installer-system LOCAL_NEW_SYSTEM` to exercise real host installer replacement and rollback against a disposable older System. The integration checks TLS admin access, credential isolation, and two-version app/System replacement/rollback, including hostname, source and publication persistence. Real private GHCR publication and authenticated private image downloads have not been tested.

Local installer/update/rollback integration used `linux/amd64`. OverlayFS verification includes real System/app/workspace creation, source/credential isolation, update/rollback persistence and no EROFS mounts. Run `bun scripts/verify-admin-bindings-system.ts --app LOCAL_APP --system LOCAL_SYSTEM --workspace LOCAL_WORKSPACE --storage-driver overlayfs --release-updates --installer-system LOCAL_SYSTEM` against locally built images. `bun packages/workspace/test/overlay-storage.integration.ts LOCAL_WORKSPACE` separately verifies complete native transfers, offline run/build/cache mounts, locally built preloads, warm reuse and restart; existing EROFS runtime integration also passes. A real EROFS-free ARM SBC kernel remains an acceptance target. GitHub Actions builds and smoke-tests fork app, System and workspace images natively on `linux/amd64` and `linux/arm64`, then publishes verified Latest manifests. ARM64 installer/System end-to-end acceptance has not been performed. See [releases](releases.md) for CI selection, caching and promotion guards.

## Present a workspace

Workspace, Agent, and Work-view destinations are browser-navigable surfaces:

```text
/workspaces/:workspaceId
/workspaces/:workspaceId?agent=:agentId
/workspaces/:workspaceId?workView=:key
```

The `agent` and `workView` parameters may be combined to choose both sides of the desktop workspace. Use `GET /workspaces/:workspaceId` with `Accept: application/json` to discover the available Agent IDs and the `key` of each Work view.

## Present workspace template settings

Workspace template settings has a browser-navigable surface that agents can pass directly to their presentation tool:

```text
/workspace-templates/:workspaceTemplateId/settings
/workspace-templates/:workspaceTemplateId/settings?section=environment
```

Supported sections are `index`, `general`, `secrets`, `ssh`, `environment`, and `container`. The index lists the five settings sections; each section opens a focused page in the complete Kintsugi shell. Use `editor=new` or a record ID for Secrets, SSH keys, or Environment Variables, and `editor=docker`, `images`, or `dockerfile` for Container. Legacy section links (`repository`, `ssh-keys`, `privileged`, `dockerfile`, `preload-images`, and `danger`) still resolve to their corresponding pages.

**Secrets** manages protected credential entries shared with a template's Workspaces. Agents receive placeholders; real values are substituted into requests to allowed hosts. Secret changes apply to existing Workspaces, while Environment Variables only apply to new containers. Secret summaries never return real values.

**Global workspace settings** hold Secrets, SSH keys, trusted SSH servers and Environment variables for every new workspace, including empty ones. They use the same endpoints under `/global-workspace-settings` instead of `/workspace-templates/:workspaceTemplateId`; `GET /global-workspace-settings` with `Accept: application/json` lists them. A template's own Secret or Environment variable with the same name overrides the global one. Present them with `/settings?section=global-workspace-settings`, or inside a template's settings with `section=global-secrets`, `global-ssh` or `global-environment`. Global summaries have no `workspaceTemplateId`.

Use `GET /workspace-templates` with `Accept: application/json` to discover the template ID before constructing the presentation URL. Template environment-variable, secret, and SSH-key summaries identify their template with `workspaceTemplateId`. Existing storage filenames and serialized formats are unchanged; their older `project` spellings remain at storage boundaries.

Other browser-navigable surfaces are:

```text
/workspaces/new                                           # Launch composer for an empty workspace
/workspace-templates/:workspaceTemplateId/workspaces/new  # Launch composer for a workspace from a template
/workspace-templates/new                                  # Add a template
/models                                 # Models: Model providers, their usage, and enabled models
/settings                               # Settings: app-level preferences and shared configuration
/settings?section=models                # A specific settings section
/settings/developer-tools               # Developer tools: app-level maintenance and design-system inspection
/host                                   # Host: System diagnostics and privileged terminals
/design-system-catalogue.html           # Live component catalogue (HTML)
```

Host targets Kintsugi System, outside individual Workspaces, rather than necessarily the physical machine running Docker. `GET /host` with `Accept: application/json` reports availability and the access boundary; it does not create a terminal.

**Developer tools** is the app-level maintenance and design-system inspection page, separate from Workspace template configuration. The existing `/settings/development` URL remains valid.

**Theme** is an app-wide setting shared across open pages, not a per-Workspace or per-browser preference. Its settings section is `theme`.

Settings shows the **Kintsugi URL** for the current browser connection, with copy and QR-code actions. It is not necessarily reachable from other devices; a local-only address must be opened on the Installation computer.

The `access` section controls **Connection mode** in a System-managed installation: **Installation computer only** or **Devices on your Tailscale network**. The existing access API spelling is unchanged.

**Commit identity** uses section `commit-identity` and POST `/settings/commit-identity` with `commitAuthorName` and `commitAuthorEmail`. Existing `git-identity` section links and POST `/settings/git-identity` remain valid.

The `update-channel` section is **Update channel**, with **Stable**, **Latest** and **Custom** choices. Its POST endpoint is `/settings/update-channel` with form field `channel=stable`, `channel=latest` or `channel=custom`. The image tags and saved settings format are unchanged.

The `update` section is **Updates**, the feature for managing Kintsugi installation Updates. It is separate from Workspace package and agent CLI updates.

Settings is app-level, not configuration for the selected Workspace, a Workspace template, or an individual Agent. Git hosting connections (GitHub, GitLab, Bitbucket and configurable Gitea) are shared across Workspaces; their tokens are distinct from the Commit identity used to author commits. Connect one with POST `/settings/git-hosting/:provider/connect` (`github`, `gitlab`, `bitbucket` or `gitea`) and form field `token`, plus `account` (the Atlassian account email) for Bitbucket or `serverUrl` (the HTTPS instance URL) for Gitea. See the [Git hosting guide](../README.md#git-hosting) for instance and credential scope. The settings section is a registered settings contribution ID, such as `theme`, `commit-identity`, `git-hosting`, `models`, `dictation`, or `update`.

## Create and wait for a workspace

Creation is asynchronous and returns `202 Accepted` immediately. The response’s
`workspace.url` and `Location` header are origin-relative paths, like workspace
detail URLs. Resolve them against the public request URL to preserve HTTPS
when Kintsugi runs behind a TLS-terminating proxy:

```sh
created=$(curl -sS -X POST http://localhost:3000/workspaces \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"source":{"type":"empty"},"title":"Evaluation"}')
id=$(jq -r '.workspace.id' <<<"$created")
```

`source` may be `{ "type": "empty" }` or `{ "type": "workspace-template", "workspaceTemplate": "name-or-id" }`. Optional `agent` fields are `agentTypeId` (Builtin, Claude Code, Claude Code CLI, Codex, Codex CLI, or Pi: `builtin`, `claude`, `claude-cli`, `codex`, `codex-cli`, or `pi`), `initialPrompt`, `model`, `thinkingLevel`, and `attachmentDraft`.

Poll the same UI URL with JSON content negotiation:

```sh
while :; do
  workspace=$(curl -sS -H 'Accept: application/json' "http://localhost:3000/workspaces/$id")
  phase=$(jq -r '.workspace.phase.kind' <<<"$workspace")
  [ "$phase" = runningPhase ] && break
  [ "$(jq -r '.workspace.phase.status' <<<"$workspace")" = failed ] && { jq . <<<"$workspace"; exit 1; }
  sleep .2
done
```

Existing workspaces are discovered before the server starts listening. Each active
workspace then runs its startup checklist in the background with phase `provisioningPhase`.
Workspace preparation checks the ingress and egress gateways and parent sockets,
and installs the workspace's saved preloaded images. Failure retains the container for repair and presents
**Retry** and **Continue anyway**. Use
`POST /workspaces/:id/provisioning/continue?action=retry` to retry runtime preparation,
or omit the query parameter to explicitly bypass the failure. Bypassing makes the
workspace enter `runningPhase` while retaining its preparation warning. Until startup completes,
the workspace shows its checklist instead of its Agents or Work views. Kintsugi and
other workspaces remain available throughout.

The list and detail responses include optional `warnings` entries with `kind` and
`message`. Running workspace details also include each warning's `title`, `state`
and `action`. Image inspection runs independently at Kintsugi startup. Workspace
preparation runs again when a workspace resumes or Kintsugi restarts; bypassing a failure does not
permanently disable checks. Existing workspaces keep their saved preload references
when template settings change.

A running-phase response advertises its `agents`, typed `workViews`, and available `commands` with their `inputSchema`.

## Stage Agents and Work views

**Close Agent** uses `POST /workspaces/:id/agents/:agentId/close`. The transcript is retained, but the closed Agent cannot be reopened or resumed. Starting a fresh Agent session is different: it keeps the same Agent.

Execute commands using their advertised schema:

```sh
curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/terminal.create" \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"title":"Tests","cwd":"/work","command":"bun test"}'

curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/browser.create" \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:3000/"}'

curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/agent.create" \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' -d '{}'
```

Navigate an existing Browser view with `POST /workspaces/:id/browser/:browserId/navigate` and `{ "url": "..." }`.

## Arrange Work views

Changes uses **Diff endpoints**: a `base` and `target`, with an optional implicit base for a single chosen commit. Existing comparison HTTP fields remain `start` (base) and `end` (target); their behavior is unchanged.

- `POST /workspaces/:id/work-views/reorder` with `key` and `index`
- `POST /workspaces/:id/work-views/close` with a typed `reference`
- `POST /workspaces/:id/work-views/:key/attention/request` to request attention for a Work view without selecting it

Open Work-view identity and order are server-persistent. Workspace, agent, and view `requestingAttention` states are independent and server-persistent; each clears only when that destination becomes visible. Workspace `phase` is an object with `kind` and `busy`, plus phase-specific substates. Agent summaries include `busy` and `requestingAttention`. Active destinations, pane visibility, and Work-pane width are browser-local.

The Agent `/park` message responds with a `307` redirect to the workspace park operation.
Follow same-origin redirects while preserving the POST method, Accept, and Origin headers (for example, `curl -L`).
Confirmation is returned only to that requester; JSON clients receive `409` when confirmation is needed.

Rename with `POST /workspaces/:id/sidebar-title` and `{ "title": "..." }`. Park, unpark, and delete use the corresponding existing workspace UI routes with `Accept: application/json` and a matching `Origin` header.

## Control an agent

- `POST /workspaces/:id/agents/:agentId/model` with `{ "model": "provider::model" }`
- `POST /workspaces/:id/agents/:agentId/thinking-level` with `{ "thinkingLevel": "medium" }`
- `POST /workspaces/:id/agents/:agentId/messages` with `{ "text": "...", "mode": "send" }`
- `POST /workspaces/:id/agents/:agentId/abort`

Message submission returns `202 Accepted`; it does not wait for inference to finish.
For Builtin Agents, `mode` defaults to `"steer"`: while the Agent is busy, it joins
the running turn. `"send"` and `"followUp"` queue the message until that turn ends.
Newly accepted submissions include an `x-kintsugi-submission-id` response header;
retain it to address that submission. An already-known `requestId` returns an
acknowledgement without creating a second submission.
An optional `requestId` (1–128 letters, numbers, underscores or hyphens) makes a
retried message submission idempotent; reuse it only for that same submission.

- `POST /workspaces/:id/agents/:agentId/queued-inputs/:submissionId/steer`
  turns a queued follow-up into steering. If the Agent is idle after a failed turn
  with input still queued, it resumes the queue in written order without resending.
  JSON replies include `{ "input": { "submissionId": "...", "steered": true } }`;
  `steered: false` means that submission could not be steered.
- `POST /workspaces/:id/agents/:agentId/queued-inputs/:submissionId/cancel`
  cancels that queued submission. JSON replies include the submission ID and a
  boolean `cancelled` result.

Use `Accept: application/json` and the matching `Origin` header for these requests.
Claude Code and Codex steer busy sessions automatically; `/openapi.json` describes
the routes supported by each Agent type.

## Present the result

After staging the desired Work view, use the agent's `present` tool with:

```text
http://localhost:3000/workspaces/<id>
```

## Export recorded token consumption

The `telemetry` Settings section configures app-level Graphite export. It is off by default, uses Carbon plaintext TCP (port `2003`) and aggregates new recorded usage every 15 minutes by default. Collection polls local accounting every 30 seconds. It does not start workspaces, make inference requests or change provider caching defaults.

All admin telemetry reads/writes require `security` scope:

| Endpoint | Operation |
| --- | --- |
| `GET /settings/telemetry` | Configuration, queue state, delivery/error and dropped/invalid/oversized counters |
| `POST /settings/telemetry` | Save enablement, host, port, instance and interval |
| `POST /settings/telemetry/test` | Test unsaved input via TCP; no metric write or settings save |
| `POST /settings/telemetry/discard` | Explicitly discard pending exports with `{ "confirmed": true }` |

Save/test body:

```json
{"enabled":true,"host":"graphite.example.net","port":2003,"instance":"my-kintsugi","intervalMinutes":15}
```

Normal UI JSON requests still require the matching `Origin`; admin bindings use bearer authentication. The HTML settings frame is excluded from admin listeners. Pending exports must be delivered or discarded before changing the saved destination/instance. Disabling stops collection/delivery; re-enabling excludes disabled-period usage while retaining prior pending batches.

The [telemetry guide](token-telemetry.md) defines the PiClaw-compatible metric paths, cache-rate denominator, native coverage, reserved Pi `unattributed` buckets, private storage and retry limits. Carbon connectivity is not an acknowledgement of stored data. The destination does not grant workspace LAN access. No production exporter is enabled merely by updating Kintsugi.

## Inspect Model provider usage

`GET /usage` with `Accept: application/json` returns all connected providers with
implemented usage support (OpenAI Codex, Anthropic, GitHub Copilot, xAI, Radius and OpenCode Go). Refresh an
individual provider with `GET /usage/providers/openai-codex` or
`GET /usage/providers/anthropic` and the same header. Anthropic requires subscription
OAuth sign-in, not an API key. Its five-hour, weekly, and available model/feature
windows use the same pacing reference. Buckets with no reset timestamp retain
their reported usage, with null reset and timing values and timing state `unknown`.
Null buckets are omitted; monetary extra usage is not a paced allowance. Anthropic
does not report a plan name or account-wide allowed/limit-reached flags, so these
are null.
In the app, each provider’s usage shows on its card in the Models dialog; the
workspace Usage button opens that dialog with its provider expanded.

Each result includes provider-reported windows, their durations and resets,
and pacing relative to elapsed time. Provider failures populate `error`.
These `/usage` endpoints report account allowances/balances, not local token consumption. Opt-in [Graphite token telemetry](token-telemetry.md) separately persists recorded local consumption and export checkpoints.

A provider card groups provider-reported 0% windows under **Unused limits**
(collapsed when there are used limits, expanded when all limits are unused)
and renders reset countdowns such as `3d 12h`. The workspace Usage button traces
Time and Usage for the subscription whose active allowance has the shortest Estimated time to hit limit
among subscriptions used for successful inference in the 30 minutes ending at the
last recorded inference. Limits are checked at display time, not frozen at the time
of that inference. Built-in Agent inference and connected-subscription CLI traffic
through workspace egress contribute activity; API-key traffic does not. Activity is
kept in memory and cleared on credential changes. The button refreshes every minute
while visible, on focus, and whenever a provider card loads fresh limits. No recorded activity or no
available active limits means no comparison ring. Both arcs start at twelve
o’clock and run clockwise on the same circle. Their shared portion is neutral;
Time beyond Usage is green, and Usage beyond Time is red. A dim full-circle
track preserves the button outline beneath the arcs.
Among active windows with nonzero usage, the button selects the shortest
Estimated time to hit limit; ties prefer higher Usage. When all active windows are
unused, the main allowance takes precedence over feature-specific allowances.
Expired/not-started windows and windows with unknown reset timing are excluded.
`GET /usage/button` returns the server-rendered button frame
(or a Turbo Stream with `Accept: text/vnd.turbo-stream.html`).
Each window also includes `timing`: the inferred start (`reset − duration`),
elapsed-time percentage, and usage-minus-time difference in percentage points.
`paceDifferenceSeconds` converts that difference to distance along the allowance
schedule (`paceDifferencePoints / 100 × durationSeconds`). Provider cards and the button
label show compact durations such as `30m ahead of pace` or `1d 4h behind pace`.
Positive means consumption is ahead; negative means behind. This is not time
until exhaustion. Both difference fields are null outside an active window.
**Estimated time to hit limit** is a separate forecast based on average consumption since the window began. It stops at the next reset; **Not before reset** means no hit is projected before then. An unavailable estimate is shown as a dash. Unlike **Resets in**, this is not an actual countdown.

Each provider card shows Time and Usage percentages above one comparison bar per allowance.
Both grow from the left: overlap is neutral, Time beyond Usage is green, and Usage
beyond Time is red. Outside an active window the bar stays neutral. This is a linear pacing
reference, not a billing forecast; pacing is omitted before a window starts or
once its reset is due.

Usage is contributed by the Agent module, including these OpenAPI paths. Its
header action and directly navigable dialog use the generic
[module-owned workspace-pane action interface](workspace-pane-actions.md).


## Trusted LAN proxy deployment (v0.0.2)

Proxy mode advertises one public UI origin and separate preview ports on the same hostname. The UI has no bearer authentication: every reachable LAN client is trusted. Use a dedicated production host where possible. On a shared test host, inventory unrelated services, storage, listeners and containers before installing. Preserve their volumes and the original kernel; OverlayFS is an explicit alternative when EROFS is unavailable.

Read the README at the release tag before running its installer. With Bun and a checkout of that release, collect a read-only inventory:

```sh
bun scripts/deployment.ts preflight --storage overlayfs --mode proxy \
  --origin https://orangepi6plus.local \
  --image ghcr.io/rcarmo/kintsugi:v0.0.2 \
  --image ghcr.io/rcarmo/kintsugi-system:v0.0.2 > preflight.json
```

Preflight does not install Docker, pull images, clone code, load modules, alter kernel settings or remove services. Missing/unavailable commands and local images have non-zero status in the report. Review these before proceeding; unloaded filesystem modules can appear absent. Check free space, Docker architecture and image storage/deployment labels. The installer checks pulled replacement capabilities before stopping the existing installation.

### Unattended installation and Orange Pi upgrade

Use an account with Docker access and passwordless sudo for the required module-loading and configuration commands. The installer uses `sudo -n` on each actual command; it never treats `sudo -v` as proof of permission. Unattended permission errors name the required command and do not prompt for a password. Docker installation requires the separate `--install-docker` acknowledgement.

Download the tagged installer and pin both images:

```sh
curl -fsSL https://raw.githubusercontent.com/rcarmo/kintsugi/v0.0.2/scripts/install.sh \
  -o /tmp/install-kintsugi-v0.0.2.sh
bash /tmp/install-kintsugi-v0.0.2.sh --non-interactive --action update \
  --system-image ghcr.io/rcarmo/kintsugi-system:v0.0.2 \
  --app-image ghcr.io/rcarmo/kintsugi:v0.0.2 \
  --access-mode proxy --public-origin https://orangepi6plus.local \
  --preview-ports 41000:41999 --ui-publish 127.0.0.1:3000:3081 \
  --acknowledge-lan-trust --result-file /tmp/kintsugi-upgrade.json
```

Updates retain the installed storage driver. For a fresh installation, replace `--action update` with `--action install` and add `--storage-driver overlayfs`. Replacing an existing installation with `install` requires `--confirm-replace`; deleting data requires `--confirm-delete`. Complete unattended arguments are validated before host mutation. Progress goes to stderr; `--result-file FILE|-` writes credential-free JSON with selected immutable images, storage, URLs and pending actions. A proxy publication alone does not mean external Caddy, name resolution or client trust is ready.

Preview identities are retained. New deployments use the full `41000:41999` pool (1,000 retained identities, including retired ports). The installer expands the legacy `41000:41009` default during upgrades; it does not rewrite assignments, recycle retired identities or change the public hostname. Other custom ranges are preserved unless explicitly expanded with `--preview-ports FIRST:LAST`. Shrinking a saved range is rejected. Publications and proxy intent survive updates and rollback to compatible images. Older replacements without `kintsugi.deployment-config=1` are rejected while proxy mode is configured.

For an existing loopback HTTP admin listener on 3443, add `--admin-proxy-port 3443 --admin-proxy-publish 127.0.0.1:3444:3082`. Existing bindings and tokens are preserved. New proxy mappings replace legacy sidecar publications at the same host address/port; unrelated admin publications remain. The old inner Caddy sidecar is no longer required; remove it only after checking that nothing else uses it. Do not expose supervisor port 3001 or the inner Docker daemon.

### Recover an exhausted preview range

Update Kintsugi and Caddy together. Before replacing services, back up the System data and Caddy configuration, record image pins/publications, and retain `app/proxy/origin-identities.json` unchanged. Do not delete or clear that file: old browser storage and service workers must not gain a different app.

1. Regenerate the Kintsugi Caddy blocks using `scripts/deployment.ts caddyfile`, the existing public origin, bind addresses, loopback upstream and optional admin settings. Its default now covers `41000:41999`. Merge those blocks into the existing Caddyfile without replacing unrelated sites. If it already has a global options block, merge the generated `servers` options into that block instead of adding a second one. Validate with `caddy validate --config PATH --adapter caddyfile` and reload Caddy.
2. Run the reviewed installer with `--action update --preview-ports 41000:41999`. The range-only option uses the saved proxy origin/admin configuration; no `--public-origin` restatement is required. Preserve custom image sources, pins and host publication arguments. Unattended replacement still requires `--non-interactive --confirm-replace`. Installation replacement interrupts running workspaces, so schedule it deliberately.
3. Confirm old preview URLs still work, a new preview can use a port above 41009, and agent/terminal panes remain available if an individual preview fails.

The full pool requires Caddy to open many listeners (including HTTP/3 UDP where enabled); ensure its service has an adequate open-file limit, for example at least 4096. The generator disables HTTP/3 specifically on each bound address at port 41641, leaving its TCP preview available without competing with Tailscale's UDP listener. Other listeners retain their protocol defaults. Existing Caddyfiles need the equivalent `servers LAN_IP:41641 { protocols h1 h2 }` option inside their global block; use `[IPv6_ADDRESS]:41641` for an IPv6 binding. Validate configuration and confirm reload succeeds, not just that generation succeeded.

The app image cannot rewrite an external Caddyfile. Existing installations need this coordinated proxy update once; subsequent deployments generated by this tooling already use the larger range. Merely updating the app on an old System does not expand that System’s saved proxy configuration. The supported pool is finite; exhausting all 1,000 identities requires an operator decision, not automatic origin recycling.

### Transactional optional admin bootstrap

Create a private input file, for example:

```json
{"bindings":[{"host":"127.0.0.1","port":3443}],"token":{"name":"lan-automation","scopes":["workspaces","host:read"]}}
```

Add these flags to the install/update command:

```sh
--admin-bootstrap /secure/admin-bootstrap.json \
--admin-token-output /secure/issued-token.json \
--admin-proxy-port 3443 --admin-proxy-publish 127.0.0.1:3444:3082
```

The input must have mode 0600. Bindings, scopes, expiry and TLS files are checked before issuing a token. Token delivery uses a new exclusive mode-0600 file; an existing output file fails without replacing it. Configuration and token hashes commit atomically after successful delivery, preserving prior tokens. Failed configuration writes roll back the new output file. `--admin-token-output -` emits the secret JSON once on stdout for direct keychain ingestion; use a file for the separate result. Stdout delivery cannot be retracted if a later commit fails: check exit status before treating the token as valid. Secrets do not enter progress logs or the result.

Bootstrap requests a supervisor-managed app restart and verifies authenticated API readiness. Distinguish Docker publication, active listener, usable TLS and authenticated readiness. The result confirms the internal authenticated listener; external Caddy and client CA trust still require separate checks. For direct CLI bootstrap, use `bun apps/web/scripts/admin-bindings.ts bootstrap --file INPUT --token-output OUTPUT`; `--check` validates without issuing or writing. The same-user/data-directory rules above apply. Direct non-loopback listeners still require TLS; proxy mode uses a loopback plaintext listener behind external TLS.

### Caddy, mDNS and client trust

System port 3080 keeps its original `kintsugi.localhost`/`p41000.kintsugi.localhost` hostname routing. Point LAN Caddy at the dedicated UI/preview port 3081, published on host loopback, and optional admin relay 3082. Previews use isolated port origins such as `https://orangepi6plus.local:41000`; hosting workspace content under the UI origin would grant it management access.

Generate a Caddyfile with the real LAN address:

```sh
bun scripts/deployment.ts caddyfile --origin https://orangepi6plus.local \
  --bind 192.168.1.50 --upstream 127.0.0.1:3000 --preview-ports 41000:41999 \
  --admin-origin https://orangepi6plus.local:3443 --admin-upstream 127.0.0.1:3444 \
  > /tmp/kintsugi.Caddyfile
caddy validate --config /tmp/kintsugi.Caddyfile --adapter caddyfile
```

Without host Bun, generate the file using `docker run --rm --entrypoint bun ghcr.io/rcarmo/kintsugi:v0.0.2 /app/scripts/deployment.ts caddyfile` followed by the same options. Omit the admin options when no admin relay is configured. Review and merge the generated blocks into the existing Caddyfile; do not overwrite unrelated sites. Each block binds only the intended LAN address, uses `tls internal` and `flush_interval -1`. Caddy handles WebSocket upgrades and streams SSE immediately. Preserve Host, Origin and Authorization. Never inject a bearer token or rewrite Origin. System pins forwarded scheme at this configured boundary and strips misleading forwarded-host metadata. API and UI remain separate ports and policies. Use the configured HTTPS UI origin; this recipe does not advertise a parallel HTTP UI.

Restrict Avahi to the intended interface where appropriate:

```ini
[server]
allow-interfaces=eth0
```

Choose the actual interface name, check the resolved address with `avahi-resolve-host-name orangepi6plus.local`, and reserve its DHCP address. Do not advertise Docker bridge addresses. Match advertised IPv4/IPv6 records to Caddy listeners and LAN firewall rules; the generator accepts comma-separated IPv4/IPv6 bind addresses. Avahi IPv6 policy affects other advertised services, so change it only deliberately. Host-local resolution does not verify a Mac or another LAN device.

Distribute only Caddy's public root certificate (usually `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`). Trust it on the Mac for Safari; use `curl --cacert root.crt` for diagnostics. Never distribute Caddy's CA private key or disable TLS verification to pass acceptance. Open the UI, API and configured preview ports only to trusted clients; Docker publications can bypass ordinary host firewall rules.

### Acceptance evidence

The disposable AMD64 System integration exercises fresh no-PTY install, token delivery, CA-verified TLS termination over plaintext upstreams, actual same-origin mutation, foreign-origin denial, UI WebSocket/SSE, preview isolation, Desktop canonical HTTPS redirect, workspace create/park/unpark/delete and file persistence, pinned System/app replacement and retained-pair rollback:

```sh
bun scripts/verify-admin-bindings-system.ts --app LOCAL_APP --system LOCAL_SYSTEM \
  --workspace LOCAL_WORKSPACE --storage-driver overlayfs --proxy-access \
  --release-updates --installer-system LOCAL_SYSTEM
```

Run the non-UI client probe on a second physical LAN client, with Bun and the release checkout. Its token needs `workspaces`; add `--confirm-create-workspace` to create, mutate, park, unpark and delete only its disposable workspace. `--preview-origin` must name an existing reachable preview:

```sh
bun scripts/verify-lan-client.ts --ui https://orangepi6plus.local \
  --api https://orangepi6plus.local:3443 --ca root.crt \
  --token-file /secure/issued-token.json --out lan-client-report.json \
  --preview-origin https://orangepi6plus.local:41000 --confirm-create-workspace
```

The report contains no token and lists omitted/unverified checks. Separately record ARM host kernel/filesystem preflight, workspace file persistence after restart/update/rollback, preview WebSockets/SSE, and Safari Desktop/terminal visual interaction. Native ARM image smoke checks and client-container probes do not establish a physical ARM/LAN lifecycle. Actual VNC interaction has not passed this workspace's acceptance: the local x11vnc fixture listened but did not deliver its TCP greeting. The canonical Desktop redirect and separate preview WebSocket transport passed independently. Hardware acceptance is still required.
