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
export const previewStateSchema = Type.Object({
  version: Type.Literal(1),
  local: Type.Array(Type.Tuple([Type.String(), Type.String()])),
  databases: Type.Array(database),
});
export type PreviewState = Static<typeof previewStateSchema>;
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Structured-cloned messages and persisted IndexedDB records are parsed at this external boundary.
export function parsePreviewState(input: unknown): PreviewState {
  if (!Value.Check(previewStateSchema, input)) throw new Error("Invalid preview storage state");
  return input;
}
export const initialPreviewState = (): PreviewState => ({ version: 1, local: [], databases: [] });
