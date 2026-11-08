import { Application, Controller } from "@hotwired/stimulus";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { PreviewStateStore } from "./preview-state-store.ts";
import { applyPreviewLocalChange, parsePreviewState, previewLocalChangeSchema, previewStorageEntriesSchema, type PreviewLocalChange, type PreviewState } from "../preview-state.ts";

const readySchema = Type.Object({ type: Type.Literal("kintsugi:preview-ready"), version: Type.Literal(2), nonce: Type.String({ minLength: 36, maxLength: 36 }) });
const saveSchema = Type.Union([
  Type.Object({ type: Type.Literal("save"), id: Type.Integer({ minimum: 1 }), state: Type.Unknown() }),
  Type.Object({ type: Type.Literal("local"), id: Type.Integer({ minimum: 1 }), change: previewLocalChangeSchema }),
  Type.Object({ type: Type.Literal("session"), id: Type.Integer({ minimum: 1 }), change: previewLocalChangeSchema }),
]);
const changeSchema = Type.Object({ scope: Type.String(), writer: Type.String(), revision: Type.Integer({ minimum: 1 }), change: previewLocalChangeSchema });

class PreviewHostController extends Controller {
  static targets = ["frame", "status"];
  static values = { scope: String };
  declare readonly frameTarget: HTMLIFrameElement;
  declare readonly statusTarget: HTMLElement;
  declare readonly scopeValue: string;
  private port?: MessagePort;
  private persistence?: MessagePort;
  private worker?: SharedWorker;
  private changes?: BroadcastChannel;
  private pendingChanges: Array<Static<typeof changeSchema>> = [];
  private writes = Promise.resolve();
  private generation = 0;
  private documentNonce?: string;
  private readonly store = new PreviewStateStore(indexedDB);

  connect(): void {
    // Only a tuple-origin host can share this native channel. Nested opaque
    // hosts persist through their containing preview's scoped database bridge.
    if (globalThis.origin !== "null") {
      this.changes = new BroadcastChannel("kintsugi-preview-local-state");
      this.changes.onmessage = event => {
        const data: unknown = event.data;
        if (Value.Check(changeSchema, data) && data.scope === this.scopeValue && data.writer !== this.documentNonce) {
          if (this.port) this.port.postMessage({ type: "local-change", change: data.change, revision: data.revision, remote: true });
          else this.pendingChanges.push(data);
        }
      };
    }
    window.addEventListener("pagehide", this.ownerClosed);
    window.addEventListener("storage", this.sessionChanged);
    this.announce();
  }
  disconnect(): void { this.generation++; this.port?.close(); this.persistence?.close(); this.ownerClosed(); this.changes?.close(); window.removeEventListener("pagehide", this.ownerClosed); window.removeEventListener("storage", this.sessionChanged); }
  private readonly ownerClosed = (event?: PageTransitionEvent): void => { if (!event?.persisted) this.worker?.port.postMessage("owner-closed"); };
  private openPersistence(): Promise<{ state: PreviewState; port: MessagePort }> {
    this.worker?.port.postMessage("owner-closed");
    const options = { name: "kintsugi-preview-storage-v2", extendedLifetime: true };
    const worker = new SharedWorker("/~preview-assets/state-worker.js", options);
    this.worker = worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Preview storage worker did not connect")), 10000);
      worker.onerror = () => { clearTimeout(timer); reject(new Error("Preview storage worker failed")); };
      worker.port.onmessage = event => {
        clearTimeout(timer);
        try {
          if (event.data?.type !== "connected" || event.ports.length !== 1) throw new Error("Invalid preview storage worker response");
          resolve({ state: parsePreviewState(event.data.state), port: event.ports[0]! });
        } catch (error) { reject(error); }
      };
      worker.port.postMessage({ type: "connect", scope: this.scopeValue });
    });
  }
  private get sessionKey(): string { return `kintsugi:preview-session:${this.scopeValue}`; }
  private readSession(): Array<[string, string]> {
    const values: unknown = JSON.parse(sessionStorage.getItem(this.sessionKey) ?? "[]");
    if (!Value.Check(previewStorageEntriesSchema, values)) throw new Error("Invalid preview session state");
    return values;
  }
  private readonly sessionChanged = (event: StorageEvent): void => {
    if (event.storageArea === sessionStorage && (event.key === this.sessionKey || event.key === null)) this.port?.postMessage({ type: "session-state", values: this.readSession() });
  };
  private saveSession(change: PreviewLocalChange): void {
    const values = new Map(this.readSession()); applyPreviewLocalChange(values, change);
    sessionStorage.setItem(this.sessionKey, JSON.stringify([...values]));
  }
  loaded(): void { this.announce(); }
  private announce(): void { this.frameTarget.contentWindow?.postMessage({ type: "kintsugi:preview-host-ready" }, "*"); }

  async receive(event: MessageEvent): Promise<void> {
    if (event.source !== this.frameTarget.contentWindow || event.origin !== "null" || !Value.Check(readySchema, event.data)) return;
    if (this.documentNonce === event.data.nonce) return;
    this.documentNonce = event.data.nonce;
    const generation = ++this.generation;
    this.port?.close(); this.port = undefined;
    try {
      await this.writes;
      const persistent = globalThis.origin === "null" ? undefined : await this.openPersistence();
      const state = persistent ? persistent.state : await this.store.load(this.scopeValue);
      if (generation !== this.generation) { persistent?.port.postMessage({ type: "close" }); return; }
      const channel = new MessageChannel(), database = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = event => {
        const data: unknown = event.data;
        if (Value.Check(Type.Object({ type: Type.Literal("close") }), data)) { this.writes = this.writes.then(() => database.port1.close()); return; }
        if (Value.Check(Type.Object({ type: Type.Literal("persisted") }), data)) { this.statusTarget.textContent = "Preview state saved"; return; }
        if (!Value.Check(saveSchema, data)) { this.fail(new Error("Invalid preview persistence message")); return; }
        this.writes = this.writes.then(async () => {
          if (data.type === "local") {
            const saved = await this.store.saveLocal(this.scopeValue, data.change);
            channel.port1.postMessage({ type: "local-change", change: data.change, revision: saved.state.revision, remote: false });
            if (saved.changed) this.changes?.postMessage({ scope: this.scopeValue, writer: this.documentNonce, revision: saved.state.revision, change: data.change });
          } else if (data.type === "session") this.saveSession(data.change);
          else await this.store.saveDatabases(this.scopeValue, parsePreviewState(data.state));
          channel.port1.postMessage({ type: "saved", id: data.id });
          this.statusTarget.textContent = "Preview state saved";
        }).catch(error => { channel.port1.postMessage({ type: "save-error", id: data.id }); this.fail(error); });
      };
      database.port1.onmessage = this.port.onmessage;
      if (persistent) { database.port1.close(); database.port2.close(); }
      else this.persistence = database.port1;
      this.frameTarget.contentWindow!.postMessage({ type: "kintsugi:preview-connect", version: 2, nonce: this.documentNonce, state, session: this.readSession() }, "*", [channel.port2, persistent ? persistent.port : database.port2]);
      for (const data of this.pendingChanges) channel.port1.postMessage({ type: "local-change", change: data.change, revision: data.revision, remote: true });
      this.pendingChanges = [];
      this.statusTarget.textContent = "Preview state restored";
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    this.statusTarget.textContent = "Preview settings could not be saved. Reloading may lose recent changes.";
    this.statusTarget.setAttribute("role", "alert");
    console.error("Preview persistence failed", error);
  }
}

Application.start().register("preview-host", PreviewHostController);
