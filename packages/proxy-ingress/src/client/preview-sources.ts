import { Value } from "typebox/value";
import { Type } from "typebox";
import { previewBlobIdentity, previewSourceHost, previewSourceUrl } from "../preview-source.ts";
import { previewBlobAllowed } from "../preview-policy.ts";
import type { PreviewUrlContext } from "../preview-url.ts";

const blobs = new Map<string, Blob>();
const generated = new Map<string, { id: string; url: string; context: string }>();
let sourcePort: Promise<MessagePort> | undefined;
const retainedPolicies = new Set<string>();
export function retainPreviewSourcePolicy(policy: string): void { retainedPolicies.add(policy); }

/** Browser-native fetching, script ordering and module namespaces own execution. */
export function previewBlobScriptUrl(url: string, context: PreviewUrlContext, nonce = ""): string {
  const original = previewBlobIdentity(url);
  const blob = original && blobs.get(original.url);
  if (!blob || !original || !context.source) return url;
  const policies = [context.policy ?? "", ...retainedPolicies, ...[...document.querySelectorAll<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')].map(meta => meta.content)];
  // Do not turn a CSP-blocked blob into an allowed HTTPS source.
  if (!previewBlobAllowed(policies, nonce === context.nonce ? "" : nonce)) return url;
  let source = generated.get(original.url);
  if (!source) {
    const id = crypto.randomUUID(); source = { id, context: context.source, url: previewSourceUrl(context.publicOrigin, context.source, id) };
    generated.set(original.url, source);
    const message = { type: "put", context: context.source, id, original: original.url, blob };
    void sourcePort!.then(port => port.postMessage(message));
  }
  return `${source.url}${nonce ? `?nonce=${encodeURIComponent(nonce)}` : ""}${original.hash}`;
}

export function installPreviewSources(context: PreviewUrlContext): void {
  if (!context.source) return;
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = value => {
    const url = create(value);
    if (value instanceof Blob) {
      blobs.set(url, value);
      if (/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(value.type)) previewBlobScriptUrl(url, context);
    }
    return url;
  };
  URL.revokeObjectURL = input => {
    // WebIDL ToString runs once, including its native rejection of symbols.
    const url = `${input}`;
    revoke(url);
    const original = previewBlobIdentity(url);
    // Native revocation looks up the complete URL, unlike Blob fetching.
    if (!original || original.hash) return;
    blobs.delete(original.url);
    const source = generated.get(original.url);
    if (source) { generated.delete(original.url); void sourcePort!.then(port => port.postMessage({ type: "revoke", context: source.context, id: source.id })); }
  };
  const nonce = crypto.randomUUID(), frame = document.createElement("iframe");
  frame.hidden = true; frame.setAttribute("aria-hidden", "true"); frame.src = new URL(`${previewSourceHost}#${nonce}`, context.publicOrigin).href;
  const sourceOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "source")!.get!;
  const dataOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")!.get!;
  sourcePort = new Promise<MessagePort>((resolve, reject) => {
    const timer = setTimeout(() => { window.removeEventListener("message", ready, true); reject(new Error("Generated source host did not connect")); }, 10000);
    function ready(event: MessageEvent) {
      const data = dataOf.call(event);
      if (!event.isTrusted || sourceOf.call(event) !== frame.contentWindow || event.origin !== "null" || data?.type !== "kintsugi:source-host-ready" || data.nonce !== nonce) return;
      event.stopImmediatePropagation(); window.removeEventListener("message", ready, true); clearTimeout(timer);
      const channel = new MessageChannel();
      channel.port1.onmessage = event => {
        if (event.data?.type === "error" && Value.Check(Type.String(), event.data.message)) console.error(new Error(event.data.message));
      };
      frame.contentWindow!.postMessage({ type: "kintsugi:source-host-connect", nonce }, "*", [channel.port2]);
      resolve(channel.port1);
    }
    window.addEventListener("message", ready, true);
    document.documentElement.append(frame);
  });
}
