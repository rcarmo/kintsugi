import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { CompactionEntry, createRegistry, Harness, MemoryStorage, UserEntry, type Conversation, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { readScrollbackPage, scrollbackPageSize } from "../../src/server/durable-scrollback.ts";

const opened: Harness[] = [];
afterEach(async () => { for (const harness of opened.splice(0)) await harness.close(context); });
async function setup() {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
  opened.push(harness);
  const conversation = await harness.root(context);
  async function append(target: Conversation, count: number, label: string) {
    return target.commit(async tx => {
      const entries: EntryRecord[] = [];
      for (let i = 0; i < count; i++) entries.push(await tx.appendEntry(UserEntry, target.id, { model: [{ role: "user", content: `${label}-${i}`, timestamp: i }] }));
      return entries;
    }, context);
  }
  return { harness, conversation, append };
}
const history = (conversation: Conversation): Conversation["entries"] => (...args) => conversation.entries(...args);

test("scrollback pages are bounded, ordered, exhaustive and retryable across compaction/reset without changing context", async () => {
  const { conversation, append } = await setup();
  const old = await append(conversation, scrollbackPageSize * 2 + 17, "old");
  await conversation.commit(tx => tx.appendEntry(CompactionEntry, conversation.id, { head: "self", data: { reason: "manual" }, model: [{ role: "user", content: "Compacted summary", timestamp: 500 }] }), context);
  await append(conversation, 5, "middle");
  await conversation.reset(undefined, context);
  await append(conversation, 1, "current");
  const active = await conversation.context(context);
  const watch = await conversation.watch(context, { from: active.head!.head, min: 1000, max: 1000 });
  try {
    const expected = (await conversation.entries({}, 1000, undefined, context)).items.filter(entry => entry.id < watch.value.entries[0]!.id).reverse();
    const loaded: EntryRecord[] = [];
    let before = watch.value.before;
    let reads = 0;
    const bounded: Conversation["entries"] = async (query, limit, cursor, ctx) => {
      expect(limit).toBeLessThanOrEqual(scrollbackPageSize + 1);
      reads++;
      return conversation.entries(query, limit, cursor, ctx);
    };
    while (before !== undefined) {
      const page = await readScrollbackPage(bounded, before, context);
      expect(page.entries.length).toBeLessThanOrEqual(scrollbackPageSize);
      expect(await readScrollbackPage(history(conversation), before, context)).toEqual(page);
      loaded.unshift(...page.entries);
      before = page.before;
    }
    expect(reads).toBe(3);
    expect(loaded.map(entry => entry.id)).toEqual(expected.map(entry => entry.id));
    expect(new Set(loaded.map(entry => entry.id)).size).toBe(loaded.length);
    expect(loaded[0]!.id).toBe(old[0]!.id);
    expect(await conversation.context(context)).toEqual(active);
    expect(JSON.stringify(active.messages)).not.toContain("old-0");
  } finally { await watch.stop(); }
});

test("history reads respect fork cutoffs and never include a sibling or another root", async () => {
  const { harness, conversation, append } = await setup();
  const shared = await append(conversation, 6, "shared");
  const fork = await conversation.fork(shared[3]!.id, { ownership: { kind: "ownerless" } }, context);
  await append(conversation, 3, "parent-only");
  const foreign = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  await append(foreign, 2, "private");
  const own = await append(fork, 4, "fork-only");
  const page = await readScrollbackPage(history(fork), own.at(-1)!.id, context);
  expect(page.entries.map(entry => entry.id)).toEqual([...shared.slice(0, 4), ...own].map(entry => entry.id));
  expect(page.before).toBeUndefined();
  expect(JSON.stringify(page)).not.toContain("private");
  expect(JSON.stringify(page)).not.toContain("parent-only");
});

test("short storage pages are followed without skipping entries; read failures propagate", async () => {
  const { conversation, append } = await setup();
  const entries = await append(conversation, 12, "sample");
  const short: Conversation["entries"] = (query, limit, cursor, ctx) => conversation.entries(query, Math.min(3, limit), cursor, ctx);
  expect((await readScrollbackPage(short, entries.at(-1)!.id, context)).entries).toEqual(entries);
  const failure: Conversation["entries"] = async () => { throw new Error("History unavailable"); };
  await expect(readScrollbackPage(failure, entries[0]!.id, context)).rejects.toThrow("History unavailable");
});

test("empty history and exact page boundaries terminate without repeating the last page", async () => {
  const { conversation, append } = await setup();
  // SAFETY: a positive boundary in a new empty conversation; no entry is assumed to exist.
  expect(await readScrollbackPage(history(conversation), 1 as EntryId, context)).toEqual({ entries: [], before: undefined });
  const entries = await append(conversation, scrollbackPageSize, "exact");
  expect(await readScrollbackPage(history(conversation), entries.at(-1)!.id, context)).toEqual({ entries, before: undefined });
});
