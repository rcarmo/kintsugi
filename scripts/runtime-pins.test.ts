import { expect, test } from "bun:test";

// Runtime consumers must adopt the same independently verified manifest.
test("app, System and workspace defaults pin the same immutable runtime", async () => {
  const root = new URL("../", import.meta.url);
  const workspace = (await Bun.file(new URL("packages/workspace-image/runtime-image", root)).text()).trim();
  const app = (await Bun.file(new URL("apps/web/Dockerfile", root)).text()).match(/^ARG ATELIER_RUNTIME_IMAGE=(\S+)$/m)?.[1];
  const system = (await Bun.file(new URL("images/system/Dockerfile", root)).text()).match(/^ARG RUNTIME_IMAGE=(\S+)$/m)?.[1];
  expect(workspace).toMatch(/^ghcr\.io\/rcarmo\/kintsugi-docker@sha256:[a-f0-9]{64}$/);
  expect(system).toBe(workspace);
  expect(app).toBe(workspace);
});
