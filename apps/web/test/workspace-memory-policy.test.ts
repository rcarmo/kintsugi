import type { JsonObject } from "@kintsugi/core";
import { expect, test } from "bun:test";
import { handleWorkspaceResourceSettings, type WorkspaceMemoryPolicyBackend } from "../src/server/settings/workspace-resources.ts";
import { matchAdminRoute } from "../src/server/admin/routes.ts";

const GiB = 1024 ** 3;
const request = (method: string, input?: JsonObject) => new Request("https://management.example/settings/workspace-resources", { method, headers: { accept: "application/json", "content-type": "application/json" }, body: input ? JSON.stringify(input) : undefined });
const policy = { maximumMemory: 2 * GiB, capacity: 6 * GiB, defaultMemory: 2 * GiB };

test("global RAM API parses finite caps and rejects arbitrary configuration fields", async () => {
  const calls: number[] = [];
  const backend: WorkspaceMemoryPolicyBackend = { available: async () => true, inspect: async () => policy, configure: async changes => { calls.push(changes.maximumMemory); return { ...policy, maximumMemory: changes.maximumMemory }; } };
  expect((await handleWorkspaceResourceSettings(request("GET"), new URL(request("GET").url), backend))!.status).toBe(200);
  const invalid: JsonObject[] = [{ maximumMemory: 0 }, { maximumMemory: "2048" }, { maximumMemory: GiB, command: "resize-all" }, { maximumMemory: -1 }];
  for (const input of invalid) {
    expect((await handleWorkspaceResourceSettings(request("POST", input), new URL(request("GET").url), backend))!.status).toBe(400);
  }
  expect(calls).toEqual([]);
  const response = (await handleWorkspaceResourceSettings(request("POST", { maximumMemory: GiB }), new URL(request("GET").url), backend))!;
  expect(response.status).toBe(200);
  expect((await response.json()).workspaceMemoryPolicy.maximumMemory).toBe(GiB);
  expect(calls).toEqual([GiB]);
});

test("global RAM API reports conflicts and requires explicit security scope", async () => {
  const backend: WorkspaceMemoryPolicyBackend = { available: async () => true, inspect: async () => policy, configure: async () => { throw Error("Lower conflicting workspace limits first"); } };
  const response = (await handleWorkspaceResourceSettings(request("POST", { maximumMemory: GiB }), new URL(request("GET").url), backend))!;
  expect(response.status).toBe(409);
  expect((await response.json()).error.message).toContain("conflicting");
  expect(matchAdminRoute("POST", "/settings/workspace-resources")?.scopes).toEqual(["security"]);
  expect(matchAdminRoute("GET", "/settings/workspace-resources")?.scopes).toEqual(["security"]);
  backend.available = async () => false;
  expect((await handleWorkspaceResourceSettings(request("GET"), new URL(request("GET").url), backend))!.status).toBe(503);
});

test("task defaults use the same strict JSON and form boundary as RAM policy",async()=>{
 const calls:unknown[]=[];
 const backend:WorkspaceMemoryPolicyBackend={available:async()=>true,inspect:async()=>({...policy,defaultPids:1024,pidsCapacity:4096}),configure:async input=>{calls.push(input);return {...policy,defaultPids:input.defaultPids,pidsCapacity:4096};}};
 const response=(await handleWorkspaceResourceSettings(request("POST",{maximumMemory:GiB,defaultPids:2048}),new URL(request("GET").url),backend))!;
 expect(response.status).toBe(200);expect((await response.json()).workspaceMemoryPolicy.defaultPids).toBe(2048);
 const form=new Request(request("GET").url,{method:"POST",headers:{accept:"application/json"},body:new URLSearchParams({maximumMemoryMiB:"1024",defaultPids:"3072"})});
 expect((await handleWorkspaceResourceSettings(form,new URL(form.url),backend))!.status).toBe(200);
 expect(calls).toEqual([{maximumMemory:GiB,defaultPids:2048},{maximumMemory:GiB,defaultPids:3072}]);
 for(const defaultPids of [0,127,1.5,"2048"]){expect((await handleWorkspaceResourceSettings(request("POST",{maximumMemory:GiB,defaultPids}),new URL(request("GET").url),backend))!.status).toBe(400);}
});
