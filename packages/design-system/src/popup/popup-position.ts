/// <reference lib="dom" />

type Bounds = Pick<DOMRect, "left" | "right" | "top" | "bottom">;
type Position = Pick<DOMRect, "left" | "top">;
const gap = 8;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/** Shared top-layer positioning lifecycle for menus, selects, autocomplete, and confirmations. */
export class PopupPosition {
  private readonly viewport = window.visualViewport!;
  private readonly resize = new ResizeObserver(() => this.position());
  private readonly visibility = new IntersectionObserver((entries) => {
    if (!entries[0]!.isIntersecting) this.menu.hidePopover();
  });

  constructor(private readonly trigger: HTMLElement, private readonly menu: HTMLElement, private readonly placement: "below" | "adjacent" = "below") {
    menu.addEventListener("beforetoggle", this.prepare);
    menu.addEventListener("toggle", this.toggle);
  }

  disconnect(): void {
    this.stop();
    this.menu.removeEventListener("beforetoggle", this.prepare);
    this.menu.removeEventListener("toggle", this.toggle);
  }

  private *ancestors(): Generator<HTMLElement> {
    for (let parent = this.trigger.parentElement; parent; parent = parent.parentElement) yield parent;
  }

  private readonly prepare = (event: ToggleEvent): void => {
    if (event.newState === "open") this.menu.style.visibility = "hidden";
  };

  private readonly toggle = (): void => {
    if (!this.menu.matches(":popover-open")) { this.stop(); return; }
    this.position();
    this.menu.addEventListener("scroll", this.updateOverflow);
    this.visibility.observe(this.trigger);
    this.resize.observe(this.trigger);
    this.resize.observe(this.menu);
    if (this.placement === "adjacent") for (const parent of this.ancestors()) this.resize.observe(parent);
    document.addEventListener("scroll", this.scroll, true);
    window.addEventListener("resize", this.position);
    this.viewport.addEventListener("resize", this.position);
    this.viewport.addEventListener("scroll", this.position);
  };

  private stop(): void {
    this.visibility.disconnect();
    this.resize.disconnect();
    this.menu.removeEventListener("scroll", this.updateOverflow);
    document.removeEventListener("scroll", this.scroll, true);
    window.removeEventListener("resize", this.position);
    this.viewport.removeEventListener("resize", this.position);
    this.viewport.removeEventListener("scroll", this.position);
  }

  private readonly scroll = (event: Event): void => {
    if (event.target instanceof Node && this.menu.contains(event.target)) return;
    this.position();
  };

  private readonly position = (): void => {
    const { offsetLeft, offsetTop, width, height } = this.viewport;
    const anchor = this.trigger.getBoundingClientRect();
    if (anchor.bottom <= offsetTop || anchor.top >= offsetTop + height
      || anchor.right <= offsetLeft || anchor.left >= offsetLeft + width) {
      this.menu.hidePopover();
      return;
    }
    const viewport: Bounds = { left: offsetLeft + gap, right: offsetLeft + width - gap, top: offsetTop + gap, bottom: offsetTop + height - gap };
    this.menu.style.maxWidth = `${Math.min(this.menu.dataset.popupMenuWidth === "content" ? Infinity : 340, width - gap * 2)}px`;
    this.menu.style.minWidth = `${this.placement === "adjacent" ? 0 : Math.min(anchor.width, width - gap * 2)}px`;
    const rtl = getComputedStyle(this.trigger).direction === "rtl";
    const position = (this.placement === "adjacent" ? this.adjacent(anchor, viewport, rtl) : undefined)
      ?? this.vertical(anchor, viewport, rtl);
    this.menu.style.left = `${position.left}px`;
    this.menu.style.top = `${position.top}px`;
    // Grow from the nearest point to the trigger, including adjacent confirmations.
    const x = clamp(anchor.left + anchor.width / 2 - position.left, 0, this.menu.offsetWidth);
    const y = clamp(anchor.top + anchor.height / 2 - position.top, 0, this.menu.offsetHeight);
    this.menu.style.transformOrigin = `${x}px ${y}px`;
    this.updateOverflow();
    this.menu.style.visibility = "visible";
  };

  private readonly updateOverflow = (): void => {
    const hint = this.menu.querySelector<HTMLElement>(":scope > .popup-menu-more");
    if (!hint) return;
    hint.hidden = this.menu.scrollHeight - this.menu.clientHeight - Math.max(0, this.menu.scrollTop) <= 1;
  };

  /** Prefer the nearest container that fits both controls, then the viewport. */
  private adjacent(anchor: DOMRect, viewport: Bounds, rtl: boolean): Position | undefined {
    this.menu.style.maxHeight = `${viewport.bottom - viewport.top}px`;
    // Layout dimensions ignore the confirmation's entrance transform.
    const width = this.menu.offsetWidth;
    const height = this.menu.offsetHeight;
    const bounds: Bounds[] = [...this.ancestors()].map((parent) => parent.getBoundingClientRect());
    bounds.push(viewport);
    for (const bound of bounds) {
      const left = Math.max(viewport.left, bound.left);
      const right = Math.min(viewport.right, bound.right);
      const top = Math.max(viewport.top, bound.top);
      const bottom = Math.min(viewport.bottom, bound.bottom);
      if (right - left < width || bottom - top < height) continue;
      const centeredTop = clamp(anchor.top + (anchor.height - height) / 2, top, bottom - height);
      const alignedLeft = clamp(rtl ? anchor.right - width : anchor.left, left, right - width);
      const before = { left: anchor.left - gap - width, top: centeredTop };
      const after = { left: anchor.right + gap, top: centeredTop };
      const candidates = [
        ...(rtl ? [before, after] : [after, before]),
        { left: alignedLeft, top: anchor.bottom + gap },
        { left: alignedLeft, top: anchor.top - gap - height },
      ];
      const position = candidates.find((candidate) => candidate.left >= left && candidate.left + width <= right
        && candidate.top >= top && candidate.top + height <= bottom);
      if (position) return position;
    }
  }

  /** Menus prefer below/above; confirmations also use this when space requires scrolling. */
  private vertical(anchor: DOMRect, viewport: Bounds, rtl: boolean): Position {
    const above = Math.max(0, anchor.top - viewport.top - gap);
    const below = Math.max(0, viewport.bottom - anchor.bottom - gap);
    const preferredAbove = this.menu.classList.contains("opens-above");
    const needed = Math.min(420, this.menu.scrollHeight + 2);
    const opensAbove = preferredAbove ? above >= needed || above > below : below < needed && above > below;
    this.menu.style.maxHeight = `${Math.min(420, opensAbove ? above : below)}px`;
    const width = this.menu.offsetWidth;
    const height = this.menu.offsetHeight;
    return {
      left: clamp(rtl ? anchor.right - width : anchor.left, viewport.left, viewport.right - width),
      top: clamp(opensAbove ? anchor.top - gap - height : anchor.bottom + gap, viewport.top, viewport.bottom - height),
    };
  }
}
