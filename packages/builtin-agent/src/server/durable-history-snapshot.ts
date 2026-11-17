import { createKeyedOperationQueue } from "@kintsugi/core";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importDurableJsonl } from "./durable-jsonl-import.ts";

// Read-only views of journals awaiting their one-shot migration. Keep only a few idle snapshots, briefly: the canonical
// source is never repaired, archived or opened through JSONL storage. Active readers own their immutable snapshot.
type Snapshot = { signature: string; path: Promise<string>; users: number; retired: boolean; timer?: ReturnType<typeof setTimeout>; discard: () => Promise<void> };
const snapshots = new Map<string, Snapshot>();
const acquire = createKeyedOperationQueue();
async function sourceSignature(directory: string) {
  const files = (await readdir(directory)).filter(name => /^(main|(?:doc|task)-(?:0|[1-9]\d*))\.jsonl$/.test(name)).sort();
  return JSON.stringify(await Promise.all(files.map(async name => {
    const info = await stat(join(directory, name), { bigint: true });
    return [name, String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)];
  })));
}
function retire(directory: string, snapshot: Snapshot) {
  snapshot.retired = true;clearTimeout(snapshot.timer);
  if (snapshots.get(directory) === snapshot) snapshots.delete(directory);
  if (!snapshot.users) void snapshot.discard().catch(error => console.warn("Could not remove a retained-history snapshot", error));
}
/** Caller must release after closing its reader. No source mutation, writer lease, scheduler or model access. */
export async function acquireDurableHistorySnapshot(directory: string) {
  const selected = await acquire(directory,async()=>{
    const signature = await sourceSignature(directory);
    let snapshot = snapshots.get(directory);
    if (snapshot && snapshot.signature !== signature) {retire(directory,snapshot);snapshot = undefined;}
    if (!snapshot) {
      const temporary = await mkdtemp(join(tmpdir(),"kintsugi-history-snapshot-")),path = join(temporary,"agent.sqlite");
      snapshot = {signature,path:importDurableJsonl(directory,path).then(()=>path),users:0,retired:false,discard:()=>rm(temporary,{recursive:true,force:true})};
      snapshots.set(directory,snapshot);
      const created = snapshot;void created.path.catch(()=>{retire(directory,created);});
    }
    snapshot.users++;clearTimeout(snapshot.timer);
    snapshots.delete(directory);snapshots.set(directory,snapshot);
    return snapshot;
  });
  let released = false;
  const release = async () => {
    if (released) return;released = true;selected.users--;
    if (selected.users) return;
    if (selected.retired) {await selected.discard();return;}
    selected.timer = setTimeout(() => retire(directory, selected), 60_000);selected.timer.unref();
    const idle = [...snapshots].filter(([, item]) => !item.users);
    for (const [source, item] of idle.slice(0, Math.max(0, idle.length - 3))) retire(source, item);
  };
  try {return { path: await selected.path, release };} catch (error) {await release();throw error;}
}

/** Retire cached snapshots at shutdown; an active reader still keeps its file until release. */
export function retireDurableHistorySnapshots() {for (const [directory, snapshot] of snapshots) retire(directory, snapshot);}
