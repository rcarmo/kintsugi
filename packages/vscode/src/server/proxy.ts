import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceHttpAppBackend } from "@kintsugi/shared";
import { isJsonObject } from "@kintsugi/core";
import { workspacePortBackend, workspaceVSCodePort } from "@kintsugi/workspace";
import { publicWorkspaceAppOrigin, type WorkspaceAppHost } from "@kintsugi/proxy-ingress/server";
import { ensureWorkspaceVSCodeServer } from "./workspace-vscode.ts";
import { vscodePublicResourcePrefix } from "./public-resources.ts";

const gallerySchema = Type.Object({ resourceUrlTemplate: Type.Optional(Type.String()) });
const remoteAuthoritySchema = Type.String();

export const vscodeAppKey = "vscode";

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function unescapeHtmlAttribute(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

// Coalesce concurrent checks, but never cache ownership across requests.
const pendingServerChecks = new Map<string, Promise<void>>();

type VSCodeThemeDefaults = {
  colorTheme: string;
  colorCustomizations: Record<string, string>;
  tokenColors: Array<{ scope: string[]; settings: { foreground: string } }>;
  semanticColors: Record<string, string>;
};

function requestColor(url: URL, name: string): string | undefined {
  const color = url.searchParams.get(name)?.trim();
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}

function luminance(hex: string): number {
  const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function themeDefaultsForRequest(request: Request): VSCodeThemeDefaults | undefined {
  const url = new URL(request.url);
  const bg = requestColor(url, "kintsugiBg");
  const panel = requestColor(url, "kintsugiPanel");
  const elev = requestColor(url, "kintsugiElev");
  const text = requestColor(url, "kintsugiText");
  const line = requestColor(url, "kintsugiLine");
  const accent = requestColor(url, "kintsugiAccent");
  if (!bg || !panel || !elev || !text) return undefined;
  interface VSCodeColorCustomizations {
    [name: string]: string;
  }
  const colorCustomizations: VSCodeColorCustomizations = {
    "activityBar.background": panel,
    "activityBar.foreground": text,
    "editor.background": bg,
    "editor.foreground": text,
    "editorGroup.border": line ?? elev,
    "editorGroupHeader.tabsBackground": panel,
    "editorGroupHeader.tabsBorder": line ?? elev,
    "tab.activeBackground": bg,
    "tab.activeForeground": text,
    "tab.border": line ?? elev,
    "tab.hoverBackground": elev,
    "tab.inactiveBackground": panel,
    "tab.inactiveForeground": text,
    "tab.unfocusedActiveBackground": bg,
    "tab.unfocusedActiveForeground": text,
    "tab.unfocusedInactiveBackground": panel,
    "tab.unfocusedInactiveForeground": text,
    "sideBar.background": panel,
    "sideBar.foreground": text,
    "sideBarSectionHeader.background": elev,
    "sideBarSectionHeader.border": line ?? elev,
    "sideBarSectionHeader.foreground": text,
    "sideBarTitle.foreground": text,
    "list.activeSelectionBackground": elev,
    "list.activeSelectionForeground": text,
    "list.hoverBackground": elev,
    "list.hoverForeground": text,
    "list.inactiveSelectionBackground": elev,
    "list.inactiveSelectionForeground": text,
    "statusBar.background": elev,
    "statusBar.foreground": text,
    "titleBar.activeBackground": panel,
    "titleBar.activeForeground": text,
    "titleBar.inactiveBackground": panel,
    "titleBar.inactiveForeground": text,
  };
  if (line) Object.assign(colorCustomizations, { "panel.border": line, "sideBar.border": line, "titleBar.border": line });
  if (accent) Object.assign(colorCustomizations, { "focusBorder": accent, "button.background": accent });
  const accentContrast = requestColor(url, "kintsugiAccentContrast");
  if (accentContrast) colorCustomizations["button.foreground"] = accentContrast;
  Object.assign(colorCustomizations, {
    "terminal.background": bg, "terminal.foreground": text,
    "panel.background": panel, "editorWidget.background": elev,
    "menu.background": panel, "menu.foreground": text, "menu.selectionBackground": elev,
    "quickInput.background": panel, "quickInput.foreground": text,
    "dropdown.background": elev, "dropdown.foreground": text, "dropdown.listBackground": panel,
    "input.background": bg, "input.foreground": text,
    "notifications.background": panel, "notifications.foreground": text,
    "notificationCenterHeader.background": elev, "notificationCenterHeader.foreground": text,
  });
  for (const color of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
    for (const prefix of ["", "bright-"]) {
      const value = requestColor(url, `kintsugiTerminal-${prefix}${color}`);
      if (value) colorCustomizations[`terminal.ansi${prefix ? "Bright" : ""}${color[0]!.toUpperCase()}${color.slice(1)}`] = value;
    }
  }
  const tokenColors: VSCodeThemeDefaults["tokenColors"] = [];
  const semanticColors: Record<string, string> = {};
  const syntaxRoles: Array<[string, string[], string[]]> = [
    ["comment", ["comment"], ["comment"]],
    ["string", ["string", "string.tag", "string.value", "string.regexp"], ["string", "regexp", "stringLiteral"]],
    // Match the base theme's specific scopes, not just their broader parents.
    ["keyword", ["keyword", "keyword.control", "storage", "storage.type", "storage.modifier"], ["keyword", "modifier", "newOperator"]],
    ["number", ["constant.numeric", "constant.language", "variable.other.enummember"], ["number", "numberLiteral", "enumMember"]],
    ["function", ["entity.name.function", "support.function"], ["function", "method"]],
    ["variable", ["variable", "variable.language", "variable.other.constant", "support.variable", "entity.name.variable", "meta.definition.variable.name", "meta.object-literal.key", "meta.template.expression", "entity.other.attribute-name"], ["variable", "parameter", "property"]],
    ["type", ["entity.name.type", "support.type", "support.class", "entity.name.tag"], ["type", "class", "interface", "enum", "struct", "typeParameter"]],
    ["punctuation", ["punctuation", "punctuation.definition.tag", "punctuation.definition.template-expression.begin", "punctuation.definition.template-expression.end", "punctuation.section.embedded", "keyword.operator"], ["operator"]],
  ];
  for (const [role, scope, types] of syntaxRoles) {
    const foreground = requestColor(url, `kintsugiSyntax-${role}`);
    if (!foreground) continue;
    tokenColors.push({ scope, settings: { foreground } });
    for (const type of types) semanticColors[type] = foreground;
  }
  const punctuation = requestColor(url, "kintsugiSyntax-punctuation");
  if (punctuation) for (let index = 1; index <= 6; index++) colorCustomizations[`editorBracketHighlight.foreground${index}`] = punctuation;
  return {
    colorTheme: luminance(bg) > 0.55 ? "Default Light Modern" : "Default Dark Modern",
    colorCustomizations,
    tokenColors,
    semanticColors,
  };
}

async function ensureVSCodeServer(workspaceId: string): Promise<void> {
  let pending = pendingServerChecks.get(workspaceId);
  if (!pending) {
    pending = ensureWorkspaceVSCodeServer(workspaceId).finally(() => {
      pendingServerChecks.delete(workspaceId);
    });
    pendingServerChecks.set(workspaceId, pending);
  }
  await pending;
}

export async function patchVSCodeWorkspaceAppResponse(app: WorkspaceAppHost, response: Response, request: Request, resourceOrigin?: URL): Promise<Response> {
  if (app.appKey !== vscodeAppKey || !response.ok) return response;
  if (!response.headers.get("content-type")?.includes("text/html")) return response;
  const requestUrl = new URL(request.url);
  const file = requestUrl.searchParams.get("kintsugiOpenFile");
  if (file !== null) {
    await response.body?.cancel();
    if (!file.startsWith("/")) return new Response("File path must be absolute", { status: 422 });
    const origin = new URL(publicWorkspaceAppOrigin(request));
    const resource = new URL(`vscode-remote://${origin.host}`);
    resource.pathname = pathToFileURL(file).pathname;
    const payload = [["openFile", resource.href]];
    if (requestUrl.searchParams.get("kintsugiGotoLine") === "1") payload.push(["gotoLineMode", "true"]);
    const destination = new URL(requestUrl.pathname + requestUrl.search, origin);
    destination.searchParams.delete("kintsugiOpenFile");
    destination.searchParams.delete("kintsugiGotoLine");
    destination.searchParams.set("payload", JSON.stringify(payload));
    return new Response(null, { status: 302, headers: { location: destination.href, "cache-control": "no-store" } });
  }
  const themeDefaults = themeDefaultsForRequest(request);
  const text = await response.text();
  const configPattern = /(<meta id="vscode-workbench-web-configuration" data-settings=")([^"]+)(">)/;
  if (!configPattern.test(text)) return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  const themed = text.replace(configPattern, (_match, prefix, rawSettings, suffix) => {
    const parsed: unknown = JSON.parse(unescapeHtmlAttribute(rawSettings));
    if (!isJsonObject(parsed)) throw new Error("VS Code workbench configuration is not a JSON object");
    const settings = parsed;
    // VS Code's browser connection settings belong to this adapter, not to the
    // app-facing Host policy. Keep them pointed at the actual preview endpoint.
    const publicOrigin = new URL(publicWorkspaceAppOrigin(request));
    const localAuthority = Value.Parse(remoteAuthoritySchema, settings.remoteAuthority);
    settings.remoteAuthority = publicOrigin.host;
    for (const name of ["workspaceUri", "folderUri"]) {
      const uri = settings[name];
      if (isJsonObject(uri) && uri.scheme === "vscode-remote" && uri.authority === localAuthority) uri.authority = publicOrigin.host;
    }
    const product = settings.productConfiguration;
    const gallery = isJsonObject(product) ? product.extensionsGallery : undefined;
    if (resourceOrigin && isJsonObject(product)) {
      product.chatParticipantRegistry = new URL(`${vscodePublicResourcePrefix}chat.json`, resourceOrigin).href;
      if (isJsonObject(gallery)) {
        gallery.controlUrl = new URL(`${vscodePublicResourcePrefix}marketplace.json`, resourceOrigin).href;
        gallery.mcpUrl = new URL(`${vscodePublicResourcePrefix}mcp.json`, resourceOrigin).href;
      }
    }
    if (isJsonObject(gallery)) {
      const { resourceUrlTemplate } = Value.Parse(gallerySchema, gallery);
      const localPrefix = `http://${localAuthority}/`;
      if (resourceUrlTemplate?.startsWith(localPrefix)) gallery.resourceUrlTemplate = `${publicOrigin.origin}/${resourceUrlTemplate.slice(localPrefix.length)}`;
    }
    settings.enableWorkspaceTrust = false;
    const configurationDefaults = isJsonObject(settings.configurationDefaults) ? settings.configurationDefaults : {};
    Object.assign(configurationDefaults, {
      "security.workspace.trust.enabled": false,
      "security.workspace.trust.startupPrompt": "never",
      "security.workspace.trust.banner": "never",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "workbench.startupEditor": "none",
      "chat.disableAIFeatures": true,
    });
    if (themeDefaults) {
      configurationDefaults["workbench.colorTheme"] = themeDefaults.colorTheme;
      // Current VS Code renames "Default Dark/Light Modern" to "Dark/Light Modern".
      // Match both identities across workspace image versions, without colouring unrelated user-selected themes.
      const scope = `[${themeDefaults.colorTheme}][${themeDefaults.colorTheme.replace("Default ", "")}]`;
      configurationDefaults["workbench.colorCustomizations"] = { [scope]: themeDefaults.colorCustomizations };
      configurationDefaults["editor.tokenColorCustomizations"] = { [scope]: { textMateRules: themeDefaults.tokenColors } };
      configurationDefaults["editor.semanticTokenColorCustomizations"] = { [scope]: { rules: themeDefaults.semanticColors } };
    }
    settings.configurationDefaults = configurationDefaults;
    return `${prefix}${escapeHtmlAttribute(JSON.stringify(settings))}${suffix}`;
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(themed, { status: response.status, statusText: response.statusText, headers });
}

export async function resolveVSCodeWorkspaceAppBackend(app: WorkspaceAppHost, requestUrl: URL): Promise<WorkspaceHttpAppBackend> {
  if (app.appKey !== vscodeAppKey) throw new Error(`unknown workspace app: ${app.appKey}`);
  await ensureVSCodeServer(app.workspaceId);
  const targetUrl = new URL(requestUrl.pathname + requestUrl.search, "http://kintsugi.local");
  [...targetUrl.searchParams.keys()].forEach((key) => {
    if (key.startsWith("kintsugi")) targetUrl.searchParams.delete(key);
  });
  const path = targetUrl.pathname + targetUrl.search;
  return await workspacePortBackend(app.workspaceId, workspaceVSCodePort, path);
}
