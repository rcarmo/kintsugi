import { Value } from "typebox/value";
import { decodeHTMLAttribute } from "entities";
import { escapeHtml } from "@kintsugi/shared";
import { mapPreviewUrl, mapPreviewScriptUrl, mapPreviewSrcset, previewContentPolicy, rewritePreviewCss, previewUrlContextSchema, type PreviewUrlContext } from "../preview-url.ts";

export { previewContentPolicy, rewritePreviewCss } from "../preview-url.ts";

export const previewSandbox = "sandbox allow-scripts allow-forms allow-popups allow-downloads";

export { rewritePreviewJavaScript } from "../preview-javascript.ts";
import { rewritePreviewJavaScript } from "../preview-javascript.ts";
import { rewritePreviewGlobals } from "./preview-globals.ts";
import { PreviewInlinePolicy } from "./preview-inline-policy.ts";

export async function readNestedPreviewContext(text: string): Promise<PreviewUrlContext> {
  let context: PreviewUrlContext | undefined;
  await new HTMLRewriter().on('meta[name="kintsugi-preview-context"]', { element(element) {
    if (!context) context = Value.Parse(previewUrlContextSchema, JSON.parse(decodeHTMLAttribute(element.getAttribute("content")!)));
  } }).transform(new Response(text)).text();
  if (!context) throw new Error("Nested preview did not provide its routing context");
  return context;
}

export async function rewritePreviewHtml(text: string, context: PreviewUrlContext, nonce: string, persist: boolean, nested = false): Promise<{ html: string; policy: PreviewInlinePolicy }> {
  const policy = new PreviewInlinePolicy();
  if (!/<head(?:\s|>)/i.test(text)) text = `<!doctype html><html><head></head><body>${text}</body></html>`;
  const configuration = escapeHtml(JSON.stringify(context));
  const persistence = persist ? '<meta name="kintsugi-preview-persistence">' : "";
  const bootstrap = `<meta name="kintsugi-preview-context" content="${configuration}">${persistence}<script nonce="${nonce}" src="/~preview-assets/runtime.js"></script>`;
  let scriptType = "";
  let scriptBuffer = "";
  let styleBuffer = "";
  const html = await new HTMLRewriter().on("head", { element(element) { if (!nested) element.prepend(bootstrap, { html: true }); } })
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
    .on("*", { async element(element) {
      for (const name of ["src", "href", "action", "formaction", "poster", "data"]) {
        const value = element.getAttribute(name);
        if (value !== null) element.setAttribute(name, escapeHtml(element.tagName === "script" && name === "src" ? mapPreviewScriptUrl(decodeHTMLAttribute(value), context) : mapPreviewUrl(decodeHTMLAttribute(value), context)));
      }
      if (!nested && context.windowGlobals && context.app !== "vscode") for (const [name, value] of element.attributes) {
        if (name.toLowerCase().startsWith("on")) {
          const original = decodeHTMLAttribute(value); const rewritten = await rewritePreviewGlobals(original, true);
          policy.record("script", original, rewritten); element.setAttribute(name, escapeHtml(rewritten));
        }
      }
      const srcset = element.getAttribute("srcset");
      if (srcset) element.setAttribute("srcset", escapeHtml(mapPreviewSrcset(decodeHTMLAttribute(srcset), context)));
      const style = element.getAttribute("style");
      if (style) {
        const original = decodeHTMLAttribute(style); const rewritten = rewritePreviewCss(original, context);
        policy.record("style", original, rewritten); element.setAttribute("style", escapeHtml(rewritten));
      }
    } })
    .on("script", { element(element) {
      const type = decodeHTMLAttribute(element.getAttribute("type") ?? "text/javascript");
      scriptType = type.toLowerCase(); scriptBuffer = "";
      if (persist && !nested && ["", "module", "text/javascript", "application/javascript"].includes(type.toLowerCase())) {
        element.setAttribute("data-kintsugi-script-type", escapeHtml(type || "text/javascript"));
        element.setAttribute("type", "application/kintsugi-pending-script");
      }
    }, async text(chunk) {
      if (!["", "module", "text/javascript", "application/javascript"].includes(scriptType)) return;
      scriptBuffer += chunk.text;
      if (chunk.lastInTextNode) {
        const source = !nested && context.windowGlobals && context.app !== "vscode" ? await rewritePreviewGlobals(scriptBuffer) : scriptBuffer;
        const rewritten = scriptType === "module" ? rewritePreviewJavaScript(source, context) : source;
        policy.record("script", scriptBuffer, rewritten); chunk.replace(rewritten, { html: true });
      }
      else chunk.remove();
    } })
    .on("style", { element() { styleBuffer = ""; }, text(chunk) {
      styleBuffer += chunk.text;
      if (chunk.lastInTextNode) {
        const rewritten = rewritePreviewCss(styleBuffer, context); policy.record("style", styleBuffer, rewritten); chunk.replace(rewritten, { html: true });
      }
      else chunk.remove();
    } }).transform(new Response(text)).text();
  const translated = await new HTMLRewriter().on("meta[http-equiv]", { element(element) {
    if (element.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy") element.setAttribute("content", escapeHtml(policy.rewrite(decodeHTMLAttribute(element.getAttribute("content") ?? ""))));
  } }).transform(new Response(html)).text();
  return { html: translated, policy };
}
