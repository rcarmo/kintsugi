import { expect, test } from "bun:test";

const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:KINTSUGI|ATELIER)_/.test(name)));
const source = new URL("../src/index.ts", import.meta.url).pathname;
const cases: Array<{ name: string; env: Record<string, string>; prefix: string }> = [
  { name: "legacy installation names", env: { ATELIER_DATA_DIR: "/tmp/kintsugi-legacy-data", ATELIER_DOCKER_HOST_DATA_DIR: "/tmp/kintsugi-legacy-host", ATELIER_NAMESPACE: "existing-namespace", ATELIER_COMMIT_ID: "existing-commit", ATELIER_RELEASE_HELPER: "builder@existing", ATELIER_HOST_UID: "1000", ATELIER_WORKSPACE_IMAGE_NO_CACHE: "1" }, prefix: "ATELIER_" },
  { name: "Kintsugi configuration names", env: { KINTSUGI_DATA_DIR: "/tmp/kintsugi-primary-data", KINTSUGI_DOCKER_HOST_DATA_DIR: "/tmp/kintsugi-primary-host", KINTSUGI_NAMESPACE: "primary-namespace", KINTSUGI_COMMIT_ID: "primary-commit", KINTSUGI_RELEASE_HELPER: "builder@primary", KINTSUGI_HOST_UID: "1001", KINTSUGI_WORKSPACE_IMAGE_NO_CACHE: "0" }, prefix: "KINTSUGI_" },
];
cases.push({ name: "Kintsugi names take precedence when both are set", env: { ...cases[0]!.env, ...cases[1]!.env }, prefix: "KINTSUGI_" });

for (const { name, env, prefix } of cases) {
  test(name, async () => {
    const child = Bun.spawn([process.execPath, "-e", `
      import { getKintsugiRuntimeContext, kintsugiEnv } from ${JSON.stringify(source)};
      const runtime = getKintsugiRuntimeContext();
      console.log(JSON.stringify({ data: runtime.kintsugiDataDir, host: runtime.dockerHostKintsugiDataDir,
        values: Object.fromEntries(["NAMESPACE", "COMMIT_ID", "RELEASE_HELPER", "HOST_UID", "WORKSPACE_IMAGE_NO_CACHE"].map(name => [name, kintsugiEnv(name)])) }));
    `], { env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result.data).toBe(env[`${prefix}DATA_DIR`]);
    expect(result.host).toBe(env[`${prefix}DOCKER_HOST_DATA_DIR`]);
    for (const [key, value] of Object.entries(result.values)) expect(value).toBe(env[`${prefix}${key}`]);
  });
}
