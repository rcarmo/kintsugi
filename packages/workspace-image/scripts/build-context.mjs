#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { imageSource } from "../../shared/src/publishing.ts";
import { workspaceRuntimeUnits } from "../src/workspace-systemd-units.ts";

const outDir = process.argv[2];
if (!outDir || process.argv.length > 3) throw new Error("usage: build-context.mjs <output-dir>");
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const packagesDir = join(root, "packages");

function quote(value) { return JSON.stringify(value); }
function dockerEscapeRun(script) { return script.replaceAll("\\", "\\\\").replaceAll("\n", " "); }
function dockerContinuationList(values) {
  const continuation = " " + "\\";
  return values.map((value, index) => `      ${value}${index === values.length - 1 ? "" : continuation}`).join("\n");
}
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

function moduleNameFor(dir) {
  const name = basename(dir);
  return name === "workspace-image" ? "base" : name;
}

async function packageManifests() {
  const manifestPaths = [join(packagesDir, "workspace-image", "workspace-image.json")];
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "workspace-image") continue;
    const path = join(packagesDir, entry.name, "workspace-image.json");
    if (existsSync(path)) manifestPaths.push(path);
  }
  const manifests = [];
  for (const path of manifestPaths) {
    const dir = dirname(path);
    manifests.push({ path, dir, name: moduleNameFor(dir), manifest: await readJson(path), hashPath: relative(root, path) });
  }
  return manifests;
}

const manifests = await packageManifests();
const runtimeImage = (await readFile(join(packagesDir, "workspace-image/runtime-image"), "utf8")).trim();

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, "files"), { recursive: true });

const hash = createHash("sha256");
// v14 embeds the resulting signature as an image label.
hash.update("kintsugi-workspace-image-v14\n");
const env = {};
const moduleNames = [];
const modules = [];
const finalCopies = [];

// Keep slow, broadly-shared layers early so small later module changes do not
// force VS Code server/extension installation to run again.
function moduleSortKey(manifest) {
  if (manifest.name === "base") return "00-base";
  if (manifest.name === "vscode") return "01-vscode";
  return `10-${manifest.name}`;
}

manifests.sort((a, b) => moduleSortKey(a).localeCompare(moduleSortKey(b)));

for (const { path, dir, name, manifest, hashPath } of manifests) {
  moduleNames.push(name);
  const moduleCopyInstructions = [];
  const manifestText = await readFile(path, "utf8");
  hash.update(hashPath); hash.update("\0"); hash.update(manifestText); hash.update("\0");
  Object.assign(env, manifest.env ?? {});
  for (const file of manifest.files ?? []) {
    const from = join(dir, file.from);
    const rel = `${name}/${file.from.replaceAll(/[^a-zA-Z0-9._/-]/g, "_")}`;
    const dest = join(outDir, "files", rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(from, dest, { recursive: true });
    const copyInstruction = { rel: `files/${rel}`, to: file.to, mode: file.mode };
    (file.afterRun ? finalCopies : moduleCopyInstructions).push(copyInstruction);
  }
  const aptPackageGroups = (manifest.aptPackageGroups ?? [manifest.aptPackages ?? []])
    .map((packages) => [...new Set(packages)].sort());
  modules.push({ name, aptPackageGroups, copyInstructions: moduleCopyInstructions, runInstructions: manifest.run ?? [] });
}

// The gateway is built separately so Go never enters the runtime image.
const gatewaySource = join(packagesDir, "workspace-image", "workspace-image", "gateway");
await cp(gatewaySource, join(outDir, "gateway"), { recursive: true });
for (const name of (await readdir(gatewaySource)).sort()) {
  hash.update(`gateway/${name}\0`);
  hash.update(await readFile(join(gatewaySource, name)));
}

let dockerfile = `FROM golang:1.27.3@sha256:b76020929b709ddb6202afc05410a0faefae20ae05e27ad548b3870092688a69 AS gateway-build\nWORKDIR /src\nCOPY gateway/ ./\nRUN go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /kintsugi-workspace-gateway .\n\nFROM oven/bun:1.4.4 AS bun-dist\n\nFROM ${runtimeImage}\n\nRUN test -x /usr/local/bin/kintsugi-dockerd || ln -s /usr/local/bin/agents-in-the-cloud-dockerd /usr/local/bin/kintsugi-dockerd\nRUN test -x /usr/local/bin/kintsugi-image-transfer || ln -s /usr/local/bin/agents-in-the-cloud-image-transfer /usr/local/bin/kintsugi-image-transfer\n\nARG DEBIAN_FRONTEND=noninteractive\nLABEL com.kintsugi.workspace-image.modules=${quote(moduleNames.join(","))}\n\nRUN mkdir -p /opt/kintsugi/home-defaults && cp -a /etc/skel/. /opt/kintsugi/home-defaults/\n\n`;
dockerfile += `COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun\nCOPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx\nRUN bun --version\n\n`;
function appendCopies(copies) {
  for (const copy of copies) {
    dockerfile += `COPY ${quote(copy.rel)} ${quote(copy.to)}\n`;
    if (copy.mode) dockerfile += `RUN chmod ${quote(copy.mode)} ${quote(copy.to)}\n`;
  }
  if (copies.length) dockerfile += "\n";
}

for (const module of modules) {
  dockerfile += `# Module: ${module.name}\n`;
  for (const packages of module.aptPackageGroups) {
    if (!packages.length) continue;
    const aptPackages = dockerContinuationList(packages);
    dockerfile += `RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\\n    apt-get update \\\n && apt-get install -y --no-install-recommends \\\n${aptPackages}\n\n`;
  }
  appendCopies(module.copyInstructions);
  for (const script of module.runInstructions) dockerfile += `RUN ${dockerEscapeRun(script)}\n\n`;
}
// Module installation must not change the original home. Template-only defaults are copied later.
dockerfile += `RUN diff -r --no-dereference /opt/kintsugi/home-defaults /home/agent\n`;
if (finalCopies.length) dockerfile += "# Files independent of module setup\n";
appendCopies(finalCopies);
if (Object.keys(env).length) dockerfile += `ENV ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" \\\n    ")}\n\n`;
dockerfile += `COPY --from=gateway-build /kintsugi-workspace-gateway /usr/local/bin/kintsugi-workspace-gateway\n\n`;
await mkdir(join(outDir, "runtime-units"));
for (const [name, content] of Object.entries(workspaceRuntimeUnits())) {
  await writeFile(join(outDir, "runtime-units", name), content);
}
dockerfile += `COPY runtime-units/ /usr/lib/systemd/system/\n`;
dockerfile += `RUN python3 -c 'import json; p="/etc/docker/daemon.json"; c=json.load(open(p)); c["hosts"]=["fd://"]; json.dump(c,open(p,"w"))'\n`;
dockerfile += `RUN mkdir -p /etc/kintsugi && printf "disabled\\n\\n" > /etc/kintsugi/docker-support\n`;
dockerfile += `RUN mkdir -p /.kintsugi && printf "systemctl start kintsugi-tmux.service\\n" > /.kintsugi/init.sh\n`;
// binfmt registrations belong to the host kernel; workspace shutdown must not unregister them.
dockerfile += `RUN systemctl mask systemd-binfmt.service\n`;
dockerfile += `ENTRYPOINT ["/usr/local/bin/kintsugi-workspace-init"]\nCMD []\nWORKDIR /work\n`;
await writeFile(join(outDir, "Dockerfile"), dockerfile);
// Identity covers the Docker build context, including generated instructions,
// file modes and symlinks, excluding publication/storage metadata labels added below.
// Timestamps and the checkout's absolute path do not count.
async function hashContext(directory, prefix = "") {
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const stat = await lstat(path);
    hash.update(`${prefix}${name}\0${stat.mode & 0o7777}\0`);
    if (stat.isSymbolicLink()) { hash.update("link\0"); hash.update(await readlink(path)); }
    else if (stat.isDirectory()) { hash.update("dir\0"); await hashContext(path, `${prefix}${name}/`); }
    else { hash.update("file\0"); hash.update(await readFile(path)); }
    hash.update("\0");
  }
}
await hashContext(outDir);
const signature = hash.digest("hex").slice(0, 16);
dockerfile += `LABEL kintsugi.storage-drivers="erofs,overlayfs"\n`;
dockerfile += `LABEL org.opencontainers.image.source=${quote(imageSource)}\n`;
dockerfile += `LABEL com.kintsugi.workspace-image.signature=${quote(signature)}\n`;
await writeFile(join(outDir, "Dockerfile"), dockerfile);
await writeFile(join(outDir, "metadata.json"), `${JSON.stringify({ tag: `kintsugi-workspace:${signature}`, modules: moduleNames }, null, 2)}\n`);
