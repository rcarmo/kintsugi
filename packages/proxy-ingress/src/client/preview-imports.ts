import { mapPreviewScriptUrl, mapPreviewModuleUrl, type PreviewUrlContext } from "../preview-url.ts";
import { previewBlobScriptUrl } from "./preview-sources.ts";
import { previewBlobIdentity } from "../preview-source.ts";

declare global { var __kintsugiPreviewImportSpecifier: typeof previewImportSpecifier; }

const nativeString = String;

/** Leave coercion to native import(), after its options expression is evaluated. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Module specifiers are arbitrary JavaScript values; native ToString and URL parsing define their contract.
export function previewImportSpecifier(value: unknown, context: PreviewUrlContext, active?: PreviewUrlContext) {
  return { [Symbol.toPrimitive]() {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ToString rejects symbol primitives whereas the explicit String constructor accepts them.
    if (typeof value === "symbol") throw new TypeError("A module specifier cannot be a symbol");
    const text = nativeString(value);
    if (previewBlobIdentity(text)) return previewBlobScriptUrl(text, active ?? context);
    if (active) {
      const resolved = URL.parse(text, active.publicOrigin);
      if (resolved && ["http:", "https:"].includes(resolved.protocol)) {
        if (resolved.origin === active.publicOrigin && resolved.pathname.startsWith(active.root)) return mapPreviewScriptUrl(resolved.href, active);
        if (active.aliases?.some(alias => (resolved.origin === active.publicOrigin || resolved.host === new URL(alias.origin).host) && resolved.pathname.startsWith(alias.root))) return mapPreviewScriptUrl(resolved.href, active);
      }
    }
    return mapPreviewModuleUrl(text, context);
  } };
}
