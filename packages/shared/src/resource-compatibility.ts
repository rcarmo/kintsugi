import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isNotFoundError } from "@kintsugi/core";
import { workspaceDiskIdPattern, workspaceDiskImageDirectory, workspaceDiskImageSuffix } from "./workspace-disk.ts";
import { parseSystemVersion, resourcePolicyVersionLabel, resourceControlSystemVersion, workspaceMemoryPolicySystemVersion, workspaceTaskLimitsSystemVersion, workspaceDiskSystemVersion, workspaceDiskResourceVersion, systemVersionLabel } from "./system-version.ts";

const markerSchema=Type.Object({version:Type.Integer({minimum:1,maximum:2147483647})},{additionalProperties:false});
export async function requiredAppResourceStateVersion(appData:string):Promise<number>{
  let required=0;
  try {
    const policy=JSON.parse(await readFile(join(appData,"workspace-resource-policy.json"),"utf8"));
    required=Value.Parse(Type.Object({version:Type.Integer({minimum:2,maximum:2147483647})}),policy).version;
  } catch(error) { if(!isNotFoundError(error))throw error; }
  let directories;
  try{directories=await readdir(join(appData,"workspaces"),{withFileTypes:true});}catch(error){if(isNotFoundError(error))return required;throw error;}
  for(const directory of directories){if(!directory.isDirectory())continue;
    try{const data=await readFile(join(appData,"workspaces",directory.name,"metadata","resource-policy.json"),"utf8");required=Math.max(required,Value.Parse(markerSchema,JSON.parse(data)).version);}catch(error){if(!isNotFoundError(error))throw error;}
  }
  return required;
}
export async function requiredResourceStateVersion(systemData: string): Promise<number> {
  const required = await requiredAppResourceStateVersion(join(systemData, "app"));
  if (required >= workspaceDiskResourceVersion) return required;
  // Published disks can outlive the app's workspace records. A .new image has never held workspace data.
  try {
    const entries = await readdir(join(systemData, "supervisor", workspaceDiskImageDirectory), { withFileTypes: true });
    if (entries.some(entry => entry.isFile() && entry.name.endsWith(workspaceDiskImageSuffix) && workspaceDiskIdPattern.test(entry.name.slice(0, -workspaceDiskImageSuffix.length)))) return workspaceDiskResourceVersion;
  } catch (error) { if (!isNotFoundError(error)) throw error; }
  return required;
}
export function assertResourceStateCompatible(required:number,appLabels:Readonly<Record<string,string>>|null|undefined,systemLabels?:Readonly<Record<string,string>>|null):void{
  if(required===0)return;
  if(parseSystemVersion(appLabels?.[resourcePolicyVersionLabel])<required||(systemLabels!==undefined&&parseSystemVersion(systemLabels?.[systemVersionLabel])<(required>=workspaceDiskResourceVersion?workspaceDiskSystemVersion:required>=3?workspaceTaskLimitsSystemVersion:required>=2?workspaceMemoryPolicySystemVersion:resourceControlSystemVersion)))throw Error("Saved workspace resource limits require resource-aware app and System images. Select compatible images; desired allocations were not changed. Image rollback does not restore configuration.");
}
