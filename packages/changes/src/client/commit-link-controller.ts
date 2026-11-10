import type { WorkspaceClientControllerConstructor } from "@kintsugi/shared";

interface CommitLinkLabel { found: boolean; html: string }
/** Share lookups and cache found labels; a missing commit may become available later. */
const labels = new Map<string, Promise<CommitLinkLabel>>();

function label(url: string): Promise<CommitLinkLabel> {
  let loaded = labels.get(url);
  if (!loaded) {
    loaded = fetch(url, { headers: { Accept: "text/html" } }).then(async result => {
      if (!result.ok && result.status !== 404) throw new Error(`Couldn’t load commit label: ${result.status}`);
      const html = await result.text();
      if (!result.ok) labels.delete(url);
      return { found: result.ok, html: result.ok ? html : "" };
    });
    labels.set(url, loaded);
    loaded.catch(() => labels.delete(url));
  }
  return loaded;
}

/** Fills a Markdown commit link with its server-rendered subject or range size. */
export function createCommitLinkController(Controller: WorkspaceClientControllerConstructor) {
  return class CommitLinkController extends Controller {
    declare readonly element: HTMLAnchorElement;
    static targets = ["label"];
    static values = { url: String };
    declare readonly labelTarget: HTMLElement;
    declare readonly urlValue: string;
    private shown?: string;

    async urlValueChanged(): Promise<void> {
      const url = this.urlValue;
      const { found, html } = await label(url);
      if (url !== this.urlValue || !this.element.isConnected) return;
      this.labelTarget.innerHTML = html;
      if (!found) {
        this.element.removeAttribute("href");
        this.element.dataset.missing = "true";
        this.element.title = "Commit details unavailable in this workspace’s repository.";
      }
      this.shown = found ? url : undefined;
    }

    // A loaded link is browser-owned; morphing the same link would blank its label.
    preserve(event: CustomEvent<{ newElement: Element }>): void {
      const incoming = event.detail.newElement;
      if (this.shown !== undefined && event.target === this.element && incoming instanceof HTMLElement && incoming.dataset.commitLinkUrlValue === this.shown) event.preventDefault();
    }
  };
}
