# syntax=docker/dockerfile:1-labs
ARG ATELIER_RUNTIME_IMAGE=ghcr.io/rcarmo/kintsugi-docker@sha256:5b3106e3e906e30b2d314ce66d53afc1bb816f8bcd91aa578879e13194c5f351
FROM oven/bun:1.4.4 AS bun-dist

FROM ubuntu:26.04 AS transcription-runtime
ARG TARGETARCH
ARG NEMO_SPEECH_VERSION=0.1.0
COPY packages/dictation/install-runtime.sh /tmp/install-transcription-runtime.sh
RUN sh /tmp/install-transcription-runtime.sh "$TARGETARCH" "$NEMO_SPEECH_VERSION"

FROM ubuntu:26.04 AS deps
ARG DEBIAN_FRONTEND=noninteractive
COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates
WORKDIR /app

# Source-only changes must not invalidate the dependency installation layer.
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY --parents apps/*/package.json packages/*/package.json ./

# Claude Code runs in workspaces; the Agent SDK's bundled platform binaries are never used here.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile \
    && rm -rf node_modules/.bun/@anthropic-ai+claude-agent-sdk-*

FROM deps AS build
COPY --exclude=packages/workspace-helper/dist --exclude=packages/workspace-helper/workspace_tools . .
RUN bun run --cwd apps/web build:client

FROM ${ATELIER_RUNTIME_IMAGE} AS runtime
# Adapt executable names supplied by the pinned upstream runtime.
RUN test -x /usr/local/bin/kintsugi-dockerd || ln -s /usr/local/bin/agents-in-the-cloud-dockerd /usr/local/bin/kintsugi-dockerd
RUN test -x /usr/local/bin/kintsugi-image-transfer || ln -s /usr/local/bin/agents-in-the-cloud-image-transfer /usr/local/bin/kintsugi-image-transfer
ARG DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      git-lfs \
      gosu \
      libcap2-bin \
      openssh-client \
      sudo \
      socat \
      util-linux \
      tmux

COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
RUN setcap cap_net_bind_service=+ep /usr/local/bin/bun
COPY --from=transcription-runtime /opt/nemo-speech /opt/nemo-speech
RUN ln -s /opt/nemo-speech/bin/nemo-speech /usr/local/bin/nemo-speech

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV ATELIER_NAMESPACE=default
ENV ATELIER_DATA_DIR=/data/app

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build --exclude=node_modules /app /app
ARG TARGETARCH
COPY packages/workspace-helper/dist/linux-${TARGETARCH}/kintsugi-workspace-helper /app/packages/workspace-helper/workspace_tools/kintsugi-workspace-helper
RUN printf '%s\n' '#!/usr/bin/env sh' 'exec /usr/local/bin/bun /app/packages/proxy-ingress/src/ingress/tailscale-serve-helper.ts "$@"' > /usr/local/bin/kintsugi-tailscale-serve-helper \
 && chmod 755 /usr/local/bin/kintsugi-tailscale-serve-helper /app/apps/web/docker-entrypoint.sh

ARG ATELIER_COMMIT_ID
ARG ATELIER_DEFAULT_WORKSPACE_IMAGE
ARG ATELIER_EAGERLY_PRELOAD="[]"
ENV ATELIER_COMMIT_ID=${ATELIER_COMMIT_ID}
LABEL kintsugi.deployment-config="1"
LABEL kintsugi.storage-drivers="erofs,overlayfs" \
      org.opencontainers.image.revision="${ATELIER_COMMIT_ID}" \
      eagerly-preload="${ATELIER_EAGERLY_PRELOAD}"
RUN printf '%s\n' "$ATELIER_DEFAULT_WORKSPACE_IMAGE" > /app/.kintsugi-default-workspace-image

EXPOSE 3000

ENTRYPOINT ["/app/apps/web/docker-entrypoint.sh"]
CMD ["bun", "run", "apps/web/src/server/main.ts"]
