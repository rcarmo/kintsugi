import { expect, test } from "bun:test";

test("test Docker discovery uses a private namespace passed in the child environment", async () => {
  const namespace = process.env.KINTSUGI_NAMESPACE;
  expect(namespace).toStartWith("kintsugi-test-data-");
  expect(namespace).not.toBe("host");
  const child = Bun.spawn([process.execPath, "--eval", "console.log(process.env.KINTSUGI_NAMESPACE)"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout.trim()).toBe(namespace);
});
