import { kintsugiName } from "@kintsugi/shared";

export function workspacePageTitle(workspaceName?: string, agentName?: string): string {
  const workspace = workspaceName?.trim();
  if (!workspace) return kintsugiName;
  const agent = agentName?.trim().replace(/^@/, "");
  return agent ? `${workspace} - @${agent}` : workspace;
}
