import type { Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";
/** Count and byte bounded, including image-bearing entries; an individual entry is the unavoidable minimum unit. */
export async function readDurableHistoryPage(scan: (cursor: Cursor | undefined) => Promise<Page<EntryRecord,Cursor>>) {
  const entries: EntryRecord[] = [];let cursor:Cursor|undefined,bytes=0;
  do {
    const page=await scan(cursor),entry=page.items[0];if(!entry)break;
    const size=Buffer.byteLength(JSON.stringify(entry));
    if(entries.length>=200 || entries.length>0&&bytes+size>2*1024*1024)return{entries:entries.reverse(),before:entry.id};
    entries.push(entry);bytes+=size;cursor=page.next;
  }while(cursor);
  return{entries:entries.reverse(),before:undefined};
}
