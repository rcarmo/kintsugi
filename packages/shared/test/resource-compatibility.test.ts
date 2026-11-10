import { expect,test } from "bun:test";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import { requiredAppResourceStateVersion,requiredResourceStateVersion,assertResourceStateCompatible } from "../src/resource-compatibility.ts";
import {resourcePolicyVersionLabel,systemVersionLabel} from "../src/system-version.ts";

test("configured resource markers require a reader without changing network format or empty-install compatibility",async()=>{
  const root=await mkdtemp(join(tmpdir(),"resource-compatibility-"));const app=join(root,"app"),directory=join(app,"workspaces","fixture","metadata");
  try{
    expect(await requiredResourceStateVersion(root)).toBe(0);await mkdir(directory,{recursive:true});await writeFile(join(directory,"resource-policy.json"),JSON.stringify({version:1}));
    expect(await requiredResourceStateVersion(root)).toBe(1);expect(await requiredAppResourceStateVersion(app)).toBe(1);
    expect(()=>assertResourceStateCompatible(0,{},{})).not.toThrow();
    expect(()=>assertResourceStateCompatible(1,{[resourcePolicyVersionLabel]:"1"},{[systemVersionLabel]:"3"})).not.toThrow();
    expect(()=>assertResourceStateCompatible(1,{}, {[systemVersionLabel]:"3"})).toThrow("resource-aware");
    expect(()=>assertResourceStateCompatible(1,{[resourcePolicyVersionLabel]:"1"},{[systemVersionLabel]:"2"})).toThrow("resource-aware");
    await rm(join(app,"workspaces","fixture"),{recursive:true});expect(await requiredResourceStateVersion(root)).toBe(0);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("malformed markers do not silently authorise a downgrade",async()=>{
  const root=await mkdtemp(join(tmpdir(),"resource-compatibility-invalid-"));const directory=join(root,"workspaces","fixture","metadata");
  try{await mkdir(directory,{recursive:true});await writeFile(join(directory,"resource-policy.json"),'{"version":0}');await expect(requiredAppResourceStateVersion(root)).rejects.toThrow();}finally{await rm(root,{recursive:true,force:true});}
});

test("global RAM policy fences old app/System images even with no workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "global-resource-compatibility-"));
  try {
    await writeFile(join(root, "workspace-resource-policy.json"), JSON.stringify({ version: 2, maximumMemory: 2 * 1024 ** 3 }));
    expect(await requiredAppResourceStateVersion(root)).toBe(2);
    expect(() => assertResourceStateCompatible(2, { [resourcePolicyVersionLabel]: "2" }, { [systemVersionLabel]: "4" })).not.toThrow();
    expect(() => assertResourceStateCompatible(2, { [resourcePolicyVersionLabel]: "1" }, { [systemVersionLabel]: "4" })).toThrow();
    expect(() => assertResourceStateCompatible(2, { [resourcePolicyVersionLabel]: "2" }, { [systemVersionLabel]: "3" })).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("saved task defaults and overrides fence pre-task-policy app and System images",async()=>{
 const root=await mkdtemp(join(tmpdir(),"task-resource-compatibility-"));
 try{
  await writeFile(join(root,"workspace-resource-policy.json"),JSON.stringify({version:3,maximumMemory:2*1024**3,defaultPids:2048}));
  expect(await requiredAppResourceStateVersion(root)).toBe(3);
  expect(()=>assertResourceStateCompatible(3,{[resourcePolicyVersionLabel]:"3"},{[systemVersionLabel]:"5"})).not.toThrow();
  expect(()=>assertResourceStateCompatible(3,{[resourcePolicyVersionLabel]:"2"},{[systemVersionLabel]:"5"})).toThrow();
  expect(()=>assertResourceStateCompatible(3,{[resourcePolicyVersionLabel]:"3"},{[systemVersionLabel]:"4"})).toThrow();
  await rm(join(root,"workspace-resource-policy.json"));await mkdir(join(root,"workspaces/one/metadata"),{recursive:true});
  await writeFile(join(root,"workspaces/one/metadata/resource-policy.json"),JSON.stringify({version:3}));
  expect(await requiredAppResourceStateVersion(root)).toBe(3);
 }finally{await rm(root,{recursive:true,force:true});}
});
