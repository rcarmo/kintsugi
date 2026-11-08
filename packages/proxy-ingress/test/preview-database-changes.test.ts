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

test("an explicit clear removes unseen sibling records and retains puts after the clear", async () => {
  const store = new PreviewStateStore(new IDBFactory()), before = database([{ key: "same", value: "kept-after-clear" }]);
  await store.saveDatabases("one", before, []);
  await store.saveDatabases("one", database([{ key: "unseen", value: "sibling" }]), []);
  // The surviving record equals the baseline but was explicitly put after clear.
  await store.saveDatabases("one", before, before.databases, [{ kind: "clear", database: "shared", store: "values" }]);
  expect((await store.load("one")).databases[0]!.stores[0]!.records).toEqual(before.databases[0]!.stores[0]!.records);
  await store.saveDatabases("one", database([]), before.databases, [{ kind: "clear", database: "shared", store: "values" }]);
  expect((await store.load("one")).databases[0]!.stores[0]!.records).toEqual([]);
});

test("explicit deletion removes an unseen database and a recreated name starts with its new records", async () => {
  const store = new PreviewStateStore(new IDBFactory()), original = database([{ key: "unseen", value: "sibling" }]);
  await store.saveDatabases("one", original, []);
  await store.saveDatabases("other", original, []);
  await store.saveDatabases("one", initialPreviewState(), [], [{ kind: "delete-database", database: "shared" }]);
  expect((await store.load("one")).databases).toEqual([]);
  expect((await store.load("other")).databases).toEqual(original.databases);
  await store.saveDatabases("one", original, []);
  const recreated = database([{ key: "new", value: "fresh" }]);
  await store.saveDatabases("one", recreated, original.databases, [{ kind: "delete-database", database: "shared" }]);
  expect((await store.load("one")).databases).toEqual(recreated.databases);
});

test("unique-index conflicts reject a merged save and preserve the previously committed database", async () => {
  const store = new PreviewStateStore(new IDBFactory());
  const first = database([{ key: "one", value: { email: "same@example.test" } }]);
  first.databases[0]!.stores[0]!.indexes.push({ name: "email", keyPath: "email", unique: true, multiEntry: false });
  await store.saveDatabases("one", first, []);
  const sibling = structuredClone(first);
  sibling.databases[0]!.stores[0]!.records = [{ key: "two", value: { email: "same@example.test" } }];
  const committed = await store.load("one");
  await expect(store.saveDatabases("one", sibling, [])).rejects.toThrow();
  expect(await store.load("one")).toEqual(committed);
});

test("validation retries cannot replace a concurrent localStorage mutation", async () => {
  const factory = new IDBFactory(), one = new PreviewStateStore(factory), two = new PreviewStateStore(factory);
  await Promise.all([
    one.saveDatabases("scope", database([{ key: "record", value: "value" }]), []),
    two.saveLocal("scope", { kind: "set", key: "local", value: "preserved" }),
  ]);
  const state = await one.load("scope");
  expect(state.local).toEqual([["local", "preserved"]]);
  expect(state.databases[0]!.stores[0]!.records).toEqual([{ key: "record", value: "value" }]);
});

test("unseen auto-increment key collisions reject without replacing the sibling's durable record", async () => {
  const store = new PreviewStateStore(new IDBFactory());
  const one = database([{ key: 1, value: "first" }]);
  one.databases[0]!.stores[0]!.autoIncrement = true;
  one.databases[0]!.stores[0]!.nextGeneratedKey = 2;
  await store.saveDatabases("scope", one, []);
  const two = structuredClone(one);
  two.databases[0]!.stores[0]!.records[0]!.value = "second";
  const committed = await store.load("scope");
  await expect(store.saveDatabases("scope", two, [])).rejects.toThrow("auto-increment key collision");
  expect(await store.load("scope")).toEqual(committed);
  // A connection that actually observed the existing row can still update it.
  await store.saveDatabases("scope", two, one.databases);
  expect((await store.load("scope")).databases[0]!.stores[0]!.records[0]!.value).toBe("second");
});
