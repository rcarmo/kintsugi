import { createAgentBackgroundController, createAgentBackgroundRefreshController } from "./background-controllers.ts";
import { createAgentMessageTimeController } from "./message-time-controller.ts";
import { createAgentPlanController } from "./plan-controller.ts";
import { createAgentToolAbortController } from "./tool-abort-controller.ts";
import { createAgentFooterController } from "./footer-controller.ts";
import { createUsageControllers } from "./usage-controllers.ts";
import type { WorkspaceClientModule } from "@kintsugi/shared";
import { createAgentCompletionsController, registerPromptTemplateCommands } from "./completions-controller.ts";
import { createAgentEditDiffController } from "./edit-diff-controller.ts";
import { createAgentElapsedController } from "./elapsed-controller.ts";
import { createAgentNoticeController } from "./notice-controller.ts";
import { registerLaunchComposerCommand } from "./launch-composer-command.ts";
import { createAgentMermaidController } from "./mermaid-controller.ts";
import { createAgentThinkingController } from "./thinking-controller.ts";
import { createAgentStreamingTextController } from "./streaming-text-controller.ts";
import { createAgentLazyDetailController, createAgentTailFrameController } from "./transcript-detail-controllers.ts";
import { createTranscriptQuoteController } from "./transcript-quote-controller.ts";

export { agentComposerPrimaryAction, agentComposerTextStorageKey, navigatePromptHistory, PromptHistoryNavigator } from "./composer-state.ts";
export { agentCompletionRequest, fileCompletionPrefix, insertSlashCommand, type AgentCompletionInput } from "./completion-input.ts";
export { promptTemplateShortcutConflict } from "./completions-controller.ts";
export { createHtmlAutocompleteController } from "./html-autocomplete-controller.ts";

export const agentClientModule: WorkspaceClientModule = {
  id: "agent",
  install({ application, Controller, hooks }) {
    for (const [name, controller] of Object.entries(createUsageControllers(Controller))) application.register(name, controller);
    application.register("agent-background", createAgentBackgroundController(Controller));
    application.register("agent-background-refresh", createAgentBackgroundRefreshController(Controller));
    application.register("agent-message-time", createAgentMessageTimeController(Controller));
    application.register("agent-plan", createAgentPlanController(Controller));
    application.register("agent-footer", createAgentFooterController(Controller));
    application.register("agent-elapsed", createAgentElapsedController(Controller));
    application.register("agent-edit-diff", createAgentEditDiffController(Controller));
    application.register("agent-thinking", createAgentThinkingController(Controller));
    application.register("agent-streaming-text", createAgentStreamingTextController(Controller));
    application.register("agent-tail-frame", createAgentTailFrameController(Controller));
    application.register("agent-lazy-detail", createAgentLazyDetailController(Controller));
    application.register("agent-mermaid", createAgentMermaidController(Controller));
    application.register("agent-tool-abort", createAgentToolAbortController(Controller));
    application.register("agent-notice", createAgentNoticeController(Controller));
    application.register("transcript-quote", createTranscriptQuoteController(Controller));
    application.register("agent-completions", createAgentCompletionsController(Controller, hooks));

    registerLaunchComposerCommand(hooks);
    registerPromptTemplateCommands(hooks);
  },
};
