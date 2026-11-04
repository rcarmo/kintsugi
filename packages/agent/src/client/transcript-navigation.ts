import { frameScrollEvent, layoutAfterEvent, layoutBeforeEvent, type FrameScrollDetail } from "@kintsugi/shared";

interface TranscriptGeometry {
  viewport: number;
  contentStart: number;
  contentEnd: number;
  bottomPadding: number;
  threshold: number;
  followThreshold: number;
  latestTop: number;
}

/** Transcript content dispatches this, bubbling, when the reader expands it in place. */
export const transcriptExpandEvent = "agent-transcript:expand";

/** Show the end of the answer, scrolling back only as far as its prompt requires.
 * A prompt taller than the viewport opens at its beginning instead. */
export function latestExchangeTop(transcript: HTMLElement, content: HTMLElement, bottomTop: number): number {
  const prompts = content.querySelectorAll<HTMLElement>(".agent-user");
  const latest = prompts.item(prompts.length - 1)?.closest<HTMLElement>(".agent-item");
  const promptTop = latest ? transcript.scrollTop + latest.getBoundingClientRect().top - transcript.getBoundingClientRect().top : bottomTop;
  return Math.max(0, Math.min(bottomTop, promptTop));
}

/** Owns transcript navigation. Geometry is an output of follow intent, never
 * evidence that the user has opted out. In particular, keyboard/viewport resize,
 * scroll anchoring, Turbo updates and programmatic scrolls cannot pause follow. */
export class TranscriptNavigation {
  private following = true;
  private visible = false;
  private frame = 0;
  private pendingPosition: "prompt" | "instant" | "smooth" | undefined;
  private floor = 0;
  private width = 0;
  private height = 0;
  private readingAnchor?: { element: HTMLElement; offset: number; height: number };
  private streaming = false;
  private motionFrame = 0;
  private motionTarget = 0;
  private motionTime = 0;
  private motionForward = true;
  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private selectionAwaitingSnapshot = false;
  private touch?: { x: number; y: number };
  // Where the reader last was: the scroll position and, while paused, the
  // distance from there to the end. Reaching the end resumes following only
  // when the reader went there: scrolled down and got nearer the end. Content
  // shrinking below brings the end nearer without scrolling down; scroll
  // anchoring for content growing above scrolls down without nearing the end.
  private lastScrollTop = 0;
  private lastDistanceToEnd = Infinity;
  // Showing or selecting the pane leaves the position to the next frame's
  // reconcile, so connecting controllers don't force a layout to measure it.
  private positionStale = false;
  private reconciled = false;
  private readonly resizeObserver: ResizeObserver;
  private readonly composerOpener: HTMLElement | null;
  private layoutBottom?: number;

  constructor(private readonly transcript: HTMLElement, private readonly content: HTMLElement, private readonly latestButton: HTMLElement) {
    this.composerOpener = transcript.closest(".agent-composer-pane")!.querySelector<HTMLElement>(".agent-composer-opener > button");
    this.resizeObserver = new ResizeObserver(this.layoutChanged);
    this.resizeObserver.observe(transcript);
    this.resizeObserver.observe(content);
    if (this.composerOpener) this.resizeObserver.observe(this.composerOpener);
    transcript.addEventListener("scroll", this.scrolled);
    transcript.addEventListener("wheel", this.wheel, { capture: true, passive: true });
    transcript.addEventListener(frameScrollEvent, this.frameScrolled);
    transcript.addEventListener("touchstart", this.touchStarted, { passive: true });
    transcript.addEventListener("touchmove", this.touchMoved, { passive: true });
    transcript.addEventListener("touchend", this.touchEnded, { passive: true });
    transcript.addEventListener("touchcancel", this.touchEnded, { passive: true });
    transcript.addEventListener("keydown", this.keydown);
    transcript.addEventListener("pointerdown", this.pointerDown);
    transcript.addEventListener("click", this.clicked);
    transcript.addEventListener(transcriptExpandEvent, this.expanded);
    transcript.addEventListener("scrollbar:drag-start", this.scrollbarDrag);
    window.visualViewport?.addEventListener("resize", this.layoutChanged);
    document.addEventListener(layoutBeforeEvent, this.layoutBefore);
    document.addEventListener(layoutAfterEvent, this.layoutAfter);
    this.renderMode();
  }

  // Composer and keyboard changes push the transcript up in the same frame:
  // the content at its bottom edge stays put, so the scroll offset changes once.
  // Before the first reconcile nothing is on screen to keep: that reconcile,
  // already scheduled, places the transcript without forcing a layout here.
  // Later shows measure, since the reader's position is on screen.
  private readonly layoutBefore = (): void => {
    this.layoutBottom = this.visible && this.reconciled && this.transcript.checkVisibility() ? this.transcript.scrollTop + this.transcript.clientHeight : undefined;
  };

  private readonly layoutAfter = (): void => {
    const bottom = this.layoutBottom;
    this.layoutBottom = undefined;
    if (bottom === undefined || this.transcript.clientHeight === this.height) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.stopMotion();
    if (!this.following) this.scrollTo(bottom - this.transcript.clientHeight);
    else this.pendingPosition = "instant";
    this.reconcile();
  };

  setVisible(visible: boolean): void {
    this.visible = visible;
    // Hidden panes get no scroll events, so the last position may be stale.
    if (visible) { this.positionStale = true; this.layoutChanged(); }
    else { this.touch = undefined; this.stopMotion(); }
  }

  select(busy: boolean): void {
    this.setStreaming(busy);
    this.stopMotion();
    this.floor = 0;
    this.readingAnchor = undefined;
    this.positionStale = true;
    this.transcript.style.removeProperty("--agent-follow-floor");
    this.pendingPosition = busy ? "instant" : "prompt";
    this.selectionAwaitingSnapshot = true;
    this.following = busy;
    this.touch = undefined;
    this.renderMode();
    this.layoutChanged();
  }

  snapshotReady(busy: boolean): void {
    if (this.selectionAwaitingSnapshot) this.select(busy);
    else this.setStreaming(busy);
    this.selectionAwaitingSnapshot = false;
    this.layoutChanged();
  }

  setStreaming(streaming: boolean): void {
    if (this.streaming === streaming) return;
    this.streaming = streaming;
    this.layoutChanged();
  }

  followLatest(): void {
    this.selectionAwaitingSnapshot = false;
    this.touch = undefined;
    this.following = true;
    this.pendingPosition = "smooth";
    this.renderMode();
    this.layoutChanged();
  }

  reveal(target: HTMLElement): void {
    this.pause();
    target.scrollIntoView({ block: "center" });
    // Revealing a target near the end isn't the reader scrolling there.
    this.rememberPosition();
  }

  private pause(): void {
    this.stopMotion();
    this.pendingPosition = undefined;
    this.selectionAwaitingSnapshot = false;
    this.following = false;
    this.renderMode();
    this.rememberPosition();
    this.layoutChanged();
  }

  private rememberPosition(latestTop = this.visible ? this.geometry().latestTop : Infinity): void {
    this.positionStale = false;
    this.lastScrollTop = this.transcript.scrollTop;
    this.lastDistanceToEnd = latestTop - this.lastScrollTop;
  }

  private renderMode(): void {
    this.latestButton.hidden = this.following;
    this.transcript.dataset.following = String(this.following);
  }

  private geometry(): TranscriptGeometry {
    const viewport = this.transcript.clientHeight;
    const contentBounds = this.content.getBoundingClientRect();
    const contentStart = contentBounds.top - this.transcript.getBoundingClientRect().top + this.transcript.scrollTop;
    const bottomPadding = Number.parseFloat(getComputedStyle(this.transcript).paddingBottom);
    const openerBounds = this.composerOpener?.getBoundingClientRect();
    // In mobile reading mode the opener overlays the transcript. Follow just
    // above it, without changing the transcript's scrollable reading area.
    const openerRoom = openerBounds?.height
      ? Math.max(0, this.transcript.getBoundingClientRect().bottom - openerBounds.top + 8)
      : 0;
    const room = openerRoom || (this.streaming ? Math.min(160, viewport * 0.25) : bottomPadding);
    const contentEnd = contentStart + contentBounds.height;
    const threshold = Math.min(32, room * 0.25);
    return { viewport, contentStart, contentEnd, bottomPadding,
      threshold, followThreshold: openerRoom ? room - 4 : threshold,
      latestTop: Math.max(0, contentEnd - viewport + room) };
  }

  private reserve(geometry: TranscriptGeometry): void {
    // Reserve enough to reach the visible content's follow destination, not
    // the current scrollTop: using scrollTop here lets scrolling into the
    // reserve grow the reserve again, with no effective end to the transcript.
    const { viewport, contentStart, bottomPadding, latestTop } = geometry;
    const floor = Math.ceil(Math.max(0, latestTop + viewport - contentStart - bottomPadding));
    if (floor === this.floor) return;
    this.floor = floor;
    this.transcript.style.setProperty("--agent-follow-floor", `${floor}px`);
  }

  private reconcileMotion(geometry: TranscriptGeometry): void {
    if (!this.motionFrame || this.motionTarget <= geometry.latestTop) return;
    const contentAboveViewport = geometry.contentEnd < this.transcript.scrollTop + geometry.threshold;
    // If the newest content is already visible, stop a forward glide rather than
    // turn a small contraction into backward scrolling. Otherwise shorten/reverse
    // its destination now, not after it has travelled through obsolete reserve.
    const target = this.motionForward && !contentAboveViewport
      ? Math.max(this.transcript.scrollTop, geometry.latestTop)
      : geometry.latestTop;
    if (target === this.transcript.scrollTop) this.stopMotion();
    else this.moveTo(target, false);
  }

  private rememberReadingPosition(): void {
    this.readingAnchor = undefined;
    if (this.following) return;
    const top = this.transcript.getBoundingClientRect().top;
    for (const element of this.content.querySelectorAll<HTMLElement>(".agent-item, p, pre, li, h1, h2, h3, h4, h5, h6")) {
      const bounds = element.getBoundingClientRect();
      if (bounds.height === 0 || bounds.bottom <= top) continue;
      // Prefer the innermost visible block over a potentially very long message.
      if (this.readingAnchor && !this.readingAnchor.element.contains(element)) break;
      this.readingAnchor = { element, offset: bounds.top - top, height: bounds.height };
    }
  }

  readonly layoutChanged = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.reconcile();
    });
  };

  private reconcile(): void {
    if (!this.visible) return;
    const width = this.transcript.clientWidth;
    const geometry = this.geometry();
    if (this.positionStale) this.rememberPosition(geometry.latestTop);
    const widthChanged = this.width !== 0 && width !== this.width;
    const resized = widthChanged || (this.height !== 0 && geometry.viewport !== this.height);
    this.width = width;
    this.height = geometry.viewport;
    this.reconciled = true;
    if (resized && this.following) {
      // Composer/keyboard changes resize the viewport immediately. Match that
      // layout change with a snap, even if a follow glide is already running.
      this.stopMotion();
      this.pendingPosition = "instant";
    } else if (widthChanged && !this.pendingPosition && this.readingAnchor && this.content.contains(this.readingAnchor.element)) {
      const { element, offset, height } = this.readingAnchor;
      const bounds = element.getBoundingClientRect();
      // Scale an offset inside a reflowed block; preserve gaps above it.
      const nextOffset = offset < 0 ? offset * bounds.height / height : offset;
      this.moveTo(this.transcript.scrollTop + bounds.top - this.transcript.getBoundingClientRect().top - nextOffset, true);
    }
    this.reconcileMotion(geometry);
    this.reserve(geometry);

    if (this.pendingPosition === "prompt") {
      this.pendingPosition = undefined;
      this.scrollTo(latestExchangeTop(this.transcript, this.content, geometry.latestTop));
    } else if (!this.following && geometry.contentEnd < this.transcript.scrollTop + geometry.threshold) {
      // A wider pane (for example fullscreen) can reflow the entire transcript
      // above a paused viewport. Do not protect an empty viewport with reserve.
      this.scrollTo(geometry.latestTop);
    } else if (this.following) {
      // Follow visible content, not scrollHeight (which includes our reserve).
      // Keep the opener's 8px clearance as new content arrives; elsewhere
      // retain the larger streaming hysteresis before another scroll.
      const plannedTop = this.motionFrame ? Math.max(this.transcript.scrollTop, this.motionTarget) : this.transcript.scrollTop;
      const contentAboveViewport = geometry.contentEnd < this.transcript.scrollTop + geometry.threshold;
      if (this.pendingPosition || contentAboveViewport || geometry.contentEnd > plannedTop + geometry.viewport - geometry.followThreshold) {
        this.moveTo(geometry.latestTop, this.pendingPosition === "instant");
        this.pendingPosition = undefined;
      }
    }
    this.reserve(geometry);
    this.rememberReadingPosition();
  }

  private moveTo(top: number, instant: boolean): void {
    if (instant || this.reducedMotion.matches) {
      this.stopMotion();
      this.scrollTo(top);
      return;
    }
    this.motionForward = top >= this.transcript.scrollTop;
    this.motionTarget = top;
    // Retarget an existing glide without restarting it on each incoming delta.
    if (!this.motionFrame) this.motionFrame = requestAnimationFrame(this.glide);
  }

  private readonly glide = (time: number): void => {
    // ResizeObserver reconciliation can be queued behind this animation frame.
    // Re-read geometry before moving so even that frame cannot use a stale goal.
    const geometry = this.geometry();
    this.reconcileMotion(geometry);
    this.reserve(geometry);
    if (!this.motionFrame) return;
    const elapsed = this.motionTime ? Math.min(time - this.motionTime, 64) : 16;
    this.motionTime = time;
    const target = Math.min(this.motionTarget, this.transcript.scrollHeight - this.transcript.clientHeight);
    const distance = target - this.transcript.scrollTop;
    if (this.motionForward && distance < 0) {
      this.stopMotion();
    } else if (this.reducedMotion.matches || Math.abs(distance) <= 2) {
      this.scrollTo(target);
      this.stopMotion();
    } else {
      this.scrollTo(this.transcript.scrollTop + distance * (1 - Math.exp(-elapsed / 85)));
      this.motionFrame = requestAnimationFrame(this.glide);
    }
    this.reserve(geometry);
  };

  private stopMotion(): void {
    cancelAnimationFrame(this.motionFrame);
    this.motionFrame = 0;
    this.motionTime = 0;
  }

  private scrollTo(top: number): void {
    this.transcript.scrollTop = top;
    this.lastScrollTop = this.transcript.scrollTop;
  }

  private readonly scrolled = (): void => {
    const top = this.transcript.scrollTop;
    const distanceToEnd = this.following ? Infinity : this.geometry().latestTop - top;
    // Without a position from before, this scroll is where the reader starts.
    const towardEnd = !this.positionStale && top > this.lastScrollTop && distanceToEnd < this.lastDistanceToEnd;
    this.positionStale = false;
    this.lastScrollTop = top;
    this.lastDistanceToEnd = distanceToEnd;
    // Reaching the end by going there resumes following; scroll-to-bottom shows only away from it.
    // A scroll event from showing the pane must not override its pending selection position.
    if (towardEnd && !this.following && !this.pendingPosition && !this.motionFrame && distanceToEnd <= 2) {
      this.following = true;
      this.renderMode();
    }
    // Geometry does not toggle intent, and being above the padded end is normal.
    // Paused/idle scrolling must also reclaim reserve behind the viewport.
    if (!this.motionFrame) this.layoutChanged();
  };

  // Conservatively treat upward input anywhere in the transcript as reading,
  // including nested output. Do not try to predict native scroll chaining.
  private readonly wheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.deltaY === 0) return;
    if (event.deltaY < 0) this.pause();
  };

  private readonly frameScrolled = (event: Event): void => {
    // SAFETY: frameScrollEvent always carries a FrameScrollDetail.
    if ((event as CustomEvent<FrameScrollDetail>).detail.deltaY < 0) this.pause();
  };

  private readonly touchStarted = (event: TouchEvent): void => {
    this.touch = event.touches.length === 1 ? { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY } : undefined;
  };

  private readonly touchMoved = (event: TouchEvent): void => {
    if (!this.touch || event.touches.length !== 1) { this.touch = undefined; return; }
    const point = event.touches[0]!;
    const delta = this.touch.y - point.clientY;
    if (Math.abs(delta) < 4 || Math.abs(delta) < Math.abs(this.touch.x - point.clientX)) return;
    this.touch = { x: point.clientX, y: point.clientY };
    if (delta < 0) this.pause();
  };

  private readonly touchEnded = (): void => { this.touch = undefined; };

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      if (target.isContentEditable || target.closest("input, textarea, select")) return;
      // Space activates these controls; Page Up/Home/arrows still scroll.
      if (event.key === " " && target.closest("button, summary")) return;
    }
    const up = ["ArrowUp", "PageUp", "Home"].includes(event.key)
      || (event.key === " " && event.shiftKey);
    if (up) this.pause();
  };

  private readonly scrollbarDrag = (): void => this.pause();

  // Expanding content in place, like truncated thinking, is reading it.
  private readonly expanded = (): void => this.pause();

  // Opening a disclosure means reading it: keep it where it is rather than
  // following its newly revealed content to the end. Controls inside a summary
  // and cancelled clicks don't open it.
  private readonly clicked = (event: MouseEvent): void => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const summary = event.target.closest("summary");
    const details = summary?.parentElement;
    if (!(details instanceof HTMLDetailsElement) || details.open || !this.content.contains(details)) return;
    const control = event.target.closest("a, button, input, select, textarea");
    if (control && summary!.contains(control)) return;
    this.pause();
  };

  private readonly pointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if (event.target !== this.transcript && event.target !== this.content && event.target !== this.content.parentElement) return;
    // Bare-background clicks pause follow; shared overlay drags notify us separately.
    // Ordinary message/control clicks remain untouched.
    this.pause();
  };

  disconnect(): void {
    cancelAnimationFrame(this.frame);
    this.stopMotion();
    this.resizeObserver.disconnect();
    this.transcript.style.removeProperty("--agent-follow-floor");
    delete this.transcript.dataset.following;
    this.transcript.removeEventListener("scroll", this.scrolled);
    this.transcript.removeEventListener("wheel", this.wheel, true);
    this.transcript.removeEventListener(frameScrollEvent, this.frameScrolled);
    this.transcript.removeEventListener("touchstart", this.touchStarted);
    this.transcript.removeEventListener("touchmove", this.touchMoved);
    this.transcript.removeEventListener("touchend", this.touchEnded);
    this.transcript.removeEventListener("touchcancel", this.touchEnded);
    this.transcript.removeEventListener("keydown", this.keydown);
    this.transcript.removeEventListener("pointerdown", this.pointerDown);
    this.transcript.removeEventListener("click", this.clicked);
    this.transcript.removeEventListener(transcriptExpandEvent, this.expanded);
    this.transcript.removeEventListener("scrollbar:drag-start", this.scrollbarDrag);
    window.visualViewport?.removeEventListener("resize", this.layoutChanged);
    document.removeEventListener(layoutBeforeEvent, this.layoutBefore);
    document.removeEventListener(layoutAfterEvent, this.layoutAfter);
  }
}
