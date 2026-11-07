import { Application, Controller } from "@hotwired/stimulus";
import { Value } from "typebox/value";
import { Type } from "typebox";
import { installPreviewIndexedDB, installPreviewNetwork, installPreviewStorage, installPreviewWorkers } from "@kintsugi/proxy-ingress/preview-client";
import { nativeWebviewEnvelope, nativeWebviewInnerConfiguration, nativeWebviewStyles } from "../native-webview-protocol.ts";

if (globalThis.origin !== "null") throw new Error("Webview content requires an opaque origin");
const input: unknown = JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="kintsugi-webview-inner"]')!.content);
if (!Value.Check(nativeWebviewInnerConfiguration, input)) throw new Error("Invalid native webview configuration");
const config = input;
installPreviewIndexedDB();
installPreviewStorage(new Map(), () => {}, config.context.cookies);
const context = installPreviewNetwork(); installPreviewWorkers(context);

// Install the private handshake before extension scripts execute. A content
// script must not acquire the privileged bridge's MessagePort from the event.
const sourceOf = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(MessageEvent.prototype, "source")!.get!);
const portsOf = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(MessageEvent.prototype, "ports")!.get!);
const dataOf = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")!.get!);
const stop = Function.prototype.call.bind(Event.prototype.stopImmediatePropagation);
const post = Function.prototype.call.bind(MessagePort.prototype.postMessage);
const listen = Function.prototype.call.bind(EventTarget.prototype.addEventListener);
const startPort = Function.prototype.call.bind(MessagePort.prototype.start);
const parentWindow = window.parent;
let port: MessagePort | undefined;
let controller: NativeWebviewInnerController | undefined;
const outgoing: Array<{ message: { channel: string; data: unknown }; transfer: Transferable[] }> = [];
const incoming: unknown[] = [];
function send(message: { channel: string; data: unknown }, transfer: Transferable[] = []): void {
  if (port) post(port, message, transfer);
  else outgoing.push(structuredClone({ message, transfer }, { transfer }));
}
window.addEventListener("message", event => {
  const data = dataOf(event);
  if (!event.isTrusted || sourceOf(event) !== parentWindow || data?.type !== "kintsugi:webview-inner-connect" || data.nonce !== config.nonce) return;
  stop(event);
  const ports: readonly MessagePort[] = portsOf(event);
  if (port || ports.length !== 1) return;
  port = ports[0]!;
  listen(port, "message", (event: Event) => {
    const data = dataOf(event);
    if (controller) controller.command(data);
    else incoming.push(data);
  });
  startPort(port);
  for (const queued of outgoing) post(port, queued.message, queued.transfer);
  outgoing.length = 0;
}, { capture: true });

let state: unknown = config.state ? JSON.parse(config.state) : undefined;
let acquired = false;
if (config.allowScripts) Object.defineProperty(window, "acquireVsCodeApi", { configurable: false, writable: false, value: () => {
  if (acquired && !config.allowMultipleAPIAcquire) throw new Error("An instance of the VS Code API has already been acquired");
  acquired = true;
  return Object.freeze({
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Extension postMessage accepts structured-clone payloads validated by the native MessagePort.
    postMessage(message: unknown, transfer: Transferable[] = []) { send({ channel: "onmessage", data: { message, transfer } }, transfer); },
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Extension state is serialized using the VS Code API's JSON contract.
    setState(value: unknown) { state = value; send({ channel: "do-update-state", data: JSON.stringify(value) }); return value; },
    getState() { return state; },
  });
} });

class NativeWebviewInnerController extends Controller {
  private observer?: ResizeObserver;
  connect(): void {
    controller = this;
    for (const message of incoming) this.command(message);
    incoming.length = 0;
    this.observer = new ResizeObserver(() => send({ channel: "updated-intrinsic-content-size", data: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } }));
    this.observer.observe(document.documentElement);
    parentWindow.postMessage({ type: "kintsugi:webview-inner-ready", nonce: config.nonce }, "*");
  }
  disconnect(): void { this.observer?.disconnect(); controller = undefined; }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Workbench envelopes arrive over the private MessagePort and are decoded before applying commands.
  command(input: unknown): void {
    if (!Value.Check(nativeWebviewEnvelope, input)) return;
    const { channel, args } = input;
    if (channel === "styles" && Value.Check(nativeWebviewStyles, args)) {
      for (const name of [...document.documentElement.style]) if (name.startsWith("--vscode-")) document.documentElement.style.removeProperty(name);
      for (const [key, value] of Object.entries(args.styles)) document.documentElement.style.setProperty(`--${key}`, value);
      for (const name of ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"]) document.body.classList.toggle(name, name === args.activeTheme);
      document.body.dataset.vscodeThemeKind = args.activeTheme;
      document.body.dataset.vscodeThemeName = args.themeLabel ?? "";
      document.body.dataset.vscodeThemeId = args.themeId ?? "";
      document.body.classList.toggle("vscode-reduce-motion", Boolean(args.reduceMotion));
      document.body.classList.toggle("vscode-using-screen-reader", Boolean(args.screenReader));
    } else if (channel === "message") {
      if (Value.Check(Type.Object({ message: Type.Unknown() }), args)) window.dispatchEvent(new MessageEvent("message", { data: args.message, source: parentWindow }));
    } else if (channel === "focus") window.focus();
    else if (channel === "set-title" && Value.Check(Type.String(), args)) document.title = args;
    else if (channel === "initial-scroll-position" && Value.Check(Type.Number(), args)) window.scrollTo(0, document.body.clientHeight * args);
    else if (channel === "execCommand" && Value.Check(Type.String(), args)) document.execCommand(args);
  }
  click(event: MouseEvent): void {
    if (!event.isTrusted) return;
    const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (!(anchor instanceof HTMLAnchorElement) || !anchor.href || anchor.getAttribute("href")?.startsWith("#")) return;
    event.preventDefault(); send({ channel: "did-click-link", data: { uri: anchor.href } });
  }
  keydown(event: KeyboardEvent): void { this.key("did-keydown", event); }
  keyup(event: KeyboardEvent): void { this.key("did-keyup", event); }
  private key(channel: string, event: KeyboardEvent): void {
    if (!event.isTrusted) return;
    send({ channel, data: { key: event.key, keyCode: event.keyCode, code: event.code, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, repeat: event.repeat, isComposing: event.isComposing, isTrusted: true } });
  }
  focus(): void { send({ channel: "did-focus", data: undefined }); }
  blur(): void { send({ channel: "did-blur", data: undefined }); }
  scroll(): void { send({ channel: "did-scroll", data: { scrollYPercentage: window.scrollY / document.body.clientHeight } }); }
  submit(event: SubmitEvent): void { if (!config.allowForms) event.preventDefault(); }
}
Application.start().register("native-webview-inner", NativeWebviewInnerController);
