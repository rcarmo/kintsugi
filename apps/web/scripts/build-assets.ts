import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseAssetManifest, type AssetManifest } from "../src/server/asset-manifest.ts";
import type { StaticFileEntry } from "../src/server/static-files.ts";

await import("./generate-workspace-modules.ts");
const { clientEntrypoints, fingerprintedStaticFiles } = await import("../src/server/static-files.ts");

const assetsDir = new URL("../public/assets/", import.meta.url);
const stagingDir = new URL(`../.asset-build-${process.pid}/`, import.meta.url);
const manifestUrl = new URL("../public/assets-manifest.json", import.meta.url);
const manifestTempUrl = new URL(`../.assets-manifest-${process.pid}.json`, import.meta.url);
const maxCssManifestPasses = 10;
const clientOnly = process.argv.includes("--client-only") && await Bun.file(manifestUrl).exists();
if (!clientOnly) await import("../../../packages/drawio/scripts/unpack.ts");

type StaticFileRecord = [logicalPath: string, entry: StaticFileEntry];

const manifest: AssetManifest = {};
const staticFiles = Object.entries(fingerprintedStaticFiles).sort(([a], [b]) => a.localeCompare(b));
const cssFiles = staticFiles.filter(([, entry]) => isCss(entry));
const nonCssFiles = staticFiles.filter(([, entry]) => !isCss(entry));

function contentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function fingerprintedPath(logicalPath: string, content: string | Uint8Array): string {
  const extension = extname(logicalPath);
  const name = basename(logicalPath, extension);
  return `/assets/${name}-${contentHash(content)}${extension}`;
}

function isCss(entry: StaticFileEntry): boolean {
  return entry.contentType.toLowerCase().startsWith("text/css");
}

function requiredAssetPath(logicalPath: string): string {
  const path = manifest[logicalPath];
  if (!path) throw new Error(`missing built asset path for ${logicalPath}`);
  return path;
}

function rewriteAssetReferences(content: string, assetManifest: AssetManifest, logicalPath?: string): string {
  // Vendor stylesheets (such as KaTeX) use relative font URLs. Resolve those
  // against their logical stylesheet URL before looking up fingerprinted assets.
  let next = logicalPath ? content.replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (original, _quote, reference: string) => {
    if (reference.startsWith("#")) return original;
    const resolved = new URL(reference, `https://assets.invalid${logicalPath}`);
    const path = resolved.origin === "https://assets.invalid" ? assetManifest[resolved.pathname] : undefined;
    return path ? `url("${path}${resolved.search}${resolved.hash}")` : original;
  }) : content;
  for (const [logicalPath, publicPath] of Object.entries(assetManifest).sort((a, b) => b[0].length - a[0].length)) {
    next = next
      .replaceAll(`url("${logicalPath}")`, `url("${publicPath}")`)
      .replaceAll(`url('${logicalPath}')`, `url('${publicPath}')`)
      .replaceAll(`url(${logicalPath})`, `url(${publicPath})`)
      .replaceAll(`@import "${logicalPath}"`, `@import "${publicPath}"`)
      .replaceAll(`@import '${logicalPath}'`, `@import '${publicPath}'`);
  }
  return next;
}

async function buildClientEntrypoints(): Promise<void> {
  for (const [logicalPath, entry] of Object.entries(clientEntrypoints)) {
    const build = await Bun.build({
      entrypoints: [entry.url.pathname],
      outdir: stagingDir.pathname,
      format: entry.bundle ?? "esm",
      target: "browser",
      splitting: entry.bundle !== "iife",
      minify: true,
      // JSZip's pre-browserified entry retains a dynamic require fallback that Bun's
      // IIFE output cannot supply. Bundle its reviewed CommonJS source instead.
      plugins: [{ name: "jszip-browser-source", setup(builder) {
        builder.onResolve({ filter: /^jszip$/ }, args => ({ path: Bun.resolveSync("jszip/lib/index.js", dirname(args.importer)) }));
      } }],
      define: {
        KINTSUGI_GHOSTTY_WASM_URL: JSON.stringify(requiredAssetPath("/ghostty-vt.wasm")),
        KINTSUGI_GHOSTTY_CALLBACKS_WASM_URL: JSON.stringify(requiredAssetPath("/ghostty-callbacks.wasm")),
      },
      naming: {
        entry: "[name]-[hash].[ext]",
        chunk: "[name]-[hash].[ext]",
        asset: "[name]-[hash].[ext]",
      },
    });

    if (!build.success) {
      for (const log of build.logs) console.error(log);
      throw new Error(`Could not build client entrypoint ${logicalPath}`);
    }

    const entryExtension = extname(logicalPath);
    const outputs = build.outputs.filter((output) => output.kind === "entry-point" && extname(output.path) === entryExtension);
    if (outputs.length !== 1) {
      throw new Error(`expected exactly one ${entryExtension} entry point for ${logicalPath}, got ${outputs.length}`);
    }
    manifest[logicalPath] = `/assets/${basename(outputs[0].path)}`;
  }
}

async function copyBinaryAsset(logicalPath: string, source: URL): Promise<void> {
  const content = new Uint8Array(await Bun.file(source).arrayBuffer());
  const publicPath = fingerprintedPath(logicalPath, content);
  await Bun.write(new URL(`.${publicPath.replace("/assets/", "/")}`, stagingDir), content);
  manifest[logicalPath] = publicPath;
}

async function fingerprintCssAssets(cssFiles: StaticFileRecord[]): Promise<Map<string, string>> {
  const cssSources = new Map<string, string>();
  for (const [logicalPath, entry] of cssFiles) {
    const source = await Bun.file(entry.url).text();
    cssSources.set(logicalPath, source);
    manifest[logicalPath] = fingerprintedPath(logicalPath, source);
  }

  const rendered = new Map<string, string>();
  for (let pass = 0; pass < maxCssManifestPasses; pass += 1) {
    let changed = false;
    for (const [logicalPath, source] of cssSources) {
      const content = rewriteAssetReferences(source, manifest, logicalPath);
      rendered.set(logicalPath, content);
      const publicPath = fingerprintedPath(logicalPath, content);
      if (manifest[logicalPath] !== publicPath) {
        manifest[logicalPath] = publicPath;
        changed = true;
      }
    }
    if (!changed) return rendered;
  }

  throw new Error(`CSS asset manifest did not stabilize after ${maxCssManifestPasses} passes`);
}

async function publishGespenstWorker(): Promise<void> {
  // Gespenst resolves `assets/terminal-worker-*.js` relative to our `/assets/` client bundle.
  const packageJson = new URL(import.meta.resolve("@gespenst/core/package.json"));
  const packageAssets = new URL("./dist/assets/", packageJson);
  const workers = (await readdir(packageAssets)).filter((name) => /^terminal-worker-[\w-]+\.js$/.test(name));
  if (workers.length !== 1) throw new Error(`expected exactly one Gespenst terminal worker, got ${workers.length}`);
  const content = new Uint8Array(await Bun.file(new URL(workers[0]!, packageAssets)).arrayBuffer());
  const workerDir = new URL("./assets/", assetsDir);
  await mkdir(workerDir, { recursive: true });
  await Bun.write(new URL(workers[0]!, workerDir), content);
  await Bun.write(new URL(`${workers[0]!}.gz`, workerDir), gzipSync(content, { level: 9 }));
}

async function publishStagedAssets(): Promise<void> {
  await mkdir(assetsDir, { recursive: true });
  for (const entry of await readdir(stagingDir, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`Unexpected staged asset directory: ${entry.name}`);
    await rename(join(stagingDir.pathname, entry.name), join(assetsDir.pathname, entry.name));
  }
  await Bun.write(manifestTempUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(manifestTempUrl, manifestUrl);
}

async function compressStagedAssets(): Promise<void> {
  for (const entry of await readdir(stagingDir, { withFileTypes: true })) {
    if (!entry.isFile() || ![".css", ".js", ".svg"].includes(extname(entry.name))) continue;
    const content = new Uint8Array(await Bun.file(join(stagingDir.pathname, entry.name)).arrayBuffer());
    await Bun.write(join(stagingDir.pathname, `${entry.name}.gz`), gzipSync(content, { level: 9 }));
  }
}

await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

try {
  if (clientOnly) Object.assign(manifest, parseAssetManifest(await Bun.file(manifestUrl).text()));
  else for (const [logicalPath, entry] of nonCssFiles) await copyBinaryAsset(logicalPath, entry.url);

  await buildClientEntrypoints();

  if (!clientOnly) {
    const cssAssets = await fingerprintCssAssets(cssFiles);
    for (const [logicalPath, content] of cssAssets) {
      await Bun.write(new URL(manifest[logicalPath]!.replace("/assets/", ""), stagingDir), content);
    }
  }

  await compressStagedAssets();
  await publishGespenstWorker();
  await publishStagedAssets();

  for (const [logicalPath, publicPath] of Object.entries(manifest).sort()) {
    console.log(`${logicalPath} -> ${publicPath}`);
  }
} finally {
  await rm(stagingDir, { recursive: true, force: true });
  await rm(manifestTempUrl, { force: true });
}
