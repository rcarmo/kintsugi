import { readFileSync } from "node:fs";
import { kintsugiEnv, kintsugiDataPath, getKintsugiRuntimeContext, isNotFoundError } from "@kintsugi/core";
import { updateJsonSettings } from "@kintsugi/core/json-settings";
import { parseThemeSettings, type KintsugiTheme } from "./theme.ts";

export { kintsugiThemes, isKintsugiTheme, themeAppearance, type KintsugiTheme } from "./theme.ts";

// Kintsugi System reads this file directly, so its location is part of that contract.
function themeSettingPath(): string {
  return kintsugiDataPath(getKintsugiRuntimeContext(), "theme.json");
}

/** Synchronous because every page render embeds the theme. */
export function readThemeSetting(): KintsugiTheme {
  let text: string | undefined;
  try {
    text = readFileSync(themeSettingPath(), "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  // An Kintsugi running inside a workspace looks different from the host by default.
  return parseThemeSettings(text, kintsugiEnv("HOST_UID") ? "cappuccino" : "nord");
}

export async function writeThemeSetting(theme: KintsugiTheme): Promise<void> {
  await updateJsonSettings(themeSettingPath(), (settings) => { settings.theme = theme; });
}
