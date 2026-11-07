import { initialPreviewState, parsePreviewState, type PreviewState } from "../preview-state.ts";

/** The host chooses the scope; the opaque child never supplies a workspace or storage key. */
export class PreviewStateStore {
  constructor(private readonly factory: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    const request = this.factory.open("kintsugi-isolated-previews", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("states");
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }

  async load(scope: string): Promise<PreviewState> {
    const db = await this.open();
    try {
      const request = db.transaction("states").objectStore("states").get(scope);
      const state: unknown = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      return state === undefined ? initialPreviewState() : parsePreviewState(state);
    } finally { db.close(); }
  }

  async save(scope: string, input: PreviewState): Promise<void> {
    const state = parsePreviewState(input);
    const db = await this.open();
    try {
      const transaction = db.transaction("states", "readwrite");
      transaction.objectStore("states").put(state, scope);
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error("Could not persist preview state"));
      });
    } finally { db.close(); }
  }
}
