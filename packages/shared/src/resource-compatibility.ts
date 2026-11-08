import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isNotFoundError } from "@kintsugi/core";
import { parseSystemVersion, resourcePolicyVersionLabel, resourceControlSystemVersion, workspaceMemoryPolicySystemVersion, systemVersionLabel } from "./system-version.ts";

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
export async function requiredResourceStateVersion(systemData:string):Promise<number>{return requiredAppResourceStateVersion(join(systemData,"app"));}
export function assertResourceStateCompatible(required:number,appLabels:Readonly<Record<string,string>>|null|undefined,systemLabels?:Readonly<Record<string,string>>|null):void{
  if(required===0)return;
  if(parseSystemVersion(appLabels?.[resourcePolicyVersionLabel])<required||(systemLabels!==undefined&&parseSystemVersion(systemLabels?.[systemVersionLabel])<(required>=2?workspaceMemoryPolicySystemVersion:resourceControlSystemVersion)))throw Error("Saved workspace resource limits require resource-aware app and System images. Select compatible images; desired allocations were not changed. Image rollback does not restore configuration.");
}
