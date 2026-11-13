/// <reference lib="dom" />
import { changeLayout } from "./layout-transaction.ts";
export type LayoutPreference = "auto" | "desktop" | "compact";
export const layoutPreferenceKey = "kintsugi.layout";
export const layoutPreferenceEvent = "kintsugi:layout-preference-changed";
/** Window size chooses the shell arrangement; touch/keyboard capabilities remain independent. */
export const phoneLayoutMediaQuery = "(max-width: 700px)";
export function layoutPreference(): LayoutPreference {
  const stored = localStorage.getItem(layoutPreferenceKey);
  return stored === "desktop" || stored === "compact" ? stored : "auto";
}
export function isCompactLayout(): boolean {
  return document.documentElement.dataset.kintsugiLayout === "compact";
}
/** Called by the small blocking head script before the first paint. */
export function initializeLayoutPreference(): void {
  const preference = layoutPreference();
  const compact = preference === "compact" || preference === "auto" && window.matchMedia(phoneLayoutMediaQuery).matches;
  document.documentElement.dataset.kintsugiLayout = compact ? "compact" : "desktop";
}
function applyLayoutPreference(): void {
  changeLayout(() => {
    initializeLayoutPreference();
    document.dispatchEvent(new Event(layoutPreferenceEvent));
  });
}
export function setLayoutPreference(preference: LayoutPreference): void {
  localStorage.setItem(layoutPreferenceKey, preference);
  applyLayoutPreference();
}
/** The main client owns listeners so shell and composer changes share one layout transaction. */
export function installLayoutPreference(): void {
  applyLayoutPreference();
  window.matchMedia(phoneLayoutMediaQuery).addEventListener("change", applyLayoutPreference);
  window.addEventListener("storage", event => {if (event.key === layoutPreferenceKey || event.key === null) applyLayoutPreference();});
  window.addEventListener("pageshow", applyLayoutPreference);
}
