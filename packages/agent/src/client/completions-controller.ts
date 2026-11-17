import { setContentRowLabel } from "@kintsugi/design-system/content-row/client";
import { autocompleteHtml } from "@kintsugi/design-system/autocomplete";
import { agentComposerSendPromptEvent, changeLayout, composerSubmitKey, type AgentComposerSendPromptDetail, focusLikelyOpensSoftwareKeyboard, isApplePlatform, setTextInputValue, type WorkspaceClientCommand, type WorkspaceClientControllerConstructor as StimulusControllerConstructor, type WorkspaceClientHooks } from "@kintsugi/shared";
import { agentCompletionRequest, insertFileCompletion, insertSlashCommand } from "./completion-input.ts";
import { createHtmlAutocompleteController } from "./html-autocomplete-controller.ts";
import { handleAgentTreeKeydown, handleAgentTreeMenuEvent, selectAgentTreeOption } from "./session-tree.ts";


type ShortcutCommand = Pick<WorkspaceClientCommand, "label" | "binding">;

// Prompt-template shortcuts are ⌘⌥Letter on Apple platforms and Ctrl+Alt+Letter elsewhere.
function promptTemplateBinding(shortcut: string, apple: boolean): string {
  return `${apple ? "Meta" : "Control"}+Alt+Key${shortcut.toUpperCase()}`;
}

export function promptTemplateShortcutConflict(shortcut: string, commands: readonly ShortcutCommand[], apple: boolean): ShortcutCommand | undefined {
  const binding = promptTemplateBinding(shortcut, apple);
  return commands.find((command) => command.binding === binding);
}

function visibleWorkspaceCommands(): ShortcutCommand[] {
  const presentation = document.querySelector<HTMLElement>(".workspace-detail-mount.visible .fixed-workspace-presentation")
    ?? document.querySelector<HTMLElement>(".fixed-workspace-presentation");
  if (!presentation) return [];
  // SAFETY: The server serializes WorkspaceCommandRegistration values into this dataset.
  return JSON.parse(presentation.dataset.workspaceCommands!) as ShortcutCommand[];
}

function workspacePromptTemplateShortcutConflict(hooks: WorkspaceClientHooks, shortcut: string): ShortcutCommand | undefined {
  return promptTemplateShortcutConflict(shortcut, [...hooks.registeredCommands(), ...visibleWorkspaceCommands()], isApplePlatform());
}

function activeAgentComposer(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-workspace-pane-role="agent"].is-active .composer[data-controller~="agent-completions"]')]
    .find((composer) => composer.closest(".workspace-detail-mount")?.classList.contains("visible") ?? true);
}

// Prompt templates with shortcuts are workspace shortcuts aimed at the active Agent,
// independent of focus and of whether its composer is shown.
export function registerPromptTemplateCommands(hooks: WorkspaceClientHooks): void {
  hooks.registerCommandProvider(() => {
    const composer = activeAgentComposer();
    if (!composer) return [];
    const templates = composer.querySelectorAll<HTMLElement>('[data-agent-completions-target="catalog"] [role="option"][data-prompt-template-shortcut]');
    return [...templates].flatMap((template): WorkspaceClientCommand[] => {
      const shortcut = template.dataset.promptTemplateShortcut!;
      if (workspacePromptTemplateShortcutConflict(hooks, shortcut)) return [];
      const trigger = template.dataset.commandTrigger!;
      return [{
        id: `prompt-template.${trigger.slice(1)}`,
        label: `Send ${trigger}`,
        scope: "agent",
        binding: promptTemplateBinding(shortcut, isApplePlatform()),
        run: () => { composer.dispatchEvent(new CustomEvent<AgentComposerSendPromptDetail>(agentComposerSendPromptEvent, { detail: { text: trigger } })); },
      }];
    });
  });
}

function labelPromptTemplateShortcuts(html: string, hooks: WorkspaceClientHooks): string {
  const container = document.createElement("template");
  container.innerHTML = html.trim();
  for (const option of container.content.querySelectorAll<HTMLElement>("[data-prompt-template-shortcut]")) {
    const shortcut = option.dataset.promptTemplateShortcut!;
    const key = shortcut.toUpperCase();
    const apple = isApplePlatform();
    const label = apple ? `⌘⌥${key}` : `Ctrl+Alt+${key}`;
    const conflict = workspacePromptTemplateShortcutConflict(hooks, shortcut);
    if (!conflict) {
      option.dataset.agentPromptTemplateButtonShortcut = label;
      option.setAttribute("aria-keyshortcuts", `${apple ? "Meta" : "Control"}+Alt+${key}`);
      continue;
    }
    option.removeAttribute("data-prompt-template-shortcut");
    const message = `Shortcut unavailable: ${label} is used by ${conflict.label}.`;
    option.title = message;
    option.setAttribute("aria-label", `${option.getAttribute("aria-label") ?? option.dataset.commandTrigger}. ${message}`);
    option.classList.add("shortcut-conflict");
    option.dataset.agentPromptTemplateButtonShortcut = `${label} used by ${conflict.label}`;
  }
  return container.innerHTML;
}

function filterSlashCompletionCatalog(html: string, query: string, compactAvailable: boolean): string {
  const container = document.createElement("template");
  container.innerHTML = html.trim();
  const menu = container.content.querySelector<HTMLElement>(".autocomplete")!;
  const compact = menu.querySelector<HTMLButtonElement>('[data-command-trigger="/compact"]');
  if (compact && !compactAvailable) {
    compact.disabled = true;
    compact.setAttribute("aria-disabled", "true");
    setContentRowLabel(compact, "/compact [instructions] — Available after more conversation history.");
  }
  const normalized = query.toLowerCase();
  const options = [...menu.querySelectorAll<HTMLButtonElement>("[role=\"option\"]")]
    .filter((option) => option.dataset.commandTrigger!.slice(1).toLowerCase().includes(normalized))
    .sort((a, b) => {
      const aName = a.dataset.commandTrigger!.slice(1).toLowerCase();
      const bName = b.dataset.commandTrigger!.slice(1).toLowerCase();
      return Number(bName.startsWith(normalized)) - Number(aName.startsWith(normalized)) || aName.localeCompare(bName);
    })
    .slice(0, 12);

  if (options.length === 0) return autocompleteHtml({ kind: "message", content: { kind: "text", text: "No matching commands" } });
  menu.replaceChildren(...options);
  const active = options.find((option) => !option.disabled);
  for (const option of options) {
    option.setAttribute("aria-selected", option === active ? "true" : "false");
  }
  return menu.outerHTML;
}

function slashCompletionHtml(catalog: string, query: string, compactAvailable: boolean): string {
  return filterSlashCompletionCatalog(catalog, query, compactAvailable);
}

function promptTemplateButtonHtml(catalog: string): string {
  const container = document.createElement("template");
  container.innerHTML = catalog.trim();
  return container.content.querySelector<HTMLElement>(".agent-prompt-template-buttons")?.outerHTML ?? "";
}

async function expandedSlashCommand(url: string, text: string): Promise<string> {
  const body = new FormData();
  body.set("text", text);
  const response = await fetch(`${url}/slash-command-expand`, { method: "POST", body, headers: { Accept: "text/plain" } });
  return await response.text();
}

function composerIsDictating(element: Element): boolean {
  return Boolean(element.closest(".composer")?.hasAttribute("data-dictating"));
}

export function createAgentCompletionsController(Controller: StimulusControllerConstructor, hooks: WorkspaceClientHooks) {
  const HtmlAutocompleteController = createHtmlAutocompleteController(Controller, {
    optionSelector: '[role="option"]:not([hidden]):not(:disabled)',
    loadingHtml: autocompleteHtml({ kind: "message", role: "status", content: { kind: "html", html: '<span class="agent-completion-spinner" aria-hidden="true"></span>Loading completions…' } }),
    triggerKeysWhenClosed: ["/", "@"],
    fullscreenShortcut: (option) => option.hasAttribute("data-kintsugi-fullscreen-title"),
    menuEvent: handleAgentTreeMenuEvent,
    request(input, force) {
      if (composerIsDictating(input)) return undefined;
      const completion = agentCompletionRequest(input, force);
      if (!completion) return completion;
      interface CompletionRequestParams {
        [name: string]: string;
        kind: typeof completion.kind;
      }
      const params: CompletionRequestParams = { kind: completion.kind };
      if (completion.mode) params["mode"] = completion.mode;
      if (completion.kind === "slash-command") {
        const availability = input.closest(".agent-pane")?.querySelector<HTMLElement>("[data-agent-compact-available]");
        params["compactAvailable"] = String(availability?.dataset.agentCompactAvailable !== "false");
      }
      return { query: completion.query, params, debounceMs: completion.kind === "file" ? 70 : 0 };
    },
    loadHtml(request, host) {
      const catalog = host.querySelector<HTMLElement>("[data-agent-completions-target='catalog']")!.innerHTML;
      const html = request.params?.kind === "slash-command"
        ? slashCompletionHtml(catalog, request.query, request.params.compactAvailable !== "false")
        : undefined;
      return html === undefined ? undefined : labelPromptTemplateShortcuts(html, hooks);
    },
    select(option, input, url) {
      if (selectAgentTreeOption(option, input)) return false;
      if (option.dataset.commandTrigger) insertSlashCommand(option, input);
      else if (option.dataset.completionKind === "file") insertFileCompletion(option, input);
    },
    keydown(event, input, url, actions) {
      if (event.key === "ArrowUp" && input.value === "" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        actions.close();
        return false;
      }
      const send = composerSubmitKey(event);
      const expand = event.key === "Enter" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (handleAgentTreeKeydown(event, input, actions)) return true;
      if (send || expand) {
        const active = actions.open ? actions.activeOption() : undefined;
        if (active?.dataset.commandTrigger) actions.select(active);
        if (send || !/^\/[^/\s]+(?:\s+[\s\S]*)?$/.test(input.value.trim())) return false;
        event.preventDefault();
        void expandedSlashCommand(url, input.value)
          .then((expanded) => {
            actions.setInputValue(expanded);
            actions.close();
          });
        return true;
      }
      if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey || (actions.open && actions.hasOptions)) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      actions.refresh(true);
      return true;
    },
  });

  return class AgentCompletionsController extends HtmlAutocompleteController {
    static targets = [...HtmlAutocompleteController.targets, "promptTemplateButtons"];
    declare readonly catalogTarget: HTMLElement;
    declare readonly promptTemplateButtonsTarget: HTMLElement;
    declare readonly hasPromptTemplateButtonsTarget: boolean;
    private catalogObserver?: MutationObserver;

    connect(): void {
      super.connect();
      this.inputTarget.closest("form")?.addEventListener("submit",this.treeSubmit,true);
      this.catalogObserver = new MutationObserver(() => { this.renderPromptTemplateButtons(); this.input(); });
      this.catalogObserver.observe(this.catalogTarget, { childList: true });
      if (this.hasPromptTemplateButtonsTarget) this.promptTemplateButtonsTarget.addEventListener("click", this.promptTemplateButton);
      this.renderPromptTemplateButtons();
      this.input();
    }

    disconnect(): void {
      this.inputTarget.closest("form")?.removeEventListener("submit",this.treeSubmit,true);
      this.catalogObserver?.disconnect();
      if (this.hasPromptTemplateButtonsTarget) this.promptTemplateButtonsTarget.removeEventListener("click", this.promptTemplateButton);
      super.disconnect();
    }

    private readonly treeSubmit = (event:Event):void => {
      if (this.inputTarget.value.trim() !== "/tree") return;
      const option = this.catalogTarget.querySelector<HTMLElement>('[data-command-action="tree"]');
      if (!option) return;
      event.preventDefault();event.stopImmediatePropagation();this.close();selectAgentTreeOption(option,this.inputTarget);
    };
    /** Prompt template buttons always sit in the composer, so its height never changes late. */
    private renderPromptTemplateButtons(): void {
      if (!this.hasPromptTemplateButtonsTarget) return;
      const html = labelPromptTemplateShortcuts(promptTemplateButtonHtml(this.catalogTarget.innerHTML), hooks);
      if (this.promptTemplateButtonsTarget.innerHTML === html) return;
      changeLayout(() => {
        this.promptTemplateButtonsTarget.innerHTML = html;
        this.element.dispatchEvent(new Event("agent-composer:resize", { bubbles: true }));
      });
    }

    private readonly promptTemplateButton = (event: MouseEvent): void => {
      const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-agent-prompt-template-button]") : null;
      if (!option) return;
      const input = this.inputTarget;
      const initialValue = input.value;
      void expandedSlashCommand(this.urlValue, option.dataset.commandTrigger!).then((expanded) => {
        if (input.value !== initialValue || composerIsDictating(input)) return;
        // A draft is never discarded: the template follows it.
        setTextInputValue(input, initialValue.trim() ? `${initialValue.trimEnd()}\n\n${expanded}` : expanded);
        if (!focusLikelyOpensSoftwareKeyboard()) input.focus({ preventScroll: true });
      });
    };
  };
}

