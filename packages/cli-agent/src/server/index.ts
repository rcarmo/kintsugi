import { registerPlanAgentResolver } from "@kintsugi/agent/server/plan";
import { registerAgentTurnSettler } from "@kintsugi/agent/server";
import { renderWorkspaceCompletionCatalog } from "@kintsugi/agent/server/completion-catalog";
import { renderTranscriptQuoteAction } from "@kintsugi/agent/server/render-transcript";
import { agentAttachmentDraftId, listStagedAttachments, renderComposerBody, renderFloatingStack, renderOpenComposerButton, agentComposerActions, composerAttachmentAttributes } from "@kintsugi/prompt/server";
import { dictationComposerController } from "@kintsugi/dictation/server";
import { observableTerminalStaticFiles, renderTerminalKeyBar, renderTerminalConnectionStatus } from "@kintsugi/observable-terminal/server";
import { terminalProcessSocketPath } from "@kintsugi/observable-terminal/shared";
import { domId, escapeHtml, turboStream, turboStreamResponse, type WorkspaceModule } from "@kintsugi/shared";
import type { KintsugiEventBus } from "@kintsugi/core";
import type { CliAgentAdapter } from "./adapter.ts";
import { createCliAgents, type CliAgentTerminal } from "./agents.ts";
import { cliComposerRoutes } from "./composer-routes.ts";
import { cliCompletionCatalogId, cliTranscriptAttributes, cliTranscriptChannel, cliTranscriptRoutes, renderCliTranscriptControls, renderCliTranscriptView } from "./transcript-routes.ts";

export type { CliAgentConnection } from "@kintsugi/agent/server";
export type { CliAgentSession } from "./adapter.ts";

function terminalStatus(terminal: CliAgentTerminal): string {
  if (terminal.state === "starting" || terminal.state === "running") return "";
  return terminal.state === "exited" && terminal.exitCode ? `Session ended (exit ${terminal.exitCode}). Its output is below.` : "Session ended";
}

/** One adapter supplies CLI policy; this module owns the complete terminal-agent lifecycle. */
export function createCliAgentModule(adapter: CliAgentAdapter): WorkspaceModule {
  let events: KintsugiEventBus;
  const agents = createCliAgents(adapter, async (workspaceId, agentId, title, workspaceNamed) => {
    await events.emit("workspace_agent_title_changed", { workspaceId, agentId, title });
    if (workspaceNamed) await events.emit("workspace_title_changed", { workspaceId, title });
  });
  function failureStatus(error: string) { return `Could not start ${escapeHtml(adapter.label)}: ${escapeHtml(error)}`; }
  async function renderTab(workspaceId: string, agentId: string): Promise<string> {
    const session = await agents.ready(workspaceId, agentId);
    const terminal = await agents.terminalState(workspaceId, session);
    const url = `/workspaces/${encodeURIComponent(workspaceId)}/${adapter.id}-agents/${encodeURIComponent(agentId)}`;
    const draftId = agentAttachmentDraftId(workspaceId, `${adapter.id}:${agentId}`);
    const rowId = domId("cli_attach", workspaceId, agentId);
    const composerUrl = `${url}/composer`;
    const transcriptControls = renderCliTranscriptControls(adapter);
    const running = terminal.state === "running";
    const composer = running ? `<div class="composer cli-agent-composer" data-controller="agent-completions ${dictationComposerController}" data-action="agent-composer:send-prompt->cli-terminal#sendPrompt" data-agent-completions-url-value="${escapeHtml(composerUrl)}/completions" data-dictation-composer-workspace-id-value="${escapeHtml(workspaceId)}">
      <div class="composer-surface">
        <form id="${domId("cli_composer_form", workspaceId, agentId)}" method="post" action="${escapeHtml(composerUrl)}" data-turbo="false" data-cli-terminal-target="form" data-action="submit->dictation-composer#submit keydown->agent-completions#keydown submit->cli-terminal#submit">
          ${renderComposerBody({
            draft: { id: draftId, rowId, attachments: await listStagedAttachments(draftId) },
            collapsible: true,
            promptTemplateButtons: true,
            inputHtml: `<textarea class="composer-input" name="text" rows="2" placeholder="Write your prompt here" aria-label="CLI agent prompt" data-controller="composer-send-hint" data-cli-terminal-target="input" data-agent-completions-target="input" data-action="input->agent-completions#input keydown->cli-terminal#inputKeydown paste->agent-attachments#paste"></textarea>`,
          })}
        </form>
        <div class="agent-completion-menu-host" data-agent-completions-target="menu" hidden></div>
        <div id="${cliCompletionCatalogId(workspaceId, agentId)}" data-agent-completions-target="catalog" hidden>${await renderWorkspaceCompletionCatalog(workspaceId, "cli")}</div>
      </div>
    </div>` : "";
    // Permanent keeps a live terminal through page renders; an ended one has none, and must be replaceable.
    return `<section id="${domId("cli_agent", workspaceId, agentId)}"${running ? " data-turbo-permanent" : ""} class="cli-agent-body agent-composer-pane" data-controller="cli-terminal agent-composer composer-focus${composer ? " agent-attachments transcript-quote" : ""}" data-agent-composer-open-on-select-value="false" data-cli-terminal-url-value="${escapeHtml(url)}" data-cli-terminal-socket-value="${escapeHtml(terminalProcessSocketPath(workspaceId, agentId))}" data-cli-terminal-workspace-id-value="${escapeHtml(workspaceId)}" ${cliTranscriptAttributes(adapter, agentId)} ${composerAttachmentAttributes(draftId, rowId, `kintsugi:workspace-pane-visible@window->cli-terminal#refresh kintsugi:workspace-agent-focus->cli-terminal#focus kintsugi:theme-change@document->cli-terminal#theme ${agentComposerActions}`)}>
      <div class="cli-terminal-status" role="status">${session.error ? failureStatus(session.error) : terminalStatus(terminal)}</div>
      <div class="cli-agent-stage">
        ${running ? renderTerminalConnectionStatus("cli-terminal") : ""}
        ${terminal.state === "exited" && terminal.output.text ? `<pre class="cli-terminal-output">${escapeHtml(terminal.output.text)}</pre>` : ""}
        ${running ? '<div class="observable-terminal-host" data-cli-terminal-target="terminal" tabindex="0" data-action="pointerdown->cli-terminal#terminalPointer:capture pointermove->cli-terminal#terminalPointer:capture pointerup->cli-terminal#terminalPointer:capture terminal-text-input:input->cli-terminal#sendNativeInput keydown->cli-terminal#resumeInput:capture beforeinput->cli-terminal#resumeInput:capture touchstart->cli-terminal#startTerminalTouch:passive touchmove->cli-terminal#moveTerminalTouch:!passive touchcancel->cli-terminal#cancelTerminalTouch touchend->cli-terminal#finishTerminalTouch:!passive"></div>' : ""}
        ${renderCliTranscriptView(adapter, workspaceId, agentId)}
        ${renderFloatingStack({ openComposer: composer ? renderOpenComposerButton() : undefined, ...transcriptControls })}
        ${composer ? renderTranscriptQuoteAction() : ""}
      </div>
      ${running ? renderTerminalKeyBar("cli-terminal") : ""}
      ${composer}
    </section>`;
  }

  /** The tab again, once its terminal has ended under a viewer, so it can show why. */
  async function tabRoute(request: Request, url: URL): Promise<Response | undefined> {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)-agents\/([^/]+)\/tab$/);
    if (!match || match[2] !== adapter.id || request.method !== "GET") return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const agentId = decodeURIComponent(match[3]!);
    return turboStreamResponse(turboStream("replace", domId("cli_agent", workspaceId, agentId), await renderTab(workspaceId, agentId)));
  }
  return {
    id: `${adapter.id}-agent`,
    staticFiles: {
      ...observableTerminalStaticFiles,
      "/cli-agent.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    },
    initialize(context) {
      events = context.events;
      registerPlanAgentResolver(adapter.id, async (workspaceId, agentId) => {
        const agent = agents.list(workspaceId).find(agent => agent.id === agentId);
        return agent ? { id: agent.id, title: agent.title } : undefined;
      });
      if (adapter.turnSettled) registerAgentTurnSettler(agents.settleTurn);
      context.events.on("workspace_agent_turn_finished", ({ workspaceId, agentId }) => {
        if (agents.list(workspaceId).some((session) => session.id === agentId)) {
          context.registry.requestAttention(workspaceId);
          void agents.exportHistory(workspaceId, agentId).catch((error) => console.error(`Could not export ${adapter.label} session ${agentId}`, error));
        }
      });
      context.events.on("workspace_runtime_ready", async ({ workspaceId }) => {
        await agents.restoreWorkspace(workspaceId);
      });
      context.events.on("workspace_deleting", async ({ workspaceId }) => {
        await agents.exportWorkspaceHistory(workspaceId);
      });
    },
    cableChannels: adapter.loadTranscript ? [cliTranscriptChannel(adapter, agents)] : [],
    routes: [{ handle: cliComposerRoutes(adapter.id, agents) }, { handle: cliTranscriptRoutes(adapter, agents) }, { handle: tabRoute }],
    agentType: {
      id: adapter.id, label: adapter.label, iconHtml: adapter.iconHtml,
      async create({ workspaceId }) {
        await adapter.requireSetup();
        return agents.create(workspaceId, await adapter.settings.prepare());
      },
      tabs: {
        async list({ workspaceId }) { return agents.list(workspaceId).map(({ id, title }) => ({ id, title })); },
        async render({ workspaceId, agentId }) { return { html: await renderTab(workspaceId, agentId) }; },
        close: ({ workspaceId, agentId }) => agents.close(workspaceId, agentId),
      },
      launch: {
        renderFooter: adapter.settings.renderFooter,
        async prepare(parameters) { await adapter.requireSetup(); return { agent: await adapter.settings.prepare(parameters) }; },
        async submit(form) {
          await adapter.requireSetup();
          const settings = await adapter.settings.prepare({ model: String(form.get("model") ?? ""), thinkingLevel: String(form.get("thinkingLevel") ?? "") });
          return { async prepare() { return { agent: settings }; } };
        },
        prepareWorkspace: (workspaceId, context) => agents.prepareWorkspace(workspaceId, context?.agent),
      },
    },
  };
}

export { createCliModelSettings, type CliModelSettings } from "./model-settings.ts";
export { checkedWorkspaceShell, writeCliSessionFiles } from "./agents.ts";
export { managedCliLaunchScript, cliLaunchScript, cliPromptText, emptyAgentInput, writeFileScript } from "./launch-script.ts";
export { turnSignalArgv, turnSignalShell, type TurnBoundary } from "./turn-signal.ts";
export { syntaxSlot, transcriptSlot } from "./transcript-palette.ts";
export { latestNativeSessionFile, loadNativeTranscriptFiles, loadNativeTranscriptImage, nativeImageResponse, nativeImageTypes, nativeJsonlRows, nativeSessionFiles, nativeTimestamp } from "./native-transcript.ts";
