# Workspace networking

## Security boundary

Kintsugi is a single-user application intended to run inside a trusted network, such as a Tailnet. Workspace-app links are not secrets and do not have independent authentication: anyone who can reach one through the deployment network boundary can use it. Operators are responsible for ensuring that Kintsugi and its managed app-origin range are not unintentionally public.

Inline images use the image-only `/workspaces/:id/images/...` endpoint on the management connection. It accepts known image types, sends `nosniff` and `Cross-Origin-Resource-Policy: same-origin`, and sandboxes SVG responses with scripts and external resource loading disabled. These passive previews do not allocate a public preview port. HTML, interactive artifacts and workspace apps still require isolated origins.

Kintsugi uses one networking model for workspace app ports:

```text
workspace gateway:2999 -> published on host 127.0.0.1:<allocated-port>
Kintsugi -> gateway -> workspace 127.0.0.1:<requested-app-port>
```

Workspace containers publish only their authenticated gateway port on the Docker host loopback interface. Kintsugi allocates and pins that host port in Docker’s container configuration, so both controlled and automatic restarts retain the same ingress endpoint. VS Code and browser previews both use that gateway. Kintsugi never connects to workspace container IPs, Docker DNS names, Docker bridge addresses, or `host.docker.internal` for workspace app ingress.

## Workspace egress

Outbound traffic from workspaces follows one invariant:

```text
Over IP, a workspace may reach global unicast destinations (the public internet) and nothing else.
```

Two layers enforce the same policy, generated from one definition in `packages/shared/src/egress-policy.ts` so they cannot drift:

- The System nftables table (`images/system/src/firewall.ts`) drops workspace-bridge traffic to every special-purpose range: RFC1918, CGNAT/tailnet, loopback, link-local, multicast, documentation ranges, and non-global IPv6. It also isolates the System itself (input chain), peer workspaces, and workspace-to-workspace forwarding. This is the real boundary: it applies to every packet, not only to traffic that respects `HTTP(S)_PROXY`.
- The workspace egress proxy (`packages/proxy-egress`) applies the same address policy to proxied HTTP, CONNECT and WebSocket traffic, resolves each hostname **once**, and connects to the address it checked. For direct connections, the routed hostname survives in the `Host` header and TLS `serverName`, so virtual hosting, SNI and certificate verification are unaffected. DNS cannot change the destination between the policy check and the connection. When an environment-configured upstream proxy is used (including a nested installation’s parent proxy), it is a trusted egress boundary: requests and CONNECT keep their logical hostname for credential hooks, and that proxy owns destination resolution, policy enforcement and outbound pinning. Only configure upstream proxies you trust to enforce this boundary.

Private destinations (LAN, VPN, tailnet, Docker bridges) were briefly allowed and are closed again: nothing in the codebase depended on it, and it exposed every unauthenticated Kintsugi instance on the same networks. When a workspace legitimately needs an internal host, allow that exact host through the proxy's hook layer rather than reopening a range.

### Docker Desktop firewall compatibility

The firewall uses separate `ip` and `ip6` tables for local-address FIB checks. This avoids requiring `CONFIG_NFT_FIB_INET`, which LinuxKit kernels such as Docker Desktop 4.71.0's 6.12.76 kernel omit. All three family tables are replaced in one atomic nftables batch.

Host-side repository build clients are selected with `socket cgroupv2` only when a kernel capability preflight succeeds. On kernels without `CONFIG_NFT_SOCKET`, those output rules are omitted, without runtime warnings or disabling repository builds. **This is a temporary security gap:** the Docker CLI's registry-auth and credential-helper traffic is not restricted to public destinations on those kernels. The cgroup migration still applies resource limits, but does not itself enforce networking. Bridge-attached workspaces, Docker builds, and helper containers retain their destination and isolation rules. A separate build-client network boundary is still needed to close this gap portably.

System still requires cgroup v2 and the base nftables features used by the bridge policy, including `CONFIG_NFT_FIB_IPV4` and `CONFIG_NFT_FIB_IPV6`. Unexpected preflight errors or failure to install the bridge firewall remain fatal before dockerd starts. There is no Docker Desktop version override; capability detection uses the running kernel. Firewall compatibility does not resolve the separate Docker Desktop ingress limitations described under Supported shapes below.

Run `python3 images/system/firewall-kernel-smoke.py` from the repository root on Linux or macOS with Docker running, Bun, and Python 3 installed. It installs nftables in a disposable privileged Ubuntu container and verifies actual IPv4/IPv6 FIB packet lookup, installation of the no-socket rule set, atomic replacement and rollback, and (when available) cgroup-selected local-address blocking and DNS exceptions. It never uses the host network namespace.

Non-System deployment shapes (a host app on macOS, `bun run web` on a Linux host, Kintsugi nested in a workspace) are trusted-workload development setups and do not install the firewall; do not run untrusted agents in workspaces there.

Restricting workspaces to egress **through the proxy only** (never direct) remains a deliberate one-line firewall change away—drop all forwarding from `atw-*`—but it would break non-HTTP protocols such as git over SSH and QUIC, so it stays deferred.

## Supported shapes

Docker-on-macOS is not a supported deployment shape for this model. Docker Desktop's host networking is not equivalent to Linux host networking: it lets a container reach services in the Docker Desktop Linux VM host namespace, but it does not reliably expose services listening in that host-networked container back to the macOS host, and Docker discards `-p` port publishing when `--network host` is used. Supporting Docker-on-macOS would require an additional UI forwarding sidecar or a separate `host.docker.internal`-based workspace access path, which would reintroduce the split networking model this design avoids.

### Kintsugi as a host app on macOS

No special networking setup is required:

```text
Kintsugi on macOS -> 127.0.0.1:<published-port> -> Docker Desktop port forward -> workspace container
```

Docker Desktop forwards published container ports from the macOS host into its Linux VM. The workspace container's private Docker IP is not reachable from macOS, so published loopback ports are the portable address.

### Kintsugi in Docker on Linux

Run the Kintsugi container with host networking:

```sh
docker run --network host ... kintsugi:latest
```

Then `127.0.0.1` inside the Kintsugi container is the host network namespace:

```text
Kintsugi container -> 127.0.0.1:<published-port> -> workspace container
```

Do not run the Kintsugi container on Docker's default bridge network for this model. In that case `127.0.0.1` would be the Kintsugi container itself, not the Docker host.

### Kintsugi in an Kintsugi workspace

An Kintsugi development server in a workspace uses that workspace's nested Docker daemon. Its inner workspace gateway ports are still published on the surrounding workspace's loopback interface, so the inner server can reach them normally.

Browser-facing app identity is independent from an active listener. A stable canonical app link retains a logical browser-origin assignment while listeners and external publication are leased only while the app is active. Origin assignments are never transferred to another app, preventing stale addresses and browser storage from crossing app identities. In a nested Kintsugi, the inner ingress leases a local origin reachable through the surrounding workspace’s gateway and redirects through that workspace's canonical app route. The outer ingress then supplies the browser-reachable origin. This preserves root-relative URLs and WebSockets without keeping inactive listeners or externally published resources alive.

Browser navigation carries its target origin in a query parameter scoped to the owning Browser view (`kintsugiBrowserOrigin.browser-<uuid>`). Each browser proxy reads and removes only its own parameter. Routing metadata for an inner Browser passes through the outer Browser unchanged, so an inner target port cannot retarget the surrounding workspace’s preview. Initial URLs and rewritten redirects use the same encoding.

## Workspace gateway

A small Go binary, `/usr/local/bin/kintsugi-workspace-gateway`, runs as the workspace container's main process after initialization, under Docker's `--init` signal-forwarder and child-process reaper. It binds port **2999**, writes the startup readiness marker only after binding, and exits with the container. Stopping or restarting a workspace stops or restarts its gateway; gateway failure terminates the container rather than silently leaving previews broken. Docker's existing restart policy applies.

Workspace web apps can use **any TCP port from 1 through 65535 except 2999**, including privileged ports and services bound only to IPv4 loopback (`127.0.0.1`). The gateway always connects to `127.0.0.1:<port>` inside the workspace. It never resolves a caller-supplied hostname or routes to another container, the Docker host, or the internet. This is web-app ingress, not general-purpose TCP/UDP publishing. Only explicitly requested app routes are exposed; services are not scanned or automatically published.

Ingress sends the destination port, HTTP/HTTPS protocol, app Host, and a per-workspace credential in reserved `X-Kintsugi-Gateway-*` headers. Browser-supplied values are removed and replaced with trusted routing metadata. The gateway authenticates and validates the request, strips its metadata and proxy credentials, then forwards it using Go's standard reverse proxy. App authorization, streaming, and WebSocket upgrades are preserved. Ingress applies the workspace app-port Host policy and narrow redirect/cookie translation described below. HTTPS upstreams require certificates trusted by the gateway; certificate verification is not disabled.

The credential is generated at workspace creation, stored in a mode-0600 host-side workspace file, and copied to `/etc/kintsugi-workspace-gateway-token` inside the container. It is not an environment variable, URL parameter, or browser credential. Workspaces already allow privileged/root access, so this protects gateway access from other network callers, not from code executing inside that same workspace.

### Localhost-compatible app previews

All workspace HTTP apps use one local-origin policy, with no per-app settings:

- `Host` and `X-Forwarded-Host` are `localhost:<app-port>`.
- `X-Forwarded-Proto` and `X-Forwarded-Port` describe the actual local app target.
- The RFC `Forwarded` header is removed so it cannot contradict those values.
- For HTTP and WebSockets, an `Origin` exactly matching the receiving preview
  origin is translated to the local app origin. Foreign, opaque (`null`), and
  missing Origins, and `Referer`, are unchanged.

This gives frameworks checking Host and frameworks checking forwarded headers
one consistent view. Next.js Server Actions and Webpack's Host/Origin checks both
work with this policy. No framework detection or alternate-host retries are used.

The browser keeps its public preview URL. Kintsugi carries that identity separately
in `X-Kintsugi-Public-Origin` for nested routing and response adaptation. Public
ingress derives it from the canonical app lease and overwrites caller-supplied
metadata. `X-Kintsugi-Origin-Context` carries the same-origin decision between
nested hops, preventing a foreign Origin that happens to name an intermediate
localhost address from becoming same-origin. Nested metadata comes from the
surrounding trusted Kintsugi ingress, like the existing parent-routing metadata.

Local `Location` headers are mapped back only for the current app's protocol and
port; redirects cannot publish other services. Explicit local cookie domains
become host-only. For translated requests, matching `Access-Control-Allow-Origin`
and `Timing-Allow-Origin` values are mapped back, with `Vary: Origin` preserved or
added. Bodies, unrelated origins, wildcard values, and other cookie/CORS attributes
are unchanged.

Source-edit reloads were verified with React/Vite, SvelteKit, Next.js, and Webpack.
Webpack's separate generated-URL issue remains: its client embeds the workspace
port and needs a socket-URL hint to reach the public preview port. Header
translation does not rewrite URLs embedded in HTML or JavaScript.

### Bun transport and environment proxies

Bun 1.4's `fetch` honors `NO_PROXY` even with an explicit proxy, and an empty `proxy` string does not suppress `HTTP_PROXY`. Ingress therefore uses the gateway URL as both the HTTP destination and explicit proxy. Whether Bun sends an origin-form request directly or an absolute-form proxy request, it reaches the **same authenticated gateway**. The gateway ignores the URL authority when choosing an upstream and uses only the validated local-port metadata. A separate app-Host header preserves the intended Host in both forms. No global environment changes are needed.

Bun WebSockets connect directly to the gateway with routing headers and no proxy; unlike `fetch`, that client does not implicitly select an environment proxy. Go handles the app-side HTTP or HTTPS upgrade. There is no CONNECT handshake in this gateway protocol.

The gateway preserves raw query strings, including semicolons, leaving query parsing to the app. Transport failures carry a reserved `X-Kintsugi-Gateway-Error: upstream` response marker; the gateway strips this marker from app responses. Ingress consumes marked failures, retries GET/HEAD startup requests, and records persistent failures in ingress status. Application-generated 502 responses pass through without retries.

### Existing workspaces and verification

Workspaces created with older images must be recreated to gain the gateway. There is deliberately no legacy port-publishing fallback or live-container migration. A missing published gateway produces an actionable error.

Run `bun run test:gateway` with Go 1.26+ installed for the real Bun-ingress/Go-gateway protocol integration. It covers both bypass-all and bypass-none proxy environments, streaming uploads, SSE and cancellation, text/binary WebSockets, subprotocols, cookies, authentication, and shutdown. Go tests also cover HTTPS trust, invalid destinations, connection errors, and credential isolation. The image build runs the Go tests before compiling a static binary in a separate build stage; Go is not installed in the workspace runtime image.

## Remote HTTPS

When Kintsugi is reached over HTTPS, every active browser-origin port must also be reachable with a trusted HTTPS certificate. With Tailscale remote access, Kintsugi publishes and retracts active origins through Tailscale Serve. An operator using another trusted-network reverse proxy must equivalently terminate HTTPS and forward the managed origin range (41000–41999 by default) to the same local ports. Publishing only Kintsugi's main port is insufficient because each app origin intentionally has a separate browser origin.

## Why not container IPs?

Container IPs are not a portable control-plane address.

On native Linux, Docker creates real host bridge interfaces and host routes such as `172.17.0.0/16 dev docker0`. A host process can often connect directly to an unpublished container IP.

On Docker Desktop for macOS, Linux containers and their bridge networks live inside a hidden Linux VM. The macOS host does not have a route to those container subnets. Docker documents this as a known limitation: the Docker bridge network is not reachable from the macOS host, and per-container IP addressing is not available from macOS.

Relying on container IPs would therefore work on Linux and fail on macOS.

## Why not Docker bridge-published ports?

Binding ports to Docker bridge interfaces is Linux-specific and interacts with host firewalls. On a locked-down Linux host, UFW may block traffic from containers to host-bound bridge addresses unless explicit rules are installed. Docker Desktop for macOS also cannot bind host ports to the Linux VM's bridge gateway address from the macOS host.

That makes bridge addresses a poor default for workspace app ingress.

## Experiments

We tested with small `nginx:alpine` workspace-like containers on:

- macOS with Docker Desktop, Docker server 29.4.1
- Linux host `kintsugi-1`, Docker 29.1.3, UFW active

Observed results:

| Experiment | macOS Docker Desktop | Linux `kintsugi-1` |
| --- | --- | --- |
| Host app connects to unpublished container IP | failed / timed out | succeeded |
| Container on same Docker network connects to unpublished port | succeeded | succeeded |
| Host app connects to `127.0.0.1:<published-port>` | succeeded | succeeded |
| Default-network container connects back to host-published port | platform/firewall-dependent | failed with UFW |
| Host app connects to port bound on Docker bridge address | not available | succeeded |
| Container connects to port bound on Docker bridge address | not portable | failed with UFW |
| Host-networked Kintsugi-like container connects to `127.0.0.1:<published-port>` | not the target shape | succeeded |

The host-networked Linux test also created the workspace-like container through the Docker socket from inside an Kintsugi-like container, then connected back to its loopback-published port through `127.0.0.1`.

## Consequence

Workspace app ingress has no Kintsugi runtime knob. The constants are:

```text
publish host: 127.0.0.1
connect host: 127.0.0.1
```

The deployment invariant is external:

```text
If Kintsugi runs in Docker on Linux, run it with --network host.
```
