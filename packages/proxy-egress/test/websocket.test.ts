import { deflateRawSync, inflateRawSync, constants } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import tls from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkspaceEgressProxy } from "../src/egress/egress-proxy.ts";
import { ensureMitmCa, ensureLeafCertificate } from "../src/egress/mitm-ca.ts";
import { createHttpHooks, type CreateHttpHooksOptions } from "../src/secrets/placeholder-hooks.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; });
const key = "dGhlIHNhbXBsZSBub25jZQ==";
const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

class Wire {
  bytes = Buffer.alloc(0);
  constructor(readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => { this.bytes = Buffer.concat([this.bytes, chunk]); });
    socket.setTimeout(5000, () => socket.destroy(new Error("Test connection timed out")));
    cleanup.push(() => { socket.destroy(); });
  }
  async read(length: number): Promise<Buffer> {
    while (this.bytes.length < length) await once(this.socket, "data");
    const result = this.bytes.subarray(0, length);
    this.bytes = this.bytes.subarray(length);
    return result;
  }
  async headers(): Promise<string> {
    while (this.bytes.indexOf("\r\n\r\n") < 0) await once(this.socket, "data");
    return (await this.read(this.bytes.indexOf("\r\n\r\n") + 4)).toString();
  }
  async frame(): Promise<{ opcode: number; data: Buffer }> {
    const prefix = await this.read(2);
    let length = prefix[1]! & 127;
    if (length === 126) length = (await this.read(2)).readUInt16BE();
    else if (length === 127) length = Number((await this.read(8)).readBigUInt64BE());
    expect(prefix[1]! & 128).toBe(0);
    return { opcode: prefix[0]! & 15, data: await this.read(length) };
  }
}

function frame(data: Buffer, opcode = 1): Buffer {
  const size = data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10;
  const header = Buffer.alloc(size + 4);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (size === 2 ? data.length : size === 4 ? 126 : 127);
  if (size === 4) header.writeUInt16BE(data.length, 2);
  if (size === 10) header.writeBigUInt64BE(BigInt(data.length), 2);
  const mask = Buffer.from([1, 2, 3, 4]);
  mask.copy(header, size);
  return Buffer.concat([header, Buffer.from(data.map((byte, index) => byte ^ mask[index % 4]!))]);
}

function handshake(path = "/echo", authorization = "KINTSUGI_WS_PLACEHOLDER", extra = ""): string {
  return `GET ${path} HTTP/1.1\r\nHost: forged.example\r\nConnection: Upgrade, x-hop\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nAuthorization: Bearer ${authorization}\r\nProxy-Authorization: must-not-leak\r\nX-Hop: must-not-leak\r\nX-Workspace-Id: beta\r\n${extra}\r\n`;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-ws-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const ca = await ensureMitmCa({ kintsugiDataDir: directory, dockerHostKintsugiDataDir: directory, dockerBridgeHost: "127.0.0.1" });
  const leaf = await ensureLeafCertificate(ca, "localhost");
  const caPem = await readFile(ca.certPath, "utf8");
  const received: Headers[] = [];
  let active = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    tls: { cert: await readFile(leaf.certPath), key: await readFile(leaf.keyPath) },
    fetch(request, server) {
      received.push(request.headers);
      const path = new URL(request.url).pathname;
      if (path === "/reject") return new Response("subscription unavailable", { status: 429, headers: { "retry-after": "10" } });
      if (path === "/redirect") return new Response(null, { status: 302, headers: { location: `https://example.com/${request.headers.get("authorization")}` } });
      const headers = new Headers();
      headers.set("x-echo-authorization", request.headers.get("authorization")!);
      if (request.headers.has("sec-websocket-protocol")) headers.set("sec-websocket-protocol", "kintsugi-test");
      if (server.upgrade(request, { headers })) return;
      return new Response("Expected WebSocket", { status: 405 });
    },
    websocket: {
      perMessageDeflate: true,
      open(socket) { active++; socket.send("ready"); },
      message(socket, message) { socket.send(message, true); },
      close() { active--; },
    },
  });
  cleanup.push(() => { server.stop(true); });
  let upgrades = 0;
  async function proxy(id: string, options: Omit<CreateHttpHooksOptions, "onRequest"> = {}, verifyCertificate = true) {
    let hooks = createHttpHooks({ allowedInternalHosts: ["localhost"], secrets: { token: { hosts: ["localhost"], value: `${id}-secret`, placeholder: "KINTSUGI_WS_PLACEHOLDER" } }, ...options });
    const socketPath = join(directory, `${id}.sock`);
    const proxy = await startWorkspaceEgressProxy({ socketPath, ca,
      getContext: async () => ({ workspaceId: id, hooks: hooks.httpHooks, env: hooks.env, secrets: hooks.secrets }),
      upstreamUpgrade: (url, options) => {
        upgrades++;
        const destination = new URL(`${url.pathname}${url.search}`, `https://localhost:${server.port}`);
        return httpsRequest(destination, { ...options, agent: false, ca: verifyCertificate ? caPem : undefined });
      },
    });
    const dispose = () => proxy.close();
    cleanup.push(dispose);
    async function connect() {
      const tunnel = net.connect(socketPath);
      const connection = new Wire(tunnel);
      await once(tunnel, "connect");
      tunnel.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
      expect(await connection.headers()).toContain("200 Connection Established");
      tunnel.removeAllListeners("data");
      const secure = tls.connect({ socket: tunnel, ca: caPem, servername: "localhost" });
      const wire = new Wire(secure);
      await once(secure, "secureConnect");
      return wire;
    }
    return {
      connect, socketPath,
      setCredential(value: string) {
        hooks = createHttpHooks({ allowedInternalHosts: ["localhost"], secrets: { token: { hosts: ["localhost"], value, placeholder: "KINTSUGI_WS_PLACEHOLDER" } }, ...options });
      },
      async close() { cleanup.splice(cleanup.indexOf(dispose), 1); await dispose(); },
    };
  }
  return { proxy, received, get upgrades() { return upgrades; }, get active() { return active; } };
}

test("MITM WebSockets preserve workspace identity, negotiation, head bytes, binary traffic, ping/pong and close", async () => {
  const f = await fixture();
  const alpha = await f.proxy("alpha");
  const beta = await f.proxy("beta");
  for (const [id, proxy] of [["alpha", alpha], ["beta", beta]] as const) {
    const wire = await proxy.connect();
    // A frame arriving with the HTTP headers exercises the parser's client head buffer.
    wire.socket.write(Buffer.concat([Buffer.from(handshake("/echo", "KINTSUGI_WS_PLACEHOLDER", "Sec-WebSocket-Protocol: kintsugi-test\r\n")), frame(Buffer.from("early"))]));
    const headers = await wire.headers();
    expect(headers).toContain("x-echo-authorization: Bearer [REDACTED]");
    expect(headers).toContain("101 Switching Protocols");
    expect(headers).toContain(`sec-websocket-accept: ${accept}`);
    expect(headers).toContain("sec-websocket-protocol: kintsugi-test");
    expect((await wire.frame()).data.toString()).toBe("ready");
    expect((await wire.frame()).data.toString()).toBe("early");
    expect(f.received.at(-1)!.get("authorization")).toBe(`Bearer ${id}-secret`);
    expect(f.received.at(-1)!.get("host")).toStartWith("localhost:");
    expect(f.received.at(-1)!.get("proxy-authorization")).toBeNull();
    expect(f.received.at(-1)!.get("x-hop")).toBeNull();
    // Larger than socket high-water marks; allow data to queue before consuming.
    const payload = Buffer.alloc(512 * 1024, 173);
    wire.socket.pause();
    wire.socket.write(frame(payload, 2));
    await delay(20);
    wire.socket.resume();
    expect(await wire.frame()).toEqual({ opcode: 2, data: payload });
    wire.socket.write(frame(Buffer.from("ping"), 9));
    expect(await wire.frame()).toEqual({ opcode: 10, data: Buffer.from("ping") });
    wire.socket.write(frame(Buffer.from([3, 232]), 8));
    expect((await wire.frame()).opcode).toBe(8);
    wire.socket.destroy();
  }
});

test("WebSocket rejection status/body and redirects are forwarded without retries or redirect following", async () => {
  const f = await fixture();
  const proxy = await f.proxy("alpha");
  const rejected = await proxy.connect();
  rejected.socket.write(handshake("/reject"));
  const headers = await rejected.headers();
  expect(headers).toContain("429");
  expect(headers).toContain("retry-after: 10");
  expect((await rejected.read(Buffer.byteLength("subscription unavailable"))).toString()).toBe("subscription unavailable");
  const redirected = await proxy.connect();
  redirected.socket.write(handshake("/redirect"));
  const redirectHeaders = await redirected.headers();
  expect(redirectHeaders).toContain("302");
  expect(redirectHeaders).toContain("https://example.com/Bearer [REDACTED]");
  expect(redirectHeaders).not.toContain("alpha-secret");
  expect(f.upgrades).toBe(2);
});

test("WebSocket policy and credential failures are rejected before dialing upstream", async () => {
  const f = await fixture();
  for (const [id, options, status] of [
    ["denied", { isRequestAllowed: () => false }, 403],
    ["wrong-host", { secrets: { token: { hosts: ["localhost"], value: "secret", placeholder: "select-mitm" }, other: { hosts: ["example.com"], value: "other-secret", placeholder: "KINTSUGI_WS_PLACEHOLDER" } } }, 403],
    ["policy-error", { isRequestAllowed: () => { throw new Error("Policy lookup failed"); } }, 502],
  ] satisfies Array<[string, Omit<CreateHttpHooksOptions, "onRequest">, number]>) {
    const proxy = await f.proxy(id, options);
    const wire = await proxy.connect();
    wire.socket.write(handshake());
    expect(await wire.headers()).toContain(String(status));
  }
  expect(f.upgrades).toBe(0);
});

test("WebSocket handshakes use refreshed credentials on each connection", async () => {
  const f = await fixture();
  const proxy = await f.proxy("alpha");
  for (const generation of [1, 2]) {
    proxy.setCredential(`token-${generation}`);
    const wire = await proxy.connect();
    wire.socket.write(handshake());
    expect(await wire.headers()).toContain("101");
    expect(f.received.at(-1)!.get("authorization")).toBe(`Bearer token-${generation}`);
    wire.socket.destroy();
  }
});

test("WebSocket TLS verification stays enabled", async () => {
  const f = await fixture();
  const proxy = await f.proxy("untrusted", {}, false);
  const wire = await proxy.connect();
  wire.socket.write(handshake());
  expect(await wire.headers()).toContain("502");
  expect(f.received).toHaveLength(0);
});

test("invalid client handshakes and blocked network destinations never reach upstream", async () => {
  const f = await fixture();
  const proxy = await f.proxy("alpha");
  for (const request of [handshake().replace(key, "invalid-key"), handshake().replace("Version: 13", "Version: 12"), handshake("/", "KINTSUGI_WS_PLACEHOLDER", "Content-Length: 5\r\n")]) {
    const wire = await proxy.connect();
    wire.socket.write(request);
    expect(await wire.headers()).toContain("400");
  }
  const denied = new Wire(net.connect(proxy.socketPath));
  await once(denied.socket, "connect");
  denied.socket.write(handshake("http://127.0.0.1/private"));
  expect(await denied.headers()).toContain("403");
  expect(f.upgrades).toBe(0);
});

test("closing a workspace proxy closes active upgraded connections", async () => {
  const f = await fixture();
  const proxy = await f.proxy("alpha");
  const wire = await proxy.connect();
  wire.socket.write(handshake());
  expect(await wire.headers()).toContain("101");
  await wire.frame();
  const closed = once(wire.socket, "close");
  await proxy.close();
  await closed;
});

test("plain ws upgrades preserve early upstream bytes and reject invalid upstream handshakes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-ws-plain-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const ca = await ensureMitmCa({ kintsugiDataDir: directory, dockerHostKintsugiDataDir: directory, dockerBridgeHost: "127.0.0.1" });
  const upstream = createServer();
  upstream.on("upgrade", (req, socket) => {
    cleanup.push(() => { socket.destroy(); });
    socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${req.url === "/invalid" ? "bad" : accept}\r\n\r\n`),
      Buffer.from([0x81, 5]), Buffer.from("early"),
    ]));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  // SAFETY: The server is listening on a TCP address.
  const port = (upstream.address() as net.AddressInfo).port;
  cleanup.push(() => { upstream.close(); });
  const hooks = createHttpHooks({ allowedInternalHosts: ["localhost"] });
  const socketPath = join(directory, "proxy.sock");
  const proxy = await startWorkspaceEgressProxy({ socketPath, ca, getContext: async () => ({ workspaceId: "plain", env: hooks.env, hooks: hooks.httpHooks, secrets: hooks.secrets }), upstreamUpgrade: (url, options) => httpRequest(url, { ...options, agent: false }) });
  cleanup.push(() => proxy.close());
  for (const path of ["/valid", "/invalid"]) {
    const wire = new Wire(net.connect(socketPath));
    await once(wire.socket, "connect");
    wire.socket.write(handshake(`http://localhost:${port}${path}`, "not-a-secret"));
    expect(await wire.headers()).toContain(path === "/valid" ? "101" : "502");
    if (path === "/valid") expect((await wire.frame()).data.toString()).toBe("early");
  }
});


test("negotiated permessage-deflate survives the bridge unchanged", async () => {
  const f = await fixture();
  const proxy = await f.proxy("compression");
  const wire = await proxy.connect();
  wire.socket.write(handshake("/echo", "KINTSUGI_WS_PLACEHOLDER", "Sec-WebSocket-Extensions: permessage-deflate; client_no_context_takeover; server_no_context_takeover\r\n"));
  const headers = await wire.headers();
  expect(headers).toContain("101");
  expect(headers).toContain("sec-websocket-extensions: permessage-deflate");
  await wire.frame(); // Initial, uncompressed ready message.
  const message = Buffer.from("compressed WebSocket payload ".repeat(100));
  const compressed = deflateRawSync(message, { flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH }).subarray(0, -4);
  const outgoing = frame(compressed);
  outgoing[0] = outgoing[0]! | 0x40;
  wire.socket.write(outgoing);
  const prefix = await wire.read(2);
  expect(prefix[0]! & 0x40).toBe(0x40);
  expect(prefix[1]!).toBeLessThan(126);
  const data = await wire.read(prefix[1]!);
  const inflated = inflateRawSync(Buffer.concat([data, Buffer.from([0, 0, 255, 255])]), { finishFlush: constants.Z_SYNC_FLUSH });
  expect(inflated).toEqual(message);
});
