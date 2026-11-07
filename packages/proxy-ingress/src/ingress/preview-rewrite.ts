import { init, parse } from "es-module-lexer";
import { Value } from "typebox/value";
import { decodeHTMLAttribute } from "entities";
import { escapeHtml } from "@kintsugi/shared";
import { mapPreviewUrl, mapPreviewSrcset, previewContentPolicy, rewritePreviewCss, previewUrlContextSchema, type PreviewUrlContext } from "../preview-url.ts";

export { previewContentPolicy, rewritePreviewCss } from "../preview-url.ts";

export const previewSandbox = "sandbox allow-scripts allow-forms allow-popups allow-downloads";

export async function rewritePreviewJavaScript(text: string, context: PreviewUrlContext): Promise<string> {
  await init;
  const [imports] = parse(text);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  for (const entry of imports) {
    if (entry.type === "import-meta" || !entry.specifier || (entry.type === "dynamic" && entry.glob)) continue;
    if (!/^(?:\.{1,2}\/|\/|https?:\/\/|file:\/\/)/.test(entry.specifier)) continue;
    const mapped = mapPreviewUrl(entry.specifier, context);
    const literal = JSON.stringify(mapped);
    if (mapped !== entry.specifier) edits.push({ start: entry.start, end: entry.end, value: entry.type === "dynamic" ? literal : literal.slice(1, -1).replaceAll("'", "\\'") });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}

export async function readNestedPreviewContext(text: string): Promise<PreviewUrlContext> {
  let context: PreviewUrlContext | undefined;
  await new HTMLRewriter().on('meta[name="kintsugi-preview-context"]', { element(element) {
    if (!context) context = Value.Parse(previewUrlContextSchema, JSON.parse(decodeHTMLAttribute(element.getAttribute("content")!)));
  } }).transform(new Response(text)).text();
  if (!context) throw new Error("Nested preview did not provide its routing context");
  return context;
}

export async function rewritePreviewHtml(text: string, context: PreviewUrlContext, nonce: string, persist: boolean, nested = false): Promise<string> {
  if (!/<head(?:\s|>)/i.test(text)) text = `<!doctype html><html><head></head><body>${text}</body></html>`;
  const configuration = escapeHtml(JSON.stringify(context));
  const persistence = persist ? '<meta name="kintsugi-preview-persistence">' : "";
  const bootstrap = `<meta name="kintsugi-preview-context" content="${configuration}">${persistence}<script nonce="${nonce}" src="/~preview-assets/runtime.js"></script>`;
  let scriptType = "";
  let scriptBuffer = "";
  let styleBuffer = "";
  return new HTMLRewriter().on("head", { element(element) { if (!nested) element.prepend(bootstrap, { html: true }); } })
    .on('meta[name="kintsugi-preview-context"]', { element(element) {
      if (!nested) return;
      const inner = Value.Parse(previewUrlContextSchema, JSON.parse(decodeHTMLAttribute(element.getAttribute("content")!)));
      const root = new URL(mapPreviewUrl(`${inner.publicOrigin}${inner.root}`, context));
      if (root.origin !== context.publicOrigin || !root.pathname.startsWith(context.root)) throw new Error("Nested preview context escaped its containing workspace");
      element.setAttribute("content", escapeHtml(JSON.stringify({ ...inner, publicOrigin: context.publicOrigin, root: root.pathname, aliases: [...(inner.aliases ?? []), { origin: inner.publicOrigin, root: inner.root }] })));
    } })
    .on("meta[http-equiv]", { element(element) {
      if (element.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy") element.setAttribute("content", escapeHtml(previewContentPolicy(decodeHTMLAttribute(element.getAttribute("content") ?? ""), context, nonce)));
    } })
    .on('meta#vscode-workbench-web-base-url', { element(element) {
      const value = element.getAttribute("data-settings"); if (value) element.setAttribute("data-settings", escapeHtml(mapPreviewUrl(decodeHTMLAttribute(value), context)));
    } })
    .on("*", { element(element) {
      for (const name of ["src", "href", "action", "formaction", "poster", "data"]) {
        const value = element.getAttribute(name);
        if (value !== null) element.setAttribute(name, escapeHtml(mapPreviewUrl(decodeHTMLAttribute(value), context)));
      }
      const srcset = element.getAttribute("srcset");
      if (srcset) element.setAttribute("srcset", escapeHtml(mapPreviewSrcset(decodeHTMLAttribute(srcset), context)));
      const style = element.getAttribute("style");
      if (style) element.setAttribute("style", escapeHtml(rewritePreviewCss(decodeHTMLAttribute(style), context)));
    } })
    .on("script", { element(element) {
      const type = decodeHTMLAttribute(element.getAttribute("type") ?? "text/javascript");
      scriptType = type.toLowerCase(); scriptBuffer = "";
      if (persist && !nested && ["", "module", "text/javascript", "application/javascript"].includes(type.toLowerCase())) {
        element.setAttribute("data-kintsugi-script-type", escapeHtml(type || "text/javascript"));
        element.setAttribute("type", "application/kintsugi-pending-script");
      }
    }, async text(chunk) {
      if (scriptType !== "module") return;
      scriptBuffer += chunk.text;
      if (chunk.lastInTextNode) chunk.replace(await rewritePreviewJavaScript(scriptBuffer, context), { html: true });
      else chunk.remove();
    } })
    .on("style", { element() { styleBuffer = ""; }, text(chunk) {
      styleBuffer += chunk.text;
      if (chunk.lastInTextNode) chunk.replace(rewritePreviewCss(styleBuffer, context), { html: true });
      else chunk.remove();
    } }).transform(new Response(text)).text();
}
