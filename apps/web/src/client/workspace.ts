import { registerLiveSurfaces } from "./live-surface.ts";
import { installLayoutPreference } from "@kintsugi/shared/layout-preference";
/// <reference lib="dom" />

import { Application as StimulusApplication, Controller as StimulusController } from "@hotwired/stimulus";
// Turbo does not publish TypeScript declarations, but Bun resolves and bundles its browser module.
import { registerDesignSystemControllers } from "@kintsugi/design-system/client";
import {
  installSoftwareKeyboardTracking,
  type KintsugiCableClient,
  type WorkspaceClientControllerConstructor,
} from "@kintsugi/shared";
import { createProvisionTerminalController } from "@kintsugi/workspace/client";
// @ts-expect-error Turbo ships no TypeScript declarations.
import * as Turbo from "@hotwired/turbo";
import { NavigationOriginController } from "./navigation-origin-controller.ts";
import { BrowserTitleController } from "./browser-title-controller.ts";
import { ConnectionModeSettingsController } from "./connection-mode-settings.ts";
import { LayoutPickerController } from "./layout-picker.ts";
import { registerWorkspaceAppFrameController } from "./workspace-app-frame.ts";
import { installWorkspaceCable } from "./workspace-cable.ts";
import { clientHooks } from "./workspace-client-hooks.ts";
import { workspaceClientModules } from "./workspace-client-modules.generated.ts";
import { initializeWorkspaceControllerRegistry, registerWorkspaceControllers, workspaceNavigationController } from "./workspace-controller-registry.ts";
import { registerWorkspaceDevReloadController } from "./workspace-dev-reload.ts";
import { registerWorkspaceDialogControllers } from "./workspace-dialogs.ts";
import { registerWorkspaceFullscreenController } from "./workspace-fullscreen.ts";
import { registerWorkspaceNavigationControllers } from "./workspace-navigation.ts";
import { createWorkspacePresentationController, installWorkspacePresentationTurboStream } from "./workspace-presentation.ts";
import { registerWorkspaceSelectionController } from "./workspace-selection.ts";
import { registerWorkspaceSettingsControllers } from "./workspace-settings.ts";
import { registerWorkspaceShortcutsController } from "./workspace-shortcuts.ts";

declare global {
  interface Window {
    Turbo?: { renderStreamMessage(html: string): void };
    KintsugiCable?: KintsugiCableClient;
  }
}

window.Turbo = Turbo;

const Controller: WorkspaceClientControllerConstructor = StimulusController;
const application = StimulusApplication.start();
application.register("navigation-origin", NavigationOriginController);
application.register("browser-title", BrowserTitleController);
installLayoutPreference();
installSoftwareKeyboardTracking();
initializeWorkspaceControllerRegistry(application);

installWorkspaceCable();
registerLiveSurfaces();
installWorkspacePresentationTurboStream(Turbo, application);
Turbo.StreamActions["select-workspace"] = function selectWorkspace(this: HTMLElement): void {
  const workspaceId = this.dataset.workspaceId;
  if (!workspaceId) throw new Error("select-workspace requires a Workspace id");
  void workspaceNavigationController()?.selectWorkspaceById(workspaceId);
};

for (const module of workspaceClientModules) await module.install({ application, Controller, hooks: clientHooks });
registerWorkspaceControllers({
  "connection-mode-settings": ConnectionModeSettingsController,
  "layout-picker": LayoutPickerController,
  "workspace-presentation": createWorkspacePresentationController(Controller, application, clientHooks),
});
registerWorkspaceNavigationControllers();
registerWorkspaceSelectionController();
registerWorkspaceShortcutsController();
registerWorkspaceFullscreenController();
registerWorkspaceDialogControllers();
registerWorkspaceAppFrameController();
registerWorkspaceSettingsControllers();
registerWorkspaceDevReloadController();
registerDesignSystemControllers(application);
registerWorkspaceControllers({
  "provision-terminal": createProvisionTerminalController(Controller),
});

// Nested workspace previews are deliberately opaque; offline/PWA workers
// require an ordinary origin and are not part of that browsing context.
if (globalThis.origin !== "null" && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/service-worker.js");
}
