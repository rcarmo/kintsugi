import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as core from "../src/core/index.ts";
import manifest from "../package.json";
const root = `${import.meta.dir}/..`;
test("declared entry points exist and core exports load without a host", () => {
  for (const entry of Object.values(manifest.exports)) expect(existsSync(`${root}/${entry}`)).toBe(true);
  expect(core.defaultPolicy().enabled).toBe(false);
  expect(manifest.peerDependencies["@earendil-works/pi-durable"]).toBe("1.5.2");
});
test("core imports no host, SDK, filesystem, network or clock", async () => {
  const allowedDependencies = new Set(["typebox", "typebox/value", "re2js", "@noble/hashes/legacy.js", "@noble/hashes/sha2.js"]);
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: root })) {
    const source = await Bun.file(`${root}/${file}`).text();
    const { imports } = new Bun.Transpiler({ loader: "ts" }).scan(source);
    const names = new Set([...imports.map(item => item.path), ...Array.from(source.matchAll(/\bfrom\s+["']([^"']+)["']/g), match => match[1])]);
    for (const name of names) {
      expect(name.startsWith("@kintsugi/")).toBe(false);
      if (file.startsWith("src/core/")) {
        const insideCore = name.startsWith(".") && resolve(dirname(`${root}/${file}`), name).startsWith(`${resolve(root)}/src/core/`);
        expect(insideCore || allowedDependencies.has(name)).toBe(true);
      }
    }
    if (file.startsWith("src/core/")) expect(source).not.toMatch(/\b(?:fetch|eval|setTimeout|setInterval|Date\.now|performance\.now)\s*\(|\b(?:Bun|process)\./);
  }
});
test("distribution retains the pinned upstream licence, attribution and modified-port notices",async () => {
  const licence = await Bun.file(`${root}/LICENSE`).text();expect(new Bun.CryptoHasher("sha256").update(licence).digest("hex")).toBe("cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30");
  const notice = await Bun.file(`${root}/../../NOTICE`).text();expect(notice).toContain("Microsoft TokenEconomizer");expect(notice).toContain("81e32e56bb3c4c1b4c9756b429be91e3960116ca");
  for await (const file of new Bun.Glob("src/core/{microskills,loopguard,toolprune}/**/*.ts").scan({cwd:root})) expect(await Bun.file(`${root}/${file}`).text()).toContain("Modified TypeScript port");
  expect(await Bun.file(`${root}/../../apps/web/Dockerfile`).text()).toContain("COPY --from=build --exclude=node_modules /app /app");expect((await Bun.file(`${root}/../../.dockerignore`).text()).split("\n")).not.toContain("packages/token-economizer/LICENSE");
});
