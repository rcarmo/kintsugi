# syntax=docker/dockerfile:1
# Shared base for workspace and service daemons. Neither Kintsugi nor workspace
# policy belongs here. Build from this directory with ./build.sh --load.
FROM docker:29.6.1-dind@sha256:66d292e5c26bd33a6f6f61cacb880de2186339a524ecba1ce098dbbaceed6515 AS docker-tools
FROM ubuntu:26.04@sha256:513c074113a871b51a8d16ab445c88779d6452d937a164fb5cc479f32668a41d AS ubuntu

# Compile natively, including CGO/seccomp, even when targeting the other CPU.
FROM --platform=$BUILDPLATFORM golang:1.26.10@sha256:672c944cfd07599b5f1bb179869270cdc94c6254e41db4d431259693cb286b82 AS go-toolchain
# Build-only settings; the Ubuntu runtime inherits none of these.
ENV GOTOOLCHAIN=local GOMAXPROCS=2 GOFLAGS=-p=2
RUN test "$(go env GOVERSION)" = go1.26.10

FROM go-toolchain AS cgo-toolchain
ARG TARGETARCH
RUN dpkg --add-architecture "$TARGETARCH" \
    && apt-get update && apt-get install -y --no-install-recommends \
      libseccomp-dev libseccomp-dev:${TARGETARCH} libc6-dev:${TARGETARCH} pkg-config xz-utils \
      gcc-aarch64-linux-gnu gcc-x86-64-linux-gnu \
    && rm -rf /var/lib/apt/lists/*
FROM cgo-toolchain AS build
ARG TARGETARCH
# Parent of Moby PR #53126: pin the source, then apply both reviewable patches.
ADD --checksum=sha256:60063d5e609c498333bad7a2c0c4be43abe417aabdaacac0137f6ef4519f357a \
    https://codeload.github.com/moby/moby/tar.gz/0584603b8c3a7ad224a2932ccdab0d17d6202687 /tmp/moby.tar.gz
WORKDIR /src
RUN tar xzf /tmp/moby.tar.gz --strip-components=1 && rm /tmp/moby.tar.gz
COPY patches/ /patches/
RUN git apply /patches/0001-moby-mount-manager.patch \
    && git apply /patches/0002-buildkit-erofs.patch
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
      -ldflags '-X github.com/moby/moby/v2/dockerversion.Version=kintsugi-erofs-1 -X github.com/moby/moby/v2/dockerversion.GitCommit=0584603+kintsugi-erofs' \
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
ADD --checksum=sha256:110aba8239bedd0efc7d359fa211b7ed1634713c3c05da3dd43a5b33d4a40194 \
    https://codeload.github.com/containerd/containerd/tar.gz/58e6cee9dee67ee87ee2f727d3570009050f9954 /tmp/containerd.tar.gz
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
      -ldflags '-X github.com/containerd/containerd/v2/version.Version=v2.4.0-beta.0-kintsugi -X github.com/containerd/containerd/v2/version.Revision=58e6cee9dee67ee87ee2f727d3570009050f9954+cache-lease+mount-root+cache-reuse+loop-node' \
      -o /out/ ./cmd/ctr ./cmd/containerd ./cmd/containerd-shim-runc-v2 ./cmd/containerd-stress

# Preserve CLI/plugin versions, rebuilding pinned sources with the current Go.
FROM go-toolchain AS docker-cli
ADD --checksum=sha256:41540b35a1157e76eb1a3c3e87dd196896a8e76b27c4bfcafb826dbc15b0acd9 \
    https://codeload.github.com/docker/cli/tar.gz/8900f1d330cb39e93e16d780a26bff1d7e07ba03 /tmp/source.tar.gz
WORKDIR /src
RUN tar xzf /tmp/source.tar.gz --strip-components=1 && rm /tmp/source.tar.gz && cp vendor.mod go.mod
ARG TARGETARCH
RUN --mount=type=cache,id=kintsugi-runtime-cli-go,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -mod=vendor -trimpath -tags 'grpcnotrace osusergo netgo' \
      -ldflags '-s -w -X github.com/docker/cli/cli/version.GitCommit=8900f1d -X github.com/docker/cli/cli/version.Version=29.6.1' \
      -o /out/docker ./cmd/docker

FROM go-toolchain AS buildx
ADD --checksum=sha256:9946be04c616cf0ca14ad0f41561f4cd6a41545b6303bc945d83e9fcada3625b \
    https://codeload.github.com/docker/buildx/tar.gz/a319e5b15052cf6557ceb666eb8ff6e32380b782 /tmp/source.tar.gz
WORKDIR /src
RUN tar xzf /tmp/source.tar.gz --strip-components=1 && rm /tmp/source.tar.gz
ARG TARGETARCH
RUN --mount=type=cache,id=kintsugi-runtime-buildx-go,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -mod=vendor -trimpath \
      -ldflags '-s -w -X github.com/docker/buildx/version.Version=v0.35.0 -X github.com/docker/buildx/version.Revision=a319e5b15052cf6557ceb666eb8ff6e32380b782' \
      -o /out/docker-buildx ./cmd/buildx

FROM go-toolchain AS compose
ADD --checksum=sha256:0a9f43689fd7a512f50849e83036e7fb771b87afb17ee6301f4cbaacfb798a77 \
    https://codeload.github.com/docker/compose/tar.gz/3d0dd57fbd634d78fd440c08bd4c143eb1f9d5e0 /tmp/source.tar.gz
WORKDIR /src
RUN tar xzf /tmp/source.tar.gz --strip-components=1 && rm /tmp/source.tar.gz && go mod download
ARG TARGETARCH
RUN --mount=type=cache,id=kintsugi-runtime-compose-go,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -mod=readonly -trimpath -tags e2e \
      -ldflags '-s -w -X github.com/docker/compose/v5/internal.Version=v5.2.0' -o /out/docker-compose ./cmd

# Preserve Ubuntu's runc source and patch set, not its Go 1.24 build.
FROM cgo-toolchain AS runc
ADD --checksum=sha256:6a05f22e6aac3a8a47690bc8acac10e53303e5605536df5efe4ebeae30783ded \
    https://ports.ubuntu.com/ubuntu-ports/pool/main/r/runc-app/runc-app_1.4.0.orig.tar.xz /tmp/runc.tar.xz
ADD --checksum=sha256:953fb6d2f4b6284284939d7d2659b1bc0a20f748d210f9f7f8f5f47ba04c35e5 \
    https://ports.ubuntu.com/ubuntu-ports/pool/main/r/runc-app/runc-app_1.4.0-0ubuntu1.debian.tar.xz /tmp/debian.tar.xz
WORKDIR /src
RUN tar xf /tmp/runc.tar.xz --strip-components=1 && tar xf /tmp/debian.tar.xz \
    && while read -r patch; do case "$patch" in ''|'#'*) continue ;; esac; git apply "debian/patches/$patch"; done < debian/patches/series
# Upstream runc #5091: Go 1.26 forbids retrying Start on the same exec.Cmd.
# Systemd moves init to a child cgroup, forcing CLONE_INTO_CGROUP to fall back.
COPY patches/0007-runc-go126-exec-retry.patch /tmp/exec-retry.patch
RUN git apply /tmp/exec-retry.patch
ARG TARGETARCH
RUN --mount=type=cache,id=kintsugi-runtime-runc-go,target=/root/.cache/go-build \
    case "$TARGETARCH" in arm64) compiler=aarch64-linux-gnu ;; amd64) compiler=x86_64-linux-gnu ;; *) exit 1 ;; esac \
    && CGO_ENABLED=1 GOOS=linux GOARCH="$TARGETARCH" CC="${compiler}-gcc" PKG_CONFIG_LIBDIR="/usr/lib/${compiler}/pkgconfig" \
      go build -mod=vendor -trimpath -tags 'apparmor seccomp selinux ambient' -ldflags '-s -w -X main.version=1.4.0-0ubuntu1+kintsugi-exec-retry' -o /out/runc .

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
      file="/verify/bin/$name"; test "$(go version -m "$file" | head -1 | awk '{print $2}')" = go1.26.10; go version -m "$file" >> /verified-build-info.txt; \
    done; for file in /verify/plugins/*; do \
      test "$(go version -m "$file" | head -1 | awk '{print $2}')" = go1.26.10; go version -m "$file" >> /verified-build-info.txt; \
    done

FROM runtime AS final
LABEL org.kintsugi.go-version="go1.26.10"
COPY --from=verify-go /verified-build-info.txt /usr/share/kintsugi-patched-docker/go-build-info.txt
COPY --from=docker-cli /src/LICENSE /src/NOTICE /usr/share/kintsugi-patched-docker/cli/
COPY --from=buildx /src/LICENSE /usr/share/kintsugi-patched-docker/buildx/LICENSE
COPY --from=compose /src/LICENSE /usr/share/kintsugi-patched-docker/compose/LICENSE
COPY --from=runc /src/LICENSE /src/debian/copyright /usr/share/kintsugi-patched-docker/runc/
