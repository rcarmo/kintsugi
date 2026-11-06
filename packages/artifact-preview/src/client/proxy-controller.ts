import { workspaceProxyUrl, type WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@kintsugi/shared";
import { workspaceImageUrl } from "@kintsugi/shared/file-metadata";

export function createArtifactPreviewProxyController(Controller: StimulusControllerConstructor) {
  return class ArtifactPreviewProxyController extends Controller {
    static values = { workspaceId: String, appKey: String, path: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly appKeyValue: string;
    declare readonly pathValue: string;

    connect(): void {
      this.element.addEventListener("turbo:before-morph-attribute", this.preserveUrl);
      this.updateUrl();
    }

    disconnect(): void {
      this.element.removeEventListener("turbo:before-morph-attribute", this.preserveUrl);
    }

    workspaceIdValueChanged(): void { this.updateUrl(); }
    appKeyValueChanged(): void { this.updateUrl(); }
    pathValueChanged(): void { this.updateUrl(); }

    private readonly preserveUrl = (event: Event): void => {
      // SAFETY: Turbo's before-morph-attribute event carries the mutated attribute name.
      const { attributeName } = (event as CustomEvent<{ attributeName: string }>).detail;
      if (event.target === this.element && attributeName === (this.element instanceof HTMLAnchorElement ? "href" : "src")) event.preventDefault();
    };

    private updateUrl(): void {
      const url = this.element instanceof HTMLImageElement && this.appKeyValue === "file"
        ? workspaceImageUrl(this.workspaceIdValue, this.pathValue)
        : workspaceProxyUrl(this.workspaceIdValue, this.appKeyValue, this.pathValue || "/");
      const attribute = this.element instanceof HTMLAnchorElement ? "href" : "src";
      // These URLs belong to the browser; server-owned values still morph and
      // update them when the embed's destination changes.
      if (this.element.getAttribute(attribute) !== url) this.element.setAttribute(attribute, url);
    }
  };
}
