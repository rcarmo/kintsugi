import {invalidArguments} from "@kintsugi/core";
import {tokenOptimizerConfiguration} from "./token-optimizer-config.ts";
import {nativeTokenOptimizers} from "./token-optimizer.ts";
export type OptimizerCommand={action:"status"|"help"|"settings"|"on"|"watch"|"off"|"restore";names:string[]};
export function parseOptimizerCommand(text:string):OptimizerCommand|undefined {
  const match=/^\/tokeneconomizer(?:\s+([\s\S]*))?$/.exec(text.trim());if(!match)return;
  const [action="status",...names]=(match[1]?.trim()||"status").split(/\s+/);
  if(!["status","help","settings","on","watch","off","restore"].includes(action)||action!=="restore"&&names.length)throw invalidArguments("Use /tokeneconomizer [status|help|settings|on|watch|off|restore [tool…]].");
  // SAFETY: The allowlist above validates the action; restore arguments are tool names, not executable commands.
  return {action:action as OptimizerCommand["action"],names};
}
export async function runOptimizerCommand(workspaceId:string,agentId:string,command:OptimizerCommand,requestId:string){
  const config=tokenOptimizerConfiguration();await config.load();
  const native=nativeTokenOptimizers().find(([id])=>id===workspaceId)?.[1];if(!native)throw new Error("Open this Agent before using optimizer commands.");
  const host=await native.hostForAgent(agentId);
  let text:string;
  if(command.action==="help")text="/tokeneconomizer status — show state; settings — open controls; on/watch/off — set this Agent’s mode; restore [tool…] — restore named tools, or all hidden tools. Commands do not call a model.";
  else if(command.action==="settings")text="Open Token optimizer Settings below to choose features, models and limits.";
  else if(["on","watch","off"].includes(command.action)){
    const next=config.snapshot();
    if(command.action!=="off"&&(!next.policy.enabled||next.policy.mode==="off"))throw invalidArguments("Enable the optimizer in Settings first. This command changes only this Agent’s override.");
    next.agents[JSON.stringify([workspaceId,agentId])]=command.action==="on"?"active":command.action==="watch"?"observe":"off";
    await config.configure(next);text=`This Agent’s optimizer mode: ${command.action==="watch"?"Watch only":command.action==="on"?"On":"Off"}.`;
  }else if(command.action==="restore"){
    const restored=await native.optimizer.restore(host,command.names.length?command.names:undefined);text=restored.length?`Restored ${restored.join(", ")} for the next session or resume.`:"No hidden tools to restore.";
  }else {
    const state=await native.optimizer.status(host),policy=state.policy;
    text=`Token optimizer: ${!policy.enabled||policy.mode==="off"?"Off":policy.mode==="observe"?"Watch only":"On"}. ${state.session?.injectedIds.length??0} injected facts; ${state.session?.frozenMask.length??0} hidden tools. Output reduction: ${policy.reduceOutputs?"enabled":"disabled"}; goal checks: ${policy.goalChecks?"enabled":"disabled"}.`;
  }
  await native.commandNotice(host,requestId,text);
  return {text,settingsUrl:`/settings?section=token-optimizer&focus=${encodeURIComponent(JSON.stringify([workspaceId,agentId]))}`};
}
