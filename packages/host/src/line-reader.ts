import type { Socket } from "node:net";
import { createInterface } from "node:readline";

/** readline can forward the input's error as its own event. Handle both, once. */
export function readHostLines(socket: Socket, onError: (error: Error) => void) {
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  let failed = false;
  const fail = (error: Error) => {
    if (failed) return;
    failed = true;
    onError(error);
  };
  lines.on("error", fail);
  socket.on("error", fail);
  socket.once("close", () => lines.close());
  return lines;
}
