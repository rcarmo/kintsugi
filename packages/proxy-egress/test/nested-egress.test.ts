import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import net from "node:net";
import tls from "node:tls";
import { join } from "node:path";
import { startWorkspaceEgressProxy } from "../src/egress/egress-proxy.ts";
import { requestWebSocketUpgrade } from "../src/egress/websocket.ts";
import { ensureLeafCertificate, ensureMitmCa } from "../src/egress/mitm-ca.ts";
import { createHttpHooks } from "../src/secrets/placeholder-hooks.ts";

// Real Bun fetch and HttpsProxyAgent transport through a parent workspace proxy.
// Only the parent's final destination is replaced by a local protocol fixture.
test("nested HTTP, HTTPS and WebSocket egress preserve inherited credentials and delegate pinning to the parent", async () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  const directory = await mkdtemp("/tmp/kintsugi-nested-egress-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const envNames = ["http_proxy", "https_proxy", "no_proxy"] as const;
  const oldEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  try {
    const ca = await ensureMitmCa({ kintsugiDataDir: directory, dockerHostKintsugiDataDir: directory, dockerBridgeHost: "127.0.0.1" });
    const caPem = await readFile(ca.certPath, "utf8");
    const hostname = "nested-egress.test";
    const placeholder = "KINTSUGI_NESTED_PLACEHOLDER";
    const value = "parent-secret";
    const leaf = await ensureLeafCertificate(ca, hostname);
    const websocketCredentials: string[] = [];
    const destination = createHttpsServer({ key: await readFile(leaf.keyPath), cert: await readFile(leaf.certPath) });
    destination.on("upgrade", (req, socket) => {
      websocketCredentials.push(String(req.headers.authorization));
      socket.end("HTTP/1.1 429 Too Many Requests\r\nContent-Length: 12\r\nConnection: close\r\n\r\nfixture body");
    });
    destination.listen(0, "127.0.0.1");
    await once(destination, "listening");
    cleanup.push(() => new Promise<void>(resolve => destination.close(() => resolve())));
    // SAFETY: This fixture listens on TCP, so address() is an AddressInfo.
    const destinationPort = (destination.address() as net.AddressInfo).port;
    const hooks = (secret: string) => createHttpHooks({ secrets: { TOKEN: { hosts: [hostname], placeholder, value: secret } } });
    const parentHooks = hooks(value);
    const nestedHooks = hooks(placeholder);
    const parentFetches: Array<{ url: string; host: string | null; authorization: string | null; proxy?: string }> = [];
    const checked: string[] = [];
    let parentAddress = "8.8.8.8";
    const pinnedUpgrades: string[] = [];
    const parentSocket = join(directory, "parent.sock");
    const parent = await startWorkspaceEgressProxy({ socketPath: parentSocket, ca,
      // The parent runs outside the child’s environment in a real installation.
      upstreamProxyForUrl: () => "",
      getContext: async () => ({ workspaceId: "parent", ...parentHooks, hooks: parentHooks.httpHooks }),
      upstreamDnsLookup: async name => {
        expect(name).toBe(hostname);
        // The parent checks its own DNS result, not the child's earlier result.
        checked.push(parentAddress);
        return [{ address: parentAddress, family: 4 }];
      },
      upstreamFetch: async (url, init) => {
        const headers = new Headers(init.headers);
        parentFetches.push({ url, host: headers.get("host"), authorization: headers.get("authorization"), proxy: init.proxy });
        return new Response("parent response");
      },
      upstreamUpgrade: (url, options) => {
        expect(options.lookup).toBeDefined();
        options.lookup!(url.hostname, {}, (error, address) => {
          expect(error).toBeNull();
          pinnedUpgrades.push(String(address));
        });
        // Redirect the parent's checked socket to the local TLS fixture, keeping
        // certificate verification and the actual WebSocket HTTP handshake.
        const fixture = new URL(url);
        fixture.hostname = "127.0.0.1";
        fixture.port = String(destinationPort);
        return httpsRequest(fixture, { ...options, lookup: undefined, agent: false, servername: hostname, ca: caPem });
      },
    });
    cleanup.push(() => parent.close());
    const relaySockets = new Set<net.Socket>();
    const relay = net.createServer(socket => {
      const upstream = net.connect(parentSocket);
      for (const connection of [socket, upstream]) {
        relaySockets.add(connection);
        connection.once("close", () => relaySockets.delete(connection));
      }
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    cleanup.push(async () => {
      for (const socket of relaySockets) socket.destroy();
      await new Promise<void>(resolve => relay.close(() => resolve()));
    });
    // SAFETY: This fixture listens on TCP, so address() is an AddressInfo.
    const relayPort = (relay.address() as net.AddressInfo).port;
    process.env.http_proxy = process.env.https_proxy = `http://127.0.0.1:${relayPort}`;
    process.env.no_proxy = "localhost,127.0.0.1";
    const childSocket = join(directory, "child.sock");
    const child = await startWorkspaceEgressProxy({ socketPath: childSocket, ca,
      getContext: async () => ({ workspaceId: "child", ...nestedHooks, hooks: nestedHooks.httpHooks }),
      upstreamDnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
      upstreamFetch: (url, init) => fetch(url, { ...init, tls: { ...init.tls, ca: caPem } }),
      upstreamUpgrade: (url, options) => {
        // Proxied CONNECT must not pretend its destination is pinned locally.
        expect(options.lookup).toBeUndefined();
        const trustedOptions = { ...options, ca: caPem };
        return requestWebSocketUpgrade(url, trustedOptions);
      },
    });
    cleanup.push(() => child.close());
    for (const protocol of ["http", "https"]) {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        request({ socketPath: childSocket, path: `${protocol}://${hostname}/data`, headers: { authorization: `Bearer ${placeholder}` } }, response => {
          let body = "";
          response.on("data", chunk => { body += chunk; });
          response.on("end", () => resolve({ status: response.statusCode!, body }));
          response.on("error", reject);
        }).on("error", reject).end();
      });
      expect(response).toEqual({ status: 200, body: "parent response" });
    }
    expect(parentFetches).toEqual(["http", "https"].map(protocol => ({
      url: `${protocol}://8.8.8.8/data`, host: hostname, authorization: `Bearer ${value}`, proxy: "",
    })));
    const tunnel = net.connect(childSocket);
    cleanup.push(() => { tunnel.destroy(); });
    tunnel.setTimeout(5000, () => tunnel.destroy(new Error("Nested CONNECT timed out")));
    await once(tunnel, "connect");
    const connected = new Promise<string>((resolve, reject) => {
      let headers = "";
      const received = (chunk: Buffer) => {
        headers += chunk.toString();
        if (headers.includes("\r\n\r\n")) { tunnel.off("data", received); resolve(headers); }
      };
      tunnel.on("data", received);
      tunnel.once("error", reject);
    });
    tunnel.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`);
    expect(await connected).toContain("200 Connection Established");
    const secure = tls.connect({ socket: tunnel, servername: hostname, ca: caPem });
    cleanup.push(() => { secure.destroy(); });
    await once(secure, "secureConnect");
    const response = new Promise<string>((resolve, reject) => {
      let text = "";
      secure.on("data", chunk => { text += chunk.toString(); });
      secure.once("end", () => resolve(text));
      secure.once("error", reject);
    });
    secure.write(`GET /socket HTTP/1.1\r\nHost: ${hostname}\r\nAuthorization: Bearer ${placeholder}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    expect(await response).toContain("429 Too Many Requests");
    expect(websocketCredentials).toEqual([`Bearer ${value}`]);
    expect(pinnedUpgrades).toEqual(["8.8.8.8"]);
    expect(checked.length).toBeGreaterThanOrEqual(4);
    // A child-approved public answer cannot bypass the parent's own policy.
    parentAddress = "10.1.2.3";
    const refused = await new Promise<number>((resolve, reject) => {
      request({ socketPath: childSocket, path: `http://${hostname}/private`, headers: { authorization: `Bearer ${placeholder}` } }, response => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
        response.once("error", reject);
      }).on("error", reject).end();
    });
    expect(refused).toBe(403);
    expect(parentFetches).toHaveLength(2);
    expect(checked.at(-1)).toBe(parentAddress);
  } finally {
    for (const name of envNames) {
      if (oldEnv[name] === undefined) delete process.env[name]; else process.env[name] = oldEnv[name];
    }
    for (const dispose of cleanup.reverse()) await dispose();
  }
});
