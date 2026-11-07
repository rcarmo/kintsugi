import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { restorePreviewDatabases, snapshotPreviewDatabases } from "../src/client/preview-database.ts";

for (const keyPath of [null, "id", "nested.id"] as const) {
  test(`preview restore preserves auto-increment generators after records are deleted (${keyPath})`, async () => {
    const source = new IDBFactory();
    const request = source.open("auto", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath, autoIncrement: true });
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transaction = db.transaction("records", "readwrite");
    const store = transaction.objectStore("records");
    store.add({}); store.add({}); store.add({}); store.clear();
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
    db.close();
    const snapshot = await snapshotPreviewDatabases(source);
    expect(snapshot[0]!.stores[0]!.nextGeneratedKey).toBe(4);
    const target = new IDBFactory();
    await restorePreviewDatabases(target, snapshot);
    expect(await snapshotPreviewDatabases(target)).toEqual(snapshot);
    const reopened = target.open("auto", 1);
    const restored = await new Promise<IDBDatabase>(resolve => { reopened.onsuccess = () => resolve(reopened.result); });
    const write = restored.transaction("records", "readwrite");
    const added = write.objectStore("records").add({});
    expect(await new Promise(resolve => { added.onsuccess = () => resolve(added.result); })).toBe(4);
    await new Promise<void>(resolve => { write.oncomplete = () => resolve(); });
    restored.close();
  });
}

test("preview restore retains an exhausted auto-increment generator", async () => {
  const source = new IDBFactory();
  const request = source.open("exhausted", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("records", { autoIncrement: true });
  const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
  const transaction = db.transaction("records", "readwrite");
  transaction.objectStore("records").put({}, 2 ** 53);
  transaction.objectStore("records").clear();
  await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
  db.close();
  const snapshot = await snapshotPreviewDatabases(source);
  expect(snapshot[0]!.stores[0]!.nextGeneratedKey).toBeNull();
  const target = new IDBFactory();
  await restorePreviewDatabases(target, snapshot);
  expect(await snapshotPreviewDatabases(target)).toEqual(snapshot);
});
