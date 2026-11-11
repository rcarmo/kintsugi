import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenOptimizerConfiguration, parseOptimizerConfig } from "../../src/server/token-optimizer-config.ts";
const paths:string[] = [];
afterEach(async () => {for (const path of paths.splice(0)) await rm(path,{recursive:true,force:true});});
test("optimizer settings: default Off, first enable Observe, explicit Active, ancestor veto and restart",async () => {
  const path = await mkdtemp(join(tmpdir(),"optimizer-config-"));paths.push(path);
  const service = new TokenOptimizerConfiguration(path), config = await service.load();
  expect(service.policy("workspace","agent").mode).toBe("off");
  config.policy.enabled = true;config.policy.mode = "active";
  expect((await service.configure(config)).policy.mode).toBe("observe");
  const active = service.snapshot();active.policy.mode = "active";active.workspaces.workspace = "off";active.agents[JSON.stringify(["workspace","agent"])] = "active";
  await service.configure(active);expect(service.policy("workspace","agent").mode).toBe("off");
  active.workspaces.workspace = "inherit";await service.configure(active);expect(service.policy("workspace","agent").mode).toBe("active");
  const reopened = new TokenOptimizerConfiguration(path);await reopened.load();expect(reopened.policy("workspace","agent").mode).toBe("active");
  active.policy.enabled = false;await service.configure(active);expect(service.policy("workspace","agent").mode).toBe("off");
  expect((await stat(join(path,"token-optimizer/config.json"))).mode & 0o777).toBe(0o600);
});
test("optimizer settings reject unvalidated inputs and latent Active overrides on first enable",async () => {
  expect(() => parseOptimizerConfig({version:2})).toThrow();
  const path = await mkdtemp(join(tmpdir(),"optimizer-config-"));paths.push(path);
  const service = new TokenOptimizerConfiguration(path), config = await service.load();config.policy.enabled = true;config.workspaces.workspace = "active";
  await expect(service.configure(config)).rejects.toThrow("Observe");expect(service.snapshot().policy.enabled).toBe(false);
});
