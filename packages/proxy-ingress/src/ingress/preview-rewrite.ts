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
import { rewritePreviewScriptDataUrl } from "../preview-script-data.ts";

interface PreviewHtmlRewriteState { policy: PreviewInlinePolicy; depth: number; recordContext?: (context: PreviewUrlContext) => void }

export async function readNestedPreviewContext(text: string): Promise<PreviewUrlContext> {
  let context: PreviewUrlContext | undefined;
  await new HTMLRewriter().on('meta[name="kintsugi-preview-context"]', { element(element) {
    if (!context) context = Value.Parse(previewUrlContextSchema, JSON.parse(decodeHTMLAttribute(element.getAttribute("content")!)));
  } }).transform(new Response(text)).text();
  if (!context) throw new Error("Nested preview did not provide its routing context");
  return context;
}

export async function rewritePreviewHtml(text: string, context: PreviewUrlContext, nonce: string, persist: boolean, nested = false, state: PreviewHtmlRewriteState = { policy: new PreviewInlinePolicy(), depth: 0 }): Promise<{ html: string; policy: PreviewInlinePolicy }> {
  if (state.depth > 32) throw new Error("Preview srcdoc nesting limit exceeded");
  const policy = state.policy;
  const inheritedPolicies = context.policy ? [context.policy] : [];
  let documentContext = context;
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
      const composed = { ...inner, publicOrigin: context.publicOrigin, root: root.pathname, source: context.source, aliases: [...(inner.aliases ?? []), { origin: inner.publicOrigin, root: inner.root }] };
      documentContext = composed;
      state.recordContext?.(composed);
      element.setAttribute("content", escapeHtml(JSON.stringify(composed)));
    } })
    .on("meta[http-equiv]", { element(element) {
      if (element.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy") {
        const original = decodeHTMLAttribute(element.getAttribute("content") ?? "");
        inheritedPolicies.push(original);
        element.setAttribute("content", escapeHtml(previewContentPolicy(original, context, nonce)));
      }
    } })
    .on('meta#vscode-workbench-web-base-url', { element(element) {
      const value = element.getAttribute("data-settings"); if (value) element.setAttribute("data-settings", escapeHtml(mapPreviewUrl(decodeHTMLAttribute(value), context)));
    } })
    .on("*", { async element(element) {
      for (const name of ["src", "href", "action", "formaction", "poster", "data"]) {
        const value = element.getAttribute(name);
        if (value !== null) {
          const original = decodeHTMLAttribute(value);
          const source = element.tagName === "script" && name === "src" ? rewritePreviewScriptDataUrl(original, source => rewritePreviewJavaScript(!nested && context.windowGlobals && context.app !== "vscode" ? rewritePreviewGlobals(source) : source, context)) : original;
          element.setAttribute(name, escapeHtml(element.tagName === "script" && name === "src" ? mapPreviewScriptUrl(source, context) : mapPreviewUrl(source, context)));
        }
      }
      if (!nested && context.windowGlobals && context.app !== "vscode") for (const [name, value] of element.attributes) {
        if (name.toLowerCase().startsWith("on")) {
          const original = decodeHTMLAttribute(value); const rewritten = await rewritePreviewGlobals(original, true);
          policy.record("script", original, rewritten); element.setAttribute(name, escapeHtml(rewritten));
        }
      }
      if (element.tagName === "iframe") {
        const source = element.getAttribute("srcdoc");
        if (source) {
          const child = await rewritePreviewHtml(decodeHTMLAttribute(source), { ...context, policy: inheritedPolicies.join(", ") }, nonce, false, nested, { policy, depth: state.depth + 1, recordContext: state.recordContext });
          element.setAttribute("srcdoc", escapeHtml(child.html));
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
        const rewritten = rewritePreviewJavaScript(source, context);
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
  state.recordContext?.({ ...documentContext, policy: [documentContext.policy ?? "", ...inheritedPolicies].join(", ") });
  return { html: translated, policy };
}
