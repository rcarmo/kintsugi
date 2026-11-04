/// <reference lib="dom" />

import { Controller } from "@hotwired/stimulus";

/** Measure browser-sized auxiliary controls, including groups and confirmations. */
export class ContentRowActionsController extends Controller<HTMLElement> {
  private observer!: ResizeObserver;

  connect(): void {
    const item = this.element.parentElement!;
    // The first observation arrives before the first paint, without forcing a layout while controllers connect.
    this.observer = new ResizeObserver(([entry]) => {
      item.style.setProperty("--content-row-actions-width", `${entry!.borderBoxSize[0]!.inlineSize}px`);
    });
    this.observer.observe(this.element);
  }

  disconnect(): void {
    this.observer.disconnect();
  }
}
