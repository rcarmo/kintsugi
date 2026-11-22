import { expect, test } from "bun:test";
import { Socket } from "node:net";
import { readHostLines } from "./line-reader.ts";

test("a Host input error reaches connection cleanup once even when readline forwards it", async () => {
  const socket = new Socket();
  const failure = new Error("fixture input error");
  const seen: Error[] = [];
  const lines = readHostLines(socket, error => { seen.push(error); });
  const closed = new Promise<void>(resolve => { lines.once("close", resolve); });
  try {
    socket.emit("error", failure);
    lines.emit("error", failure);
    expect(seen).toEqual([failure]);
  } finally {
    // The synthetic socket is never connected to any service.
    socket.destroy();
  }
  await closed;
});
