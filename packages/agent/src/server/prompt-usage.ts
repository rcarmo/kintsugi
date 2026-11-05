/** Prompt tokens in Pi/Anthropic's disjoint buckets. Output tokens never enter CH. */
export interface PromptUsage {
  input: number;
  cacheRead: number | null | undefined;
  cacheWrite?: number | null;
}

/** Token-weighted hit percentage, not an average of per-request percentages. Unknown data stays unknown. */
export function promptCacheHitPercent(usages: Iterable<PromptUsage>): number | null {
  let hits = 0;
  let prompts = 0;
  for (const usage of usages) {
    const { input, cacheRead } = usage;
    const cacheWrite = usage.cacheWrite ?? 0;
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(cacheWrite) || cacheWrite < 0) return null;
    if (cacheRead == null) {
      if (input === 0 && cacheWrite === 0) continue;
      return null;
    }
    if (!Number.isFinite(cacheRead) || cacheRead < 0) return null;
    hits += cacheRead;
    prompts += input + cacheRead + cacheWrite;
  }
  return prompts > 0 && Number.isFinite(prompts) ? hits / prompts * 100 : null;
}
