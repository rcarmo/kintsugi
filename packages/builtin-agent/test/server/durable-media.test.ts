import {storeDurableAttachments,readDurableAttachmentBytes} from "../../src/server/durable-upload-store.ts";
import { afterEach, describe, expect, it, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { openDurableWorkspace } from "../../src/server/durable-workspace.ts";
import { agentDatabase } from "../../src/server/agent-database.ts";
import { openBunDurableStorage, openReadOnlyDurableStorage } from "../../src/server/durable-sqlite.ts";
import { durableMediaDatabase, initializeDurableMedia } from "../../src/server/durable-media.ts";
import { openBunSqliteDatabase } from "@kintsugi/core/bun-sqlite";
import { durableAttachmentEndpoint } from "../../src/server/durable-attachments.ts";
import { submitDurableInput } from "../../src/server/durable-input.ts";
import { persistedTimelineText } from "./fixtures/sqlite-timeline.ts";
const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function directory() {const path = await mkdtemp(join(tmpdir(), "durable-media-"));cleanup.push(() => rm(path, { recursive: true, force: true }));return path;}
registerStorageConformance({ describe, expect, it }, "media-backed Bun SQLite", async use => {
  const path = await directory(), storage = await openBunDurableStorage(join(path, "agent.sqlite"));
  try {await use(storage);} finally {await storage.close(context);}
});
test("small/batched and large records deduplicate image bytes; provider/doc reads hydrate unchanged across reopen", async () => {
  const path = await directory(), options = { models: createModels(), registry: createRegistry() };
  const workspace = await openDurableWorkspace(path, "fixture", options);cleanup.push(() => workspace.close());
  const conversation = await workspace.agent({ agentId: "one", label: "One", title: "Media" });
  const image = { type: "image" as const, mimeType: "image/png", data: png };
  const Doc = defineDoc({ kind: "media.doc", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", initial: () => ({ image }), checkpointWhen: () => false });
  const entries = [];
  for (const text of ["small", "large".repeat(4000)]) entries.push(await conversation.commit(tx => tx.appendEntry(conversation.id, { kind: "test.image", model: [{ role: "user", timestamp: 1, content: [{ type: "text", text }, image] }] }), context));
  await workspace.harness.commit(async tx => {await tx.doc(Doc, conversation.id);}, context);
  const other = Buffer.from("another payload").toString("base64");
  await workspace.harness.commit(async tx => {(await tx.doc(Doc, conversation.id)).image.data = other;}, context);
  expect((await workspace.harness.snapshot(Doc, conversation.id, context))!.image.data).toBe(other);
  const db = await agentDatabase(async () => join(path, "agent.sqlite"))();
  expect(await db.get("SELECT count(*) n FROM media")).toEqual({ n: 2 });
  expect((await db.get<{n:number}>("SELECT count(*) n FROM media_links WHERE record_type='timeline_entries'"))!.n).toBeGreaterThanOrEqual(2);
  const raw = persistedTimelineText(path);expect(raw).not.toContain(png);expect(raw).not.toContain(other);expect(raw).toContain("__kintsugi_media");
  await workspace.close();
  const restored = await openBunDurableStorage(join(path, "agent.sqlite"));
  try {for (const entry of entries) expect((await restored.entry(entry.id, context))!.entry).toEqual(entry);} finally {await restored.close(context);}
  const reader = await openReadOnlyDurableStorage(join(path, "agent.sqlite"));
  try {expect((await reader.entry(entries[0]!.id, context))!.entry).toEqual(entries[0]);} finally {await reader.close(context);}
});
test("binary/link writes rollback with their record, and storage-shaped user JSON remains literal", async () => {
  const path = join(await directory(), "agent.sqlite"), db = await openBunSqliteDatabase(path);cleanup.push(() => db.close());
  await initializeDurableMedia(db);await db.exec("CREATE TABLE timeline_fixture(record TEXT)");
  const codec = durableMediaDatabase(db);
  await expect(codec.transaction(async tx => {await tx.run("INSERT INTO timeline_fixture (record) VALUES(?)", JSON.stringify({ image: { type: "image", mimeType: "image/png", data: png } }));throw new Error("rollback");})).rejects.toThrow("rollback");
  for (const table of ["media", "media_links", "timeline_fixture"]) expect(await db.get(`SELECT count(*) n FROM ${table}`)).toEqual({ n: 0 });
  const literal = {value:{__kintsugi_media:"a".repeat(64),token:crypto.randomUUID()},nested:{__kintsugi_literal:'{"type":"image","data":"not a storage reference"}'}};
  await codec.run("INSERT INTO timeline_fixture (record) VALUES(?)",JSON.stringify(literal));
  expect(JSON.parse((await codec.get<{record:string}>("SELECT record FROM timeline_fixture"))!.record)).toEqual(literal);
  expect(await db.get("SELECT count(*) n FROM media_links")).toEqual({n:0});
});
test("uploaded files are admitted atomically with custom user entries, omitted from model payloads and served only through visible history", async () => {
  const path = await directory(), models = createModels(), faux = fauxProvider({ tokensPerSecond: 100_000 });models.setProvider(faux.provider);
  const workspace = await openDurableWorkspace(path, "fixture", { models, registry: createRegistry() });cleanup.push(() => workspace.close());
  const one = await workspace.agent({ agentId: "one", title: "One", label: "One" }, { model: { provider: "faux", modelId: "faux-1" } });
  const two = await workspace.agent({ agentId: "two", title: "Two", label: "Two" });
  const contents = "retained file bytes\0private", data = Buffer.from(contents).toString("base64");
  faux.setResponses([request => {expect(JSON.stringify(request.messages)).not.toContain(data);return fauxAssistantMessage("Done");}]);
  const submission = await submitDurableInput(one, "fixture", models, { requestId: "files", text: "Review this file", files: [{ type: "attachment", filename: "report.txt", mimeType: "text/plain", data }] }, context, async (_id, text) => text,()=>{},files=>storeDurableAttachments(path,files));
  await submission.wait(context);
  const entry = (await one.entries({}, 100, undefined, context)).items.find(item => item.kind === "kintsugi.user")!;
  const response = await durableAttachmentEndpoint(one, String(entry.id), 0, context,id=>readDurableAttachmentBytes(join(path,"agent.sqlite"),id));
  expect(await response.text()).toBe(contents);expect(response.headers.get("content-disposition")).toContain("attachment;");expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await durableAttachmentEndpoint(two, String(entry.id), 0, context)).status).toBe(404);
  expect((await durableAttachmentEndpoint(one, String(entry.id), 1, context)).status).toBe(404);
  const fork = await one.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
  expect((await durableAttachmentEndpoint(fork, String(entry.id), 0, context,id=>readDurableAttachmentBytes(join(path,"agent.sqlite"),id))).status).toBe(200);
  expect(persistedTimelineText(path)).not.toContain(data);
});

test("streaming JSONL migration extracts inline image bases and data-only deltas without changing the source", async () => {
  const path = await directory();
  const { openNodeJsonlStorage } = await import("@earendil-works/pi-durable/storage/jsonl/node");
  const { Harness } = await import("@earendil-works/pi-durable");
  const { importDurableJsonl } = await import("../../src/server/durable-jsonl-import.ts");
  const options = { models: createModels(), registry: createRegistry() };
  const harness = await Harness.open(await openNodeJsonlStorage(path, context), options, context);
  const root = await harness.root(context);
  const Doc = defineDoc({ kind: "old.media", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", checkpointWhen: () => false, initial: () => ({ image: { type: "image", mimeType: "image/png", data: png } }) });
  await harness.commit(async tx => {await tx.doc(Doc, root.id);}, context);
  await harness.commit(tx => tx.appendEntry(root.id, { kind: "test.image", model: [{ role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", data: png }] }] }), context);
  const changed = Buffer.from("changed image fixture").toString("base64");
  await harness.commit(async tx => {(await tx.doc(Doc, root.id)).image.data = changed;}, context);
  await harness.close(context);
  const source = await Bun.file(join(path, "main.jsonl")).text();
  await importDurableJsonl(path, join(path, "agent.sqlite"));
  expect(await Bun.file(join(path, "main.jsonl")).text()).toBe(source);
  expect(persistedTimelineText(path)).not.toContain(png);expect(persistedTimelineText(path)).not.toContain(changed);
  const storage = await openReadOnlyDurableStorage(join(path, "agent.sqlite"));
  const restored = await Harness.open(storage, { ...options, readOnly: true }, context);
  try {expect((await restored.snapshot(Doc, root.id, context))!.image.data).toBe(changed);} finally {await restored.close(context);}
});

test("close waits for the entire media hydration read, not only its first SQLite query", async () => {
  const db = await openBunSqliteDatabase(join(await directory(), "agent.sqlite"));cleanup.push(() => db.close());
  await initializeDurableMedia(db);await db.exec("CREATE TABLE timeline_fixture(record TEXT)");
  const codec = durableMediaDatabase(db), value = { type: "image", mimeType: "image/png", data: png };
  await codec.run("INSERT INTO timeline_fixture (record) VALUES(?)", JSON.stringify(value));
  const reading = codec.get<{record:string}>("SELECT record FROM timeline_fixture");
  const closing = codec.close();
  expect(JSON.parse((await reading)!.record)).toEqual(value);
  await closing;
});

test("original uploaded images remain downloadable while model resizing and image messages stay unchanged", async () => {
  const path = await directory(), models = createModels(), faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "small", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 4, maxHeight: 4 } } } }] });models.setProvider(faux.provider);
  const workspace = await openDurableWorkspace(path, "fixture", { models, registry: createRegistry() });cleanup.push(() => workspace.close());
  const root = await workspace.agent({ agentId: "one", title: "One", label: "One" }, { model: { provider: "faux", modelId: "small" } });
  faux.setResponses([fauxAssistantMessage("Done"),fauxAssistantMessage("Done")]);
  const image = {type:"image" as const,mimeType:"image/png",data:png};
  const first = await submitDurableInput(root,"fixture",models,{requestId:"resized",text:"Review",images:[image]},context,async(_id,text)=>text,()=>{},files=>storeDurableAttachments(path,files));await first.wait(context);
  const second = await submitDurableInput(root,"fixture",models,{requestId:"original",text:"Review",images:[image],files:[{type:"attachment",filename:"original.png",mimeType:"image/png",data:png}]},context,async(_id,text)=>text,()=>{},files=>storeDurableAttachments(path,files));await second.wait(context);
  const entries = (await root.entries({},100,undefined,context)).items.filter(entry=>entry.model?.[0]?.role==="user");
  expect(entries).toHaveLength(2);expect(entries[1]!.model?.[0]?.content).toEqual(entries[0]!.model?.[0]?.content);
  expect(JSON.stringify(entries[1]!.model)).not.toContain(png);
  expect(Buffer.from(await (await durableAttachmentEndpoint(root,String(entries.find(entry=>entry.kind==="kintsugi.user")!.id),0,context,id=>readDurableAttachmentBytes(join(path,"agent.sqlite"),id))).arrayBuffer()).toString("base64")).toBe(png);
});

test("media-looking indexed identity strings remain exact and are not decoded as JSON columns", async () => {
  const path = await directory(), options = {models:createModels(),registry:createRegistry()};
  const one = await openDurableWorkspace(path,"fixture",options);cleanup.push(()=>one.close());
  const kinds = [JSON.stringify({type:"image",mimeType:"image/png",data:png}),JSON.stringify({__kintsugi_literal:"42"})];
  const docs = kinds.map(kind=>defineDoc({kind,version:1,scope:"session",initial:()=>({value:"kept"}),checkpointWhen:()=>false}));
  for (const doc of docs) await one.harness.commit(async tx=>{await tx.doc(doc);},context);
  await one.close();
  const two = await openDurableWorkspace(path,"fixture",options);cleanup.push(()=>two.close());
  for (const doc of docs) expect(await two.harness.snapshot(doc,context)).toEqual({value:"kept"});
  const db = await agentDatabase(async()=>join(path,"agent.sqlite"))();
  expect(await db.get("SELECT count(*) n FROM media")).toEqual({n:0});
  const codec = durableMediaDatabase(db);
  expect(await codec.get("SELECT ? AS kind",kinds[1]!)).toEqual({kind:kinds[1]});
});

test("upload bytes never enter immutable entry metadata and staging leases protect concurrent/failing admissions",async()=>{
  const path=await directory(),options={models:createModels(),registry:createRegistry()},one=await openDurableWorkspace(path,"fixture",options);cleanup.push(()=>one.close());
  const payload={type:"attachment" as const,filename:"large.bin",mimeType:"application/octet-stream",data:Buffer.alloc(1024*1024,65).toString("base64")};
  const first=await storeDurableAttachments(path,[payload]),second=await storeDurableAttachments(path,[payload]);
  const db=await agentDatabase(async()=>join(path,"agent.sqlite"))();
  await first.release();expect(await db.get("SELECT count(*) n FROM media")).toEqual({n:1});
  await second.release();expect(await db.get("SELECT count(*) n FROM media")).toEqual({n:0});
  const abandoned=await storeDurableAttachments(path,[payload]);
  expect(JSON.stringify(abandoned.files).length).toBeLessThan(400);
  await one.close();
  const reopened=await openDurableWorkspace(path,"fixture",options);cleanup.push(()=>reopened.close());
  const fresh=await agentDatabase(async()=>join(path,"agent.sqlite"))();
  expect(await fresh.get("SELECT count(*) n FROM media_staging")).toEqual({n:0});
  expect(await fresh.get("SELECT count(*) n FROM media")).toEqual({n:0});
});
