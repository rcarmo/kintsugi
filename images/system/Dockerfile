ARG RUNTIME_IMAGE=ghcr.io/rcarmo/kintsugi-docker@sha256:5b3106e3e906e30b2d314ce66d53afc1bb816f8bcd91aa578879e13194c5f351
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun
FROM ghcr.io/tailscale/tailscale:v1.102.3@sha256:8c42c4574ab066384fcb72f69e086a2ff1dd3652eb6f56856cee34bcf0d2f680 AS tailscale
FROM ${RUNTIME_IMAGE}
# Adapt executable names supplied by the pinned upstream runtime.
RUN test -x /usr/local/bin/kintsugi-dockerd || ln -s /usr/local/bin/agents-in-the-cloud-dockerd /usr/local/bin/kintsugi-dockerd
RUN test -x /usr/local/bin/kintsugi-image-transfer || ln -s /usr/local/bin/agents-in-the-cloud-image-transfer /usr/local/bin/kintsugi-image-transfer
# Keep incident-response tools in the System image, not the shared Docker runtime.
# Profiling needs host kernel support/permissions; installing systemd only supplies
# its diagnostic commands (the container still runs the Kintsugi supervisor).
RUN apt-get update && apt-get install -y --no-install-recommends \
    atop bpfcc-tools bpftrace btop coreutils dnsutils htop iftop \
    iotop-c iproute2 iputils-ping linux-perf lsof mtr-tiny ncdu nethogs \
    nftables procps psmisc smem strace sysstat systemd tcpdump tmux util-linux \
    && rm -rf /var/lib/apt/lists/*
LABEL kintsugi.host-updater="1"
LABEL kintsugi.deployment-config="1"
LABEL kintsugi.installer-config="1" kintsugi.storage-drivers="erofs,overlayfs"
LABEL org.opencontainers.image.title="Kintsugi System"
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY .build/host-updater.js .build/install.sh /opt/kintsugi-system/
COPY .build/supervisor.js .build/client.js .build/design-system.css /opt/kintsugi-system/
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "/opt/kintsugi-system/supervisor.js"]
CMD []
