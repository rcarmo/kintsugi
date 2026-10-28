import type { JsonValue } from "@kintsugi/core";
import { domId } from "@kintsugi/shared";
import { createWorkspaceMetadataState } from "@kintsugi/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const workspaceBrowserViewSchema = Type.Object({
  key: Type.String({ pattern: "^browser-[a-zA-Z0-9-]+$" }),
  label: Type.String(),
  targetUrl: Type.String(),
});

const workspaceBrowserViewsSchema = Type.Array(workspaceBrowserViewSchema);

export type WorkspaceBrowserView = Static<typeof workspaceBrowserViewSchema>;

function parseBrowserViews(value: JsonValue): WorkspaceBrowserView[] {
  return Value.Parse(workspaceBrowserViewsSchema, Value.Clean(workspaceBrowserViewsSchema, value));
}

const browserViews = createWorkspaceMetadataState("browser-work-views.json", parseBrowserViews, () => []);
// Bumped on every navigation so re-navigating to the same URL still reloads the Browser iframe.
const browserNavigationCounts = new Map<string, number>();

function navigationCountKey(workspaceId: string, browserId: string): string {
  return `${workspaceId}/${browserId}`;
}

export function browserNavigationCount(workspaceId: string, browserId: string): number {
  return browserNavigationCounts.get(navigationCountKey(workspaceId, browserId)) ?? 0;
}

export function browserFrameId(workspaceId: string, browserId: string): string {
  return domId("browser_frame", workspaceId, browserId);
}

export function listWorkspaceBrowserViews(workspaceId: string): WorkspaceBrowserView[] {
  return browserViews.read(workspaceId);
}

export function getWorkspaceBrowserView(workspaceId: string, browserId: string): WorkspaceBrowserView | undefined {
  return browserViews.read(workspaceId).find((view) => view.key === browserId);
}

export function createWorkspaceBrowserView(workspaceId: string): WorkspaceBrowserView {
  const existing = listWorkspaceBrowserViews(workspaceId);
  const index = existing.length + 1;
  const view = { key: `browser-${crypto.randomUUID()}`, label: `Browser ${index}`, targetUrl: "" };
  existing.push(view);
  browserViews.write(workspaceId, existing);
  return view;
}

export function deleteWorkspaceBrowserView(workspaceId: string, browserId: string): void {
  browserViews.write(workspaceId, browserViews.read(workspaceId).filter((view) => view.key !== browserId));
  browserNavigationCounts.delete(navigationCountKey(workspaceId, browserId));
}

export function setWorkspaceBrowserTarget(workspaceId: string, browserId: string, input: string): WorkspaceBrowserView | undefined {
  const view = getWorkspaceBrowserView(workspaceId, browserId);
  if (!view) return undefined;
  view.targetUrl = normalizeBrowserUrl(input);
  browserViews.write(workspaceId, browserViews.read(workspaceId));
  browserNavigationCounts.set(navigationCountKey(workspaceId, browserId), browserNavigationCount(workspaceId, browserId) + 1);
  return view;
}

export function deleteWorkspaceBrowserState(workspaceId: string): void {
  for (const view of browserViews.read(workspaceId)) browserNavigationCounts.delete(navigationCountKey(workspaceId, view.key));
  browserViews.delete(workspaceId);
}

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return "";
  }
  // Workspace files have no host; file://host would name another machine.
  if (parsed.protocol === "file:") return parsed.host ? "" : parsed.toString();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (!parsed.hostname) return "";
  return parsed.toString();
}
