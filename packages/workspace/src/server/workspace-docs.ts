import { imageSource } from "@kintsugi/shared/publishing";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { kintsugiEnv, writeFileAtomic } from "@kintsugi/core";

/** Merge shared and package-owned documentation into the existing read-only bind mount. */
export async function syncWorkspaceDocs(repositoryRoot: string, destination: string, buildCommit = kintsugiEnv("COMMIT_ID")): Promise<void> {
  const sources = [join(repositoryRoot, "docs", "deploy-in-workspace")];
  const packages = join(repositoryRoot, "packages");
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(packages, entry.name);
    if ((await readdir(root, { withFileTypes: true })).some((child) => child.name === "deploy-in-workspace" && child.isDirectory())) {
      sources.push(join(root, "deploy-in-workspace"));
    }
  }

  const files = new Map<string, string>();
  const directories = new Set<string>();
  async function collect(source: string, relative = ""): Promise<void> {
    for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      const origin = join(source, path);
      if (files.has(path) || (entry.isFile() && directories.has(path))) {
        throw new Error(`Conflicting workspace documentation path: ${path} (${origin})`);
      }
      if (entry.isDirectory()) {
        directories.add(path);
        await collect(source, path);
      } else if (entry.isFile()) {
        files.set(path, origin);
      } else {
        throw new Error(`Workspace documentation must contain regular files and directories: ${origin}`);
      }
    }
  }
  for (const source of sources.sort()) await collect(source);

  // Keep existing directory inodes: running workspaces have this tree bind-mounted.
  await mkdir(destination, { recursive: true });
  async function prune(relative = ""): Promise<void> {
    for (const entry of await readdir(join(destination, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory() && directories.has(path)) await prune(path);
      else if (!entry.isFile() || !files.has(path)) await rm(join(destination, path), { recursive: true, force: true });
    }
  }
  await prune();
  for (const directory of directories) await mkdir(join(destination, directory), { recursive: true });
  const repositoryUrl = imageSource;
  const build = buildCommit
    ? `[${buildCommit.slice(0, 7)}](${repositoryUrl}/commit/${encodeURIComponent(buildCommit)})`
    : "local development build";
  const sourceLine = `\n\nIf you cannot find the answer to your question here, you can find the source code of this version of Kintsugi here: [GitHub](${repositoryUrl}) · ${build}\n`;
  for (const [path, source] of files) {
    const content = await readFile(source);
    const deployed = path.endsWith(".md") ? Buffer.concat([content, Buffer.from(sourceLine)]) : content;
    await writeFileAtomic(join(destination, path), deployed, { mode: 0o444 });
  }
}
