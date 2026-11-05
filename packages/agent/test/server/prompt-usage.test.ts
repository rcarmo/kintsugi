import { expect, test } from "bun:test";
import { promptCacheHitPercent } from "../../src/server/prompt-usage.ts";

test("CH counts read hits over all disjoint prompt buckets, including writes", () => {
  expect(promptCacheHitPercent([{ input: 10, cacheRead: 80, cacheWrite: 10 }])).toBe(80);
  expect(promptCacheHitPercent([{ input: 0, cacheRead: 0, cacheWrite: 100 }])).toBe(0);
  expect(promptCacheHitPercent([{ input: 0, cacheRead: 100 }])).toBe(100);
});

test("CH weights tokens across requests, model tools and models instead of averaging percentages", () => {
  expect(promptCacheHitPercent([{ input: 0, cacheRead: 10 }, { input: 90, cacheRead: 0 }])).toBe(10);
  expect(promptCacheHitPercent([{ input: 20, cacheRead: 80 }, { input: 20, cacheRead: 0, cacheWrite: 80 }])).toBe(40);
});

test("inclusive Codex counters and exclusive Anthropic counters produce the same ratio", () => {
  const codex = { inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 10 };
  expect(promptCacheHitPercent([{ input: codex.inputTokens - codex.cachedInputTokens, cacheRead: codex.cachedInputTokens }])).toBe(80);
  expect(promptCacheHitPercent([{ input: 10, cacheRead: 80, cacheWrite: 10 }])).toBe(80);
});

test("empty, output-only and missing usage is N/A; a known miss is zero", () => {
  expect(promptCacheHitPercent([])).toBeNull();
  expect(promptCacheHitPercent([{ input: 0, cacheRead: 0, cacheWrite: 0 }])).toBeNull();
  expect(promptCacheHitPercent([{ input: 100, cacheRead: undefined }])).toBeNull();
  expect(promptCacheHitPercent([{ input: 100, cacheRead: null }])).toBeNull();
  expect(promptCacheHitPercent([{ input: 100, cacheRead: 0 }])).toBe(0);
  expect(promptCacheHitPercent([{ input: 10, cacheRead: 90 }, { input: 20, cacheRead: undefined }])).toBeNull();
});

test("invalid provider counters cannot yield a misleading hit percentage", () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(promptCacheHitPercent([{ input: bad, cacheRead: 0 }])).toBeNull();
    expect(promptCacheHitPercent([{ input: 10, cacheRead: bad }])).toBeNull();
    expect(promptCacheHitPercent([{ input: 10, cacheRead: 0, cacheWrite: bad }])).toBeNull();
  }
  expect(promptCacheHitPercent([{ input: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE }])).toBeNull();
});
