/// <reference lib="dom" />

import type { WorkspaceClientControllerConstructor, WorkspaceClientModule } from "@kintsugi/shared";
import { flushPreviewFrame } from "@kintsugi/proxy-ingress/preview-client";

function createBrowserAddressController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class BrowserAddressController extends Controller {
    declare readonly element: HTMLFormElement;
    private preparedSubmit = false;

    initializeAddress(): void {
      const input = this.input();
      if (input && !input.value) input.value = "http://localhost:3000";
    }

    submit(event: SubmitEvent): void {
      if (this.preparedSubmit) { this.preparedSubmit = false; return; }
      const input = this.input();
      if (!input) return;
      input.value = normalizeBrowserInput(input.value);
      event.preventDefault();
      const iframe = this.iframe();
      void (iframe ? flushPreviewFrame(iframe) : Promise.resolve()).then(() => {
        this.preparedSubmit = true;
        this.element.requestSubmit(event.submitter);
      }).catch(error => { console.error("Browser navigation paused", error); window.alert("Preview settings could not be saved. The current page was kept open."); });
    }

    reload(event?: Event): void {
      event?.preventDefault();
      const iframe = this.iframe();
      if (!iframe?.src) return;
      void flushPreviewFrame(iframe).then(() => { iframe.src = iframe.src; }).catch(error => { console.error("Browser reload paused", error); window.alert("Preview settings could not be saved. The current page was kept open."); });
    }

    private input(): HTMLInputElement | null {
      return this.element.querySelector<HTMLInputElement>(".browser-address-input");
    }

    private iframe(): HTMLIFrameElement | null {
      return this.element.closest(".browser-shell")?.querySelector<HTMLIFrameElement>("iframe") ?? null;
    }
  };
}

function normalizeBrowserInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

const browserClientModule: WorkspaceClientModule = {
  id: "browser",
  install({ application, Controller }) {
    application.register("browser-address", createBrowserAddressController(Controller));

  },
};

export { browserClientModule as kintsugiClientModule };
