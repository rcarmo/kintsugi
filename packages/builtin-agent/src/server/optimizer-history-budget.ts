import { AsyncLocalStorage } from "node:async_hooks";

// Only optimiser reads use this projection. Ordinary transcript, replay and
// provider-context reads still see the original records and hydrated media.
export const optimizerHistoryRead = new AsyncLocalStorage<"analysis" | "id">();
export const optimizerEntryBytes = 128 * 1024;
export const optimizerOversizedEntry = "kintsugi.optimizer-oversized-entry";
