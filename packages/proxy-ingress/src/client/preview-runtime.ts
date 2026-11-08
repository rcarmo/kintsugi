import { installPreviewMessages } from "./preview-messages.ts";
import { installPreviewStorage, installPreviewIndexedDB } from "./preview-storage.ts";
import { installPreviewWorkers } from "./preview-worker.ts";
import { restorePreviewDatabases, snapshotPreviewDatabases } from "./preview-database.ts";
import { Value } from "typebox/value";
import { Type } from "typebox";
import { applyPreviewLocalChange, parsePreviewState, previewLocalChangeSchema, previewStorageEntriesSchema, type PreviewDatabaseDestruction, type PreviewLocalChange, type PreviewState } from "../preview-state.ts";
import { installPreviewNetwork } from "./preview-network.ts";
import { previewFlushRequestSchema } from "../preview-persistence-protocol.ts";
import { setPreviewParserScriptText } from "./preview-markup.ts";

// Workspace documents only. Never load this entrypoint into a management document.
if (globalThis.origin !== "null") throw new Error("The preview runtime requires an opaque sandbox");
installPreviewIndexedDB();
installPreviewMessages();
const network = installPreviewNetwork();
installPreviewWorkers(network);

async function connectHost(): Promise<{ port: MessagePort; persistence: MessagePort; state: PreviewState; session: Array<[string, string]> }> {
  const nonce = crypto.randomUUID();
  const ready = () => window.parent.postMessage({ type: "kintsugi:preview-ready", version: 2, nonce }, "*");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("Preview storage host did not connect")); }, 10000);
    function receive(event: MessageEvent) {
      if (event.source !== window.parent) return;
      if (event.data?.type === "kintsugi:preview-host-ready") { ready(); return; }
      if (event.data?.type !== "kintsugi:preview-connect" || event.data.version !== 2 || event.ports.length !== 2) return;
      if (event.data.nonce !== nonce) { for (const port of event.ports) port.close(); return; }
      window.removeEventListener("message", receive);
      clearTimeout(timer);
      try {
        if (!Value.Check(previewStorageEntriesSchema, event.data.session)) throw new Error("Invalid preview session state");
        resolve({ port: event.ports[0]!, persistence: event.ports[1]!, state: parsePreviewState(event.data.state), session: event.data.session });
      }
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
    setPreviewParserScriptText(script, source.textContent ?? "");
    const loaded = script.src || script.type === "module" ? new Promise<void>((resolve, reject) => {
      script.onload = () => resolve(); script.onerror = () => reject(new Error(`Preview script failed: ${script.src || "inline module"}`));
    }) : Promise.resolve();
    source.replaceWith(script);
    await loaded;
  }
}

async function start(): Promise<void> {
  if (!document.querySelector('meta[name="kintsugi-preview-persistence"]')) { installPreviewStorage(new Map(), () => {}, network?.cookies); return; }
  const { port, persistence, state, session: sessionEntries } = await connectHost();
  const local = new Map(state.local), session = new Map(sessionEntries);
  let revision = state.revision;
  await restorePreviewDatabases(indexedDB, state.databases);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  let databaseDirty = false;
  let destructions: PreviewDatabaseDestruction[] = [];
  let sequence = 0;
  const saved = new Map<number, { done: Promise<void>; resolve(): void; reject(error: Error): void }>();
  let persistenceFailure: Error | undefined;
  function waitForSave(id: number): Promise<void> {
    const pending = Promise.withResolvers<void>();
    saved.set(id, { done: pending.promise, resolve: pending.resolve, reject: pending.reject });
    return pending.promise;
  }
  function notifyStorage(area: Storage, key: string | null, oldValue: string | null, newValue: string | null): void {
    const notification = new StorageEvent("storage", { key, oldValue, newValue });
    Object.defineProperty(notification, "storageArea", { value: area });
    window.dispatchEvent(notification);
  }
  port.onmessage = event => {
    if (Value.Check(previewFlushRequestSchema, event.data)) {
      const id = event.data.id;
      void flush().then(async () => {
        await Promise.all([...saved.values()].map(pending => pending.done));
        if (persistenceFailure) throw persistenceFailure;
        port.postMessage({ type: "flushed", id, saved: true });
      }).catch(error => { port.postMessage({ type: "flushed", id, saved: false }); fail(error); });
      return;
    }
    if (event.data?.type === "session-state" && Value.Check(previewStorageEntriesSchema, event.data.values)) {
      const next = new Map<string, string>(event.data.values);
      for (const key of new Set([...session.keys(), ...next.keys()])) {
        const oldValue = session.get(key) ?? null, newValue = next.get(key) ?? null;
        if (oldValue === newValue) continue;
        if (newValue === null) session.delete(key); else session.set(key, newValue);
        notifyStorage(sessionStorage, key, oldValue, newValue);
      }
      return;
    }
    if (event.data?.type === "local-change" && Value.Check(previewLocalChangeSchema, event.data.change)) {
      if (!Value.Check(Type.Integer({ minimum: 1 }), event.data.revision) || event.data.revision <= revision) return;
      revision = event.data.revision;
      const change = event.data.change;
      const key = change.kind === "clear" ? null : change.key;
      const oldValue = key === null ? null : local.get(key) ?? null, wasEmpty = local.size === 0;
      applyPreviewLocalChange(local, change);
      const newValue = change.kind === "set" ? change.value : null;
      if (event.data.remote && (change.kind === "clear" ? !wasEmpty : oldValue !== newValue)) notifyStorage(localStorage, key, oldValue, newValue);
      return;
    }
    const pending = saved.get(event.data?.id);
    if (!pending) return;
    saved.delete(event.data.id);
    if (event.data.type === "saved") { pending.resolve(); port.postMessage({ type: "persisted" }); }
    else { persistenceFailure = new Error("Preview settings could not be saved"); pending.reject(persistenceFailure); }
  };
  persistence.onmessage = port.onmessage;
  function changed() { databaseDirty = true; clearTimeout(timer); timer = setTimeout(() => { void flush().catch(fail); }, 250); }
  function flush(): Promise<void> {
    clearTimeout(timer);
    writes = writes.then(async () => {
      while (databaseDirty) {
        databaseDirty = false;
        const committedDestructions = destructions; destructions = [];
        const databases = await snapshotPreviewDatabases(indexedDB);
        const id = ++sequence;
        const done = waitForSave(id);
        persistence.postMessage({ type: "save", id, state: { version: 2, revision: 0, local: [], databases }, destructions: committedDestructions });
        await done;
      }
    });
    return writes;
  }
  function persistStorage(type: "local" | "session", change: PreviewLocalChange): void {
    const id = ++sequence;
    const done = waitForSave(id);
    void done.catch(fail);
    (type === "local" ? persistence : port).postMessage({ type, id, change });
  }
  installPreviewStorage(local, change => persistStorage("local", change), network?.cookies, session, change => persistStorage("session", change));
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
  const clear = IDBObjectStore.prototype.clear;
  const transactionDestructions = new WeakMap<IDBTransaction, PreviewDatabaseDestruction[]>();
  IDBObjectStore.prototype.clear = function() {
    const request = clear.call(this);
    let journal = transactionDestructions.get(this.transaction);
    if (!journal) {
      journal = []; transactionDestructions.set(this.transaction, journal);
      const committed = journal;
      this.transaction.addEventListener("complete", () => { destructions.push(...committed); changed(); }, { once: true });
    }
    const entry: PreviewDatabaseDestruction = { kind: "clear", database: this.transaction.db.name, store: this.name };
    const pending = journal;
    request.addEventListener("success", () => pending.push(entry), { once: true });
    return request;
  };
  const remove = indexedDB.deleteDatabase.bind(indexedDB);
  indexedDB.deleteDatabase = input => {
    // Convert once before delegation, matching the installed factory's DOMString boundary.
    const name = String(input);
    const request = remove(name);
    request.addEventListener("success", () => { destructions.push({ kind: "delete-database", database: name }); changed(); }, { once: true });
    return request;
  };
  window.addEventListener("beforeunload", event => {
    if (!saved.size && !databaseDirty) return;
    event.preventDefault(); event.returnValue = "";
    void flush().catch(fail);
  });
  window.addEventListener("pagehide", event => { void flush().then(() => { if (!event.persisted) persistence.postMessage({ type: "close" }); }).catch(fail); });
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
