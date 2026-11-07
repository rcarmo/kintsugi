import type { WorkspaceClientControllerConstructor } from "@kintsugi/shared";

export function createAgentMessageTimeController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static values = { timestamp: Number, tooltipOnly: Boolean };
    declare readonly timestampValue: number;
    declare readonly tooltipOnlyValue: boolean;
    declare readonly element: HTMLElement;

    private observer?: MutationObserver;

    connect(): void {
      // Turbo may morph the UTC fallback back in without changing the timestamp value.
      this.observer = new MutationObserver(() => this.timestampValueChanged());
      this.observer.observe(this.tooltipOnlyValue ? this.element : this.element.parentElement!, { childList: !this.tooltipOnlyValue, subtree: !this.tooltipOnlyValue, attributes: true, attributeFilter: ["title", "aria-label", "data-agent-message-time-timestamp-value"] });
    }
    disconnect(): void { this.observer?.disconnect(); }

    timestampValueChanged(): void {
      const date = new Date(this.timestampValue);
      const label = date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      if (!this.tooltipOnlyValue && this.element.textContent !== label) this.element.textContent = label;
      const title = date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" });
      if (this.element.title !== title) this.element.title = title;
      if (this.tooltipOnlyValue) return;
      const parent = this.element.parentElement!;
      if (parent.getAttribute("aria-label") !== `Last message: ${label}`) parent.setAttribute("aria-label", `Last message: ${label}`);
    }
  };
}
