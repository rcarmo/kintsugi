// @ts-expect-error Turbo ships no TypeScript declarations.
import { StreamActions } from "@hotwired/turbo";
import type { CableStreamRenderer } from "./cable.ts";

type Stream = HTMLElement & { targetElements: HTMLElement[]; templateElement: HTMLTemplateElement };
let delivery = Promise.resolve();

/** One application queue, not just a receipt-time lease check. Parent mounts and
 * their children are applied in wire order, with no deferred Turbo repaint race. */
export const renderCableStreams: CableStreamRenderer = (html, isCurrent, onApplied, onFailed) => {
  delivery = delivery.then(async () => {
    if (!isCurrent()) return;
    const template = document.createElement("template");
    template.innerHTML = html;
    const fragment = document.importNode(template.content, true);
    customElements.upgrade(fragment);
    for (const stream of fragment.querySelectorAll<Stream>("turbo-stream")) {
      if (!isCurrent()) return;
      // Ordered Cable delivery bypasses Turbo's deferred stream renderer. Give
      // mounted controllers a chance to retain presentation state before disposal.
      if (!document.dispatchEvent(new CustomEvent("live:before-stream-render", { cancelable: true, detail: { newStream: stream } }))) continue;
      // Permanent islands survive only while their key remains in the parent's
      // snapshot. Turbo itself preserves them even when absent, so dispose those
      // absent keys explicitly before morphing the owning region. Nested islands
      // belong to their enclosing island's region, not this one. The region itself
      // may be permanent; its own islands are still this region's to dispose.
      if (stream.getAttribute("method") === "morph") {
        // Read the template itself: Turbo's templateContent getter clones it on every access.
        const incoming = new Map([...stream.templateElement.content.querySelectorAll("[id]")].map(element => [element.id, element]));
        for (const target of stream.targetElements) {
          for (const island of target.querySelectorAll<HTMLElement>("[id][data-turbo-permanent]")) {
            const enclosing = island.parentElement!.closest("[id][data-turbo-permanent]");
            if (enclosing && enclosing !== target && target.contains(enclosing)) continue;
            if (!incoming.has(island.id) && island.dispatchEvent(new CustomEvent("live:before-island-remove", { bubbles: true, cancelable: true, detail: { incoming } }))) island.remove();
          }
        }
      }
      const action = StreamActions[stream.getAttribute("action")!];
      if (!action) throw new Error(`Unknown live action: ${stream.getAttribute("action")}`);
      await action.call(stream);
    }
    if (!isCurrent()) return;
    document.querySelectorAll("[data-controller~='workspace-presentation']").forEach(element => element.dispatchEvent(new Event("live:structure")));
    document.dispatchEvent(new Event("kintsugi:workspace-pane-changed"));
    onApplied();
  }).catch(error => {
    // A late error from an obsolete view must not disturb a newer connection.
    if (isCurrent()) onFailed(error instanceof Error ? error : new Error(String(error)));
  });
};
