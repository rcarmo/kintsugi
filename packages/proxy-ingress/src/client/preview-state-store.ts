import { applyPreviewLocalChange, initialPreviewState, parsePreviewState, type PreviewLocalChange, type PreviewState } from "../preview-state.ts";

/** The host chooses the scope; the opaque child never supplies a workspace or storage key. */
export class PreviewStateStore {
  constructor(private readonly factory: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    // Version 2 fences out old whole-snapshot writers after upgrading storage.
    const request = this.factory.open("kintsugi-isolated-previews", 2);
    request.onupgradeneeded = event => { if (event.oldVersion === 0) request.result.createObjectStore("states"); };
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
    await this.update(scope, current => { current.local = state.local; current.databases = state.databases; });
  }

  async saveLocal(scope: string, change: PreviewLocalChange): Promise<{ state: PreviewState; changed: boolean }> {
    let changed = false;
    const state = await this.update(scope, current => {
      const values = new Map(current.local);
      changed = change.kind === "clear" ? values.size > 0 : change.kind === "remove" ? values.has(change.key) : values.get(change.key) !== change.value;
      applyPreviewLocalChange(values, change); current.local = [...values];
    });
    return { state, changed };
  }

  async saveDatabases(scope: string, input: PreviewState): Promise<void> {
    const state = parsePreviewState(input);
    await this.update(scope, current => { current.databases = state.databases; });
  }

  /** Read and modify in one native transaction, including across host instances/tabs. */
  private async update(scope: string, mutate: (state: PreviewState) => void): Promise<PreviewState> {
    const db = await this.open();
    try {
      const transaction = db.transaction("states", "readwrite"), store = transaction.objectStore("states");
      let failure: unknown, result: PreviewState;
      const done = new Promise<PreviewState>((resolve, reject) => {
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Could not persist preview state"));
      });
      const request = store.get(scope);
      request.onsuccess = () => {
        try {
          const state = request.result === undefined ? initialPreviewState() : parsePreviewState(request.result);
          if (state.revision === Number.MAX_SAFE_INTEGER) throw new Error("Preview storage revision exhausted");
          mutate(state); state.revision++; result = state; store.put(state, scope);
        } catch (error) { failure = error; transaction.abort(); }
      };
      return await done;
    } finally { db.close(); }
  }
}
