import { Application, Controller } from "@hotwired/stimulus";
import { setPreparedPreviewDocument } from "@kintsugi/proxy-ingress/preview-client";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { mapPreviewUrl, mapPreviewSrcset, previewUrlContextSchema, previewContentPolicy, rewritePreviewCss, type PreviewUrlContext } from "@kintsugi/proxy-ingress/preview";
import { nativeWebviewContent, nativeWebviewEnvelope, nativeWebviewStyles, type NativeWebviewContent, type NativeWebviewStyles } from "../native-webview-protocol.ts";

const innerReady = Type.Object({ type: Type.Literal("kintsugi:webview-inner-ready"), nonce: Type.String() });
const notification = Type.Object({ channel: Type.String(), data: Type.Optional(Type.Unknown()) });
const keyEvent = Type.Object({ key: Type.String(), keyCode: Type.Number(), code: Type.String(), shiftKey: Type.Boolean(), altKey: Type.Boolean(), ctrlKey: Type.Boolean(), metaKey: Type.Boolean(), repeat: Type.Boolean(), isTrusted: Type.Literal(true) });

class NativeWebviewOuterController extends Controller {
  static targets = ["frame"];
  declare readonly frameTarget: HTMLIFrameElement;
  private host?: MessagePort;
  private inner?: MessagePort;
  private nonce?: string;
  private styles?: NativeWebviewStyles;
  private queued: Array<{ channel: string; args: unknown }> = [];
  private routing!: PreviewUrlContext;
  private readonly keyEventToken = crypto.randomUUID();

  connect(): void {
    if (globalThis.origin !== "null") throw new Error("Webviews require an opaque origin");
    const context: unknown = JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="kintsugi-preview-context"]')!.content);
    if (!Value.Check(previewUrlContextSchema, context)) throw new Error("Invalid webview routing context");
    this.routing = context;
    const id = new URL(location.href).searchParams.get("id");
    if (!id || window.parent === window) throw new Error("Webview has no workbench owner");
    const channel = new MessageChannel(); this.host = channel.port1;
    this.host.onmessage = event => { try { this.fromHost(event.data); } catch (error) { this.sendHost("fatal-error", { message: error instanceof Error ? error.message : String(error) }); } };
    window.parent.postMessage({ target: id, channel: "webview-ready", data: { keyEventToken: this.keyEventToken, mountId: new URL(location.href).searchParams.get("mountId") } }, "*", [channel.port2]);
  }
  disconnect(): void { this.host?.close(); this.inner?.close(); }

  receive(event: MessageEvent): void {
    if (this.inner || !event.isTrusted || event.source !== this.frameTarget.contentWindow || event.origin !== "null" || !Value.Check(innerReady, event.data) || event.data.nonce !== this.nonce) return;
    const channel = new MessageChannel(); this.inner = channel.port1;
    this.inner.onmessage = event => {
      const message: unknown = event.data;
      if (!Value.Check(notification, message)) return;
      if (["did-keydown", "did-keyup"].includes(message.channel)) {
        if (Value.Check(keyEvent, message.data)) this.sendHost(message.channel, { ...message.data, keyEventToken: this.keyEventToken });
      } else if (["onmessage", "do-update-state", "did-click-link", "did-focus", "did-blur", "did-scroll", "did-scroll-wheel", "updated-intrinsic-content-size", "did-find", "fatal-error"].includes(message.channel)) this.sendHost(message.channel, message.data, [...event.ports]);
    };
    this.frameTarget.contentWindow!.postMessage({ type: "kintsugi:webview-inner-connect", nonce: this.nonce }, "*", [channel.port2]);
    if (this.styles) this.inner.postMessage({ channel: "styles", args: this.styles });
    for (const message of this.queued) this.inner.postMessage(message);
    this.queued.length = 0;
    this.sendHost("did-load", undefined);
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the native structured-clone protocol boundary to the workbench's private MessagePort.
  private sendHost(channel: string, data: unknown, transfer: Transferable[] = []): void { this.host!.postMessage({ channel, data }, transfer); }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The private workbench MessagePort is decoded before invoking rendering or forwarding operations.
  private fromHost(input: unknown): void {
    if (!Value.Check(nativeWebviewEnvelope, input)) throw new Error("Invalid webview workbench message");
    const { channel, args } = input;
    if (channel === "content") {
      if (!Value.Check(nativeWebviewContent, args)) throw new Error("Invalid webview content");
      this.render(args); return;
    }
    if (channel === "styles") {
      if (!Value.Check(nativeWebviewStyles, args)) throw new Error("Invalid webview styles");
      this.styles = args;
    }
    if (this.inner) this.inner.postMessage({ channel, args });
    else this.queued.push({ channel, args });
  }
  private render(content: NativeWebviewContent): void {
    this.inner?.close(); this.inner = undefined;
    this.nonce = crypto.randomUUID();
    this.frameTarget.sandbox.value = `allow-scripts allow-popups allow-downloads${content.options.allowForms ? " allow-forms" : ""}`;
    const doc = new DOMParser().parseFromString(content.contents, "text/html");
    const context = this.routing;
    for (const element of doc.querySelectorAll("*")) {
      for (const attribute of [...element.attributes]) {
        if (!content.options.allowScripts && (attribute.name.toLowerCase().startsWith("on") || /^(?:javascript|vbscript):/i.test(attribute.value.trimStart()))) element.removeAttribute(attribute.name);
      }
      for (const name of ["src", "href", "action", "formaction", "poster", "data"]) {
        const value = element.getAttribute(name); if (value !== null) element.setAttribute(name, mapPreviewUrl(value, context));
      }
      const srcset = element.getAttribute("srcset"); if (srcset) element.setAttribute("srcset", mapPreviewSrcset(srcset, context));
      const style = element.getAttribute("style"); if (style) element.setAttribute("style", rewritePreviewCss(style, context));
    }
    if (!content.options.allowScripts) for (const element of doc.querySelectorAll("script,iframe,object,embed")) element.remove();
    for (const style of doc.querySelectorAll("style")) style.textContent = rewritePreviewCss(style.textContent ?? "", context);
    for (const meta of doc.querySelectorAll('meta[http-equiv]')) {
      if (meta.getAttribute("http-equiv")?.toLowerCase() !== "content-security-policy") { meta.remove(); continue; }
      const policy = (meta.getAttribute("content") ?? "").replace(/https:\/\/[^\s;]*\.vscode-resource\.vscode-cdn\.net\/?/g, `${context.publicOrigin}${context.root}file/`).replace(/(?:vscode-webview-resource|vscode-resource):(?=\s|;|$)/g, `${context.publicOrigin}${context.root}file/`);
      meta.setAttribute("content", previewContentPolicy(policy, context, this.nonce));
    }
    const config = doc.createElement("meta"); config.name = "kintsugi-webview-inner";
    config.content = JSON.stringify({ nonce: this.nonce, context, state: content.state, allowScripts: Boolean(content.options.allowScripts), allowForms: Boolean(content.options.allowForms), allowMultipleAPIAcquire: Boolean(content.options.allowMultipleAPIAcquire) });
    const routing = doc.createElement("meta"); routing.name = "kintsugi-preview-context"; routing.content = JSON.stringify(context);
    const script = doc.createElement("script"); script.nonce = this.nonce;
    script.src = new URL("kintsugi-webview-inner.js", location.href).href;
    doc.head.prepend(config, routing, script);
    doc.body.setAttribute("data-controller", `${doc.body.getAttribute("data-controller") ?? ""} native-webview-inner`.trim());
    doc.body.setAttribute("data-action", `${doc.body.getAttribute("data-action") ?? ""} click->native-webview-inner#click keydown->native-webview-inner#keydown keyup->native-webview-inner#keyup focus@window->native-webview-inner#focus blur@window->native-webview-inner#blur scroll@window->native-webview-inner#scroll submit->native-webview-inner#submit`);
    setPreparedPreviewDocument(this.frameTarget, `<!doctype html>\n${doc.documentElement.outerHTML}`);
  }
}
Application.start().register("native-webview-outer", NativeWebviewOuterController);
