import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkspaceImageMetadata } from "../src/metadata.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryRoots: string[] = [];
afterAll(async () => { await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true }))); });

async function generateContext(fixture: string) {
  const output = join(fixture, "output");
  const process = Bun.spawnSync(["bun", join(fixture, "packages/workspace-image/scripts/build-context.mjs"), output], { cwd: fixture, stdout: "pipe", stderr: "pipe" });
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
  return { fixture, output, metadata: await Bun.file(join(output, "metadata.json")).text(), dockerfile: await Bun.file(join(output, "Dockerfile")).text() };
}

async function generateInCheckout() {
  const fixture = await mkdtemp(join(tmpdir(), "kintsugi-image-context-"));
  temporaryRoots.push(fixture);
  await cp(join(root, "packages"), join(fixture, "packages"), { recursive: true });
  return generateContext(fixture);
}

describe("workspace image content identity", () => {
  test("validates generated metadata before consumers use it", () => {
    expect(parseWorkspaceImageMetadata({ tag: "kintsugi-workspace:abc", modules: ["base"] })).toEqual({
      tag: "kintsugi-workspace:abc",
      modules: ["base"],
    });
    expect(() => parseWorkspaceImageMetadata({ tag: 42, modules: ["base"] })).toThrow();
    expect(() => parseWorkspaceImageMetadata({ tag: "kintsugi-workspace:abc" })).toThrow();
  });

  test.each([
    ["systemd bootstrap script", "packages/workspace-image/rootfs/usr/local/bin/kintsugi-workspace-init", "files/base/rootfs/usr/local/bin/kintsugi-workspace-init", "#"],
    ["Docker capability guard", "packages/workspace-image/rootfs/usr/local/bin/docker", "files/base/rootfs/usr/local/bin/docker", "#"],
  ])("%s is packaged and changes the default image identity", async (_name, sourcePath, packagedPath, comment) => {
    const before = await generateInCheckout();
    const source = join(before.fixture, sourcePath);
    await appendFile(source, `\n${comment} image identity probe\n`);
    const after = await generateContext(before.fixture);
    expect(await Bun.file(join(after.output, packagedPath)).text()).toBe(await Bun.file(source).text());
    expect(after.metadata).not.toBe(before.metadata);
  }, 30_000);

  test("generated Dockerfile and file permissions participate in identity", async () => {
    const before = await generateInCheckout();
    const generator = join(before.fixture, "packages/workspace-image/scripts/build-context.mjs");
    await writeFile(generator, (await readFile(generator, "utf8")).replace("WORKDIR /work", "WORKDIR /changed-work"));
    const instructionChange = await generateContext(before.fixture);
    expect(instructionChange.metadata).not.toBe(before.metadata);
    await chmod(join(before.fixture, "packages/workspace-image/rootfs/usr/local/bin/kintsugi-workspace-init"), 0o700);
    const permissionChange = await generateContext(before.fixture);
    expect(permissionChange.metadata).not.toBe(instructionChange.metadata);
  }, 30_000);

  test("adds mounted tools to the inherited PATH and restores them for login shells", async () => {
    const { dockerfile, output } = await generateInCheckout();
    expect(dockerfile).toContain('PATH="/opt/kintsugi/bin:${PATH}"');
    const profile = await readFile(join(output, "files/base/rootfs/etc/profile.d/kintsugi-tools.sh"), "utf8");
    const result = Bun.spawnSync(["/bin/sh", "-ec", `${profile}\nprintf '%s' "$PATH"`], {
      env: { PATH: "/custom/bin:/usr/bin:/bin" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("/opt/kintsugi/bin:/custom/bin:/usr/bin:/bin");
  }, 30_000);

  test("mounted helper changes do not change the image or its identity", async () => {
    const before = await generateInCheckout();
    for (const [packageName, name] of [
      ["desktop", "kintsugi-desktop"],
      ["vscode", "kintsugi-start-vscode"],
      ["workspace-terminal", "pbcopy"],
      ["workspace-image", "chromium"],
    ]) {
      expect(before.dockerfile).not.toContain(`/usr/local/bin/${name}`);
      await appendFile(join(before.fixture, "packages", packageName!, "workspace_tools", name!), "\n# mounted helper update\n");
    }
    const after = await generateContext(before.fixture);
    expect(after.metadata).toBe(before.metadata);
    expect(after.dockerfile).toBe(before.dockerfile);
  }, 30_000);

  test("equivalent checkouts at different absolute paths produce identical output", async () => {
    const [left, right] = await Promise.all([generateInCheckout(), generateInCheckout()]);
    expect(left.metadata).toBe(right.metadata);
    expect(left.dockerfile).toBe(right.dockerfile);
  }, 30_000);
});

describe("workspace image layer ordering", () => {
  test("splits base apt packages into five layers before setup", async () => {
    const { dockerfile, fixture } = await generateInCheckout();
    const manifest = JSON.parse(await readFile(join(fixture, "packages/workspace-image/workspace-image.json"), "utf8"));
    const base = dockerfile.split("# Module: base\n")[1]!.split("# Module:")[0]!;
    const installs = [...base.matchAll(/apt-get install -y --no-install-recommends \\\n([\s\S]*?)\n\n/g)];
    expect(installs).toHaveLength(5);
    const packages = installs.map((match) => match[1]!.replaceAll("\\", "").trim().split(/\s+/));
    expect(packages).toEqual(manifest.aptPackageGroups.map((group: string[]) => [...group].sort()));
    expect(new Set(packages.flat()).size).toBe(packages.flat().length);
    expect(packages[2]).toEqual(["python3-pil"]);
    for (const removed of ["python3-imageio", "python3-matplotlib", "python3-moviepy", "python3-opencv", "python3-skimage"]) {
      expect(packages.flat()).not.toContain(removed);
    }
    expect(base.lastIndexOf("apt-get install")).toBeLessThan(base.indexOf("RUN ln -sf"));
  }, 30_000);

  test("changing the last base apt group preserves earlier install instructions", async () => {
    const before = await generateInCheckout();
    const path = join(before.fixture, "packages/workspace-image/workspace-image.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.aptPackageGroups.at(-1).push("valgrind");
    await writeFile(path, JSON.stringify(manifest));
    const after = await generateContext(before.fixture);
    const prefix = (dockerfile: string) => dockerfile.split("      gdb")[0];
    expect(prefix(after.dockerfile)).toBe(prefix(before.dockerfile));
    expect(after.dockerfile).toContain("      valgrind");
    expect(after.metadata).not.toBe(before.metadata);
  }, 30_000);

  test("installs module dependencies before their setup, after heavyweight tooling", async () => {
    const { dockerfile } = await generateInCheckout();
    const moduleBlock = (name: string) => dockerfile.split(`# Module: ${name}\n`)[1]!.split("# Module:")[0]!.split("# Files independent")[0]!;
    const base = moduleBlock("base");
    expect(base.indexOf("apt-get install")).toBeLessThan(base.indexOf("npm install -g playwright"));
    expect(base).not.toContain("      socat");
    expect(base).not.toContain("      openbox");
    expect(base).not.toContain("      tmux");
    expect(moduleBlock("proxy-egress")).toContain("      socat");
    expect(moduleBlock("workspace-terminal")).toContain("tmux-$tmux_version.tar.gz");
    const desktop = moduleBlock("desktop");
    expect(desktop).toContain("      openbox");
    expect(desktop.indexOf("apt-get install")).toBeLessThan(desktop.indexOf("RUN glib-compile-schemas"));
    expect(dockerfile.indexOf("# Module: base")).toBeLessThan(dockerfile.indexOf("# Module: vscode"));
    expect(dockerfile.indexOf("# Module: vscode")).toBeLessThan(dockerfile.indexOf("# Module: desktop"));
  }, 30_000);

  test("changing feature dependencies preserves preceding build instructions", async () => {
    const before = await generateInCheckout();
    const manifest = join(before.fixture, "packages/proxy-egress/workspace-image.json");
    await writeFile(manifest, JSON.stringify({ aptPackages: ["socat", "strace", "socat"] }));
    const after = await generateContext(before.fixture);
    expect(after.metadata).not.toBe(before.metadata);
    const prefix = (dockerfile: string) => dockerfile.split("# Module: proxy-egress\n")[0];
    expect(prefix(after.dockerfile)).toBe(prefix(before.dockerfile));
    expect(after.dockerfile.match(/      socat/g)).toHaveLength(1);
    expect(after.dockerfile).toContain("      socat \\\n      strace");
  }, 30_000);

  test.each([
    ["packages/workspace-image/rootfs/usr/local/bin/kintsugi-workspace-init", "files/base/rootfs/usr/local/bin/kintsugi-workspace-init"],
  ])("copies runtime script %s only after module setup", async (sourcePath, packagedPath) => {
    const before = await generateInCheckout();
    const copy = `COPY ${JSON.stringify(packagedPath)}`;
    expect(before.dockerfile.indexOf(copy)).toBeGreaterThan(before.dockerfile.indexOf("# Files independent of module setup"));
    await appendFile(join(before.fixture, sourcePath), "\n# cache boundary probe\n");
    const after = await generateContext(before.fixture);
    expect(after.metadata).not.toBe(before.metadata);
    expect(after.dockerfile.split("LABEL com.kintsugi.workspace-image.signature=")[0]).toBe(before.dockerfile.split("LABEL com.kintsugi.workspace-image.signature=")[0]);
    expect(await readFile(join(after.output, packagedPath), "utf8")).toContain("# cache boundary probe");
  }, 30_000);
});
