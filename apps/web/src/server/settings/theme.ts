import { escapeHtml } from "@kintsugi/shared";
import { stream } from "@kintsugi/shared/http";
import { kintsugiThemes, isKintsugiTheme, readThemeSetting, writeThemeSetting, type KintsugiTheme } from "@kintsugi/shared/theme";

export const themeRegionId = "kintsugi_theme";

/** Contents of the page's theme region. Its controller applies the theme to the document. */
export function themeRegionHtml(theme: KintsugiTheme = readThemeSetting()): string {
  return `<span data-controller="kintsugi-theme" data-kintsugi-theme-name-value="${escapeHtml(theme)}"></span>`;
}

export async function renderThemeSettings(): Promise<string> {
  const current = readThemeSetting();
  const options = kintsugiThemes.map(({ id, label, appearance }) => `<label class="theme-choice">
    <input type="radio" name="theme" value="${id}"${id === current ? " checked" : ""}>
    <span class="theme-choice-label">${escapeHtml(label)}<small>${appearance === "light" ? "Light" : "Dark"}</small></span>
    <span class="theme-palette" data-theme="${id}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
  </label>`).join("");
  return `<section class="settings-sec settings-sec-theme" id="settings-sec-theme"><h2 id="settings-theme-title">Theme</h2><form method="post" action="/settings/theme" data-turbo="true" data-controller="settings-autosave" data-action="change->settings-autosave#save submit->settings-autosave#submit"><fieldset class="theme-options" aria-labelledby="settings-theme-title">${options}</fieldset></form></section>`;
}

export async function handleThemeSettingsRequest(request: Request, url: URL, themeChanged: () => void): Promise<Response | undefined> {
  if (url.pathname !== "/settings/theme" || request.method !== "POST") return undefined;
  const theme = (await request.formData()).get("theme");
  if (!isKintsugiTheme(theme)) return new Response("Unsupported theme", { status: 400 });
  await writeThemeSetting(theme);
  // Every open page, including this one, applies it through the shell region.
  themeChanged();
  return stream("");
}
