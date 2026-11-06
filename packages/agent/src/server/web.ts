import { createAgentTermSocketSession } from "./bash-tool.ts";
import { createCodeSearchTool, createCodeRewriteTool } from "./structural-code.ts";
import { planWorkViews, planCommands, planPresentation, planLauncher, planChannel, planOpenApiPaths, handlePlanRequest } from "./plan-web.ts";
import { agentPlanStore, createAgentPlanTool } from "./plan.ts";
import { dockerHostKintsugiDataPath, getKintsugiRuntimeContext, type KintsugiEventBus } from "@kintsugi/core";
import { markdownMathStaticFiles } from "@kintsugi/markdown/assets";
import type { WorkspaceModule } from "@kintsugi/shared";
import { observableTerminalStaticFiles } from "@kintsugi/observable-terminal/server";
import { workspacePortBackend, type WorkspaceDockerMount, type WorkspaceInitInstruction } from "@kintsugi/workspace";
import { mkdir } from "node:fs/promises";
import { sessionShareDir, sessionShareKeyForInit, sessionShareMountPath } from "./session-share.ts";
import { createDeleteCurrentWorkspaceTool, registerWorkspaceAgentTool } from "./tools.ts";
import { usageOpenApiPaths } from "./usage-openapi.ts";
import { handleUsageRequest, renderUsagePaneAction } from "./usage-web.ts";
import { handleWorkspaceImageRequest, workspaceFileEndpoint } from "./workspace-files.ts";
import { subscribeWorkspaceAgentBusy } from "./workspace-agent-busy.ts";

type WorkspacePlanEvents = {
  on(eventName: "workspace_plan_prepare", handler: (event: { init?: WorkspaceInitInstruction; plan: { mounts: WorkspaceDockerMount[] } }) => void | Promise<void>): void;
};

function dockerHostSessionShareDir(shareKey: string): string {
  return dockerHostKintsugiDataPath(getKintsugiRuntimeContext(), "session-shares", shareKey);
}

function registerSessionShareMountEvents(events: KintsugiEventBus): void {
  // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
  (events as WorkspacePlanEvents).on("workspace_plan_prepare", async ({ init, plan }) => {
    const shareKey = sessionShareKeyForInit(init);
    await mkdir(sessionShareDir(shareKey), { recursive: true });
    plan.mounts.push({ type: "bind", source: dockerHostSessionShareDir(shareKey), target: sessionShareMountPath, readonly: true });
  });
}

export const agentWorkspaceModule: WorkspaceModule = {
  id: "agent",
  staticFiles: {
    "/agent-usage.css": { url: new URL("../client/usage.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    "/agent-plan.css": { url: new URL("../client/plan.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    "/agent.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    "/agent-tree.css": { url: new URL("../client/tree.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    ...observableTerminalStaticFiles,
    ...markdownMathStaticFiles,
  },
  workViews: planWorkViews,
  commands: planCommands,
  cableChannels: [planChannel],
  attachToWorkspace: () => ({ workViews: [planPresentation], commands: [planLauncher] }),
  renderWorkspacePaneActions: renderUsagePaneAction,
  openApiPaths: { ...usageOpenApiPaths, ...planOpenApiPaths },
  routes: [{ handle: handleUsageRequest }, { handle: handlePlanRequest }, { handle: handleWorkspaceImageRequest }],
  initialize(context) {
    registerSessionShareMountEvents(context.events);
    registerWorkspaceAgentTool("code_search", workspaceId => createCodeSearchTool(workspaceId));
    registerWorkspaceAgentTool("code_rewrite", workspaceId => createCodeRewriteTool(workspaceId));
    registerWorkspaceAgentTool("plan", (workspaceId, options) => options.agentId ? createAgentPlanTool(workspaceId, options.agentId) : undefined);
    context.onWorkspaceRemoved(workspaceId => agentPlanStore().delete(workspaceId));
    context.events.on("agent_system_prompt_prepare", ({ lines }) => { lines.push("Your persistent plan is editable by the user in the Plan Work pane. Use the plan tool to read it and keep it current; at most one item may be in progress. Saving a plan is not permission to start additional work. Read its current revision before replacing it."); });
    context.registerSocketHandler(createAgentTermSocketSession);
    context.registerWorkspaceAppResolver(async (app, requestUrl) => {
      if (app.appKey === "file") return {
        kind: "fetch",
        fetch: (request) => workspaceFileEndpoint(app.workspaceId, decodeURIComponent(new URL(request.url).pathname), request),
      };
      const portMatch = app.appKey.match(/^port-(\d+)$/);
      if (!portMatch) return undefined;
      return await workspacePortBackend(app.workspaceId, Number(portMatch[1]), `${requestUrl.pathname}${requestUrl.search}`);
    });
    subscribeWorkspaceAgentBusy(({ workspaceId, agentKey, busy }) => context.registry.setAgentBusy(workspaceId, agentKey, busy));
    registerWorkspaceAgentTool("delete_current_workspace", (workspaceId) => createDeleteCurrentWorkspaceTool(workspaceId, async (force) => await context.deleteCurrentWorkspace(workspaceId, force)));
  },
};
