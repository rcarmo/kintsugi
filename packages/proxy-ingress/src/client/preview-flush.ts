import { Value } from "typebox/value";
import { previewHostFlushedSchema } from "../preview-persistence-protocol.ts";
import { previewAppPath, previewUrlContextSchema } from "../preview-url.ts";

const inFlight = new WeakMap<HTMLIFrameElement, Promise<void>>();
/** The wrapper returns only an acknowledgement, never workspace storage data. */
export function flushPreviewFrame(frame: HTMLIFrameElement): Promise<void> {
  const url = URL.parse(frame.src);
  if (!url || url.origin !== window.location.origin) return Promise.resolve();
  let path = url.pathname;
  const opaque = globalThis.origin === "null";
  if (opaque) {
    const configuration = document.querySelector<HTMLMetaElement>('meta[name="kintsugi-preview-context"]');
    if (!configuration) return Promise.reject(new Error("Preview routing context is unavailable"));
    const prefix = previewAppPath(Value.Parse(previewUrlContextSchema, JSON.parse(configuration.content)));
    if (!path.startsWith(`${prefix}/`)) return Promise.resolve();
    path = path.slice(prefix.length);
  }
  if (!/^\/workspaces\/[^/]+\/(?:apps\/[^/]+|ports\/\d+)(?:\/|$)/.test(path)) return Promise.resolve();
  const origin = opaque ? "null" : url.origin;
  const pending = inFlight.get(frame);
  if (pending) return pending;
  const target = frame.contentWindow;
  if (!target) return Promise.reject(new Error("Preview frame is unavailable"));
  const id = crypto.randomUUID();
  const result = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); window.removeEventListener("message", receive); if (error) reject(error); else resolve(); };
    const receive = (event: MessageEvent) => {
      if (!event.isTrusted || event.source !== target || event.origin !== origin || !Value.Check(previewHostFlushedSchema, event.data) || event.data.id !== id) return;
      finish(event.data.saved ? undefined : new Error("Preview settings could not be saved. The view was kept open."));
    };
    const timer = setTimeout(() => finish(new Error("Preview settings did not finish saving. The view was kept open.")), 12000);
    window.addEventListener("message", receive);
    target.postMessage({ type: "kintsugi:preview-flush", id }, opaque ? "*" : origin);
  });
  inFlight.set(frame, result);
  void result.then(() => inFlight.delete(frame), () => inFlight.delete(frame));
  return result;
}
export async function flushPreviewFrames(root: ParentNode): Promise<void> {
  await Promise.all([...root.querySelectorAll<HTMLIFrameElement>("iframe")].map(flushPreviewFrame));
}
