import { Type } from "typebox";
import { Value } from "typebox/value";
import { PreviewPersistenceBroker } from "./preview-persistence-broker.ts";
import { PreviewStateStore } from "./preview-state-store.ts";

// Fixed management-origin code. This worker never imports or evaluates workspace bytes.
const broker = new PreviewPersistenceBroker(new PreviewStateStore(indexedDB));
const setup = Type.Object({ type: Type.Literal("connect"), scope: Type.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false });
addEventListener("connect", event => {
  // WebKit marks even native SharedWorker connect events untrusted. Only
  // same-origin management documents can construct this worker; opaque
  // workspace documents cannot connect, and no workspace code runs here.
  if (!(event instanceof MessageEvent) || event.ports.length !== 1) return;
  const control = event.ports[0]!;
  let connected = false;
  let retired = false;
  let close: (() => void) | undefined;
  control.onmessage = event => {
    const data: unknown = event.data;
    if (data === "owner-closed") { setTimeout(() => { retired = true; close?.(); control.close(); }, 10000); return; }
    if (connected || !Value.Check(setup, data)) { control.postMessage({ type: "error", message: "Invalid preview storage setup" }); return; }
    connected = true;
    void broker.connect(data.scope).then(connection => {
      if (retired) { connection.close(); connection.port.close(); return; }
      close = connection.close;
      control.postMessage({ type: "connected", state: connection.state }, [connection.port]);
    }).catch(error => control.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }));
  };
});
