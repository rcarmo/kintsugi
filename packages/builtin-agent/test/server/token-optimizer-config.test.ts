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

test("classifier-only optimizer configuration preserves the Decisions reference without substituting a text model",async()=>{
  const path=await mkdtemp(join(tmpdir(),"optimizer-classifier-config-"));paths.push(path);
  const service=new TokenOptimizerConfiguration(path),config=await service.load();
  config.policy.enabled=true;config.policy.mode="observe";config.policy.loop="judge";config.policy.judge="classifier";
  config.policy.classifierModel={provider:"openai",id:"gpt-6-luna"};config.policy.generativeModel=null;
  await service.configure(config);
  const reopened=new TokenOptimizerConfiguration(path),saved=await reopened.load();
  expect(saved.policy.classifierModel).toEqual({provider:"openai",id:"gpt-6-luna"});
  expect(saved.policy.generativeModel).toBeNull();expect(saved.policy.judge).toBe("classifier");
  expect(saved.policy.mode).toBe("observe");expect(saved.policy.inferenceInObserve).toBe(false);
});

test("split settings preserve legacy modes and ancestor vetoes, then apply changes independently",async()=>{
  const path=await mkdtemp(join(tmpdir(),"optimizer-split-config-"));paths.push(path);
  const {splitOptimizerPolicy}=await import("../../src/server/token-optimizer-config.ts");
  const {oversightPolicy}=await import("@kintsugi/token-economizer/core");
  const service=new TokenOptimizerConfiguration(path),config=await service.load();
  config.policy.enabled=true;config.policy.goalChecks=true;config.policy.loop="rules";
  await service.configure(config);const legacy=service.snapshot();legacy.policy.mode="active";legacy.workspaces.blocked="off";
  await service.configure(legacy);expect(oversightPolicy(service.policy("allowed","agent")).mode).toBe("active");
  const split=service.snapshot();splitOptimizerPolicy(split);split.policy.enabled=false;
  await service.configure(split);
  expect(service.policy("allowed","agent").mode).toBe("off");expect(oversightPolicy(service.policy("allowed","agent")).mode).toBe("active");
  expect(oversightPolicy(service.policy("blocked","agent")).mode).toBe("off");
  expect(split.policy.sharePlanWithJudge).toBeUndefined();
  const next=service.snapshot();next.policy.enabled=true;next.policy.oversightMode="off";await service.configure(next);
  const saved=new TokenOptimizerConfiguration(path);await saved.load();
  expect(saved.policy("allowed","agent").mode).toBe("active");expect(oversightPolicy(saved.policy("allowed","agent")).mode).toBe("off");
});
