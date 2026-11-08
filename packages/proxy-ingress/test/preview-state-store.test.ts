import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { initialPreviewState } from "../src/preview-state.ts";
import { PreviewStateStore } from "../src/client/preview-state-store.ts";

test("preview persistence stores structured-cloneable state under a host-owned scope", async () => {
  const factory = new IDBFactory();
  const store = new PreviewStateStore(factory);
  const state = initialPreviewState();
  state.local.push(["theme", "dark"]);
  state.databases.push({ name: "vscode", version: 1, stores: [{ name: "state", keyPath: null, autoIncrement: false, indexes: [], records: [{ key: "binary", value: new Uint8Array([0, 255]) }] }] });
  await store.save("workspace-one:vscode", state);
  expect(await new PreviewStateStore(factory).load("workspace-one:vscode")).toEqual({ ...state, revision: 1 });
  expect(await store.load("workspace-two:vscode")).toEqual(initialPreviewState());
  expect(await store.load("workspace-one:browser")).toEqual(initialPreviewState());
});

test("independent hosts apply local changes atomically without overwriting sibling keys", async () => {
  const factory = new IDBFactory(), one = new PreviewStateStore(factory), two = new PreviewStateStore(factory);
  await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 ? one : two).saveLocal("shared", { kind: "set", key: String(index), value: String(index) })));
  const state = await one.load("shared");
  expect(new Map(state.local).size).toBe(30);
  for (let index = 0; index < 30; index++) expect(new Map(state.local).get(String(index))).toBe(String(index));
  await two.saveDatabases("shared", initialPreviewState());
  expect((await one.load("shared")).local).toEqual(state.local);
  expect(await one.load("sibling")).toEqual(initialPreviewState());
});

test("local remove/clear affect only the chosen scope and preserve database state", async () => {
  const store = new PreviewStateStore(new IDBFactory()), state = initialPreviewState();
  state.databases.push({ name: "data", version: 1, stores: [] });
  await store.save("one", state);
  await store.saveLocal("one", { kind: "set", key: "__proto__", value: "data" });
  await store.saveLocal("one", { kind: "set", key: "preserved", value: "yes" });
  await store.saveLocal("two", { kind: "set", key: "other", value: "scope" });
  await store.saveLocal("one", { kind: "remove", key: "__proto__" });
  expect((await store.load("one")).local).toEqual([["preserved", "yes"]]);
  await store.saveLocal("one", { kind: "clear" });
  expect(await store.load("one")).toEqual({ ...state, revision: 5 });
  expect((await store.load("two")).local).toEqual([["other", "scope"]]);
});

test("invalid persistence messages cannot replace a previous saved state", async () => {
  const store = new PreviewStateStore(new IDBFactory());
  const state = initialPreviewState(); state.local.push(["key", "preserved"]);
  await store.save("one", state);
  const invalid = initialPreviewState();
  invalid.databases.push({ name: "broken", version: 0, stores: [] });
  await expect(store.save("one", invalid)).rejects.toThrow("Invalid preview storage state");
  expect(await store.load("one")).toEqual({ ...state, revision: 1 });
});

test("storage upgrades preserve old snapshots and fence out obsolete whole-state writers", async () => {
  const factory = new IDBFactory(), request = factory.open("kintsugi-isolated-previews", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("states");
  const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const transaction = db.transaction("states", "readwrite");
  transaction.objectStore("states").put({ version: 1, local: [["old", "preserved"]], databases: [] }, "one");
  await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
  db.close();
  const store = new PreviewStateStore(factory);
  expect(await store.load("one")).toEqual({ version: 2, revision: 0, local: [["old", "preserved"]], databases: [] });
  const saved = await store.saveLocal("one", { kind: "set", key: "new", value: "yes" });
  expect(saved.state.revision).toBe(1);
  expect(new Map(saved.state.local).get("old")).toBe("preserved");
  const obsolete = factory.open("kintsugi-isolated-previews", 1);
  await expect(new Promise((resolve, reject) => { obsolete.onsuccess = () => resolve(obsolete.result); obsolete.onerror = () => reject(obsolete.error); })).rejects.toMatchObject({ name: "VersionError" });
});
