import { Application, Controller } from "@hotwired/stimulus";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { PreviewFlushChannel, previewHostFlushSchema, previewNestedStorageSchema, previewStorageScope } from "../preview-persistence-protocol.ts";
import { applyPreviewLocalChange, parsePreviewState, previewLocalChangeSchema, previewStorageEntriesSchema, type PreviewLocalChange, type PreviewState } from "../preview-state.ts";

const readySchema = Type.Object({ type: Type.Literal("kintsugi:preview-ready"), version: Type.Literal(2), nonce: Type.String({ minLength: 36, maxLength: 36 }) });
const sessionSchema = Type.Object({ type: Type.Literal("session"), id: Type.Integer({ minimum: 1 }), change: previewLocalChangeSchema }, { additionalProperties: false });
interface PersistenceConnection {
  state: PreviewState;
  port: MessagePort;
  scope: string;
  session: Array<[string, string]>;
  /** Nested session writes go back to the native, tab-owned sessionStorage. */
  control?: MessagePort;
  close(): void;
}

class PreviewHostController extends Controller {
  static targets = ["frame", "status"];
  static values = { scope: String };
  declare readonly frameTarget: HTMLIFrameElement;
  declare readonly statusTarget: HTMLElement;
  declare readonly scopeValue: string;
  private port?: MessagePort;
  private persistence?: PersistenceConnection;
  private readonly children = new Map<MessagePort, PersistenceConnection>();
  private pendingChildren = 0;
  private writes = Promise.resolve();
  private generation = 0;
  private documentNonce?: string;
  private readonly flushing = new PreviewFlushChannel(message => {
    if (!this.port) throw new Error("Preview persistence is not ready");
    this.port.postMessage(message);
  });

  connect(): void {
    window.addEventListener("pagehide", this.ownerClosed);
    window.addEventListener("storage", this.sessionChanged);
    this.announce();
  }
  disconnect(): void { this.flushing.close(); this.generation++; this.port?.close(); this.closePersistence(); window.removeEventListener("pagehide", this.ownerClosed); window.removeEventListener("storage", this.sessionChanged); }
  private readonly ownerClosed = (event?: PageTransitionEvent): void => { if (!event?.persisted) this.closePersistence(); };
  private closePersistence(): void {
    this.persistence?.close(); this.persistence = undefined;
    for (const [control, connection] of this.children) { connection.close(); control.close(); }
    this.children.clear();
  }
  private openPersistence(scopes = [this.scopeValue]): Promise<PersistenceConnection> {
    const scope = previewStorageScope(scopes), opaque = globalThis.origin === "null";
    const worker = opaque ? undefined : new SharedWorker("/~preview-assets/state-worker.js", { name: "kintsugi-preview-storage-v2" });
    const channel = opaque ? new MessageChannel() : undefined;
    const control = worker ? worker.port : channel!.port1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { control.postMessage("owner-closed"); reject(new Error("Preview storage host did not connect")); }, 10000);
      if (worker) worker.onerror = () => { clearTimeout(timer); reject(new Error("Preview storage worker failed")); };
      control.onmessage = event => {
        clearTimeout(timer);
        try {
          if (event.data?.type !== "connected" || event.ports.length !== 1) throw new Error("Invalid preview storage host response");
          const session = opaque ? Value.Parse(previewStorageEntriesSchema, event.data.session) : this.readNativeSession(scope);
          resolve({ scope, state: parsePreviewState(event.data.state), port: event.ports[0]!, session, control: opaque ? control : undefined, close: () => control.postMessage("owner-closed") });
        } catch (error) { reject(error); }
      };
      if (channel) window.parent.postMessage({ type: "kintsugi:preview-storage", scopes }, "*", [channel.port2]);
      else control.postMessage({ type: "connect", scope });
    });
  }
  private sessionKey(scope: string): string { return `kintsugi:preview-session:${scope}`; }
  private readNativeSession(scope: string): Array<[string, string]> {
    return Value.Parse(previewStorageEntriesSchema, JSON.parse(sessionStorage.getItem(this.sessionKey(scope)) ?? "[]"));
  }
  private readSession(connection: PersistenceConnection): Array<[string, string]> { return connection.control ? connection.session : this.readNativeSession(connection.scope); }
  private saveSession(scope: string, change: PreviewLocalChange): void {
    const values = new Map(this.readNativeSession(scope)); applyPreviewLocalChange(values, change);
    sessionStorage.setItem(this.sessionKey(scope), JSON.stringify([...values]));
    for (const [control, child] of this.children) if (child.scope === scope) control.postMessage({ type: "session-state", values: [...values] });
  }
  private readonly sessionChanged = (event: StorageEvent): void => {
    if (globalThis.origin === "null" || event.storageArea !== sessionStorage) return;
    if (event.key === this.sessionKey(this.scopeValue) || event.key === null) this.port?.postMessage({ type: "session-state", values: this.readNativeSession(this.scopeValue) });
    for (const [control, child] of this.children) if (event.key === this.sessionKey(child.scope) || event.key === null) control.postMessage({ type: "session-state", values: this.readNativeSession(child.scope) });
  };
  /** Only this host's source port can ask for descendants; every hop prepends its own scope. */
  private async connectChild(scopes: string[], control: MessagePort): Promise<void> {
    let connection: PersistenceConnection | undefined, closed = false;
    const close = () => { closed = true; connection?.close(); this.children.delete(control); control.close(); };
    control.onmessage = event => { if (event.data === "owner-closed") close(); };
    const generation = this.generation;
    if (this.children.size + this.pendingChildren >= 128) { control.postMessage({ type: "error", message: "Nested storage connection capacity exceeded" }); control.close(); return; }
    this.pendingChildren++;
    try {
      connection = await this.openPersistence([this.scopeValue, ...scopes]);
      if (closed || generation !== this.generation) { connection.close(); connection.port.close(); return; }
      const child = connection;
      this.children.set(control, child);
      if (child.control) child.control.onmessage = event => {
        if (Value.Check(previewStorageEntriesSchema, event.data?.values)) child.session = event.data.values;
        control.postMessage(event.data);
      };
      control.onmessage = event => {
        if (event.data === "owner-closed") { close(); return; }
        const data: unknown = event.data;
        if (!Value.Check(sessionSchema, data) || event.ports.length) { control.postMessage({ type: "error", message: "Invalid nested session message" }); return; }
        if (child.control) { child.control.postMessage(data); return; }
        try {
          this.saveSession(child.scope, data.change);
          control.postMessage({ type: "saved", id: data.id });
        } catch (error) { control.postMessage({ type: "save-error", id: data.id }); this.fail(error instanceof Error ? error : new Error(String(error))); }
      };
      control.postMessage({ type: "connected", state: child.state, session: this.readSession(child) }, [child.port]);
    } catch (error) { control.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }); close(); }
    finally { this.pendingChildren--; }
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
    if (event.isTrusted && event.source === this.frameTarget.contentWindow && event.origin === "null" && Value.Check(previewNestedStorageSchema, event.data) && event.ports.length === 1) {
      void this.connectChild(event.data.scopes, event.ports[0]!); return;
    }
    if (event.source !== this.frameTarget.contentWindow || event.origin !== "null" || !Value.Check(readySchema, event.data)) return;
    if (this.documentNonce === event.data.nonce) return;
    this.documentNonce = event.data.nonce;
    this.flushing.close();
    const generation = ++this.generation;
    this.port?.close(); this.port = undefined;
    try {
      await this.writes;
      this.closePersistence();
      const persistent = await this.openPersistence();
      if (generation !== this.generation) { persistent.close(); persistent.port.close(); return; }
      this.persistence = persistent;
      const channel = new MessageChannel();
      this.port = channel.port1;
      if (persistent.control) persistent.control.onmessage = event => {
        if (Value.Check(previewStorageEntriesSchema, event.data?.values)) persistent.session = event.data.values;
        channel.port1.postMessage(event.data);
      };
      this.port.onmessage = event => {
        const data: unknown = event.data;
        if (this.flushing.receive(data)) return;
        if (Value.Check(previewNestedStorageSchema, data) && event.ports.length === 1) { void this.connectChild(data.scopes, event.ports[0]!); return; }
        if (Value.Check(Type.Object({ type: Type.Literal("persisted") }), data)) return;
        if (!Value.Check(sessionSchema, data)) { this.fail(new Error("Invalid preview persistence message")); return; }
        this.writes = this.writes.then(() => {
          if (persistent.control) { persistent.control.postMessage(data); return; }
          this.saveSession(persistent.scope, data.change);
          channel.port1.postMessage({ type: "saved", id: data.id });
        }).catch(error => { channel.port1.postMessage({ type: "save-error", id: data.id }); this.fail(error); });
      };
      this.frameTarget.contentWindow!.postMessage({ type: "kintsugi:preview-connect", version: 2, nonce: this.documentNonce, state: persistent.state, session: this.readSession(persistent) }, "*", [channel.port2, persistent.port]);
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    this.statusTarget.textContent = "Preview settings could not be saved. Reloading may lose recent changes.";
    this.statusTarget.setAttribute("role", "alert");
    this.statusTarget.hidden = false;
    console.error("Preview persistence failed", error);
  }
}

Application.start().register("preview-host", PreviewHostController);
