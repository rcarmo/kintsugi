import { AppSettingsController } from "./app-settings-controller.ts";
import { SettingsEditorController } from "./settings-editor-controller.ts";
import { TemplateSettingsController } from "./template-settings-controller.ts";
import { WorkspaceTemplateNewSecretController } from "./workspace-template-new-secret-controller.ts";
import type { ToggleChangeEvent } from "@kintsugi/design-system/toggle/client";
import { showButtonConfirmation } from "@kintsugi/design-system/button-confirmation/client";
import { copyTextToClipboard } from "@kintsugi/shared";
import { Controller } from "@hotwired/stimulus";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

/** Applies the server's theme setting, on page load and when the shell region pushes a change. */
class KintsugiThemeController extends Controller<HTMLElement> {
  static values = { name: String };
  declare readonly nameValue: string;

  nameValueChanged(): void {
    const root = document.documentElement;
    if (root.dataset.theme === this.nameValue) return;
    root.dataset.theme = this.nameValue;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content = getComputedStyle(root).getPropertyValue("--bg").trim();
    document.dispatchEvent(new CustomEvent("kintsugi:theme-change", { detail: { theme: this.nameValue } }));
  }
}

class SettingsAutosaveController extends Controller<HTMLFormElement> {
  private savedValues = "";
  private pending?: Promise<boolean>;

  connect(): void {
    this.savedValues = this.values();
  }

  private values(): string {
    return JSON.stringify([...new FormData(this.element).entries()]);
  }

  toggleChanged(event: ToggleChangeEvent): void {
    this.element.querySelector<HTMLInputElement>(`input[type="hidden"][name="${CSS.escape(event.detail.name)}"]`)!.value = event.detail.value;
    if (this.element.checkValidity()) void this.save();
  }

  submit(event: Event): void {
    event.preventDefault();
    void this.save();
  }

  saveWhenLeaving(event: FocusEvent): void {
    if (event.target instanceof HTMLButtonElement && event.target.type === "submit") return;
    if (event.relatedTarget instanceof Node && this.element.contains(event.relatedTarget)) return;
    if (!this.element.checkValidity()) return;
    void this.save();
  }

  save(): Promise<boolean> {
    // Every caller joins the same drain. Only its owner starts requests or clears pending.
    return this.pending ??= Promise.resolve().then(() => this.drain()).finally(() => { this.pending = undefined; });
  }

  private async drain(): Promise<boolean> {
    while (this.element.isConnected) {
      const data = new FormData(this.element);
      const values = JSON.stringify([...data.entries()]);
      if (values === this.savedValues) return true;
      if (!this.element.reportValidity()) return false;
      if (!await this.persist(data, values)) return false;
    }
    return true;
  }

  private async persist(data: FormData, values: string): Promise<boolean> {
    this.dispatch("saving");
    try {
      const response = await fetch(this.element.action, {
        method: this.element.method || "POST",
        body: data,
        headers: { Accept: "text/vnd.turbo-stream.html" },
      });
      const html = await response.text();
      if (response.ok) this.savedValues = values;
      this.dispatch(response.ok ? "saved" : "failed");
      window.Turbo!.renderStreamMessage(html);
      return response.ok;
    } catch (error) {
      this.dispatch("failed");
      throw error;
    }
  }
}

class CommitIdentityController extends Controller<HTMLFormElement> {
  private timer: number | undefined;
  private saving = false;

  disconnect(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
  }

  queue(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.save(), 700);
  }

  submit(event: Event): void {
    event.preventDefault();
    void this.save();
  }

  async save(): Promise<void> {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.saving || !this.element.checkValidity()) return;
    this.saving = true;
    const response = await fetch(this.element.action, {
      method: this.element.method || "POST",
      body: new FormData(this.element),
      headers: { Accept: "text/vnd.turbo-stream.html" },
    }).catch(() => undefined);
    this.saving = false;
    if (!response?.ok) return;
    const html = await response.text();
    window.Turbo?.renderStreamMessage(html);
  }
}

class SettingsPrefetchController extends Controller {
  private prefetched?: Promise<string>;
  private expiresAt = 0;

  prefetch(): void {
    void this.settingsHtml().catch((error) => console.error("Settings prefetch failed", error));
  }

  async open(event: Event): Promise<void> {
    event.preventDefault();
    try {
      const html = await this.settingsHtml();
      this.prefetched = undefined;
      this.expiresAt = 0;
      if (window.Turbo) window.Turbo.renderStreamMessage(html);
      else window.location.assign("/settings");
    } catch (error) {
      console.error("Could not open Settings in the current page; using HTTP navigation", error);
      window.location.assign("/settings");
    }
  }

  private settingsHtml(): Promise<string> {
    if (this.prefetched && this.expiresAt > Date.now()) return this.prefetched;
    this.expiresAt = Date.now() + 10_000;
    this.prefetched = fetch("/settings", { headers: { Accept: "text/vnd.turbo-stream.html" } }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    }).catch((error) => {
      this.prefetched = undefined;
      this.expiresAt = 0;
      throw error;
    });
    return this.prefetched;
  }
}

class ServerFilterController extends Controller {
  private timer?: ReturnType<typeof setTimeout>;

  disconnect(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  submit(): void {
    if (this.timer) clearTimeout(this.timer);
    // SAFETY: The controller is attached only to server-rendered filter forms.
    this.timer = setTimeout(() => (this.element as HTMLFormElement).requestSubmit(), 200);
  }
}

class SshPublicKeyCopyController extends Controller<HTMLElement> {
  static values = { url: String };
  static targets = ["error"];
  declare readonly urlValue: string;
  declare readonly errorTarget: HTMLElement;

  async copy(event: Event): Promise<void> {
    // SAFETY: The action is bound only to the server-rendered copy button.
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    this.errorTarget.hidden = true;
    try {
      const response = await fetch(this.urlValue);
      if (!response.ok) throw new Error(`Could not derive public key: HTTP ${response.status}`);
      await copyTextToClipboard(await response.text());
      showButtonConfirmation(button);
    } catch (error) {
      this.errorTarget.hidden = false;
      throw error;
    } finally {
      button.disabled = false;
    }
  }
}

export function registerWorkspaceSettingsControllers(): void {
  registerWorkspaceControllers({
    "kintsugi-theme": KintsugiThemeController,
    "commit-identity": CommitIdentityController,
    "settings-autosave": SettingsAutosaveController,
    "ssh-public-key-copy": SshPublicKeyCopyController,
    "settings-editor": SettingsEditorController,
    "template-settings": TemplateSettingsController,
    "app-settings": AppSettingsController,
    "workspace-template-new-secret": WorkspaceTemplateNewSecretController,
    "settings-prefetch": SettingsPrefetchController,
    "server-filter": ServerFilterController,
  });
}
