import { Value } from "typebox/value";
import { previewSourceRequest, previewSourceUrl } from "../preview-source.ts";

// Fixed platform code, always sandboxed. Workspace source is uploaded, never evaluated here.
const parentWindow = window.parent;
const nonce = new URL(location.href).hash.slice(1);
let connected = false;
window.addEventListener("message", event => {
  if (!event.isTrusted || event.source !== parentWindow || event.origin !== "null" || event.data?.type !== "kintsugi:source-host-connect" || event.data.nonce !== nonce || event.ports.length !== 1 || connected) return;
  connected = true;
  const port = event.ports[0]!;
  port.onmessage = event => {
    const request: unknown = event.data;
    if (!Value.Check(previewSourceRequest, request) || (request.type === "put" && !(request.blob instanceof Blob))) { port.postMessage({ type: "error", message: "Invalid generated source request" }); return; }
    void fetch(previewSourceUrl(location.origin, request.context, request.id), { method: request.type === "put" ? "PUT" : "DELETE", body: request.type === "put" && request.blob instanceof Blob ? request.blob : undefined, headers: request.type === "put" && request.original ? { "x-kintsugi-source-original": request.original } : undefined, credentials: "omit", referrerPolicy: "no-referrer" }).then(async response => {
      if (!response.ok) throw new Error(`Generated source ${request.type} failed: ${response.status} ${await response.text()}`);
    }).catch(error => port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }));
  };
});
parentWindow.postMessage({ type: "kintsugi:source-host-ready", nonce }, "*");
