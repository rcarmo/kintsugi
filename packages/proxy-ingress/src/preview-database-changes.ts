import type { PreviewState } from "./preview-state.ts";
import { previewCloneEqual } from "./preview-clone-equal.ts";

type Database = PreviewState["databases"][number];
type Store = Database["stores"][number];
type Record = Store["records"][number];
export interface PreviewDatabaseChange {
  name: string;
  before?: Database;
  after?: Database;
  stores: Array<{ name: string; put: Record[]; remove: Array<Record["key"]> }>;
}
function sameKey(factory: IDBFactory, a: Record["key"], b: Record["key"]): boolean {
  // SAFETY: Native cmp validates each persisted IndexedDB key at the storage boundary.
  return factory.cmp(a as IDBValidKey, b as IDBValidKey) === 0;
}
function schema(database: Database): string {
  return JSON.stringify({ name: database.name, version: database.version, stores: database.stores.map(store => ({ name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: store.indexes })) });
}
/** Diff against this connection's last acknowledged snapshot, never another view's state. */
export async function previewDatabaseChanges(factory: IDBFactory, before: Database[], after: Database[]): Promise<PreviewDatabaseChange[]> {
  const changes: PreviewDatabaseChange[] = [];
  for (const name of new Set([...before.map(db => db.name), ...after.map(db => db.name)])) {
    const previous = before.find(db => db.name === name), next = after.find(db => db.name === name);
    const stores: PreviewDatabaseChange["stores"] = [];
    if (next) for (const store of next.stores) {
      const original = previous?.stores.find(item => item.name === store.name);
      const put: Record[] = [], remove: Array<Record["key"]> = [];
      for (const record of store.records) {
        const old = original?.records.find(item => sameKey(factory, item.key, record.key));
        if (!old || !await previewCloneEqual(old.value, record.value)) put.push(record);
      }
      for (const old of original?.records ?? []) if (!store.records.some(item => sameKey(factory, item.key, old.key))) remove.push(old.key);
      stores.push({ name: store.name, put, remove });
    }
    if (previous && next && schema(previous) === schema(next) && stores.every(store => !store.put.length && !store.remove.length) && previous.stores.every(store => store.nextGeneratedKey === next.stores.find(item => item.name === store.name)?.nextGeneratedKey)) continue;
    changes.push({ name, before: previous, after: next, stores });
  }
  return changes;
}
/** Apply mutations in the host's atomic read/write transaction; unchanged sibling records survive. */
export function applyPreviewDatabaseChanges(factory: IDBFactory, current: Database[], changes: PreviewDatabaseChange[]): Database[] {
  const databases = [...current];
  for (const change of changes) {
    const index = databases.findIndex(db => db.name === change.name), existing = databases[index];
    if (!change.after) { if (index !== -1) databases.splice(index, 1); continue; }
    if (!existing) { databases.push(structuredClone(change.after)); continue; }
    const incomingSchema = schema(change.after), currentSchema = schema(existing);
    if (currentSchema !== incomingSchema && (!change.before || schema(change.before) !== currentSchema)) throw new Error("Concurrent preview database schema change; reload before retrying");
    const database = structuredClone(change.after);
    for (const store of database.stores) {
      const original = existing.stores.find(item => item.name === store.name);
      store.records = original ? [...original.records] : [];
      const mutations = change.stores.find(item => item.name === store.name)!;
      for (const key of mutations.remove) store.records = store.records.filter(item => !sameKey(factory, item.key, key));
      for (const record of mutations.put) {
        const index = store.records.findIndex(item => sameKey(factory, item.key, record.key));
        if (index === -1) store.records.push(record); else store.records[index] = record;
      }
      if (original?.nextGeneratedKey === null || store.nextGeneratedKey === null) store.nextGeneratedKey = null;
      else if (original?.nextGeneratedKey !== undefined) store.nextGeneratedKey = Math.max(original.nextGeneratedKey, store.nextGeneratedKey ?? 1);
    }
    databases[index] = database;
  }
  return databases;
}
