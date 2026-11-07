import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { restorePreviewDatabases, snapshotPreviewDatabases } from "../src/client/preview-database.ts";

function open(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
  const request = factory.open(name, version);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("settings", { keyPath: "id" });
    store.createIndex("type", "type", { unique: false });
    request.result.createObjectStore("binary");
    request.result.createObjectStore("empty", { autoIncrement: true });
  };
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

test("preview storage snapshots preserve database schema and structured-clone values across fresh factories", async () => {
  const source = new IDBFactory();
  const db = await open(source, "workspace-private-state", 4);
  const transaction = db.transaction(["settings", "binary"], "readwrite");
  transaction.objectStore("settings").put({ id: "theme", type: "setting", value: "dark" });
  const cycle = new Map(); cycle.set("self", cycle);
  transaction.objectStore("binary").put({ bytes: new Uint8Array([0, 128, 255]), map: new Map([["one", 1]]), date: new Date("2026-01-01T00:00:00Z"), cycle }, ["compound", 1]);
  await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
  db.close();
  const snapshot = await snapshotPreviewDatabases(source);
  const target = new IDBFactory();
  await restorePreviewDatabases(target, structuredClone(snapshot));
  expect(await snapshotPreviewDatabases(target)).toEqual(snapshot);
  expect(snapshot[0]!.stores.find(store => store.name === "settings")!.indexes).toEqual([{ name: "type", keyPath: "type", unique: false, multiEntry: false }]);
  expect(await snapshotPreviewDatabases(new IDBFactory())).toEqual([]);
});

test("snapshots retain databases with no stores and never expose data from another factory", async () => {
  const source = new IDBFactory();
  const request = source.open("empty", 2);
  await new Promise<void>((resolve, reject) => { request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error); });
  const snapshot = await snapshotPreviewDatabases(source);
  expect(snapshot).toEqual([{ name: "empty", version: 2, stores: [] }]);
  const target = new IDBFactory();
  await restorePreviewDatabases(target, snapshot);
  expect(await snapshotPreviewDatabases(target)).toEqual(snapshot);
  expect(await snapshotPreviewDatabases(new IDBFactory())).toEqual([]);
});

test("invalid restored schema rejects the operation instead of escaping the asynchronous upgrade callback", async () => {
  const store = { name: "duplicate", keyPath: null, autoIncrement: false, indexes: [], records: [] };
  await expect(restorePreviewDatabases(new IDBFactory(), [{ name: "invalid", version: 1, stores: [store, store] }])).rejects.toThrow();
});
