# kintsugi-image-transfer

Transfer an image's metadata between Kintsugi's containerd instances while reusing
already prepared, shared EROFS layers. No registry, layer copying, persistent
service, or network access is needed in the destination workspace.

## Why this exists

Kintsugi System can build a default-workspace image locally. An agent in a separate
workspace must be able to build from that exact image. The workspace has its own
containerd image records and snapshots, even though both instances can see the
same EROFS cache files. Merely sharing the cache does not install the image.

Containerd 2.4.2's pull path can prepare snapshots from the EROFS shared
cache without downloading layer blobs. Its ordinary import/unpack path does not
support the metadata-only import used here: it attempts to read the omitted layer
blobs. This helper calls the existing cache-aware parallel unpacker instead.
It also works for registry images whose metadata has already been fetched on System.

This is custom glue around upstream APIs, not a custom snapshotter or a claim
that incomplete OCI archives are supported by every OCI importer.

## Contract

The same binary runs at both ends:

```sh
# Sender: containerd has the image manifest and configuration.
kintsugi-image-transfer export --platform linux/arm64 docker.io/library/example:dev

# Receiver: read the metadata-only OCI tar archive from stdin.
kintsugi-image-transfer import
```

`export` writes only archive bytes to stdout. `import` writes the usable
`name:tag@sha256:...` reference to stdout **after** snapshot preparation and image
registration succeed. Diagnostics use stderr. Either command accepts `--address`
and `--namespace`; defaults are `/run/containerd/containerd.sock` and `moby`.
Flags precede the image argument. There are no configuration environment variables.

Kintsugi can stream between processes over Docker exec, without a temporary file:

```sh
set -o pipefail
docker exec system kintsugi-image-transfer export docker.io/library/example:dev \
  | docker exec -i workspace kintsugi-image-transfer import
```

This example assumes the caller's Docker daemon manages both named containers.
In Kintsugi's nested layout, the sender normally runs in the app container with
System's containerd socket mounted; the receiver runs through System's Docker
socket inside the workspace. Do not use Docker exec's `--tty` for binary transport.

Before transfer, Kintsugi must build or fetch the source image and prepare its
cache, for example:

```sh
ctr --namespace moby content fetch --platform linux/arm64 docker.io/library/postgres:17
ctr --namespace moby images build-erofs-cache --platform linux/arm64 \
  docker.io/library/postgres:17 /erofs-cache
```

The destination's EROFS snapshotter must be configured with the same cache, mounted
read-only at its configured path. The helper never writes cache files, fetches
layers, or creates EROFS images. A cache miss fails explicitly; prepare the missing
entry on System and retry. It also accepts snapshots already prepared locally.

## What is transferred

One OCI tar archive containing exactly four regular files:

- `oci-layout`: OCI layout version.
- `index.json`: one selected manifest descriptor with the image name/tag.
- `blobs/<algorithm>/<manifest digest>`: original manifest bytes.
- `blobs/<algorithm>/<configuration digest>`: original configuration bytes.

The manifest still describes the original compressed layers, but those blobs are
absent. The config supplies their diffIDs, which the snapshotter uses to find the
EROFS files. Import validates the archive, sizes, digests, platform, and layer list
before writing metadata. It limits metadata to 32 MiB and rejects extra entries,
symlinks, unsupported image targets, and invalid metadata.

For a multi-platform source, export selects exactly one matching platform
(`--platform`, defaulting to the sender's platform). The **selected manifest's**
digest and bytes are preserved; the original multi-platform index digest is not
transferred. The destination must match that platform. Attestations, referrers,
and other platforms are outside this tool's scope. An explicitly supplied source
`name:tag@digest` must match the source image record before selection.

Import stores the two blobs under a temporary lease, invokes containerd's
cache-aware unpacker, and only then creates or updates the named image record.
The unpacker creates the snapshot chain and records EROFS cache references in snapshot labels and attaches the
snapshot GC reference to the config; the helper attaches manifest-to-config GC
references. It does not mount the container filesystem. Docker mounts it when
running a container or build step. Re-import is idempotent. A failed import can
leave unreferenced content or snapshots for containerd's GC; it does not publish
or replace the image record. Cache entries must remain available for the lifetime
of all snapshots referencing them, including while exporting/importing.

This creates a locally usable image, not a complete compressed-layer content
store. Build using the default Docker builder and:

```sh
docker build --output type=image,store-allow-incomplete=true -t result .
```

Use the returned **tag plus digest** in `FROM`. The tested BuildKit version tries
registry resolution for a digest-only name. `docker save`, pushing to an empty
registry, or a different BuildKit driver may need original layer blobs; this tool
does not solve those operations.

## Build and test

These sources target the new runtime candidate. App, System and workspace image
pins stay on the previously verified runtime until both native architectures
pass image, EROFS-cache and delegated-cgroup smoke gates.

The parent Dockerfile builds `/usr/local/bin/kintsugi-image-transfer` for both
linux/arm64 and linux/amd64. Its Go module pins containerd to the same
`v2.4.2` as the runtime. Update those together. The separate helper build
uses the same pinned Go 1.27.3 toolchain as every other runtime executable.

```sh
(cd images/patched-docker/image-transfer && go test ./... && go vet ./...)
images/patched-docker/build.sh kintsugi-image-transfer:test --builder desktop-linux --load
bun images/patched-docker/image-transfer-test.ts kintsugi-image-transfer:test linux/arm64
bun images/patched-docker/image-transfer-test.ts kintsugi-image-transfer:test linux/amd64
```

The integration test owns and removes its containers/volumes. It builds a local
image with a 32 MiB payload, prepares its shared cache, transfers only metadata to
an offline consumer, and checks run, build with RUN, restart, unchanged cache,
missing original layer blobs, snapshot cache labels, repeated import, cache miss/retry,
and corrupt metadata rejection. It also transfers a selected registry image
platform through the same path. The initial source build/fetch requires network;
the consumer has `--network none` for its whole lifetime.

## When we can remove it

The relevant upstream foundation is [containerd's EROFS shared cache](https://github.com/containerd/containerd/pull/13813)
and its [parallel unpacker](https://github.com/containerd/containerd/blob/v2.4.2/core/unpack/unpacker.go).
There is no assumed release date or promised upstream replacement.

Remove the import side when vanilla `ctr images import` can accept metadata-only
archives and prepare EROFS snapshots from the shared cache without requiring or
fetching omitted layer blobs. Remove the export side when vanilla tooling can
emit the equivalent metadata-only archive, with explicit platform selection and
image naming, without reading/exporting layers. A direct upstream containerd-to-
containerd transfer command with those properties would replace both sides too.

Before deleting this tool, run the same offline integration scenarios against
those upstream commands: unchanged manifest/config digests, no layer transfer,
cache miss failure, retry/idempotency, Docker run/build, and restart. Cache-aware
`docker pull` alone is not sufficient: locally built images still need metadata
transport without introducing a registry.
