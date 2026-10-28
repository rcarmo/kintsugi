# syntax=docker/dockerfile:1
# Shared base for workspace and service daemons. Neither Kintsugi nor workspace
# policy belongs here. Build from this directory with ./build.sh --load.
FROM docker:29.9.2-dind@sha256:9e79b879b177fbd72c34376a3dd3d91747da5db49e1f560f76aea59561471977 AS docker-tools
FROM ubuntu:26.04@sha256:513c074113a871b51a8d16ab445c88779d6452d937a164fb5cc479f32668a41d AS ubuntu

# Compile natively, including CGO/seccomp, even when targeting the other CPU.
FROM --platform=$BUILDPLATFORM golang:1.27.3@sha256:b76020929b709ddb6202afc05410a0faefae20ae05e27ad548b3870092688a69 AS go-toolchain
# Build-only settings; the Ubuntu runtime inherits none of these.
ENV GOTOOLCHAIN=local GOMAXPROCS=2 GOFLAGS=-p=2
RUN test "$(go env GOVERSION)" = go1.27.3

FROM go-toolchain AS cgo-toolchain
ARG TARGETARCH
RUN dpkg --add-architecture "$TARGETARCH" \
    && apt-get update && apt-get install -y --no-install-recommends \
      libseccomp-dev libseccomp-dev:${TARGETARCH} libc6-dev:${TARGETARCH} pkg-config xz-utils \
      gcc-aarch64-linux-gnu gcc-x86-64-linux-gnu \
    && rm -rf /var/lib/apt/lists/*
FROM cgo-toolchain AS build
ARG TARGETARCH
# Docker v29.9.2: pin the source and apply the reviewed EROFS/cache patches.
ADD --checksum=sha256:80c3d6f0cdc01d97be093563a9457c281f23f53ba4f36f5e49d9558322ea13cd \
    https://codeload.github.com/moby/moby/tar.gz/0367cbeb49b9d98cb0b4f51e95f7b54b4803e76c /tmp/moby.tar.gz
WORKDIR /src
RUN tar xzf /tmp/moby.tar.gz --strip-components=1 && rm /tmp/moby.tar.gz
COPY patches/ /patches/
RUN git apply /patches/0001-moby-mount-manager.patch \
    && git apply /patches/0002-buildkit-erofs.patch \
    && git apply /patches/0007-buildkit-erofs-cache-staging.patch
RUN --mount=type=cache,id=patched-docker-go-${TARGETARCH},target=/root/.cache/go-build \
    /usr/local/go/bin/go test -mod=vendor \
      github.com/moby/buildkit/snapshot \
      github.com/moby/buildkit/exporter/containerimage \
      -run 'TestManagedMount|TestFetchOnly' -count=1 \
    && case "$TARGETARCH" in \
         arm64) compiler=aarch64-linux-gnu ;; \
         amd64) compiler=x86_64-linux-gnu ;; \
         *) exit 1 ;; \
       esac \
    && CGO_ENABLED=1 GOOS=linux GOARCH="$TARGETARCH" CC="${compiler}-gcc" \
      PKG_CONFIG_LIBDIR="/usr/lib/${compiler}/pkgconfig" \
      /usr/local/go/bin/go build -mod=vendor -trimpath \
      -tags 'seccomp exclude_graphdriver_btrfs' \
      -ldflags '-X github.com/moby/moby/v2/dockerversion.Version=29.9.2-kintsugi-erofs -X github.com/moby/moby/v2/dockerversion.GitCommit=0367cbe+kintsugi-erofs' \
      -o /out/ ./cmd/dockerd ./cmd/docker-proxy \
    && /usr/local/go/bin/go version -m /out/dockerd > /out/build-info.txt

# The transfer helper uses the same containerd release as the runtime below.
FROM go-toolchain AS image-transfer
WORKDIR /src
COPY image-transfer/go.mod image-transfer/go.sum ./
RUN go mod download
COPY image-transfer/*.go ./
ARG TARGETARCH
RUN --mount=type=cache,id=kintsugi-image-transfer-go,target=/root/.cache/go-build \
    go test ./... \
    && CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -trimpath -o /out/kintsugi-image-transfer .

# Patch ctr cache leases and the daemon's empty-mount EROFS differ dispatch.
# Compile the daemon, clients and shims with the same Go toolchain.
FROM go-toolchain AS containerd-patched
ADD --checksum=sha256:e38df0eeb40d2304f3450edb148aee838cb0a57f3976a47c78870f92c80f1796 \
    https://codeload.github.com/containerd/containerd/tar.gz/b7a25261e029d68978bbf290df0a62fc819b3c51 /tmp/containerd.tar.gz
WORKDIR /src
RUN tar xzf /tmp/containerd.tar.gz --strip-components=1 && rm /tmp/containerd.tar.gz
COPY patches/0003-containerd-erofs-cache-lease.patch /tmp/lease.patch
COPY patches/0004-containerd-erofs-empty-mounts.patch /tmp/empty-mounts.patch
COPY patches/0005-containerd-erofs-cache-reuse.patch /tmp/cache-reuse.patch
COPY patches/0006-containerd-loop-device-node.patch /tmp/loop-device-node.patch
RUN git apply /tmp/lease.patch /tmp/empty-mounts.patch /tmp/cache-reuse.patch /tmp/loop-device-node.patch
ARG TARGETARCH
RUN --mount=type=cache,id=kintsugi-ctr-go,target=/root/.cache/go-build \
    go test -mod=vendor ./internal/erofsutils \
    && CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -mod=vendor -trimpath \
      -ldflags '-X github.com/containerd/containerd/v2/version.Version=v2.4.2-kintsugi -X github.com/containerd/containerd/v2/version.Revision=b7a25261e029d68978bbf290df0a62fc819b3c51+cache-lease+mount-root+cache-reuse+loop-node' \
      -o /out/ ./cmd/ctr ./cmd/containerd ./cmd/containerd-shim-runc-v2 ./cmd/containerd-stress

# Rebuild the matching, pinned CLI/plugin sources with the same Go toolchain.
FROM go-toolchain AS docker-cli
ADD --checksum=sha256:cdc8005e1958e90c035971b838cf333dc7602868c4e3ee2ccec859cf0ddc3c78 \
    https://codeload.github.com/docker/cli/tar.gz/a82e528901260c8df6073311379eac65f92db204 /tmp/source.tar.gz
WORKDIR /src
RUN tar xzf /tmp/source.tar.gz --strip-components=1 && rm /tmp/source.tar.gz && cp vendor.mod go.mod
ARG TARGETARCH
RUN --mount=type=cache,id=kintsugi-runtime-cli-go,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -mod=vendor -trimpath -tags 'grpcnotrace osusergo netgo' \
      -ldflags '-s -w -X github.com/docker/cli/cli/version.GitCommit=a82e528 -X github.com/docker/cli/cli/version.Version=29.9.2' \
      -o /out/docker ./cmd/docker

FROM go-toolchain AS buildx
ADD --checksum=sha256:c5c810b083ed3725f7d4299ba01505b5891d164cf81c3398ea4c3b27a3b71149 \
    https://codeload.github.com/docker/buildx/tar.gz/0dbe87f36ed472fe36b6796c3f70b4210a731fc5 /tmp/source.tar.gz
WORKDIR /src
RUN tar xzf /tmp/source.tar.gz --strip-components=1 && rm /tmp/source.tar.gz
ARG TARGETARCH
RUN --mount=type=cache,id=kintsugi-runtime-buildx-go,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -mod=vendor -trimpath \
      -ldflags '-s -w -X github.com/docker/buildx/version.Version=v0.38.1 -X github.com/docker/buildx/version.Revision=0dbe87f36ed472fe36b6796c3f70b4210a731fc5' \
      -o /out/docker-buildx ./cmd/buildx

FROM go-toolchain AS compose
ADD --checksum=sha256:2293b570f258dfc6e38e0bfdd3fa0e710324a7cf0449994304b524af8fb4f06c \
    https://codeload.github.com/docker/compose/tar.gz/6cbc19a3fd59e305fb814dca4d854a4fb67d2941 /tmp/source.tar.gz
WORKDIR /src
RUN tar xzf /tmp/source.tar.gz --strip-components=1 && rm /tmp/source.tar.gz && go mod download
ARG TARGETARCH
RUN --mount=type=cache,id=kintsugi-runtime-compose-go,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -mod=readonly -trimpath -tags e2e \
      -ldflags '-s -w -X github.com/docker/compose/v5/internal.Version=v5.6.1' -o /out/docker-compose ./cmd

# Build runc 1.5.2 with the same Go; retain Ubuntu's test-only patches and licence metadata.
FROM cgo-toolchain AS runc
ADD --checksum=sha256:5386e1968f70cc1482b4b2a93dc1a88ea7fa5517fba49b9e0fafe614d5a4c97a \
    https://codeload.github.com/opencontainers/runc/tar.gz/29dd3dc2b13b4123162e5fe132504bb4b15569f1 /tmp/runc.tar.gz
ADD --checksum=sha256:953fb6d2f4b6284284939d7d2659b1bc0a20f748d210f9f7f8f5f47ba04c35e5 \
    https://ports.ubuntu.com/ubuntu-ports/pool/main/r/runc-app/runc-app_1.4.0-0ubuntu1.debian.tar.xz /tmp/debian.tar.xz
WORKDIR /src
RUN tar xf /tmp/runc.tar.gz --strip-components=1 && tar xf /tmp/debian.tar.xz \
    && while read -r patch; do case "$patch" in ''|'#'*) continue ;; esac; git apply "debian/patches/$patch"; done < debian/patches/series
# runc 1.5.2 already includes #5091: check cmd.Err and clone exec.Cmd before
# retrying CLONE_INTO_CGROUP. The delegated-cgroup smoke gate must still pass.
ARG TARGETARCH
RUN --mount=type=cache,id=kintsugi-runtime-runc-go,target=/root/.cache/go-build \
    case "$TARGETARCH" in arm64) compiler=aarch64-linux-gnu ;; amd64) compiler=x86_64-linux-gnu ;; *) exit 1 ;; esac \
    && CGO_ENABLED=1 GOOS=linux GOARCH="$TARGETARCH" CC="${compiler}-gcc" PKG_CONFIG_LIBDIR="/usr/lib/${compiler}/pkgconfig" \
      go build -mod=vendor -trimpath -tags 'apparmor seccomp selinux ambient' -ldflags '-s -w -X main.version=1.5.2+kintsugi' -o /out/runc .

FROM ubuntu AS runtime
LABEL org.opencontainers.image.title="Kintsugi Docker runtime" \
      org.opencontainers.image.description="Ubuntu-based Docker runtime with patched embedded BuildKit and containerd EROFS shared-cache support."
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates erofs-utils iproute2 iptables libseccomp2 tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/erofs-cache /data/docker /data/containerd /etc/docker /etc/containerd
COPY --from=docker-tools /usr/local/bin/docker-init /usr/local/bin/
COPY --from=docker-cli /out/docker /usr/local/bin/docker
COPY --from=build /out/docker-proxy /usr/local/bin/docker-proxy
COPY --from=buildx /out/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=compose /out/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=runc /out/runc /usr/bin/runc
COPY --from=containerd-patched /out/ /usr/local/bin/
COPY --from=build /out/dockerd /usr/local/bin/dockerd
COPY --from=image-transfer /out/kintsugi-image-transfer /usr/local/bin/kintsugi-image-transfer
COPY --from=build /src/LICENSE /src/NOTICE /usr/share/kintsugi-patched-docker/
COPY --from=build /out/build-info.txt /usr/share/kintsugi-patched-docker/build-info.txt
COPY patches/ /usr/share/kintsugi-patched-docker/patches/
COPY containerd.toml /etc/containerd/config.toml
COPY daemon.json /etc/docker/daemon.json
COPY --chmod=755 entrypoint.sh /usr/local/bin/kintsugi-dockerd
# Both daemon stores live under this one explicitly mounted volume. No VOLUME
# instruction: derived images choose their storage and do not inherit anonymous volumes.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kintsugi-dockerd"]
CMD ["dockerd"]

# Check executable metadata, not just builder tags, before publishing an image.
FROM go-toolchain AS verify-go
COPY --from=runtime /usr/local/bin/ /verify/bin/
COPY --from=runtime /usr/local/libexec/docker/cli-plugins/ /verify/plugins/
COPY --from=runtime /usr/bin/runc /verify/bin/runc
RUN set -eu; for name in dockerd docker docker-proxy containerd ctr containerd-shim-runc-v2 containerd-stress kintsugi-image-transfer runc; do \
      file="/verify/bin/$name"; test "$(go version -m "$file" | head -1 | awk '{print $2}')" = go1.27.3; go version -m "$file" >> /verified-build-info.txt; \
    done; for file in /verify/plugins/*; do \
      test "$(go version -m "$file" | head -1 | awk '{print $2}')" = go1.27.3; go version -m "$file" >> /verified-build-info.txt; \
    done

FROM runtime AS final
LABEL org.kintsugi.go-version="go1.27.3"
COPY --from=verify-go /verified-build-info.txt /usr/share/kintsugi-patched-docker/go-build-info.txt
COPY --from=docker-cli /src/LICENSE /src/NOTICE /usr/share/kintsugi-patched-docker/cli/
COPY --from=buildx /src/LICENSE /usr/share/kintsugi-patched-docker/buildx/LICENSE
COPY --from=compose /src/LICENSE /usr/share/kintsugi-patched-docker/compose/LICENSE
COPY --from=runc /src/LICENSE /src/debian/copyright /usr/share/kintsugi-patched-docker/runc/
