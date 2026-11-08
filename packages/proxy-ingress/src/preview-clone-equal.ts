import { Type } from "typebox";
import { Value } from "typebox/value";

/** Compare already structured-cloned IndexedDB values, including binary data and cycles. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- IndexedDB accepts arbitrary structured-clone values at this storage boundary.
export async function previewCloneEqual(left: unknown, right: unknown): Promise<boolean> {
  const forward = new WeakMap<object, object>(), reverse = new WeakMap<object, object>();
  const object = Type.Union([Type.Object({}), Type.Array(Type.Unknown())]);
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Recursive values retain IndexedDB's structured-clone contract.
  async function equal(a: unknown, b: unknown): Promise<boolean> {
    if (Object.is(a, b)) return true;
    if (!Value.Check(object, a) || !Value.Check(object, b)) return false;
    if (Object.prototype.toString.call(a) !== Object.prototype.toString.call(b)) return false;
    const previous = forward.get(a);
    if (previous) return previous === b;
    if (reverse.has(b)) return false;
    forward.set(a, b); reverse.set(b, a);
    if (a instanceof Number && b instanceof Number) return Object.is(a.valueOf(), b.valueOf());
    if (a instanceof String && b instanceof String) return a.valueOf() === b.valueOf();
    if (a instanceof Boolean && b instanceof Boolean) return a.valueOf() === b.valueOf();
    if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime());
    if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
    if (a instanceof Blob && b instanceof Blob) {
      if (a.type !== b.type || a.size !== b.size) return false;
      if (a instanceof File && b instanceof File && (a.name !== b.name || a.lastModified !== b.lastModified)) return false;
      return bytes(new Uint8Array(await a.arrayBuffer()), new Uint8Array(await b.arrayBuffer()));
    }
    if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) return bytes(new Uint8Array(a), new Uint8Array(b));
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) return bytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false;
      const entries = [...b.entries()]; let index = 0;
      for (const [key, value] of a) { const other = entries[index++]!; if (!await equal(key, other[0]) || !await equal(value, other[1])) return false; }
      return true;
    }
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size) return false;
      const values = [...b.values()]; let index = 0;
      for (const value of a) if (!await equal(value, values[index++])) return false;
      return true;
    }
    const keys = Object.getOwnPropertyNames(a), otherKeys = Object.getOwnPropertyNames(b);
    if (keys.length !== otherKeys.length) return false;
    const left = Object.getOwnPropertyDescriptors(a), right = Object.getOwnPropertyDescriptors(b);
    for (const key of keys) {
      if (!Object.hasOwn(right, key) || !await equal(left[key]!.value, right[key]!.value)) return false;
    }
    return true;
  }
  function bytes(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
  return equal(left, right);
}
