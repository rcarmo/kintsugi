import type { ConversationId, UsageState } from "@earendil-works/pi-durable";
import type { DurableAgentRecord } from "./durable-workspace.ts";

export interface DescendantUsage {
  agents: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Own ledgers only: UsageDoc starts empty on a fork. ModelToolUsage is a mirror
 * for provider attribution, not an additional bill. Never aggregate that mirror.
 */
export async function collectDescendantUsage(records: readonly DurableAgentRecord[], agentId: string, read: (id: ConversationId) => Promise<UsageState | undefined>): Promise<DescendantUsage | undefined> {
  const family = new Set([agentId]);
  for (let added = true; added;) {
    added = false;
    for (const record of records) if (record.parentId && family.has(record.parentId) && !family.has(record.agentId)) { family.add(record.agentId); added = true; }
  }
  family.delete(agentId);
  if (!family.size) return;
  const root = records.find(record => record.agentId === agentId);
  const seen = new Set(root ? [root.durableId, ...root.branches ?? []] : []);
  const sum: DescendantUsage = { agents: family.size, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const record of records.filter(record => family.has(record.agentId))) for (const id of new Set([record.durableId, ...record.branches ?? []])) {
    if (seen.has(id)) continue;
    seen.add(id);
    const usage = await read(id);
    for (const value of [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})]) {
      sum.input += value.input; sum.output += value.output; sum.cacheRead += value.cacheRead; sum.cacheWrite += value.cacheWrite; sum.cost += value.cost.total;
    }
  }
  return sum;
}
