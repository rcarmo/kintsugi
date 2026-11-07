/** Data-URL workers retain native worker semantics without acquiring management origin. */
export function installPreviewWorkers(): void {
  const blobs = new Map<string, Blob>();
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { const url = create(blob); if (blob instanceof Blob) blobs.set(url, blob); return url; };
  URL.revokeObjectURL = (url) => { blobs.delete(url); revoke(url); };
  const NativeWorker = Worker;
  class PreviewWorker extends NativeWorker {
    constructor(source: string | URL, options: WorkerOptions = {}) {
      const url = new URL(String(source), document.baseURI).href;
      const nonce = crypto.randomUUID();
      const module = options.type === "module";
      const program = `
        const pending = [];
        const nonce = ${JSON.stringify(nonce)};
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
            ${module ? "await import('data:text/javascript,' + encodeURIComponent(script));" : "imports('data:text/javascript,' + encodeURIComponent(script));"}
            self.removeEventListener('message', receive, true);
            for (const message of pending) self.dispatchEvent(message);
            pending.length = 0;
          } catch (error) { setTimeout(() => { throw error; }, 0); }
        };
        self.addEventListener('message', receive, true);
      `;
      super(`data:text/javascript,${encodeURIComponent(program)}`, options);
      const blob = blobs.get(url);
      const script = blob ? blob.text() : Promise.resolve(module ? `await import(${JSON.stringify(url)});` : `importScripts(${JSON.stringify(url)});`);
      void script.then(text => NativeWorker.prototype.postMessage.call(this, { previewBootstrap: nonce, url, source: text })).catch(error => {
        this.dispatchEvent(new ErrorEvent("error", { message: error instanceof Error ? error.message : String(error) }));
      });
    }
  }
  globalThis.Worker = PreviewWorker;
}
