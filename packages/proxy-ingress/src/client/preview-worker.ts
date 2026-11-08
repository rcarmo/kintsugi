import { mapPreviewUrl, previewWindowParameter, previewWorkerContext, type PreviewUrlContext } from "../preview-url.ts";
import { rewritePreviewJavaScript } from "../preview-javascript.ts";
import { parse } from "@babel/parser";

/** Data-URL workers retain native worker semantics without acquiring management origin. */
export function installPreviewWorkers(context?: PreviewUrlContext): void {
  const blobs = new Map<string, Blob>();
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { const url = create(blob); if (blob instanceof Blob) blobs.set(url, blob); return url; };
  URL.revokeObjectURL = (url) => { blobs.delete(url); revoke(url); };
  const NativeWorker = Worker;
  class PreviewWorker extends NativeWorker {
    #ready = false;
    #pending: Array<{ message: unknown; transfer: Transferable[] }> = [];
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native Worker messages accept arbitrary structured-clone values, validated by structuredClone/postMessage.
    postMessage(message: unknown, options: Transferable[] | StructuredSerializeOptions = []): void {
      const transfer = Array.isArray(options) ? options : options?.transfer ?? [];
      if (this.#ready) { NativeWorker.prototype.postMessage.call(this, message, { transfer }); return; }
      this.#pending.push(structuredClone({ message, transfer }, { transfer }));
    }
    terminate(): void { this.#pending.length = 0; super.terminate(); }
    constructor(source: string | URL, options: WorkerOptions = {}) {
      const raw = new URL(String(source), document.baseURI).href;
      const sourceUrl = new URL(context ? mapPreviewUrl(raw, context) : raw);
      if (context && sourceUrl.origin === context.publicOrigin && sourceUrl.pathname.startsWith(context.root)) sourceUrl.searchParams.delete(previewWindowParameter);
      const url = sourceUrl.href;
      const nonce = crypto.randomUUID();
      const module = options.type === "module";
      const program = `
        const pending = [];
        const nonce = ${JSON.stringify(nonce)};
        const ready = self.postMessage.bind(self);
        let bootstrapping = false;
        const receive = async event => {
          event.stopImmediatePropagation();
          if (bootstrapping || event.data?.previewBootstrap !== nonce) { pending.push(event); return; }
          bootstrapping = true;
          const script = event.data.source;
          const entry = event.data.url;
          const imports = self.importScripts.bind(self);
          self.importScripts = (...urls) => imports(...urls.map(url => new URL(String(url), entry).href));
          try {
            ${context ? `self.__kintsugiPreviewWorkerContext = { context: ${JSON.stringify({ ...context, cookies: document.cookie })}, entry };
            ${module ? `await import(${JSON.stringify(new URL("/~preview-assets/worker.js", context.publicOrigin).href)});` : `imports(${JSON.stringify(new URL("/~preview-assets/worker.js", context.publicOrigin).href)});`}` : ""}
            if (event.data.blob) {
              const worker = new Worker('data:text/javascript,' + encodeURIComponent(script), { type: ${JSON.stringify(module ? "module" : "classic")}, name: 'kintsugi-worker:' + JSON.stringify({ context: ${JSON.stringify(context ? { ...context, cookies: document.cookie } : undefined)}, entry, name: self.name }) });
              worker.addEventListener('message', event => {
                if (event.data?.previewReady === nonce) {
                  self.removeEventListener('message', receive, true);
                  self.addEventListener('message', message => worker.postMessage(message.data, [...message.ports]));
                  for (const message of pending) worker.postMessage(message.data, [...message.ports]);
                  pending.length = 0;
                  ready({ previewReady: nonce });
                } else ready(event.data, [...event.ports]);
              });
              worker.addEventListener('error', event => { event.preventDefault(); setTimeout(() => { throw new Error(event.message); }, 0); });
              return;
            }
            ${module ? "await import(entry);" : "self.importScripts(entry);"}
            self.removeEventListener('message', receive, true);
            ready({ previewReady: nonce });
            for (const message of pending) self.dispatchEvent(new MessageEvent('message', { data: message.data, ports: message.ports, origin: message.origin, lastEventId: message.lastEventId }));
            pending.length = 0;
          } catch (error) { setTimeout(() => { throw error; }, 0); }
        };
        self.addEventListener('message', receive, true);
      `;
      super(`data:text/javascript,${encodeURIComponent(program)}`, options);
      this.addEventListener("message", event => {
        if (!event.isTrusted || event.data?.previewReady !== nonce) return;
        event.stopImmediatePropagation();
        if (this.#ready) return;
        this.#ready = true;
        for (const queued of this.#pending) NativeWorker.prototype.postMessage.call(this, queued.message, { transfer: queued.transfer });
        this.#pending.length = 0;
      }, { capture: true });
      const blob = blobs.get(url);
      const script = blob ? blob.text().then(text => {
        const source = context ? rewritePreviewJavaScript(text, { ...previewWorkerContext(url, context), windowGlobals: false }) : text;
        const runtime = context ? JSON.stringify(new URL("/~preview-assets/worker.js", context.publicOrigin).href) : undefined;
        const bootstrap = runtime ? module ? `import ${runtime};\n` : `importScripts(${runtime});\n` : `(()=>{const post=self.postMessage.bind(self);self.__kintsugiPreviewWorkerReady=nonce=>post({previewReady:nonce})})();\n`;
        const offset = module ? 0 : parse(source, { sourceType: "script" }).program.directives.at(-1)?.end ?? 0;
        return source.slice(0, offset) + "\n" + bootstrap + source.slice(offset) + `\n;self.__kintsugiPreviewWorkerReady(${JSON.stringify(nonce)});\n`;
      }) : Promise.resolve("");
      void script.then(text => NativeWorker.prototype.postMessage.call(this, { previewBootstrap: nonce, url, source: text, blob: Boolean(blob) })).catch(error => {
        this.dispatchEvent(new ErrorEvent("error", { message: error instanceof Error ? error.message : String(error) }));
      });
    }
  }
  globalThis.Worker = PreviewWorker;
}
