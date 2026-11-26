import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { setSupervisorRoutes } from "./tailscale.ts";

test("Serve rejects an interrupted response", async () => {
  const directory = await mkdtemp("/tmp/kintsugi-serve-");
  const socket = `${directory}/api.sock`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { ETag: "1", "Content-Length": "100" });
    response.write("{");
    setTimeout(() => response.destroy(), 20);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await expect(setSupervisorRoutes("kintsugi.test", 3000, socket)).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
}, 2_000);

test("Serve compare-and-set retries contention and preserves preview routes", async () => {
  const directory = await mkdtemp("/tmp/kintsugi-serve-");
  const socket = `${directory}/api.sock`;
  let revision = 1;
  let writes = 0;
  let config: any = {
    TCP: { "42001": { HTTPS: true } },
    Web: {
      "kintsugi.test:42001": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:42001" } },
      },
    },
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.setHeader("ETag", String(revision));
      response.end(JSON.stringify(config));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    writes++;
    if (writes === 1) {
      config.TCP["42002"] = { HTTPS: true };
      revision++;
      response.writeHead(412);
      response.end();
      return;
    }
    expect(request.headers["if-match"]).toBe(String(revision));
    config = JSON.parse(body);
    revision++;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await setSupervisorRoutes("kintsugi.test", 3000, socket);
    expect(writes).toBe(2);
    expect(config.TCP["42001"].HTTPS).toBe(true);
    expect(config.TCP["42002"].HTTPS).toBe(true);
    expect(config.Web["kintsugi.test:42001"].Handlers["/"].Proxy).toBe(
      "http://127.0.0.1:42001",
    );
    expect(config.Web["kintsugi.test:443"].Handlers["/"].Proxy).toBe(
      "http://127.0.0.1:3000",
    );
    expect(config.Web["kintsugi.test:8443"].Handlers["/"].Proxy).toBe(
      "http://127.0.0.1:3001",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});
