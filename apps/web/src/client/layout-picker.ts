import { Controller } from "@hotwired/stimulus";
import { layoutPreference, layoutPreferenceEvent, setLayoutPreference } from "@kintsugi/shared/layout-preference";
export class LayoutPickerController extends Controller<HTMLElement> {
  static targets = ["trigger", "option"];
  declare readonly triggerTarget: HTMLButtonElement;
  declare readonly optionTargets: HTMLButtonElement[];
  connect(): void {document.addEventListener(layoutPreferenceEvent, this.refresh);this.refresh();}
  disconnect(): void {document.removeEventListener(layoutPreferenceEvent, this.refresh);}
  choose(event: Event): void {
    if (!(event.currentTarget instanceof HTMLButtonElement)) return;
    const preference = event.currentTarget.value;
    if (preference !== "auto" && preference !== "desktop" && preference !== "compact") throw new Error("Invalid layout choice");
    setLayoutPreference(preference);
  }
  private readonly refresh = (): void => {
    const preference = layoutPreference(), label = preference === "auto" ? "Auto" : preference === "desktop" ? "Desktop" : "Compact";
    this.triggerTarget.setAttribute("aria-label", `Layout: ${label}`);
    this.triggerTarget.title = `Layout: ${label}`;
    for (const option of this.optionTargets) option.setAttribute("aria-checked", String(option.value === preference));
  };
}
