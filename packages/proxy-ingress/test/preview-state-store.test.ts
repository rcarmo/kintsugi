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
  expect(await new PreviewStateStore(factory).load("workspace-one:vscode")).toEqual(state);
  expect(await store.load("workspace-two:vscode")).toEqual(initialPreviewState());
  expect(await store.load("workspace-one:browser")).toEqual(initialPreviewState());
});

test("invalid persistence messages cannot replace a previous saved state", async () => {
  const store = new PreviewStateStore(new IDBFactory());
  const state = initialPreviewState(); state.local.push(["key", "preserved"]);
  await store.save("one", state);
  const invalid = initialPreviewState();
  invalid.databases.push({ name: "broken", version: 0, stores: [] });
  await expect(store.save("one", invalid)).rejects.toThrow("Invalid preview storage state");
  expect(await store.load("one")).toEqual(state);
});
