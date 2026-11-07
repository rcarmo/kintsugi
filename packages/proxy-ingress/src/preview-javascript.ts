import { parse } from "es-module-lexer/minimal/js";
import { mapPreviewScriptUrl, type PreviewUrlContext } from "./preview-url.ts";

export function rewritePreviewJavaScript(text: string, context: PreviewUrlContext): string {
  const [imports] = parse(text);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const moduleContext = JSON.stringify({ publicOrigin: context.publicOrigin, root: context.root, app: context.app, upstream: context.upstream, windowGlobals: context.windowGlobals, aliases: context.aliases }).replaceAll("<", "\\u003c");
  for (const entry of imports) {
    // The minimal parser's documented d sentinel distinguishes import.meta
    // from dynamic calls without depending on the full build's classification.
    if (entry.d === -2) continue;
    const dynamic = entry.d >= 0;
    if (dynamic && entry.n === undefined) {
      // The runtime binding returns a lazy specifier, retaining native options,
      // coercion/error timing and import-map resolution. Insertions also compose
      // when one import expression occurs inside another.
      edits.push({ start: entry.s, end: entry.s, value: "__kintsugiPreviewImportSpecifier(" }, { start: entry.e, end: entry.e, value: `,${moduleContext})` });
      continue;
    }
    if (!entry.n) continue;
    if (!/^(?:\.{1,2}\/|\/|https?:\/\/|file:\/\/)/.test(entry.n)) continue;
    const mapped = mapPreviewScriptUrl(entry.n, context);
    const literal = JSON.stringify(mapped);
    if (mapped !== entry.n) edits.push({ start: entry.s, end: entry.e, value: dynamic ? literal : literal.slice(1, -1).replaceAll("'", "\\'") });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}
