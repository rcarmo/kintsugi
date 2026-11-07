import { installPreviewMessages } from "./preview-messages.ts";
import { installPreviewStorage, installPreviewIndexedDB } from "./preview-storage.ts";
import { installPreviewWorkers } from "./preview-worker.ts";
import { restorePreviewDatabases, snapshotPreviewDatabases } from "./preview-database.ts";
import { parsePreviewState, type PreviewState } from "../preview-state.ts";
import { installPreviewNetwork } from "./preview-network.ts";

// Workspace documents only. Never load this entrypoint into a management document.
if (globalThis.origin !== "null") throw new Error("The preview runtime requires an opaque sandbox");
installPreviewIndexedDB();
installPreviewMessages();
const network = installPreviewNetwork();
installPreviewWorkers(network);

async function connectHost(): Promise<{ port: MessagePort; state: PreviewState }> {
  const nonce = crypto.randomUUID();
  const ready = () => window.parent.postMessage({ type: "kintsugi:preview-ready", nonce }, "*");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("Preview storage host did not connect")); }, 10000);
    function receive(event: MessageEvent) {
      if (event.source !== window.parent) return;
      if (event.data?.type === "kintsugi:preview-host-ready") { ready(); return; }
      if (event.data?.type !== "kintsugi:preview-connect" || event.ports.length !== 1) return;
      if (event.data.nonce !== nonce) { event.ports[0]!.close(); return; }
      window.removeEventListener("message", receive);
      clearTimeout(timer);
      try { resolve({ port: event.ports[0]!, state: parsePreviewState(event.data.state) }); }
      catch (error) { reject(error); }
    }
    window.addEventListener("message", receive);
    ready();
  });
}

async function resumeScripts(): Promise<void> {
  if (document.readyState === "loading") await new Promise<void>(resolve => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
  for (const source of document.querySelectorAll<HTMLScriptElement>("script[data-kintsugi-script-type]")) {
    // VS Code emits src="" for an unused optional language pack. It is not an application entrypoint.
    if (source.getAttribute("src") === "") { source.remove(); continue; }
    const script = document.createElement("script");
    for (const attribute of source.attributes) {
      if (!["type", "data-kintsugi-script-type"].includes(attribute.name)) script.setAttribute(attribute.name, attribute.value);
    }
    // Browsers hide nonce values through getAttribute/attributes; the nonce IDL property retains them.
    if (source.nonce) script.nonce = source.nonce;
    script.type = source.dataset.kintsugiScriptType!;
    script.async = false;
    script.textContent = source.textContent;
    const loaded = script.src || script.type === "module" ? new Promise<void>((resolve, reject) => {
      script.onload = () => resolve(); script.onerror = () => reject(new Error(`Preview script failed: ${script.src || "inline module"}`));
    }) : Promise.resolve();
    source.replaceWith(script);
    await loaded;
  }
}

async function start(): Promise<void> {
  if (!document.querySelector('meta[name="kintsugi-preview-persistence"]')) { installPreviewStorage(new Map(), () => {}, network?.cookies); return; }
  const { port, state } = await connectHost();
  const local = new Map(state.local);
  await restorePreviewDatabases(indexedDB, state.databases);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  let sequence = 0;
  const saved = new Map<number, { resolve(): void; reject(error: Error): void }>();
  port.onmessage = event => {
    const pending = saved.get(event.data?.id);
    if (!pending) return;
    saved.delete(event.data.id);
    if (event.data.type === "saved") pending.resolve();
    else pending.reject(new Error("Preview settings could not be saved"));
  };
  function changed() { clearTimeout(timer); timer = setTimeout(() => { void flush().catch(fail); }, 250); }
  function flush(): Promise<void> {
    clearTimeout(timer);
    writes = writes.then(async () => {
      const databases = await snapshotPreviewDatabases(indexedDB);
      const id = ++sequence;
      const done = new Promise<void>((resolve, reject) => { saved.set(id, { resolve, reject }); });
      port.postMessage({ type: "save", id, state: { version: 1, local: [...local], databases } });
      await done;
    });
    return writes;
  }
  installPreviewStorage(local, changed, network?.cookies);
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(...args: Parameters<typeof transaction>) {
    const result = transaction.apply(this, args);
    if (result.mode === "readwrite") result.addEventListener("complete", changed, { once: true });
    return result;
  };
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args: Parameters<typeof open>) => {
    const request = open(...args);
    request.addEventListener("upgradeneeded", () => request.transaction!.addEventListener("complete", changed, { once: true }), { once: true });
    return request;
  };
  const remove = indexedDB.deleteDatabase.bind(indexedDB);
  indexedDB.deleteDatabase = name => {
    const request = remove(name);
    request.addEventListener("success", changed, { once: true });
    return request;
  };
  window.addEventListener("pagehide", () => { void flush().catch(fail); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flush().catch(fail); });
  await resumeScripts();
}

function fail(error: Error): void {
  console.error("Preview runtime failed", error);
  const message = document.createElement("div");
  message.setAttribute("role", "alert");
  message.textContent = "Preview state could not be restored or saved. Reloading may lose recent changes.";
  Object.assign(message.style, { position: "fixed", inset: "0 0 auto", zIndex: "2147483647", background: "#5b1d24", color: "white", padding: "12px", font: "14px system-ui" });
  document.documentElement.append(message);
}
void start().catch(fail);
