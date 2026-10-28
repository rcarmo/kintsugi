/**
 * Decides which capture Changes shows. Selections (picking commits, refreshing, saving an edit, opening a commit link)
 * and refreshes after the workspace changed (an Agent turn, a superseded save) capture concurrently. The last selection
 * wins, and nothing shows a history from before a workspace change for long: that would leave out the change.
 */
export interface ChangeRefresh<Snapshot> {
  capture(previous: Snapshot): Promise<Snapshot>;
  published(snapshot: Snapshot): void;
}

export class ChangesPublication<Snapshot extends object> {
  private request = 0;
  private changes = 0;
  /** The number of workspace changes when the shown history was captured. */
  private historyChange = 0;
  private capturing = 0;
  private refreshing = 0;
  private waiting: (() => void)[] = [];
  constructor(public snapshot: Snapshot, private readonly changeRefresh: ChangeRefresh<Snapshot>) {}

  /** Starts a selection, superseding earlier ones. */
  select(): number { return ++this.request; }
  superseded(ticket: number): boolean { return ticket !== this.request; }

  /**
   * Publishes a selection's capture, or returns undefined when a later selection superseded it. Captures again when the
   * workspace changed meanwhile. `outdated` asks for a freshly captured history instead of reusing the shown one.
   */
  async publishSelection(ticket: number, capture: (outdated: boolean) => Promise<Snapshot>): Promise<Snapshot | undefined> {
    this.capturing++;
    try {
      for (let outdated = this.historyChange !== this.changes; ; outdated = true) {
        const change = this.changes;
        const next = await capture(outdated);
        if (this.superseded(ticket)) return undefined;
        if (change === this.changes) return this.publish(next, change);
      }
    } finally {
      this.capturing--;
      // A change's refresh steps aside for the selections capturing then. If they all failed, or gave way to one that
      // failed, nothing showed the change; refresh for it now.
      this.settle(true);
    }
  }

  /** The shown snapshot once nothing captures anymore: for a selection's caller when a later one superseded it. */
  async settled(): Promise<Snapshot> {
    while (this.capturing || this.refreshing) await new Promise<void>(resolve => this.waiting.push(resolve));
    return this.snapshot;
  }

  /** Refreshes after the workspace changed, unless selections capture the change themselves, or a later change refreshes. */
  changed(): Promise<void> { return this.refresh(++this.changes); }

  private async refresh(change: number): Promise<void> {
    this.refreshing++;
    let steppedAside = false;
    try {
      // Selections capturing now capture this change themselves; don't capture only to throw it away.
      if (this.capturing) { steppedAside = true; return; }
      const selection = this.request, previous = this.snapshot;
      const next = await this.changeRefresh.capture(previous);
      steppedAside = this.request !== selection || this.snapshot !== previous || this.capturing > 0 || change !== this.changes;
      if (!steppedAside) this.changeRefresh.published(this.publish(next, change));
    } finally {
      this.refreshing--;
      // A failed refresh isn't retried; the next change or selection captures again.
      this.settle(steppedAside);
    }
  }

  /**
   * When nothing captures anymore: refresh if the shown history still predates a change whose refresh stepped aside
   * for selections that then failed; otherwise wake whoever waits for what's shown. Nobody awaits that refresh, so its
   * errors are logged.
   */
  private settle(retry: boolean): void {
    if (this.capturing || this.refreshing) return;
    if (retry && this.historyChange !== this.changes) this.refresh(this.changes).catch(error => console.error("Could not refresh Changes", error));
    else for (const resolve of this.waiting.splice(0)) resolve();
  }

  private publish(snapshot: Snapshot, change: number): Snapshot {
    this.snapshot = snapshot;
    this.historyChange = change;
    return snapshot;
  }
}
