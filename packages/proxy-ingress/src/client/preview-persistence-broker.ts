import { Type } from "typebox";
import { Value } from "typebox/value";
import { parsePreviewState, previewLocalChangeSchema, type PreviewState } from "../preview-state.ts";
import { PreviewStateStore } from "./preview-state-store.ts";

const id = Type.Integer({ minimum: 1 });
const command = Type.Union([
  Type.Object({ type: Type.Literal("local"), id, change: previewLocalChangeSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("save"), id, state: Type.Unknown() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("close") }, { additionalProperties: false }),
]);

/** A connection's scope is chosen by the trusted host, never by its messages. */
export class PreviewPersistenceBroker {
  private readonly clients = new Map<string, Set<MessagePort>>();
  private readonly writes = new Map<string, Promise<void>>();
  private count = 0;
  constructor(private readonly store: PreviewStateStore) {}

  async connect(scope: string): Promise<{ port: MessagePort; state: PreviewState; close(): void }> {
    if (this.count >= 4096 || (this.clients.get(scope)?.size ?? 0) >= 128) throw new Error("Preview storage connection capacity exceeded");
    const channel = new MessageChannel();
    const clients = this.clients.get(scope) ?? new Set<MessagePort>();
    clients.add(channel.port1); this.clients.set(scope, clients); this.count++;
    const close = () => {
      if (!clients.delete(channel.port1)) return;
      this.count--; channel.port1.close();
      if (!clients.size) this.clients.delete(scope);
    };
    try {
      await this.writes.get(scope);
      const state = await this.store.load(scope);
      let previousDatabases = state.databases;
      channel.port1.onmessage = event => {
        const data: unknown = event.data;
        if (!Value.Check(command, data)) {
          console.error("Invalid preview storage command", [...Value.Errors(command, data)].map(error => ({ path: error.instancePath, message: error.message })));
          channel.port1.postMessage({ type: "save-error", id: Value.Check(Type.Object({ id }), data) ? data.id : 0 }); return;
        }
        const pending = this.writes.get(scope) ?? Promise.resolve();
        const next = pending.then(async () => {
          if (data.type === "close") { close(); return; }
          if (data.type === "local") {
            const saved = await this.store.saveLocal(scope, data.change);
            for (const client of clients) if (client === channel.port1 || saved.changed) client.postMessage({ type: "local-change", change: data.change, revision: saved.state.revision, remote: client !== channel.port1 });
          } else {
            const snapshot = parsePreviewState(data.state);
            await this.store.saveDatabases(scope, snapshot, previousDatabases);
            previousDatabases = snapshot.databases;
          }
          channel.port1.postMessage({ type: "saved", id: data.id });
        }).catch(error => {
          channel.port1.postMessage({ type: "save-error", id: data.type === "close" ? 0 : data.id });
          console.error("Preview storage commit failed", error);
        });
        this.writes.set(scope, next);
        void next.then(() => { if (this.writes.get(scope) === next) this.writes.delete(scope); });
      };
      return { state, port: channel.port2, close };
    } catch (error) { close(); throw error; }
  }
}
