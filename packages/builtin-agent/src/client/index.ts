import type { WorkspaceClientModule } from "@kintsugi/shared";
import { createMcpAccessController } from "./mcp-access-controller.ts";
import { createAgentNotificationsController } from "./notifications-controller.ts";
import { createAgentPaneController, registerAgentPaneVisibilityHooks } from "./agent-pane.ts";
import { createAgentTurnController } from "./turn-controller.ts";
import { createAgentTermController } from "./terminal-controller.ts";
import { createBackgroundController, createChildTranscriptController } from "./background-controllers.ts";

const builtinAgentClientModule: WorkspaceClientModule = {
  id: "builtin-agent",
  install({ application, Controller, hooks }) {
    application.register("mcp-access", createMcpAccessController(Controller));
    application.register("agent-notifications", createAgentNotificationsController(Controller));
    application.register("agent-pane", createAgentPaneController(Controller));
    application.register("agent-turn", createAgentTurnController(Controller));
    application.register("agent-term", createAgentTermController(Controller));
    application.register("builtin-background", createBackgroundController(Controller));
    application.register("builtin-child-transcript", createChildTranscriptController(Controller));
    registerAgentPaneVisibilityHooks(application, hooks);
  },
};
export { builtinAgentClientModule as kintsugiClientModule };
