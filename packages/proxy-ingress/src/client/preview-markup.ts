import type {} from "trusted-types";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { mapPreviewUrl, mapPreviewScriptUrl, mapPreviewSrcset, previewContentPolicy, rewritePreviewCss, type PreviewUrlContext } from "../preview-url.ts";
import { rewritePreviewGlobals } from "../preview-globals.ts";
import { rewritePreviewJavaScript } from "../preview-javascript.ts";
import { previewInlineAllowed, previewPolicyDirectives, previewPolicyName } from "../preview-policy.ts";
import { createPreviewHtmlStream, previewHtmlStartTag } from "../preview-html-stream.ts";
import { rewritePreviewScriptDataUrl } from "../preview-script-data.ts";
import { preparedPreviewDocument } from "./preview-document.ts";

let resumeScript: ((element: HTMLScriptElement, text: string) => void) | undefined;
/** Already-translated parser scripts retain their exact CSP hash during restoration. */
export function setPreviewParserScriptText(element: HTMLScriptElement, text: string): void {
  if (!resumeScript) throw new Error("Preview markup transport is not installed");
  resumeScript(element, text);
}

/** Native inert parsing validates Trusted Types before any derived nodes enter a live document. */
export function installPreviewMarkup(context: PreviewUrlContext, upstream: () => string, nativeAttribute: typeof Element.prototype.setAttribute, nativeText: PropertyDescriptor, nativeScriptSource: PropertyDescriptor): void {
  // SAFETY: WebIDL accepts these branded Trusted Types at attribute sinks; lib.dom still declares only string.
  const attribute = nativeAttribute as (this: Element, name: string, value: string | TrustedScript | TrustedScriptURL) => void;
  const inner = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  const outer = Object.getOwnPropertyDescriptor(Element.prototype, "outerHTML")!;
  const adjacent = Element.prototype.insertAdjacentHTML;
  const replaceChildren = Element.prototype.replaceChildren;
  const replaceFragment = DocumentFragment.prototype.replaceChildren;
  const insertBefore = Node.prototype.insertBefore;
  const removeChild = Node.prototype.removeChild;
  const srcdoc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc")!;
  Object.defineProperty(HTMLIFrameElement.prototype, preparedPreviewDocument, { value: srcdoc.set });
  const nativeScriptText = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "text")!;
  // Chromium has script-specific TrustedScript sinks; other engines inherit Node/HTMLElement.
  const scriptTextContent = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "textContent") ?? nativeText;
  const scriptInnerText = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "innerText") ?? Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText")!;
  const factory = "trustedTypes" in window ? window.trustedTypes : undefined;
  const retainedPolicies = new Set(context.policy ? [context.policy] : []);
  function rememberPolicies(root: ParentNode): void {
    if (root instanceof HTMLMetaElement && root.httpEquiv.toLowerCase() === "content-security-policy") retainedPolicies.add(root.content);
    for (const meta of root.querySelectorAll<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')) retainedPolicies.add(meta.content);
  }
  const policies = () => { rememberPolicies(document); return [...retainedPolicies]; };
  const forbidsPolicy = policies().some(policy => policy.split(",").some(part => previewPolicyDirectives(part).get("trusted-types")?.includes("'none'")));
  const trusted = factory && context.nonce && !forbidsPolicy ? factory.createPolicy(previewPolicyName(context.nonce), { createHTML: value => value, createScript: value => value, createScriptURL: value => value }) : undefined;
  const html = (value: string) => trusted ? trusted.createHTML(value) : value;
  const script = (value: string) => trusted ? trusted.createScript(value) : value;
  const scriptUrl = (value: string) => trusted ? trusted.createScriptURL(value) : value;
  resumeScript = (element, text) => nativeScriptText.set!.call(element, script(text));
  const current = (): PreviewUrlContext => ({ ...context, upstream: upstream() });
  const map = (value: string) => mapPreviewUrl(value, current());
  const javascript = (value: string, handler = false) => rewritePreviewJavaScript(context.app === "vscode" ? value : rewritePreviewGlobals(value, handler), current());
  const inert = () => document.createElement("template").content.ownerDocument;

  function rewriteTree(root: ParentNode, extraPolicies: string[] = [], executing = false, deferredHandlers = executing): void {
    const rules = [...policies(), ...extraPolicies];
    for (const meta of root.querySelectorAll<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')) rules.push(meta.content);
    for (const element of root.querySelectorAll("*")) {
      for (const [name, value] of [...element.attributes].map(attribute => [attribute.name, attribute.value] as const)) {
        const key = name.toLowerCase();
        if (["src", "href", "xlink:href", "action", "formaction", "poster", "data"].includes(key)) {
          const mapped = element instanceof HTMLScriptElement && key === "src" ? mapPreviewScriptUrl(executing ? rewritePreviewScriptDataUrl(value, javascript) : value, current()) : map(value);
          if (mapped !== value) { if (element instanceof HTMLScriptElement) nativeScriptSource.set!.call(element, scriptUrl(mapped)); else nativeAttribute.call(element, name, mapped); }
        } else if (key === "srcset") nativeAttribute.call(element, name, mapPreviewSrcset(value, current()));
        else if (key === "style" && previewInlineAllowed(rules, "style", value, "", true)) {
          // CSSOM writes retain authorised styles without invalidating a source hash.
          const style = element instanceof HTMLElement || element instanceof SVGElement ? element.style : undefined;
          if (style) {
            const rewritten = rewritePreviewCss(value, current());
            style.cssText = rewritten;
            if (deferredHandlers && rewritten !== value && !previewInlineAllowed(rules, "style", rewritten, "", true)) nativeAttribute.call(element, "data-kintsugi-style", value);
          }
        }
        else if (key.startsWith("on") && key in element && context.app !== "vscode" && previewInlineAllowed(rules, "script", value, "", true)) {
          const rewritten = javascript(value, true);
          if (rewritten !== value) {
            if (previewInlineAllowed(rules, "script", rewritten, "", true)) attribute.call(element, name, script(rewritten));
            else if (!deferredHandlers) installHandler(element, key, rewritten);
            else {
              const marker = `data-kintsugi-handler-${key}`;
              nativeAttribute.call(element, marker, value);
              nativeAttribute.call(element, "data-kintsugi-handler", "");
            }
          }
        }
      }
      if (element instanceof HTMLTemplateElement) rewriteTree(element.content, extraPolicies, false, true);
      if (element instanceof HTMLStyleElement) {
        const original = element.textContent ?? "";
        const rewritten = rewritePreviewCss(original, current());
        if (original !== rewritten && previewInlineAllowed(rules, "style", original, element.nonce)) { element.nonce = context.nonce ?? element.nonce; nativeText.set!.call(element, rewritten); }
      }
      if (executing && element instanceof HTMLScriptElement && !element.hasAttribute("src") && ["", "module", "text/javascript", "application/javascript"].includes(element.type)) {
        const original = element.textContent ?? "";
        if (previewInlineAllowed(rules, "script", original, element.nonce)) { element.nonce = context.nonce ?? element.nonce; nativeScriptText.set!.call(element, script(javascript(original))); }
      }
      if (element instanceof HTMLIFrameElement && element.hasAttribute("srcdoc")) srcdoc.set!.call(element, html(rewriteDocument(html(element.getAttribute("srcdoc") ?? ""))));
    }
  }

  function installHandler(element: Element, name: string, body: string): void {
    const key = `__kintsugi_handler_${crypto.randomUUID().replaceAll("-", "")}`;
    const compiler = document.createElement("script"); compiler.nonce = context.nonce ?? "";
    const owner = `${key}_owner`, args = `${key}_args`;
    nativeScriptText.set!.call(compiler, script(`window[${JSON.stringify(key)}]=function(event){const ${owner}=this,${args}=arguments;with(document){with(${owner}.form||{}){with(${owner}){return(function(event){${body}\n}).apply(${owner},${args});}}}};`));
    document.documentElement.append(compiler); compiler.remove();
    // SAFETY: The fixed compiler above creates this one function in the opaque document; the random property is removed immediately.
    const callback = window[key as keyof Window];
    if (!Value.Check(Type.Function([], Type.Unknown()), callback)) throw new Error("Preview event-handler compilation was blocked");
    Reflect.deleteProperty(window, key);
    // SAFETY: The event property was checked against the native element, and callback was created by the fixed compiler.
    Reflect.set(element, name, callback);
  }

  function restoreHandlers(root: ParentNode): void {
    const styles = [...root.querySelectorAll("[data-kintsugi-style]")];
    if (root instanceof Element && root.hasAttribute("data-kintsugi-style")) styles.unshift(root);
    for (const element of styles) {
      const source = element.getAttribute("data-kintsugi-style")!;
      if ((element instanceof HTMLElement || element instanceof SVGElement) && previewInlineAllowed(policies(), "style", source, "", true)) element.style.cssText = rewritePreviewCss(source, current());
      element.removeAttribute("data-kintsugi-style");
    }
    const elements = [...root.querySelectorAll("[data-kintsugi-handler]")];
    if (root instanceof Element && root.hasAttribute("data-kintsugi-handler")) elements.unshift(root);
    for (const element of elements) {
      for (const entry of [...element.attributes]) if (entry.name.startsWith("data-kintsugi-handler-")) {
        const name = entry.name.slice("data-kintsugi-handler-".length);
        if (name.startsWith("on") && name in element && previewInlineAllowed(policies(), "script", entry.value, "", true)) installHandler(element, name, javascript(entry.value, true));
        element.removeAttribute(entry.name);
      }
      element.removeAttribute("data-kintsugi-handler");
    }
  }
  if (context.app !== "vscode") {
    restoreHandlers(document);
    const prepareCopy = (node: Node) => {
      if (!(node instanceof Element || node instanceof DocumentFragment)) return;
      restoreHandlers(node);
      const elements = [...node.querySelectorAll("*")];
      if (node instanceof Element) elements.unshift(node);
      for (const element of elements) for (const entry of element.attributes) if (entry.name.startsWith("on") && entry.name in element && previewInlineAllowed(policies(), "script", entry.value, "", true)) {
        const rewritten = javascript(entry.value, true);
        if (rewritten !== entry.value && !previewInlineAllowed(policies(), "script", rewritten, "", true)) installHandler(element, entry.name, rewritten);
      }
    };
    const clone = Node.prototype.cloneNode;
    Node.prototype.cloneNode = function(deep) { const result = clone.call(this, deep); prepareCopy(result); return result; };
    const importNode = Document.prototype.importNode;
    Document.prototype.importNode = function(node, deep) { const result = importNode.bind(this)(node, deep); prepareCopy(result); return result; };
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of [...record.addedNodes, ...record.removedNodes]) if (node instanceof Element) rememberPolicies(node);
        for (const node of record.addedNodes) if (node instanceof Element) restoreHandlers(node);
      }
    }).observe(document, { childList: true, subtree: true });
  }

  function fragment(target: Element | ShadowRoot, value: string | TrustedHTML): DocumentFragment {
    const owner = inert();
    const source = target instanceof ShadowRoot ? target.host : target;
    const staging = owner.createElementNS(source.namespaceURI, source.localName);
    inner.set!.call(staging, value);
    const result = owner.createDocumentFragment();
    const children = staging instanceof HTMLTemplateElement ? staging.content : staging;
    while (children.firstChild) result.appendChild(children.firstChild);
    finishFragment(result);
    return result;
  }

  function finishFragment(result: DocumentFragment): void {
    const rules = [...policies(), ...[...result.querySelectorAll<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')].map(meta => meta.content)];
    const styles = [...result.querySelectorAll<HTMLElement | SVGElement>("[style]")].map(element => ({ element, source: element.getAttribute("style")! }));
    rewriteTree(result);
    document.adoptNode(result);
    // Recheck inline attributes against the live document's CSP before insertion.
    for (const { element, source } of styles) {
      // WebKit otherwise reuses an inert document's already-parsed declaration
      // when adoption is followed by setting the identical attribute value.
      element.removeAttribute("style");
      nativeAttribute.call(element, "style", source);
      if ((element instanceof HTMLElement || element instanceof SVGElement) && previewInlineAllowed(rules, "style", source, "", true) && element.style.cssText) element.style.cssText = rewritePreviewCss(element.style.cssText, current());
    }
  }

  Object.defineProperty(Element.prototype, "innerHTML", { ...inner, set(value: string | TrustedHTML) {
    if (this instanceof HTMLScriptElement || this instanceof HTMLStyleElement) {
      const staging = inert().createElement(this.localName); inner.set!.call(staging, value);
      const original: string = inner.get!.call(staging);
      const kind = this instanceof HTMLScriptElement ? "script" : "style";
      const rewritten = kind === "script" ? javascript(original) : rewritePreviewCss(original, current());
      if (previewInlineAllowed(policies(), kind, original, this.nonce)) { if (rewritten !== original && context.nonce) this.nonce = context.nonce; inner.set!.call(this, html(rewritten)); }
      else inner.set!.call(this, trusted ? html(original) : value);
      return;
    }
    const result = fragment(this, value);
    if (this instanceof HTMLTemplateElement) replaceFragment.call(this.content, result);
    else replaceChildren.call(this, result);
  } });
  const shadow = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "innerHTML")!;
  Object.defineProperty(ShadowRoot.prototype, "innerHTML", { ...shadow, set(value: string | TrustedHTML) { replaceFragment.call(this, fragment(this, value)); } });
  Object.defineProperty(Element.prototype, "outerHTML", { ...outer, set(value: string | TrustedHTML) {
    const owner = inert(); const staging = owner.createElementNS(this.parentElement?.namespaceURI ?? "http://www.w3.org/1999/xhtml", this.parentElement?.localName ?? "body");
    const placeholder = owner.createElement("span"); staging.appendChild(placeholder); outer.set!.call(placeholder, value);
    if (!this.parentNode) return;
    if (this.parentNode instanceof Document) throw new DOMException("Cannot replace the document element", "NoModificationAllowedError");
    const result = owner.createDocumentFragment(); while (staging.firstChild) result.appendChild(staging.firstChild); finishFragment(result);
    insertBefore.call(this.parentNode, result, this); removeChild.call(this.parentNode, this);
  } });
  Element.prototype.insertAdjacentHTML = function(position, value) {
    const owner = inert(); const staging = owner.createElementNS(this.parentElement?.namespaceURI ?? this.namespaceURI, this.parentElement?.localName ?? "body");
    const placeholder = owner.createElementNS(this.namespaceURI, this.localName); staging.appendChild(placeholder);
    adjacent.call(placeholder, position, value);
    const inside = position.toLowerCase() === "afterbegin" || position.toLowerCase() === "beforeend";
    const container = inside ? placeholder : staging;
    if (!inside && (!this.parentNode || this.parentNode instanceof Document)) throw new DOMException("No insertion parent", "NoModificationAllowedError");
    const result = owner.createDocumentFragment();
    for (const child of [...container.childNodes]) if (child !== placeholder) result.appendChild(child);
    finishFragment(result);
    if (inside) insertBefore.call(this, result, position.toLowerCase() === "afterbegin" ? this.firstChild : null);
    else insertBefore.call(this.parentNode!, result, position.toLowerCase() === "beforebegin" ? this : this.nextSibling);
  };

  function rewriteDocument(value: string | TrustedHTML): string {
    const doc = document.implementation.createHTMLDocument("");
    inner.set!.call(doc.documentElement, value);
    rewriteTree(doc, [], true);
    for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')) meta.content = previewContentPolicy(meta.content, current(), context.nonce ?? "");
    const configuration = doc.createElement("meta"); configuration.name = "kintsugi-preview-context"; configuration.content = JSON.stringify({ ...current(), policy: policies().join(", ") });
    const runtime = doc.createElement("script"); runtime.nonce = context.nonce ?? ""; nativeScriptSource.set!.call(runtime, scriptUrl(new URL("/~preview-assets/runtime.js", context.publicOrigin).href));
    doc.head.prepend(configuration, runtime);
    return `<!doctype html>\n${doc.documentElement.outerHTML}`;
  }
  Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", { ...srcdoc, set(value: string | TrustedHTML) {
    const staging = document.createElement("iframe"); srcdoc.set!.call(staging, value);
    const approved: string = srcdoc.get!.call(staging);
    srcdoc.set!.call(this, approved ? html(rewriteDocument(html(approved))) : trusted ? html("") : value);
  } });

  const nativeWrite = Document.prototype.write, nativeWriteln = Document.prototype.writeln, nativeClose = Document.prototype.close;
  // SAFETY: Document.write accepts branded TrustedHTML; lib.dom omits that WebIDL overload.
  const writeHtml = nativeWrite as (this: Document, ...inputs: Array<string | TrustedHTML>) => void;
  const writers = new WeakMap<Document, ReturnType<typeof createPreviewHtmlStream>>();
  function documentWriter(target: Document): ReturnType<typeof createPreviewHtmlStream> {
    let writer = writers.get(target);
    if (writer) return writer;
    const additionalPolicies: string[] = [];
    writer = createPreviewHtmlStream({
      tag(name, attributes) {
        const owner = inert(), holder = owner.createDocumentFragment(), element = owner.createElement(name);
        for (const [key, value] of Object.entries(attributes)) {
          if (element instanceof HTMLIFrameElement && key.toLowerCase() === "srcdoc") srcdoc.set!.call(element, html(value));
          else attribute.call(element, key, key.toLowerCase().startsWith("on") ? script(value) : value);
        }
        holder.appendChild(element);
        if (element instanceof HTMLMetaElement && element.httpEquiv.toLowerCase() === "content-security-policy") additionalPolicies.push(element.content);
        rewriteTree(holder, additionalPolicies, true);
        if (element instanceof HTMLMetaElement && element.httpEquiv.toLowerCase() === "content-security-policy") element.content = previewContentPolicy(element.content, current(), context.nonce ?? "");
        return previewHtmlStartTag(outer.get!.call(element));
      },
      block(source) {
        const staging = inert().createElement("template"); inner.set!.call(staging, html(source));
        rewriteTree(staging.content, additionalPolicies, true);
        return inner.get!.call(staging);
      },
    });
    writers.set(target, writer); return writer;
  }
  function writeDocument(target: Document, native: typeof Document.prototype.write, inputs: string[]): void {
    // A plaintext parser validates the exact native write/writeln TrustedHTML sink,
    // including default-policy conversion, without fetching or executing its input.
    const approval = document.implementation.createHTMLDocument("");
    if (factory && !trusted) { native.call(approval, ...inputs); native.call(target, ...inputs); return; }
    writeHtml.call(approval, html("<plaintext>"));
    native.call(approval, ...inputs); nativeClose.call(approval);
    const source = approval.querySelector("plaintext")!.textContent ?? "";
    const translated = documentWriter(target).write(source);
    writeHtml.call(target, html(translated));
    restoreHandlers(target);
  }
  const nativeOpen = Document.prototype.open;
  const clearDocument: (this: Document, unused1?: string, unused2?: string) => Document = nativeOpen;
  Object.defineProperty(Document.prototype, "open", { ...Object.getOwnPropertyDescriptor(Document.prototype, "open"), value: function(this: Document, ...inputs: [string?, string?] | [string | URL, string, string]) {
    writers.delete(this);
    if (inputs.length === 3) return nativeOpen.call(this, map(String(inputs[0])), inputs[1], inputs[2]);
    return clearDocument.call(this, ...inputs);
  } });
  Document.prototype.write = function(...inputs) { writeDocument(this, nativeWrite, inputs); };
  Document.prototype.writeln = function(...inputs) { writeDocument(this, nativeWriteln, inputs); };

  function setScriptSource(element: HTMLScriptElement, value: string | TrustedScriptURL): void {
    const staging = document.createElement("script"); nativeScriptSource.set!.call(staging, value);
    const approved = staging.getAttribute("src")!;
    nativeScriptSource.set!.call(element, scriptUrl(mapPreviewScriptUrl(rewritePreviewScriptDataUrl(approved, javascript), current())));
  }
  Object.defineProperty(HTMLScriptElement.prototype, "src", { ...nativeScriptSource, set(value: string | TrustedScriptURL) { setScriptSource(this, value); } });
  const attributes = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const key = String(name).toLowerCase();
    if (this instanceof HTMLScriptElement && key === "src") { setScriptSource(this, value); return; }
    if (key === "style" && (this instanceof HTMLElement || this instanceof SVGElement)) {
      const staging = document.createElement("template"); nativeAttribute.call(staging, name, value);
      const source = staging.getAttribute(name)!;
      if (previewInlineAllowed(policies(), "style", source, "", true) && staging.style.cssText) this.style.cssText = rewritePreviewCss(staging.style.cssText, current());
      else nativeAttribute.call(this, name, source);
      return;
    }
    if (key.startsWith("on") && key in this && context.app !== "vscode") {
      const staging = document.createElementNS(this.namespaceURI, this.localName); nativeAttribute.call(staging, name, value);
      const approved = staging.getAttribute(name)!;
      if (previewInlineAllowed(policies(), "script", approved, "", true)) {
        const rewritten = javascript(approved, true);
        if (rewritten === approved) { nativeAttribute.call(this, name, value); return; }
        if (previewInlineAllowed(policies(), "script", rewritten, "", true)) attribute.call(this, name, script(rewritten));
        else installHandler(this, key, rewritten);
        return;
      }
    }
    attributes.call(this, name, value);
  };

  const scriptContent = (element: HTMLScriptElement, native: PropertyDescriptor, value: string | TrustedScript | null) => {
    // The native setter validates TrustedScript before the adapter derives code.
    const staging = document.createElement("script"); native.set!.call(staging, value);
    const original: string = native.get!.call(staging);
    const allowed = previewInlineAllowed(policies(), "script", original, element.nonce);
    const rewritten = allowed ? javascript(original) : original;
    if (allowed && rewritten !== original && context.nonce) element.nonce = context.nonce;
    return trusted ? script(rewritten) : rewritten === original ? value : rewritten;
  };
  Object.defineProperty(HTMLScriptElement.prototype, "text", { ...nativeScriptText, set(value: string | TrustedScript) { nativeScriptText.set!.call(this, scriptContent(this, nativeScriptText, value)); } });
  const text = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
  Object.defineProperty(Node.prototype, "textContent", { ...text, set(value: string | TrustedScript | null) {
    if (this instanceof HTMLScriptElement) scriptTextContent.set!.call(this, scriptContent(this, scriptTextContent, value));
    else if (this instanceof HTMLStyleElement) {
      const staging = inert().createElement("style"); nativeText.set!.call(staging, value);
      const original: string = nativeText.get!.call(staging);
      const allowed = previewInlineAllowed(policies(), "style", original, this.nonce);
      const rewritten = allowed ? rewritePreviewCss(original, current()) : original;
      if (rewritten !== original && context.nonce) this.nonce = context.nonce;
      nativeText.set!.call(this, rewritten);
    } else text.set!.call(this, value);
  } });
  for (const [name, descriptor] of [["textContent", scriptTextContent], ["innerText", scriptInnerText]] as const) Object.defineProperty(HTMLScriptElement.prototype, name, { ...descriptor, set(value: string | TrustedScript | null) { descriptor.set!.call(this, scriptContent(this, descriptor, value)); } });
}
