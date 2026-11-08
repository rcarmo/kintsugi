import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const database = Type.Object({
  name: Type.String(), version: Type.Integer({ minimum: 1 }),
  stores: Type.Array(Type.Object({
    name: Type.String(), keyPath: Type.Union([Type.Null(), Type.String(), Type.Array(Type.String())]), autoIncrement: Type.Boolean(),
    nextGeneratedKey: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 2 ** 53 }), Type.Null()])),
    indexes: Type.Array(Type.Object({ name: Type.String(), keyPath: Type.Union([Type.String(), Type.Array(Type.String())]), unique: Type.Boolean(), multiEntry: Type.Boolean() })),
    records: Type.Array(Type.Object({ key: Type.Unknown(), value: Type.Unknown() })),
  })),
});
export const previewStorageEntriesSchema = Type.Array(Type.Tuple([Type.String(), Type.String()]));
const legacyPreviewStateSchema = Type.Object({ version: Type.Literal(1), local: previewStorageEntriesSchema, databases: Type.Array(database) });
export const previewStateSchema = Type.Object({
  version: Type.Literal(2),
  revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  local: previewStorageEntriesSchema,
  databases: Type.Array(database),
});
export type PreviewState = Static<typeof previewStateSchema>;
export const previewLocalChangeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("set"), key: Type.String(), value: Type.String() }),
  Type.Object({ kind: Type.Literal("remove"), key: Type.String() }),
  Type.Object({ kind: Type.Literal("clear") }),
]);
export type PreviewLocalChange = Static<typeof previewLocalChangeSchema>;
export function applyPreviewLocalChange(values: Map<string, string>, change: PreviewLocalChange): void {
  if (change.kind === "clear") values.clear();
  else if (change.kind === "remove") values.delete(change.key);
  else values.set(change.key, change.value);
}
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Structured-cloned messages and persisted IndexedDB records are parsed at this external boundary.
export function parsePreviewState(input: unknown): PreviewState {
  if (Value.Check(legacyPreviewStateSchema, input)) return { version: 2, revision: 0, local: input.local, databases: input.databases };
  if (!Value.Check(previewStateSchema, input)) throw new Error("Invalid preview storage state");
  return input;
}
export const initialPreviewState = (): PreviewState => ({ version: 2, revision: 0, local: [], databases: [] });
