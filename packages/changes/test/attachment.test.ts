import { expect, test } from "bun:test";

// Isolate module mocks from the real repository tests in the same suite.
test("workspace attachment and unopened turn completion do not capture Changes", async () => {
  const script = `
    import { mock } from "bun:test";
    import * as git from "@kintsugi/workspace/git";
    import { commandSignal, withCommandSignal } from "@kintsugi/core";
    let repositoryCalls = 0, rejectCapture, captureSignal;
    mock.module("@kintsugi/workspace/git", () => ({ ...git, workspaceRepository() {
      repositoryCalls++;
      captureSignal = commandSignal();
      return { gitResult() { return new Promise((_, reject) => { rejectCapture = reject; }); } };
    } }));
    const { kintsugiServerModule: module } = await import("./packages/changes/src/server/index.ts");
    const handlers = new Map();
    let notify, removed, invalidations = 0;
    module.initialize({
      invalidateWorkspace() { invalidations++; notify?.(); },
      events: { on(name, handler) { handlers.set(name, handler); } },
      onWorkspaceRemoved(handler) { removed = handler; },
    });
    await module.attachToWorkspace({ workspaceId: "slow-repository", init: { type: "existing" } });
    await handlers.get("workspace_agent_turn_finished")({ workspaceId: "slow-repository" });
    if (repositoryCalls !== 0) throw new Error("Closed Changes captured a repository");
    const view = { workspaceId: "slow-repository", reference: { type: "changes" } };
    const opening = new AbortController();
    const render = () => module.workViews[0].render(view);
    await withCommandSignal(opening.signal, render);
    await render();
    if (repositoryCalls !== 1 || !rejectCapture) throw new Error("Concurrent opens did not share one capture");
    opening.abort();
    if (!captureSignal || captureSignal.aborted) throw new Error("Changes capture inherited its view's cancellation");
    const invalidated = new Promise(resolve => { notify = resolve; });
    rejectCapture(new Error("fixture Git failure"));
    await invalidated;
    await render();
    if (repositoryCalls !== 1) throw new Error("Failure retried automatically");
    const retry = new Request("http://localhost/workspaces/slow-repository/changes/retry", { method: "POST" });
    const response = await module.routes[0].handle(retry, new URL(retry.url), {});
    if (response.status !== 200 || invalidations !== 2) throw new Error("Retry did not invalidate the failed view");
    await render();
    if (repositoryCalls !== 2) throw new Error("Retry did not start a fresh capture");
    removed(view.workspaceId);
    if (!captureSignal.aborted) throw new Error("Removed workspace did not cancel its capture");
    await Bun.sleep(0);
    if (invalidations !== 2) throw new Error("Removed workspace still published its capture");
  `;
  const process = Bun.spawn(["bun", "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  expect(stderr).toContain("fixture Git failure");
  expect(exitCode).toBe(0);
});
