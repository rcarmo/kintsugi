import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKintsugiEventBus } from "@kintsugi/core";
import { CableTopics } from "@kintsugi/shared";
import { managementOriginRejection } from "@kintsugi/proxy-ingress";
import { createCableServer, type CableSocketData } from "../apps/web/src/server/cable.ts";
import { createWorkspaceRegistry } from "../apps/web/src/server/workspace-registry.ts";

let directory: string;
let cert: string;
let key: string;
const token = `kintsugi_admin_${"a".repeat(43)}`;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "lan-client-websocket-"));
  cert = join(directory, "cert.pem");
  key = join(directory, "key.pem");
  const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdout: "pipe", stderr: "pipe" });
  expect(generated.exitCode).toBe(0);
  await writeFile(join(directory, "token.json"), JSON.stringify({ secret: token }), { mode: 0o600 });
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

type Mode = "normal" | "early-close" | "rejection" | "malformed" | "wrong-confirmation";
function fixture(mode: Mode) {
  const requests: { path: string; method: string; origin: string | null; authorization: string | null; upgrade: string | null }[] = [];
  let subscriptions = 0;
  let releases = 0;
  const cable = createCableServer({ registry: createWorkspaceRegistry(), events: createKintsugiEventBus(), logError() {}, channels: [{ name: "shell", subscribe(_identifier, listener) {
    if (mode === "rejection") throw new Error("Rejected by protocol fixture");
    subscriptions++;
    listener("snapshot");
    return { unsubscribe() { releases++; } };
  } }] });
  const server = Bun.serve<CableSocketData>({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) },
    fetch(request, server) {
      const rejected = managementOriginRejection(request, server.requestIP(request)?.address);
      if (rejected) return rejected;
      const path = new URL(request.url).pathname;
      requests.push({ path, method: request.method, origin: request.headers.get("origin"), authorization: request.headers.get("authorization"), upgrade: request.headers.get("upgrade") });
      if (path === "/up") return new Response("up");
      if (path === "/openapi.json") return request.headers.get("authorization") === `Bearer ${token}` ? Response.json({ openapi: "3.1.0" }) : new Response("Unauthorized", { status: 401 });
      if (path === "/settings/access/events") return new Response(new ReadableStream({ start(output) { output.enqueue(new TextEncoder().encode("event: access\ndata: {}\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
      if (path === "/cable") {
        if (request.headers.get("upgrade") === "websocket" && server.upgrade(request, { data: { kind: "cable", connectionId: crypto.randomUUID() } })) return;
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        if (mode === "early-close") socket.close();
        else if (mode === "malformed") socket.send("not JSON");
        else cable.open(socket, socket.data);
      },
      message(socket, message) {
        if (mode === "wrong-confirmation") socket.send(JSON.stringify({ type: "confirm_subscription", identifier: CableTopics.shell(), subscriptionId: "wrong" }));
        else cable.message(socket, message);
      },
      close(socket) { cable.close(socket); },
    },
  });
  return { server, requests, cable, counts: () => ({ subscriptions, releases }), origin: `https://127.0.0.1:${server.port}` };
}

async function probe(f: ReturnType<typeof fixture>, report: string) {
  const child = Bun.spawn([process.execPath, new URL("./verify-lan-client.ts", import.meta.url).pathname, "--ui", f.origin, "--api", f.origin, "--ca", cert, "--token-file", join(directory, "token.json"), "--out", report], {
    env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output, error };
}

test("LAN helper verifies CA-trusted WSS subscription round trip and keeps settings SSE", async () => {
  const f = fixture("normal");
  const report = join(directory, "success.json");
  try {
    const result = await probe(f, report);
    expect(result).toMatchObject({ code: 0, error: "" });
    const recorded = await Bun.file(report).json();
    expect(recorded.result).toBe("pass");
    expect(recorded.checks).toContain("CA-verified management WebSocket welcome and subscription round trip");
    expect(recorded.checks).toContain("Settings SSE delivered without waiting for stream completion");
    expect(f.requests.filter(request => request.path === "/cable")).toEqual([{ path: "/cable", method: "GET", origin: f.origin, authorization: null, upgrade: "websocket" }]);
    expect(f.requests.some(request => request.path === "/settings/access/events")).toBe(true);
    for (let i = 0; i < 100 && f.cable.stats().sockets; i++) await Bun.sleep(10);
    expect(f.cable.stats().sockets).toBe(0);
    expect(f.counts()).toEqual({ subscriptions: 1, releases: 1 });
    expect(result.output + result.error + JSON.stringify(recorded)).not.toContain(token);
  } finally { f.server.stop(true); }
}, 10_000);

for (const mode of ["early-close", "rejection", "malformed", "wrong-confirmation"] as const) {
  test(`LAN helper fails without a success report on WebSocket ${mode}`, async () => {
    const f = fixture(mode);
    const report = join(directory, `${mode}.json`);
    try {
      const result = await probe(f, report);
      expect(result.code).not.toBe(0);
      expect(result.error.length).toBeGreaterThan(0);
      expect(await Bun.file(report).exists()).toBe(false);
      expect(result.output + result.error).not.toContain(token);
    } finally { f.server.stop(true); }
  }, 10_000);
}
