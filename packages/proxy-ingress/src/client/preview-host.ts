import { Application, Controller } from "@hotwired/stimulus";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { PreviewFlushChannel, previewHostFlushSchema } from "../preview-persistence-protocol.ts";
import { PreviewStateStore } from "./preview-state-store.ts";
import { PreviewPersistenceBroker } from "./preview-persistence-broker.ts";
import { applyPreviewLocalChange, parsePreviewState, previewLocalChangeSchema, previewStorageEntriesSchema, type PreviewLocalChange, type PreviewState } from "../preview-state.ts";

const readySchema = Type.Object({ type: Type.Literal("kintsugi:preview-ready"), version: Type.Literal(2), nonce: Type.String({ minLength: 36, maxLength: 36 }) });
const sessionSchema = Type.Object({ type: Type.Literal("session"), id: Type.Integer({ minimum: 1 }), change: previewLocalChangeSchema }, { additionalProperties: false });

class PreviewHostController extends Controller {
  static targets = ["frame", "status"];
  static values = { scope: String };
  declare readonly frameTarget: HTMLIFrameElement;
  declare readonly statusTarget: HTMLElement;
  declare readonly scopeValue: string;
  private port?: MessagePort;
  private persistence?: { close(): void };
  private writes = Promise.resolve();
  private generation = 0;
  private documentNonce?: string;
  private readonly broker = new PreviewPersistenceBroker(new PreviewStateStore(indexedDB));
  private readonly flushing = new PreviewFlushChannel(message => {
    if (!this.port) throw new Error("Preview persistence is not ready");
    this.port.postMessage(message);
  });

  connect(): void {
    window.addEventListener("pagehide", this.ownerClosed);
    window.addEventListener("storage", this.sessionChanged);
    this.announce();
  }
  disconnect(): void { this.flushing.close(); this.generation++; this.port?.close(); this.ownerClosed(); window.removeEventListener("pagehide", this.ownerClosed); window.removeEventListener("storage", this.sessionChanged); }
  private readonly ownerClosed = (event?: PageTransitionEvent): void => { if (!event?.persisted) this.persistence?.close(); };
  private openPersistence(): Promise<{ state: PreviewState; port: MessagePort; close(): void }> {
    // Opaque nested hosts use the same broker, backed by their containing
    // preview's storage. Only management-origin hosts can open this worker.
    if (globalThis.origin === "null") return this.broker.connect(this.scopeValue);
    const worker = new SharedWorker("/~preview-assets/state-worker.js", { name: "kintsugi-preview-storage-v2" });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Preview storage worker did not connect")), 10000);
      worker.onerror = () => { clearTimeout(timer); reject(new Error("Preview storage worker failed")); };
      worker.port.onmessage = event => {
        clearTimeout(timer);
        try {
          if (event.data?.type !== "connected" || event.ports.length !== 1) throw new Error("Invalid preview storage worker response");
          resolve({ state: parsePreviewState(event.data.state), port: event.ports[0]!, close: () => worker.port.postMessage("owner-closed") });
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
    if (event.isTrusted && event.source === window.parent && Value.Check(previewHostFlushSchema, event.data)) {
      const id = event.data.id, parent = window.parent, generation = this.generation;
      try {
        await this.flushing.flush(); await this.writes;
        if (generation !== this.generation) throw new Error("Preview document changed while saving");
        parent.postMessage({ type: "kintsugi:preview-flushed", id, saved: true }, "*");
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        parent.postMessage({ type: "kintsugi:preview-flushed", id, saved: false }, "*");
      }
      return;
    }
    if (event.source !== this.frameTarget.contentWindow || event.origin !== "null" || !Value.Check(readySchema, event.data)) return;
    if (this.documentNonce === event.data.nonce) return;
    this.documentNonce = event.data.nonce;
    this.flushing.close();
    const generation = ++this.generation;
    this.port?.close(); this.port = undefined;
    try {
      await this.writes;
      this.persistence?.close();
      const persistent = await this.openPersistence();
      if (generation !== this.generation) { persistent.close(); persistent.port.close(); return; }
      this.persistence = persistent;
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = event => {
        const data: unknown = event.data;
        if (this.flushing.receive(data)) return;
        if (Value.Check(Type.Object({ type: Type.Literal("persisted") }), data)) { this.statusTarget.textContent = "Preview state saved"; return; }
        if (!Value.Check(sessionSchema, data)) { this.fail(new Error("Invalid preview persistence message")); return; }
        this.writes = this.writes.then(() => {
          this.saveSession(data.change);
          channel.port1.postMessage({ type: "saved", id: data.id });
          this.statusTarget.textContent = "Preview state saved";
        }).catch(error => { channel.port1.postMessage({ type: "save-error", id: data.id }); this.fail(error); });
      };
      this.frameTarget.contentWindow!.postMessage({ type: "kintsugi:preview-connect", version: 2, nonce: this.documentNonce, state: persistent.state, session: this.readSession() }, "*", [channel.port2, persistent.port]);
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
