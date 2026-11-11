import { handleConnectionModeSettings } from "./connection-mode.ts";
import { handleBrowserTransportSettings } from "./browser-transport.ts";
import { handleGitHostingSettingsRequest } from "./git-hosting.ts";
import { handleModelsRequest } from "@kintsugi/llm/server";
import { finishOnboarding } from "../onboarding/state.ts";
import { handleSettingsPageRequest, type WorkspaceCleanupResult } from "./page.ts";
import { listSettingsContributions } from "./registry.ts";
import { handleThemeSettingsRequest } from "./theme.ts";

export async function handleSettingsRequest(
  request: Request,
  url: URL,
  options: { forceDeleteAllWorkspaces?: () => Promise<WorkspaceCleanupResult>; renderModelPickerUpdates: () => Promise<string>; themeChanged: () => void },
): Promise<Response | undefined> {
  const response = await handleBrowserTransportSettings(request, url)
    ?? await handleConnectionModeSettings(request, url)
    ?? await handleThemeSettingsRequest(request, url, options.themeChanged)
    ?? await handleSettingsPageRequest(request, url, options)
    ?? await handleGitHostingSettingsRequest(request, url)
    ?? await handleModelsRequest(request, url, options.renderModelPickerUpdates, finishOnboarding);
  if (response) return response;

  for (const contribution of listSettingsContributions()) {
    const handled = await contribution.handleAction?.({ request, url });
    if (handled) return handled;
  }
  return undefined;
}
