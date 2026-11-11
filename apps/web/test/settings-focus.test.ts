import { expect, test } from "bun:test";
import { createKintsugiEventBus } from "@kintsugi/core";
import { createWebApp } from "../src/server/app.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

test("a Settings link can reveal one item inside a lazily loaded section", async () => {
  const app = createWebApp({ registry: createWorkspaceRegistry(), events: createKintsugiEventBus(), workspaceModules: [],
    provisionWorkspace: async () => {}, destroyWorkspace: async () => {},
    deletionReview: { inspect: async () => ({ status: "clear" }), renderEvidence: () => "" },
  });
  const focus = encodeURIComponent(JSON.stringify(["workspace", "agent"]));
  const frame = await (await app.fetch(new Request(`http://localhost/settings?section=token-optimizer&focus=${focus}`, { headers: { "turbo-frame": "app_settings_frame" } }))).text();
  expect(frame).toContain(`src="/settings/sections/token-optimizer?focus=${focus}"`);
  expect(frame).toContain('id="settings-sec-token-optimizer" class="disclosure" open');
  // Other sections and unfocused links keep their plain lazy source.
  expect(frame).toContain('src="/settings/sections/telemetry"');
  const section = await app.fetch(new Request(`http://localhost/settings/sections/token-optimizer?focus=${focus}`));
  expect(section.status).toBe(200);
  expect(await section.text()).toContain('id="token_optimizer_controls"');
});
