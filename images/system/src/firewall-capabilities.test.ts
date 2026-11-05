import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise installation and error handling in isolated subprocesses, without
// changing the running host firewall or concurrent tests' process environment.
for (const scenario of ["supported", "missing-socket", "permission-error", "install-error"] as const) {
  test(`firewall capability preflight: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "kintsugi-nft-test-"));
    try {
      const probeError = scenario === "missing-socket" ? "Error: Could not process rule: No such file or directory"
        : scenario === "permission-error" ? "Operation not permitted" : "";
      await writeFile(join(directory, "nft"), `#!/bin/sh
cat > '${directory}/'$(if [ "$1" = -c ]; then echo probe; else echo installed; fi)
if [ "$1" = -c ]; then
  ${probeError ? `echo '${probeError}' >&2; exit 1` : "exit 0"}
fi
${scenario === "install-error" ? "echo 'FIB unsupported' >&2; exit 1" : "exit 0"}
`, { mode: 0o755 });
      await writeFile(join(directory, "test.ts"), `
import { installWorkspaceFirewall } from ${JSON.stringify(join(import.meta.dir, "firewall.ts"))};
await installWorkspaceFirewall('/system/workloads/build-clients', ['127.0.0.53']);
`);
      const child = Bun.spawn([process.execPath, join(directory, "test.ts")], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const probe = await readFile(join(directory, "probe"), "utf8");
      expect(probe).toContain("socket cgroupv2");
      expect(probe).toContain("add table inet kintsugi_socket_preflight");
      expect(probe).not.toContain("aitc");
      if (scenario === "permission-error" || scenario === "install-error") {
        expect(code).not.toBe(0);
        expect(stderr).toContain("Could not install workspace firewall");
      } else {
        expect(code).toBe(0);
        expect(stdout).toBe("");
        expect(stderr).toBe("");
        const installed = await readFile(join(directory, "installed"), "utf8");
        expect(installed.includes("socket cgroupv2")).toBe(scenario === "supported");
        expect(installed).toContain('meta iifkind "bridge" counter drop');
        expect(installed).toContain("fib daddr type local counter drop");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
