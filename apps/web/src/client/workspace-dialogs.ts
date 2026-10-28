import { Controller } from "@hotwired/stimulus";
import { createHtmlAutocompleteController, PromptHistoryNavigator, transcriptSelectionText } from "@kintsugi/agent/client";
import { composerViewportHeight, focusComposerText, revealComposerCaret, sizeComposer } from "@kintsugi/prompt/client";
import { autocompleteHtml } from "@kintsugi/design-system/autocomplete";
import { changeLayout, composerSubmitKey, focusLikelyOpensSoftwareKeyboard, isWorkspacePaneVisible, shouldSearchRepositories, softwareKeyboardArranged } from "@kintsugi/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { submitFormWithFirstButton } from "./form-submission.ts";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

class WorkspaceSshTrustController extends Controller<HTMLElement> {
  private focusFrame?: number;

  connect(): void {
    this.focusFrame = requestAnimationFrame(() => {
      if (isWorkspacePaneVisible(this.element)) this.element.querySelector<HTMLElement>('input[name="key"], button')?.focus();
    });
  }

  disconnect(): void {
    if (this.focusFrame !== undefined) cancelAnimationFrame(this.focusFrame);
  }
}

class SubmitShortcutController extends Controller {
  private submitting = false;

  keydown(event: KeyboardEvent): void {
    if (!composerSubmitKey(event)) return;
    event.preventDefault();
    if (this.submitting) return;
    // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
    submitFormWithFirstButton(event.currentTarget as HTMLFormElement);
  }

  windowKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (!composerSubmitKey(event)) return;
    if (!isWorkspacePaneVisible(this.element) || !this.element.checkVisibility()) return;
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    if (this.submitting) return;
    // SAFETY: Window-level shortcuts are attached to the form they submit.
    submitFormWithFirstButton(this.element as HTMLFormElement);
  }

  submit(event: SubmitEvent): void {
    if (!this.submitting) {
      this.submitting = true;
      return;
    }
    event.preventDefault();
  }

  submitted(): void {
    this.submitting = false;
  }
}

const launchComposerPromptHistoryStorageKey = "kintsugi:launch-composer-prompt-history";
const launchComposerPromptHistorySchema = Type.Array(Type.String());

class LaunchComposerDialogController extends Controller<HTMLDialogElement> {
  static values = { discardUrl: String };
  declare readonly discardUrlValue: string;
  private submissionAccepted = false;
  private readonly promptHistoryNavigator = new PromptHistoryNavigator();
  private observer!: ResizeObserver;

  connect(): void {
    this.element.addEventListener("close", this.closed);
    this.input.addEventListener("keydown", this.inputKeydown);
    this.input.addEventListener("input", this.inputChanged);
    // Text selected in the transcript starts the new prompt, as is: the new Agent won't know where it came from.
    const selection = transcriptSelectionText();
    if (selection) this.input.value = selection;
    // Exclude the editor from native dialog autofocus on touch devices: opening
    // should offer dictation and attachments without briefly raising a keyboard.
    const touch = focusLikelyOpensSoftwareKeyboard();
    this.input.inert = touch;
    this.element.showModal();
    this.input.inert = false;
    if (!touch) {
      this.input.focus({ preventScroll: true });
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }
    this.observer = new ResizeObserver(() => this.layout());
    for (const chrome of this.element.querySelectorAll(".panel__header, .composer-footer, .agent-attach-row, [role='status']")) this.observer.observe(chrome);
    this.layout();
  }

  disconnect(): void {
    this.observer.disconnect();
    this.element.removeEventListener("close", this.closed);
    this.input.removeEventListener("keydown", this.inputKeydown);
    this.input.removeEventListener("input", this.inputChanged);
  }

  private get input(): HTMLTextAreaElement {
    return this.element.querySelector<HTMLTextAreaElement>('textarea[name="text"]')!;
  }

  private get composer(): HTMLElement {
    return this.element.querySelector<HTMLElement>(".launch-composer")!;
  }

  templateChanged(event: Event): void {
    // SAFETY: This action is bound to the template Turbo Frame’s load event.
    const frame = event.target as HTMLElement;
    const selection = frame.querySelector<HTMLInputElement>("[data-launch-template-action]")!;
    this.composer.querySelector<HTMLFormElement>("form")!.action = selection.dataset.launchTemplateAction!;
    this.composer.setAttribute("data-dictation-composer-workspace-template-id-value", selection.value);
  }

  focusText(event: MouseEvent): void {
    focusComposerText(this.composer, event);
  }

  layout(): void {
    if (!this.element.open) return;
    changeLayout(() => {
      const typing = softwareKeyboardArranged();
      const available = composerViewportHeight();
      const maxHeight = typing ? available - 16 : Math.min(available - 32, 860);
      this.element.style.setProperty("--launch-dialog-height", `${maxHeight}px`);
      if (typing) {
        // Flex layout owns full-height typing; discard content-sizing overrides.
        this.input.style.removeProperty("height");
        this.input.style.removeProperty("overflow-y");
        revealComposerCaret(this.input);
      } else {
        const header = this.element.querySelector<HTMLElement>(".panel__header")!;
        const panel = this.element.querySelector<HTMLElement>(".panel")!;
        const border = panel.getBoundingClientRect().height - panel.clientHeight;
        sizeComposer(this.composer, maxHeight - header.getBoundingClientRect().height - border);
      }
    });
  }

  private promptHistory(): string[] {
    const value = localStorage.getItem(launchComposerPromptHistoryStorageKey);
    return value ? Value.Parse(launchComposerPromptHistorySchema, JSON.parse(value)) : [];
  }

  private readonly inputKeydown = (event: KeyboardEvent): void => {
    this.promptHistoryNavigator.keydown(event, this.input, () => this.promptHistory());
  };

  private readonly inputChanged = (): void => {
    this.promptHistoryNavigator.inputChanged();
    this.layout();
  };

  submitted(event: CustomEvent<{ success: boolean }>): void {
    if (!event.detail.success) return;
    const prompt = this.input.value;
    if (prompt.trim()) localStorage.setItem(launchComposerPromptHistoryStorageKey, JSON.stringify([...this.promptHistory(), prompt]));
    // Intentionally only dismiss the LaunchComposer here: do not select or wait for the launched Workspace.
    this.submissionAccepted = true;
    this.element.close();
  }

  private readonly closed = (): void => {
    if (this.submissionAccepted) return;
    void fetch(this.discardUrlValue, { method: "POST" }).catch((error) => console.error("Could not discard attachment draft", error));
    const frame = this.element.closest("turbo-frame")!;
    frame.removeAttribute("src");
    frame.replaceChildren();
  };
}

class AutoScrollController extends Controller<HTMLElement> {
  connect(): void {
    requestAnimationFrame(() => {
      this.element.scrollTop = this.element.scrollHeight;
    });
  }
}

class ScrollIntoViewController extends Controller<HTMLElement> {
  static values = { targetId: String };
  declare readonly targetIdValue: string;
  declare readonly hasTargetIdValue: boolean;

  connect(): void {
    this.scroll();
  }

  frameLoaded(event: Event): void {
    const target = this.hasTargetIdValue ? document.getElementById(this.targetIdValue)! : this.element;
    if (event.target instanceof Node && target.contains(event.target)) this.scroll();
  }

  private scroll(): void {
    const target = this.hasTargetIdValue ? document.getElementById(this.targetIdValue)! : this.element;
    requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
  }
}

const WorkspaceTemplateRepositorySearchController = createHtmlAutocompleteController(Controller, {
  optionSelector: "[role=\"option\"]",
  loadingHtml: autocompleteHtml({ kind: "message", role: "status", content: { kind: "html", html: '<span class="agent-completion-spinner" aria-hidden="true"></span>Searching repositories…' } }),
  explicitSearch: true,
  request(input) {
    const query = input.value.trim();
    return shouldSearchRepositories(query) ? { query } : undefined;
  },
  select(option, input) {
    const gitUrl = option.dataset.gitUrl!;
    input.value = gitUrl;
    input.setSelectionRange(gitUrl.length, gitUrl.length);
  },
});

export function registerWorkspaceDialogControllers(): void {
  registerWorkspaceControllers({
    "submit-shortcut": SubmitShortcutController,
    "workspace-ssh-trust": WorkspaceSshTrustController,
    "launch-composer-dialog": LaunchComposerDialogController,
    "workspace-template-repository-search": WorkspaceTemplateRepositorySearchController,
    "auto-scroll": AutoScrollController,
    "scroll-into-view": ScrollIntoViewController,
  });
}
