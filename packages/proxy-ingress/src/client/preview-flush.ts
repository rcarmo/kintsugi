import { Value } from "typebox/value";
import { previewHostFlushedSchema } from "../preview-persistence-protocol.ts";

const inFlight = new WeakMap<HTMLIFrameElement, Promise<void>>();
/** The wrapper returns only an acknowledgement, never workspace storage data. */
export function flushPreviewFrame(frame: HTMLIFrameElement): Promise<void> {
  const url = URL.parse(frame.src);
  if (!url || url.origin !== window.location.origin || !/^\/workspaces\/[^/]+\/(?:apps\/[^/]+|ports\/\d+)(?:\/|$)/.test(url.pathname)) return Promise.resolve();
  const pending = inFlight.get(frame);
  if (pending) return pending;
  const target = frame.contentWindow;
  if (!target) return Promise.reject(new Error("Preview frame is unavailable"));
  const id = crypto.randomUUID();
  const result = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); window.removeEventListener("message", receive); if (error) reject(error); else resolve(); };
    const receive = (event: MessageEvent) => {
      if (!event.isTrusted || event.source !== target || event.origin !== url.origin || !Value.Check(previewHostFlushedSchema, event.data) || event.data.id !== id) return;
      finish(event.data.saved ? undefined : new Error("Preview settings could not be saved. The view was kept open."));
    };
    const timer = setTimeout(() => finish(new Error("Preview settings did not finish saving. The view was kept open.")), 12000);
    window.addEventListener("message", receive);
    target.postMessage({ type: "kintsugi:preview-flush", id }, url.origin);
  });
  inFlight.set(frame, result);
  void result.then(() => inFlight.delete(frame), () => inFlight.delete(frame));
  return result;
}
export async function flushPreviewFrames(root: ParentNode): Promise<void> {
  await Promise.all([...root.querySelectorAll<HTMLIFrameElement>("iframe")].map(flushPreviewFrame));
}
