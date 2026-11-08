import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { PreviewPersistenceBroker } from "../src/client/preview-persistence-broker.ts";
import { PreviewStateStore } from "../src/client/preview-state-store.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const reply = Type.Object({ type: Type.String(), id: Type.Optional(Type.Integer()), revision: Type.Optional(Type.Integer()) });
function receive(port: MessagePort, match: (message: Static<typeof reply>) => boolean): Promise<Static<typeof reply>> {
  return new Promise(resolve => {
    const listener = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (Value.Check(reply, data) && match(data)) { port.removeEventListener("message", listener); resolve(data); }
    };
    port.addEventListener("message", listener); port.start();
  });
}

test("private storage ports commit in order, notify sibling views and cannot select another scope", async () => {
  const store = new PreviewStateStore(new IDBFactory()), broker = new PreviewPersistenceBroker(store);
  const a = await broker.connect("one"), b = await broker.connect("one"), other = await broker.connect("two");
  try {
    const update = receive(b.port, message => message.type === "local-change");
    const saved = receive(a.port, message => message.type === "saved" && message.id === 1);
    a.port.postMessage({ type: "local", id: 1, change: { kind: "set", key: "a", value: "one" } });
    await saved; expect((await update).revision).toBe(1);
    const rejected = receive(a.port, message => message.type === "save-error" && message.id === 2);
    a.port.postMessage({ type: "local", id: 2, scope: "two", change: { kind: "set", key: "escaped", value: "bad" } });
    await rejected;
    expect((await store.load("two")).local).toEqual([]);
    const second = receive(b.port, message => message.type === "saved" && message.id === 3);
    b.port.postMessage({ type: "local", id: 3, change: { kind: "set", key: "b", value: "two" } });
    await second;
    expect(new Map((await store.load("one")).local)).toEqual(new Map([["a", "one"], ["b", "two"]]));
  } finally { a.close(); b.close(); other.close(); a.port.close(); b.port.close(); other.port.close(); }
});

test("closing a connection drains its previously queued commits", async () => {
  const store = new PreviewStateStore(new IDBFactory()), broker = new PreviewPersistenceBroker(store), client = await broker.connect("one");
  try {
    const saved = receive(client.port, message => message.type === "saved");
    client.port.postMessage({ type: "local", id: 1, change: { kind: "set", key: "last", value: "durable" } });
    client.port.postMessage({ type: "close" });
    await saved;
    expect((await store.load("one")).local).toEqual([["last", "durable"]]);
  } finally { client.close(); client.port.close(); }
});
