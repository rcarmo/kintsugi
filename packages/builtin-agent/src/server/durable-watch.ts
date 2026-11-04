import type { Context, WatchCall } from "@earendil-works/chord";

/** A watch listener of values. Durable ends a failed watch rather than calling it with a failure, so one is rethrown. */
export function onValues<T>(listener: (value: T, context: Context) => void | Promise<void>) {
  return async (call: WatchCall<T>, context: Context) => {
    if (call.kind === "failed") throw call.error;
    await listener(call.value, context);
  };
}
