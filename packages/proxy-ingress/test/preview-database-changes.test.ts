import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { initialPreviewState, type PreviewState } from "../src/preview-state.ts";
import { PreviewStateStore } from "../src/client/preview-state-store.ts";
import { previewCloneEqual } from "../src/preview-clone-equal.ts";

interface CloneGraph { value: number; next?: CloneGraph }
function database(records: PreviewState["databases"][number]["stores"][number]["records"]): PreviewState {
  return { ...initialPreviewState(), databases: [{ name: "shared", version: 1, stores: [{ name: "values", keyPath: null, autoIncrement: false, indexes: [], records }] }] };
}
test("acknowledged snapshots merge changed records without deleting an independent view's records", async () => {
  const factory = new IDBFactory(), a = new PreviewStateStore(factory), b = new PreviewStateStore(factory);
  const one = database([{ key: "a", value: new Uint8Array([1, 2]) }]), two = database([{ key: "b", value: "second" }]);
  await a.saveDatabases("one", one, []); await b.saveDatabases("one", two, []);
  expect((await a.load("one")).databases[0]!.stores[0]!.records).toEqual([{ key: "a", value: new Uint8Array([1, 2]) }, { key: "b", value: "second" }]);
  await a.saveDatabases("one", one, one.databases);
  expect((await a.load("one")).databases[0]!.stores[0]!.records).toHaveLength(2);
  await a.saveDatabases("one", database([]), one.databases);
  expect((await a.load("one")).databases[0]!.stores[0]!.records).toEqual([{ key: "b", value: "second" }]);
});
test("compound and binary record keys use native IndexedDB comparison", async () => {
  const store = new PreviewStateStore(new IDBFactory());
  const before = database([{ key: ["compound", new Uint8Array([1, 2])], value: "old" }]);
  await store.saveDatabases("one", before, []);
  const after = database([{ key: ["compound", new Uint8Array([1, 2])], value: "new" }]);
  await store.saveDatabases("one", after, before.databases);
  expect((await store.load("one")).databases[0]!.stores[0]!.records).toHaveLength(1);
  expect((await store.load("one")).databases[0]!.stores[0]!.records[0]!.value).toBe("new");
});
test("concurrent schema changes are reported rather than overwriting another view's schema", async () => {
  const store = new PreviewStateStore(new IDBFactory()), before = database([]);
  await store.saveDatabases("one", before, []);
  const upgraded = structuredClone(before); upgraded.databases[0]!.version = 2;
  await store.saveDatabases("one", upgraded, before.databases);
  await store.saveDatabases("one", before, before.databases); // unchanged older view is harmless
  const conflicting = database([{ key: "old-view", value: true }]);
  await expect(store.saveDatabases("one", conflicting, before.databases)).rejects.toThrow("Concurrent");
  expect((await store.load("one")).databases[0]!.version).toBe(2);
});
test("structured clone equality retains dates, blobs, binary views, maps, sets and graph identity", async () => {
  const graph: CloneGraph = { value: 1 };
  graph.next = graph;
  const values = [graph, new Date(123), new Uint8Array([1, 255]), new Map([["key", graph]]), new Set([1, "two"]), new Blob(["bytes"], { type: "text/plain" }), /example/gi, [1, { nested: "value" }]];
  for (const value of values) expect(await previewCloneEqual(value, structuredClone(value))).toBe(true);
  expect(await previewCloneEqual(new Date(1), new Date(2))).toBe(false);
  expect(await previewCloneEqual(new Uint8Array([1]), new Uint8Array([2]))).toBe(false);
  expect(await previewCloneEqual(new Blob(["one"]), new Blob(["two"]))).toBe(false);
  const shared = { value: true };
  expect(await previewCloneEqual([shared, shared], [{ value: true }, { value: true }])).toBe(false);
});
