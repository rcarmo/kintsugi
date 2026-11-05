import { expect, test } from "bun:test";
import type { JsonObject } from "@kintsugi/core";
import { handleWorkspaceResources, type WorkspaceResourceBackend } from "../src/server/workspace-properties.ts";
import type { WorkspaceResourceSnapshot } from "@kintsugi/shared/workspace-resources";

const GiB=1024**3;
function snapshot():WorkspaceResourceSnapshot{return {workspaceId:"fixture",containerId:"container-fixture",image:"fixture:image",state:{running:false,status:"exited",oomKilled:false,exitCode:0,restartCount:0,restartPolicy:"no",finishedAt:"",startedAt:""},desired:{memory:2*GiB,memorySwap:2*GiB,cpus:2,pids:1024},applied:{memory:2*GiB,memorySwap:2*GiB,cpus:2,pids:1024},usage:{},capacity:{hostMemory:16*GiB,hostAvailable:8*GiB,systemMemory:10*GiB,workspaceBudget:6*GiB,otherMemory:2*GiB,additionalSwapBudget:0,otherAdditionalSwap:0,cpus:8},oomKills:0,inSync:true,pending:false,addresses:[],publishedPorts:[],exposedPorts:[],affinity:""};}
const request=(method="GET",body?:JsonObject)=>new Request("http://test.local/workspaces/fixture/resources",{method,headers:{Origin:"http://test.local",Accept:"application/json","content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
test("resource inspection does not invoke mutation or require a running container",async()=>{
  let mutations=0;const backend:WorkspaceResourceBackend={inspect:async()=>snapshot(),configure:async()=>{mutations++;throw Error("Unexpected mutation");}};
  const r=await handleWorkspaceResources(request(),"fixture",backend);expect(r.status).toBe(200);expect((await r.json()).resources.state.running).toBe(false);expect(mutations).toBe(0);
});
test("resource mutations share a strict bytes/additional-swap/cores contract",async()=>{
  const calls:JsonObject[]=[];const backend:WorkspaceResourceBackend={inspect:async()=>snapshot(),configure:async(_id,input)=>{calls.push(input);return snapshot();}};
  const valid={memory:GiB,additionalSwap:0,cpus:1.5,acknowledgeMemoryReduction:true};expect((await handleWorkspaceResources(request("POST",valid),"fixture",backend)).status).toBe(200);expect(calls).toEqual([valid]);
  for(const invalid of [{memory:0,additionalSwap:0,cpus:1},{...valid,command:"docker stop other"},{...valid,additionalSwap:-1},{...valid,cpus:0},{...valid,memory:"1073741824"}])expect((await handleWorkspaceResources(request("POST",invalid),"fixture",backend)).status).toBe(400);
  expect(calls).toHaveLength(1);
});
test("admission or reduction failures remain actionable and do not invent applied state",async()=>{
  const backend:WorkspaceResourceBackend={inspect:async()=>snapshot(),configure:async()=>{throw Error("Confirm the RAM reduction");}};
  const r=await handleWorkspaceResources(request("POST",{memory:GiB,additionalSwap:0,cpus:1}),"fixture",backend);expect(r.status).toBe(409);expect((await r.json()).error.message).toContain("Confirm");
});
test("failed Docker applies return saved desired and actual applied state with a conflict status",async()=>{
  const state=snapshot();state.desired.memory=3*GiB;state.pending=true;state.inSync=false;state.failure="Docker refused the update";
  const backend:WorkspaceResourceBackend={inspect:async()=>state,configure:async()=>state};const r=await handleWorkspaceResources(request("POST",{memory:3*GiB,additionalSwap:0,cpus:1}),"fixture",backend);expect(r.status).toBe(409);const body=await r.json();expect(body.resources.desired.memory).toBe(3*GiB);expect(body.resources.applied.memory).toBe(2*GiB);expect(body.resources.pending).toBe(true);
});
test("unsupported installation capability is a bounded unavailable response",async()=>{
  const backend:WorkspaceResourceBackend={inspect:async()=>{throw Error("Update installation services to version 3");},configure:async()=>{throw Error("Unsupported");}};
  const r=await handleWorkspaceResources(request(),"fixture",backend);expect(r.status).toBe(503);expect((await r.json()).error.code).toBe("workspace_resources_unavailable");
});

test("properties network controls stage supported policy and require confirmation for installation-wide DNS",async()=>{
  const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const {handleWorkspaceProperties}=await import("../src/server/workspace-properties.ts");const {getNetworkConfiguration,setNetworkConfiguration,getWorkspaceNetworkMode,getAppliedWorkspaceNetwork,workspaceNetworkRestartRequired}=await import("@kintsugi/workspace");
  const previous=process.env.KINTSUGI_DATA_DIR,directory=await mkdtemp(join(tmpdir(),"inspector-network-"));process.env.KINTSUGI_DATA_DIR=directory;
  const backend:WorkspaceResourceBackend={inspect:async()=>snapshot(),configure:async()=>snapshot()};
  const form=(path:string,fields:Record<string,string>)=>new Request("http://test.local"+path,{method:"POST",headers:{Origin:"http://test.local",Accept:"text/vnd.turbo-stream.html","content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(fields)});
  try{
    await setNetworkConfiguration({cidrs:["192.168.22.0/24"],dns:[],search:[]});
    const mode=form("/workspaces/fixture/properties/network",{mode:"lan"});expect((await handleWorkspaceProperties(mode,new URL(mode.url),"fixture","Fixture",async()=>new Response("page"),backend)).status).toBe(200);
    expect(getWorkspaceNetworkMode("fixture")).toBe("lan");expect(getAppliedWorkspaceNetwork("fixture").mode).toBe("off");expect(await workspaceNetworkRestartRequired("fixture")).toBe(true);
    const missing=form("/workspaces/fixture/properties/dns",{cidrs:"192.168.22.0/24",dns:"8.8.8.8",search:"example.test"});expect((await handleWorkspaceProperties(missing,new URL(missing.url),"fixture","Fixture",async()=>new Response("page"),backend)).status).toBe(422);expect((await getNetworkConfiguration()).dns).toEqual([]);
    const confirmed=form("/workspaces/fixture/properties/dns",{cidrs:"192.168.22.0/24",dns:"8.8.8.8",search:"example.test",confirmGlobalNetworkChange:"on"});expect((await handleWorkspaceProperties(confirmed,new URL(confirmed.url),"fixture","Fixture",async()=>new Response("page"),backend)).status).toBe(200);expect(await getNetworkConfiguration()).toEqual({cidrs:["192.168.22.0/24"],dns:["8.8.8.8"],search:["example.test"]});
  }finally{if(previous===undefined)delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR=previous;await rm(directory,{recursive:true,force:true});}
});
