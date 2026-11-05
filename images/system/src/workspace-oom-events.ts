import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Count group kills at this workspace boundary, not OOMs contained by child limits.
 * oom_kill is hierarchical in memory.events; even its local variant counts victims,
 * which may live below init.scope/services. oom_group_kill identifies the boundary
 * whose group-OOM policy fired. The controller enables memory.oom.group on that root.
 */
export async function workspaceOomGroupKills(root: string): Promise<number> {
  const events = await readFile(join(root, "memory.events.local"), "utf8");
  const value = events.match(/^oom_group_kill (\d+)$/m)?.[1];
  const count = value === undefined ? NaN : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Workspace memory.events.local has no valid oom_group_kill counter");
  return count;
}
