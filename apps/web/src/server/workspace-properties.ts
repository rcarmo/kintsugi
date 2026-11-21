import { Value } from "typebox/value";
import { readJsonObject, type JsonObject } from "@kintsugi/core";
import { domId, escapeHtml, errorMessage, workspaceModuleModalFrameId } from "@kintsugi/shared";
import { workspaceResourceChangeSchema, type WorkspaceResourceChange, type WorkspaceResourceSnapshot } from "@kintsugi/shared/workspace-resources";
import { GiB, workspaceDiskSizeSchema, type WorkspaceDiskSnapshot } from "@kintsugi/shared/workspace-disk";
import { networkModeSchema, parseNetworkConfiguration } from "@kintsugi/shared/network-policy";
import { inspectWorkspaceDisk, growWorkspaceDisk, inspectWorkspaceResources, configureWorkspaceResources, getWorkspaceNetworkMode, getAppliedWorkspaceNetwork, workspaceNetworkRestartRequired, setWorkspaceNetworkMode, getNetworkConfiguration, setNetworkConfiguration } from "@kintsugi/workspace";
import { buttonHtml } from "@kintsugi/design-system/button";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { Icons } from "@kintsugi/design-system/icons";
import { jsonResponse, response, stream, update, wantsStream } from "@kintsugi/shared/http";

export interface WorkspaceResourceBackend {
  inspect(id: string): Promise<WorkspaceResourceSnapshot>;
  configure(id: string, changes: WorkspaceResourceChange): Promise<WorkspaceResourceSnapshot>;
  inspectDisk?(id: string): Promise<WorkspaceDiskSnapshot | null>;
  growDisk?(id: string, limitGiB: number): Promise<WorkspaceDiskSnapshot>;
}
export const defaultWorkspaceResourceBackend: WorkspaceResourceBackend = { inspect: inspectWorkspaceResources, configure: configureWorkspaceResources, inspectDisk: inspectWorkspaceDisk, growDisk: growWorkspaceDisk };
const MiB=1024**2;
const e=escapeHtml;
const bytes=(n:number|undefined)=>n===undefined?"Unavailable":`${(n/MiB).toLocaleString(undefined,{maximumFractionDigits:1})} MiB`;
const dockerBytes=(n:number)=>n===0?"Unlimited at container level":n<0?"Unlimited":bytes(n);
const row=(name:string,value:string)=>`<dt>${e(name)}</dt><dd>${e(value)}</dd>`;
const readings=(...rows:string[])=>`<dl class="workspace-properties-readings">${rows.join("")}</dl>`;
const more=(text:string,bodyHtml:string)=>disclosureHtml({summary:{kind:"compact",label:{kind:"text",text}},bodyHtml});
const submit=(caption:string)=>buttonHtml({type:"submit",variant:"primary",content:{kind:"caption",caption}});
export function parseResourceChange(value: JsonObject): WorkspaceResourceChange {
  if(!Value.Check(workspaceResourceChangeSchema,value))throw new Error("Use finite RAM bytes, non-negative additional swap bytes, positive CPU cores and an optional integer task limit of at least 128. Unknown settings are not accepted.");
  return value;
}
async function resourceInput(request:Request):Promise<WorkspaceResourceChange> {
  if(request.headers.get("content-type")?.includes("application/json"))return parseResourceChange(await readJsonObject(request));
  const data=await request.formData();
  const input: WorkspaceResourceChange = {memory:Number(data.get("memoryMiB"))*MiB,additionalSwap:Number(data.get("additionalSwapMiB"))*MiB,cpus:Number(data.get("cpus")),acknowledgeMemoryReduction:data.get("acknowledgeMemoryReduction")==="on"};
  if(data.has("pids"))input.pids=Number(data.get("pids"));
  return parseResourceChange(input);
}
export async function handleWorkspaceResources(request:Request,id:string,backend=defaultWorkspaceResourceBackend):Promise<Response> {
  if(!["GET","POST"].includes(request.method))return response("Method not allowed",{status:405,headers:{allow:"GET, POST"}});
  let changes:WorkspaceResourceChange|undefined;
  if(request.method==="POST")try{changes=await resourceInput(request);}catch(error){return jsonResponse({error:{code:"invalid_workspace_resources",message:errorMessage(error)}},{status:400});}
  try {
    const resources=changes?await backend.configure(id,changes):await backend.inspect(id);
    const failed=changes&&resources.pending;
    return jsonResponse(failed?{resources,error:{code:"workspace_resource_apply_failed",message:resources.failure??"Desired settings are saved but not applied."}}:{resources},{status:failed?409:200});
  }catch(error){return jsonResponse({error:{code:changes?"workspace_resource_change_refused":"workspace_resources_unavailable",message:errorMessage(error)}},{status:changes?409:503});}
}

async function renderProperties(id:string,title:string,backend:WorkspaceResourceBackend,error="",notice="",proposal?:WorkspaceResourceChange):Promise<string>{
  let s:WorkspaceResourceSnapshot|undefined;let unavailable="";
  try{s=await backend.inspect(id);}catch(failure){unavailable=errorMessage(failure);}
  const config=await getNetworkConfiguration(),applied=getAppliedWorkspaceNetwork(id),mode=getWorkspaceNetworkMode(id),restart=await workspaceNetworkRestartRequired(id);
  const base=`/workspaces/${encodeURIComponent(id)}/properties`;
  let disk: WorkspaceDiskSnapshot | null | undefined, diskError = "";
  try { disk = await backend.inspectDisk?.(id); } catch (failure) { diskError = errorMessage(failure); }
  const gib = (n:number) => (n/GiB).toLocaleString(undefined,{maximumFractionDigits:2})+" GiB";
  const diskTarget = disk?.requestedLimitGiB ?? disk?.limitGiB;
  const pendingDisk = disk?.requestedLimitGiB ? `<p role="status">The requested ${disk.requestedLimitGiB} GiB limit is not applied yet. Retry to finish growing the disk.</p>` : "";
  const diskForm = disk ? `<dl class="workspace-properties-readings">${row("Disk used / limit",`${gib(disk.usedBytes)} / ${gib(disk.limitGiB * GiB)}`)}${row("Free on workspace disk",gib(disk.availableBytes))}</dl>${pendingDisk}<form method="post" action="${base}/disk" data-turbo="true" class="form-stack"><label class="settings-field"><span class="settings-field-label">Disk limit (GiB)</span><input class="text-field" name="limitGiB" type="number" required min="${diskTarget}" max="1024" step="1" value="${diskTarget}"></label><p>Includes workspace files, local caches and workspace Docker data. Shared files and images are separate. Disks can grow, but not shrink.</p>${submit("Grow disk")}</form>` : `<p>${e(diskError || "No managed disk. This workspace keeps its existing storage.")}</p>`;
  const refresh=actionLinkHtml({href:base,variant:"secondary",content:{kind:"caption",caption:"Refresh"},attributesHtml:'data-turbo-stream="true"'});
  const usage = s ? readings(
    row("State",s.state.status),
    row("RAM used / peak",`${bytes(s.usage.memory)} / ${bytes(s.usage.memoryPeak)}`),
    row("Additional swap used",bytes(s.usage.swap)),
    row("CPU use / effective quota",`${s.usage.cpuCores?.toFixed(2)??"Unavailable"} / ${s.usage.effectiveCpus?.toFixed(2)??"Unavailable"} cores`),
    row("Tasks used / effective limit",`${s.usage.tasks??"Unavailable"} / ${s.usage.effectivePids??"Unavailable"}`),
  ) : `<p class="settings-error" role="alert">${e(unavailable)}</p>`;
  const diagnostics = s ? more("Container and restart details",readings(
    row("Container",s.containerId), row("Image",s.image), row("CPU affinity",s.affinity||"All permitted CPUs"),
    row("OOM kills / restart count",`${s.oomKills} / ${s.state.restartCount}`),
    row("Last exit / restart policy",`${s.lastExit?.code??(s.state.finishedAt.startsWith("0001-")?"No recorded exit":s.state.exitCode)}${s.state.oomKilled?" (OOM)":""} / ${s.state.restartPolicy||"Unavailable"}`),
    row("Last finish / failure source",`${s.lastExit?.finishedAt??(!s.state.finishedAt||s.state.finishedAt.startsWith("0001-")?"No recorded exit":s.state.finishedAt)} / ${s.lastExit?.reason??s.restartSource??"None recorded"}`),
  )) : "";
  const limitStatus = s ? `<p>${s.inSync?"Saved limits match Docker settings.":s.pending?"Saved limits are not applied. Refresh and retry.":"Saved limits differ from Docker settings."}</p>${s.failure?`<p class="settings-error" role="alert">${e(s.failure)}</p>`:""}${s.applied.memory===0||s.applied.memorySwap<0?'<p class="settings-error">Unlimited container limits can exhaust shared resources. Parent caps still apply; use finite limits.</p>':""}` : "";
  const appliedLimits = s ? readings(
    row("Saved RAM / effective hard cap",`${bytes(s.desired.memory)} / ${bytes(s.usage.effectiveMemory)}`),
    row("Docker RAM / total RAM + swap",`${dockerBytes(s.applied.memory)} / ${s.applied.memorySwap===0?"Docker default":dockerBytes(s.applied.memorySwap)}`),
    row("Effective additional swap cap",bytes(s.usage.effectiveAdditionalSwap)),
    row("Saved CPU / Docker CPU",`${s.desired.cpus} / ${s.applied.cpus||"Unlimited"} cores`),
    row("Saved / Docker task limit",`${s.desired.pids} / ${s.applied.pids||"Unlimited"}`),
  ) : "";
  const resourceForm=s?`<form method="post" action="${base}/resources" data-turbo="true" class="form-stack"><label class="settings-field"><span class="settings-field-label">RAM limit (MiB)</span><input class="text-field" name="memoryMiB" type="number" min="6" step="1" value="${e((proposal?.memory??s.desired.memory)/MiB)}" required></label><label class="settings-field"><span class="settings-field-label">Additional swap (MiB)</span><input class="text-field" name="additionalSwapMiB" type="number" min="0" step="1" value="${e((proposal?.additionalSwap??s.desired.memorySwap-s.desired.memory)/MiB)}" required></label><p>Zero disables additional swap. Docker's memory-swap value is RAM plus this allowance; it is not extra RAM. Shared workload swap capacity: ${bytes(s.capacity.additionalSwapBudget)}.</p><label class="settings-field"><span class="settings-field-label">CPU limit (cores)</span><input class="text-field" name="cpus" type="number" min="0.01" step="0.01" max="${e(s.capacity.cpus)}" value="${e(proposal?.cpus??s.desired.cpus)}" required></label>${s.capacity.pidsBudget!==undefined?`<label class="settings-field"><span class="settings-field-label">Task limit (processes and threads)</span><input class="text-field" name="pids" type="number" min="128" max="${e(s.capacity.pidsBudget)}" step="1" value="${e(proposal?.pids??s.desired.pids)}" required></label><p>Task limits share the installation ceiling of ${e(s.capacity.pidsBudget)}. Stop processes before lowering the limit below current usage. Legacy workspace services pick up corrected task defaults on their next cold start.</p>`:""}<p>Live changes do not restart the workspace. Lowering RAM below current usage may kill processes.</p><label><input type="checkbox" name="acknowledgeMemoryReduction"> I understand a RAM reduction may kill workspace processes.</label>${submit("Apply resource limits")}</form>`:"";
  const capacity=s?`<dl class="workspace-properties-readings">${row("Host RAM / currently available",`${bytes(s.capacity.hostMemory)} / ${bytes(s.capacity.hostAvailable)}`)}${row("System RAM budget",bytes(s.capacity.systemMemory))}${row("Maximum RAM limit per workspace",bytes(s.capacity.workspaceBudget))}${row("Other RAM limits (sum, not reserved)",bytes(s.capacity.otherMemory))}${row("Other additional swap limits (sum, not reserved)",bytes(s.capacity.otherAdditionalSwap))}${row("Other CPU limits (shared capacity)",`${s.capacity.otherCpus??0} cores`)}${row("System CPU capacity",`${s.capacity.cpus} cores`)}</dl><p>Management/build headroom is excluded from the per-workspace RAM maximum. RAM, swap and CPU limits may overlap; they do not reserve capacity. Actual usage shares the installation's workload caps.</p>`:"";
  const labels={off:"Off — public internet only",lan:"Local LAN — configured CIDRs",private:"Routed private networks",hosts:"Listed hosts only — exact TCP destinations"};
  const networkStatus = readings(
    row("Saved / applied LAN access",`${labels[mode]} / ${labels[applied.mode]}`),
    row("Restart required",restart?"Yes — park and unpark after saving":"No"),
  );
  const appliedNetwork = more("Applied routes and DNS",readings(
    row("Applied permitted CIDRs",applied.cidrs.join(", ")||"None"),
    row("Applied exact TCP hosts",(applied.destinations??[]).map(d=>`${d.host}:${d.port}`).join(", ")||"None"),
    row("Saved / applied DNS forwarders",`${config.dns.join(", ")||"Docker default"} / ${applied.dns.join(", ")||"Docker default"}`),
    row("Saved / applied search domains",`${config.search.join(", ")||"None"} / ${applied.search.join(", ")||"None"}`),
  ));
  const networkForm=`<form method="post" action="${base}/network" data-turbo="true" class="form-stack"><label class="settings-field"><span class="settings-field-label">Workspace LAN access</span><select class="popup-select" data-controller="popup-select" name="mode" aria-label="Workspace LAN access">${Object.entries(labels).map(([key,label])=>`<option value="${key}"${key===mode?" selected":""}>${e(label)}</option>`).join("")}</select></label><p>Saving changes desired policy only. Park/unpark applies it and closes terminal and VS Code views. Management, peer, tailnet and metadata exclusions remain enforced.</p>${submit("Save workspace network")}</form>`;
  const installationForm=`<form method="post" action="${base}/dns" data-turbo="true" class="form-stack"><p>These are installation-wide settings. Changes can affect every workspace using LAN access or custom DNS, after its next park/unpark.</p><label class="settings-field"><span class="settings-field-label">Installation LAN CIDRs</span><textarea class="textarea" name="cidrs" rows="3">${e(config.cidrs.join("\n"))}</textarea></label><label class="settings-field"><span class="settings-field-label">DNS forwarder IP addresses</span><textarea class="textarea" name="dns" rows="2">${e(config.dns.join("\n"))}</textarea></label><label class="settings-field"><span class="settings-field-label">DNS search domains</span><input class="text-field" name="search" value="${e(config.search.join(" "))}"></label><label><input type="checkbox" name="confirmGlobalNetworkChange" required> Apply these installation-wide network settings.</label>${submit("Save installation network")}</form>`;
  const deleteConfirmation = destructiveConfirmationHtml({
    id: domId("properties_delete_workspace", id),
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Delete workspace" } },
    confirmCaption: "Yes, delete",
    cancelCaption: "Cancel",
  });
  const deleteSection = `<section><h3>Delete this workspace</h3><p>This permanently removes the workspace and its local files. Save anything you want to keep first.</p><form method="post" action="/workspaces/${encodeURIComponent(id)}/delete" data-turbo="true" data-turbo-frame="_top" data-action="turbo:submit-end->dialog#submitted">${deleteConfirmation}</form></section>`;
  return dialogHtml({
    element:{id:"workspace_properties_dialog",attributesHtml:"data-dialog-auto-show"},
    iconHtml:Icons.Settings,
    titleCaption:`Properties: ${title}`,
    bodyHtml:`<div class="workspace-properties">
      ${error?`<p class="settings-error" role="alert">${e(error)}</p>`:""}
      ${notice?`<p role="status">${e(notice)}</p>`:""}
      <section><div class="workspace-properties-toolbar"><h3>Overview</h3>${refresh}</div>${usage}${diagnostics}</section>
      ${s?`<section><h3>Resource limits</h3>${limitStatus}${resourceForm}${more("Applied limits and shared capacity",appliedLimits+capacity)}</section>`:""}
      <section><h3>Storage</h3>${diskForm}</section>
      <section><h3>Workspace network</h3>${networkStatus}${networkForm}${appliedNetwork}</section>
      <section><h3>Installation settings</h3>${more("LAN and DNS for all workspaces",installationForm)}</section>
      ${deleteSection}
    </div>`,
  });
}

export async function handleWorkspaceProperties(request:Request,url:URL,id:string,title:string,modalPage:(html:string)=>Promise<Response>,backend=defaultWorkspaceResourceBackend):Promise<Response>{
  if(!["GET","POST"].includes(request.method))return response("Method not allowed",{status:405,headers:{allow:"GET, POST"}});
  let error="",notice="",proposal:WorkspaceResourceChange|undefined;
  if(request.method==="POST")try{
    if(url.pathname.endsWith("/resources")){proposal=await resourceInput(request);const applied=await backend.configure(id,proposal);if(applied.pending)error=applied.failure??"Desired settings saved but not applied.";else notice="Resource limits applied without restarting the workspace.";}
    else if(url.pathname.endsWith("/disk")){
      const limit = Number((await request.formData()).get("limitGiB"));
      if (!Value.Check(workspaceDiskSizeSchema,limit)) throw Error("Enter a whole number between 1 and 1024 GiB.");
      if (!backend.growDisk) throw Error("Workspace disk control is unavailable.");
      const disk = await backend.growDisk(id, limit);
      if (disk.requestedLimitGiB) throw Error("The disk did not finish growing. Try again.");
      notice = `Disk limit: ${disk.limitGiB} GiB.`;
    }
    else if(url.pathname.endsWith("/network")){const data=await request.formData();const mode=data.get("mode");if(!Value.Check(networkModeSchema,mode))throw Error("Select off, lan, private or listed hosts.");await setWorkspaceNetworkMode(id,mode);notice="Network settings saved. Park/unpark this workspace to apply them.";}
    else if(url.pathname.endsWith("/dns")){const data=await request.formData();if(data.get("confirmGlobalNetworkChange")!=="on")throw Error("Confirm that the LAN and DNS settings apply installation-wide.");const list=(key:string)=>String(data.get(key)??"").split(/[\s,]+/).filter(Boolean);await setNetworkConfiguration(parseNetworkConfiguration({cidrs:list("cidrs"),dns:list("dns"),search:list("search")}));notice="Installation network settings saved. Park/unpark affected workspaces to apply them.";}
    else return response("Not found",{status:404});
  }catch(failure){error=errorMessage(failure);}
  const html=await renderProperties(id,title,backend,error,notice,proposal);
  return wantsStream(request)?stream(update(workspaceModuleModalFrameId,html),{status:error?422:200}):modalPage(html);
}
