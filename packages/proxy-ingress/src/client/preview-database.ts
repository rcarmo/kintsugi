/** A structured-cloneable snapshot, transported only over a scoped MessagePort. */
export interface PreviewDatabaseSnapshot {
  name: string;
  version: number;
  stores: Array<{
    name: string;
    keyPath: string | string[] | null;
    autoIncrement: boolean;
    nextGeneratedKey?: number | null;
    indexes: Array<{ name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }>;
    records: Array<{ key: unknown; value: unknown }>;
  }>;
}

async function nextGeneratedKey(db: IDBDatabase, name: string): Promise<number | null> {
  const transaction = db.transaction(name, "readwrite");
  const request = transaction.objectStore(name).add({});
  // Probe the public API and deliberately roll back: deleted generated keys must
  // not be reused after restoring a snapshot.
  return new Promise((resolve, reject) => {
    let key: number | null = null;
    request.onsuccess = () => {
      key = Number(request.result);
      transaction.abort();
    };
    request.onerror = event => {
      event.preventDefault();
      if (request.error?.name !== "ConstraintError") reject(request.error);
      transaction.abort();
    };
    transaction.onabort = () => resolve(key);
  });
}

interface KeyPathObject { [name: string]: KeyPathObject | number }
function generatedKeyValue(keyPath: string | string[], key: number): KeyPathObject {
  if (Array.isArray(keyPath)) throw new Error("Auto-increment stores cannot have compound key paths");
  const value: KeyPathObject = {};
  let target = value;
  const parts = keyPath.split(".");
  for (const part of parts.slice(0, -1)) {
    const child: KeyPathObject = {};
    Object.defineProperty(target, part, { value: child, enumerable: true, configurable: true, writable: true });
    target = child;
  }
  Object.defineProperty(target, parts.at(-1)!, { value: key, enumerable: true, configurable: true, writable: true });
  return value;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Preview storage transaction aborted")), { once: true });
  });
}

export async function snapshotPreviewDatabases(factory: IDBFactory): Promise<PreviewDatabaseSnapshot[]> {
  const snapshots: PreviewDatabaseSnapshot[] = [];
  for (const entry of await factory.databases()) {
    const db = await requestResult(factory.open(entry.name!, entry.version));
    try {
      const snapshot: PreviewDatabaseSnapshot = { name: db.name, version: db.version, stores: [] };
      const names = [...db.objectStoreNames];
      if (names.length) {
        const transaction = db.transaction(names, "readonly");
        const done = transactionDone(transaction);
        const reads = names.map(async name => {
          const store = transaction.objectStore(name);
          const indexes = [...store.indexNames].map(name => {
            const index = store.index(name);
            return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
          });
          const keys = requestResult(store.getAllKeys());
          const values = requestResult(store.getAll());
          const [recordKeys, recordValues] = await Promise.all([keys, values]);
          return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, records: recordKeys.map((key, index) => ({ key, value: recordValues[index] })) };
        });
        const stores = Promise.all(reads);
        await Promise.all([stores, done]);
        snapshot.stores = await stores;
        for (const store of snapshot.stores) if (store.autoIncrement) store.nextGeneratedKey = await nextGeneratedKey(db, store.name);
      }
      snapshots.push(snapshot);
    } finally { db.close(); }
  }
  return snapshots;
}

/** Restore before loading the preview application, not while it has open connections. */
export async function restorePreviewDatabases(factory: IDBFactory, snapshots: PreviewDatabaseSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    const request = factory.open(snapshot.name, snapshot.version);
    let upgradeFailure: Error | undefined;
    request.addEventListener("upgradeneeded", () => {
      try {
        for (const spec of snapshot.stores) {
          const store = request.result.createObjectStore(spec.name, { keyPath: spec.keyPath, autoIncrement: spec.autoIncrement });
          for (const index of spec.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
      } catch (error) {
        upgradeFailure = error instanceof Error ? error : new Error(String(error));
        request.transaction!.abort();
      }
    }, { once: true });
    const db = await requestResult(request).catch(error => { throw upgradeFailure ?? error; });
    try {
      if (!snapshot.stores.length) continue;
      const transaction = db.transaction(snapshot.stores.map(store => store.name), "readwrite");
      const done = transactionDone(transaction);
      for (const spec of snapshot.stores) {
        const store = transaction.objectStore(spec.name);
        if (spec.autoIncrement && spec.nextGeneratedKey !== undefined && spec.nextGeneratedKey !== 1) {
          const seed = spec.nextGeneratedKey === null ? 2 ** 53 : spec.nextGeneratedKey - 1;
          if (spec.keyPath === null) store.put({}, seed);
          else store.put(generatedKeyValue(spec.keyPath, seed));
          store.delete(seed);
        }
        for (const record of spec.records) {
          if (spec.keyPath === null) {
            // SAFETY: IDBObjectStore.put validates persisted keys using native IndexedDB key rules.
            store.put(record.value, record.key as IDBValidKey);
          } else store.put(record.value);
        }
      }
      await done;
    } finally { db.close(); }
  }
}
