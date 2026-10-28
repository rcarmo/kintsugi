#!/usr/bin/env bash
# Run with Go 1.27.3. No daemon, root privileges, or EROFS kernel support needed.
# Tests the production BuildKit wrapper against the pinned containerd GC/manager.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
runtime=$(dirname "$here")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Read source URLs and checksums from the runtime Dockerfile, so this experiment
# follows the exact versions we ship rather than a separately maintained pin.
fetch_source() {
    local project=$1
    local checksum url
    read -r checksum url < <(awk -v project="$project" '
        /^ADD --checksum=sha256:/ { checksum=$2; sub("--checksum=sha256:", "", checksum) }
        $1 ~ "https://codeload.github.com/" project "/" { print checksum, $1 }
    ' "$runtime/Dockerfile")
    curl -fsSL "$url" -o "$work/$project.tar.gz"
    echo "$checksum  $work/$project.tar.gz" | sha256sum -c -
    mkdir -p "$work/$project"
    tar xzf "$work/$project.tar.gz" --strip-components=1 -C "$work/$project"
}
# Slashes in the upstream project names also form directories under the temp root.
mkdir -p "$work/moby" "$work/containerd"
fetch_source moby/moby
fetch_source containerd/containerd
(
    cd "$work/moby/moby"
    git apply "$runtime/patches/0001-moby-mount-manager.patch"
    git apply "$runtime/patches/0002-buildkit-erofs.patch"
)
(
    cd "$work/containerd/containerd"
    git apply "$runtime/patches/0003-containerd-erofs-cache-lease.patch"
    git apply "$runtime/patches/0004-containerd-erofs-empty-mounts.patch"
)
mkdir "$work/test"
# Compile the actual snapshot package and patched wrapper, not a reimplementation.
cp "$work/moby/moby/vendor/github.com/moby/buildkit/snapshot/"*.go "$work/test/"
cp "$here/"*_test.go "$work/test/"
cat > "$work/test/go.mod" <<MOD
module kintsugi-mount-lifetime-repro

go 1.27.3

require (
    github.com/moby/buildkit v0.34.0
    github.com/containerd/containerd/v2 v2.4.2
)

replace github.com/containerd/containerd/v2 => ../containerd/containerd
MOD
cd "$work/test"
go test -mod=mod -v -run '^TestManagedMount' -count=1 "$@" .
