import type { PreviewLocalChange } from "../preview-state.ts";
import { IDBCursor, IDBCursorWithValue, IDBDatabase, IDBFactory, IDBIndex, IDBKeyRange, IDBObjectStore, IDBOpenDBRequest, IDBRequest, IDBTransaction, IDBVersionChangeEvent } from "fake-indexeddb";

export function installPreviewIndexedDB(): void {
  const constructors = { IDBCursor, IDBCursorWithValue, IDBDatabase, IDBFactory, IDBIndex, IDBKeyRange, IDBObjectStore, IDBOpenDBRequest, IDBRequest, IDBTransaction, IDBVersionChangeEvent };
  for (const [name, value] of Object.entries(constructors)) Object.defineProperty(window, name, { configurable: true, writable: true, value });
  Object.defineProperty(window, "indexedDB", { configurable: true, writable: true, value: new IDBFactory() });
}

const cookies = new Map<string, string>();
export function replacePreviewCookies(value: string): void {
  cookies.clear();
  for (const pair of value.split(";")) {
    const split = pair.indexOf("=");
    if (split > 0) cookies.set(pair.slice(0, split).trim(), pair.slice(split + 1));
  }
}

/** Origin-bound browser storage is replaced only inside the opaque preview. */
export function installPreviewStorage(local = new Map<string, string>(), changed: (change: PreviewLocalChange) => void = () => {}, initialCookies = "", session = new Map<string, string>(), sessionChanged: (change: PreviewLocalChange) => void = () => {}): void {
  replacePreviewCookies(initialCookies);
  function storage(values: Map<string, string>, notify: (change: PreviewLocalChange) => void): Storage {
    function set(inputKey: string, inputValue: string): void {
      const key = `${inputKey}`, value = `${inputValue}`;
      notify({ kind: "set", key, value }); values.set(key, value);
    }
    function remove(inputKey: string): void {
      const key = `${inputKey}`;
      notify({ kind: "remove", key }); values.delete(key);
    }
    const methods = {
      get length() { return values.size; },
      clear() { notify({ kind: "clear" }); values.clear(); },
      getItem(key: string) { return values.get(String(key)) ?? null; },
      key(index: number) { return [...values.keys()][index] ?? null; },
      removeItem: remove,
      setItem: set,
    };
    return new Proxy(methods, {
      get(object, key) {
        if (key in object) {
          // SAFETY: Only keys present on the typed Storage methods object are read here.
          return object[key as keyof typeof object];
        }
        return values.get(String(key));
      },
      set(_object, key, value: string) { set(String(key), value); return true; },
      deleteProperty(_object, key) { remove(String(key)); return true; },
      ownKeys() { return [...values.keys()]; },
      getOwnPropertyDescriptor(_object, key) { return values.has(String(key)) ? { enumerable: true, configurable: true, writable: true, value: values.get(String(key)) } : undefined; },
    });
  }
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage(local, changed) });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: storage(session, sessionChanged) });
  Object.defineProperty(Document.prototype, "cookie", {
    configurable: true,
    get() { return [...cookies].map(([name, value]) => `${name}=${value}`).join("; "); },
    set(value: string) {
      const pair = String(value).split(";", 1)[0]!;
      const split = pair.indexOf("=");
      if (split > 0) cookies.set(pair.slice(0, split).trim(), pair.slice(split + 1));
    },
  });
}
