import { afterEach, expect, test } from "bun:test";
import { createServer, request, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import tls from "node:tls";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { startWorkspaceEgressProxy } from "../src/egress/egress-proxy.ts";
import { ensureMitmCa, ensureLeafCertificate } from "../src/egress/mitm-ca.ts";
import { createHttpHooks } from "../src/secrets/placeholder-hooks.ts";
import { registerWorkspaceRequestTransform, type WorkspaceSecretContext } from "../src/secrets/workspace-secrets.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; });

async function listen(server: net.Server) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  // SAFETY: The listen callback completed on an IP address, so address() is a TCP AddressInfo.
  return (server.address() as net.AddressInfo).port;
}
async function localRelay(socketPath: string): Promise<number> {
  // Use the workspace's transport, with an ephemeral port reported by socat.
  const child = spawn("socat", ["-d", "-d", "TCP4-LISTEN:0,bind=127.0.0.1,reuseaddr,fork", `UNIX-CONNECT:${socketPath}`], {
    stdio: ["ignore", "ignore", "pipe"], detached: true,
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  cleanup.push(async () => {
    // Stop the listener and every connection child, not just the parent.
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGTERM");
    await closed;
  });
  return await new Promise<number>((resolve, reject) => {
    let logs = "";
    let ready = false;
    const timeout = setTimeout(() => reject(new Error(`Local proxy did not listen: ${logs}`)), 5000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.stderr.on("data", data => {
      if (ready) return;
      logs += data.toString();
      const listening = logs.match(/listening on AF=2 127\.0\.0\.1:(\d+)/);
      if (listening) { ready = true; clearTimeout(timeout); resolve(Number(listening[1])); }
    });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Local proxy exited ${code}: ${logs}`)); });
  });
}

// Send absolute-form HTTP directly to the fixture relay, independent of Bun's
// inherited HTTP_PROXY/NO_PROXY settings.
async function proxyRequest(port: number, target: string, { method = "GET", headers = {}, body = "" }: {
  method?: string; headers?: Record<string, string>; body?: string;
} = {}) {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    // The restart case needs a new connection to the surviving relay, not a
    // global-Agent socket whose upstream listener has just been closed. Explicit
    // persistent TLS tests below retain their own connections independently.
    const req = request({ hostname: "127.0.0.1", port, path: target, method, agent: false,
      headers: { ...headers, host: new URL(target).host, "content-length": Buffer.byteLength(body) },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => body += chunk);
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function tunnel(proxyPort: number, target: string, headers = "") {
  const socket = net.connect(proxyPort, "127.0.0.1");
  return await new Promise<{ socket: net.Socket; response: string }>((resolve, reject) => {
    socket.once("error", reject);
    socket.setTimeout(5000, () => socket.destroy(new Error("CONNECT timeout")));
    socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${headers}\r\n`));
    let response = "";
    function received(data: Buffer) {
      response += data.toString();
      if (response.includes("\r\n\r\n")) { socket.off("data", received); socket.off("error", reject); resolve({ socket, response }); }
    }
    socket.on("data", received);
  });
}

// Real HTTP, CONNECT, TLS termination, placeholder injection and outgoing fetch;
// no Docker, registry, browser or external network required.
test("workspace socket controls HTTP and HTTPS identity, policy and reconnection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-egress-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const ca = await ensureMitmCa({ kintsugiDataDir: directory, dockerHostKintsugiDataDir: directory, dockerBridgeHost: "127.0.0.1" });
  const leaf = await ensureLeafCertificate(ca, ["127.0.0.1", "localhost", "::1"]);
  const caPem = await readFile(ca.certPath, "utf8");
  const received: { key?: string | string[]; authorization?: string; proxyAuthorization?: string | string[]; body: string }[] = [];
  const handler: RequestListener = (req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk.toString());
    req.on("end", () => { received.push({ key: req.headers["x-api-key"], authorization: req.headers.authorization, proxyAuthorization: req.headers["proxy-authorization"], body }); res.end("destination response"); });
  };
  const destination = createServer(handler);
  const httpPort = await listen(destination);
  cleanup.push(async () => { destination.closeAllConnections(); await new Promise<void>(resolve => destination.close(() => resolve())); });
  const secureDestination = createHttpsServer({ cert: await readFile(leaf.certPath), key: await readFile(leaf.keyPath) }, handler);
  const httpsPort = await listen(secureDestination);
  cleanup.push(async () => { secureDestination.closeAllConnections(); await new Promise<void>(resolve => secureDestination.close(() => resolve())); });
  const contexts = new Map<string, WorkspaceSecretContext>();
  for (const workspaceId of ["alpha", "beta"]) {
    const hooks = createHttpHooks({
      allowedInternalHosts: ["127.0.0.1", "localhost"],
      secrets: { API_KEY: { value: `${workspaceId}-secret`, placeholder: "KINTSUGI_TEST_PLACEHOLDER", hosts: ["127.0.0.1", "localhost"] } },
    });
    contexts.set(workspaceId, { workspaceId, env: hooks.env, hooks: hooks.httpHooks, secrets: hooks.secrets });
  }
  // Route logical TLS port443 to an ephemeral local fixture, trusting its test CA.
  // Requests still use the real upstream fetch and the proxy's real HTTP hooks.
  // The proxy pins the policy-checked address into the URL and keeps the routed
  // hostname in Host and TLS serverName; merge the proxy's serverName with the
  // fixture's trust so certificate verification keeps running against the name.
  const upstreamFetch = (url: string, init: RequestInit & { tls?: { serverName?: string } }) => {
    const target = new URL(url);
    if (target.protocol === "https:" && !target.port) { target.hostname = "127.0.0.1"; target.port = String(httpsPort); }
    return fetch(target, { ...init, proxy: "", tls: { ...init.tls, ca: caPem } });
  };
  const start = (id: string) => startWorkspaceEgressProxy({ socketPath: join(directory, id, "egress.sock"), ca, getContext: async () => contexts.get(id)!, upstreamFetch,
    // Like upstreamFetch, map logical HTTPS port 443 to the local TLS fixture.
    upstreamConnect: (port, hostname) => net.connect(port === 443 ? httpsPort : port, hostname),
  });
  let alpha = await start("alpha");
  const beta = await start("beta");
  cleanup.push(() => alpha.close()); cleanup.push(() => beta.close());
  const alphaPort = await localRelay(join(directory, "alpha", "egress.sock"));
  const betaPort = await localRelay(join(directory, "beta", "egress.sock"));
  const headers = { "X-Api-Key": "KINTSUGI_TEST_PLACEHOLDER", Authorization: "Bearer destination-authorization", "Proxy-Authorization": `Basic ${Buffer.from("beta:forged-token").toString("base64")}`, "X-Workspace-Id": "beta" };
  for (const [id, port] of [["alpha", alphaPort], ["beta", betaPort]] as const) {
    const response = await proxyRequest(port, `http://127.0.0.1:${httpPort}/upload`, { method: "POST", headers, body: "streamed payload" });
    expect(response.body).toBe("destination response");
    expect(received.at(-1)).toEqual({ key: `${id}-secret`, authorization: "Bearer destination-authorization", proxyAuthorization: undefined, body: "streamed payload" });
  }
  // Version-independent policy: real verified releases plus past/future/dev UAs.
  // Model Zig's automatic retry after rejection as absolute-form HTTPS.
  for (const version of ["0.14.1", "0.15.2", "0.16.0", "0.17.0-dev.123+abcdef", "1.0.0", "42.0.0"]) {
    const userAgent = `User-Agent: zig/${version} (std.http)\r\n`;
    const zigHeaders = { ...headers, "User-Agent": `zig/${version} (std.http)` };
    const beforeConnect = received.length;
    const rejected = await tunnel(alphaPort, "127.0.0.1:443", userAgent);
    expect(rejected.response).toContain("405 Method Not Allowed");
    expect(rejected.response).toContain("Connection: close\r\nContent-Length: 0\r\n\r\n");
    expect(received.length).toBe(beforeConnect);
    rejected.socket.destroy();
    const forwarded = await proxyRequest(alphaPort, "https://127.0.0.1/zig", { headers: zigHeaders });
    expect(forwarded.status).toBe(200);
    expect(forwarded.body).toBe("destination response");
    expect(received.at(-1)).toEqual({ key: "alpha-secret", authorization: "Bearer destination-authorization", proxyAuthorization: undefined, body: "" });
    const beforeDenied = received.length;
    const denied = await tunnel(alphaPort, "127.0.0.2:443", userAgent);
    expect(denied.response).toContain("403");
    denied.socket.destroy();
    expect((await proxyRequest(alphaPort, "https://127.0.0.2/private", { headers: zigHeaders })).status).toBe(403);
    expect(received.length).toBe(beforeDenied);
  }
  // Only the default Zig std.http signature selects the compatibility path.
  for (const agent of ["curl/8.0.0", "zig/0.16.0", "zig/ (std.http)", "zig/0.16.0 (std.http) custom", "not-zig/0.16.0 (std.http)"]) {
    const unaffected = await tunnel(alphaPort, "localhost:443", `User-Agent: ${agent}\r\n`);
    expect(unaffected.response).toContain("200 Connection Established");
    unaffected.socket.destroy();
  }
  const connected = await tunnel(alphaPort, "localhost:443", `Proxy-Authorization: ${headers["Proxy-Authorization"]}\r\nX-Workspace-Id: beta\r\n`);
  expect(connected.response).toContain("200 Connection Established");
  const secure = tls.connect({ socket: connected.socket, servername: "localhost", ca: caPem, rejectUnauthorized: true });
  const response = await new Promise<string>((resolve, reject) => {
    let body = "";
    secure.on("error", reject);
    secure.on("data", data => body += data.toString());
    secure.on("end", () => resolve(body));
    secure.once("secureConnect", () => secure.write(`GET /secure HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nX-Api-Key: KINTSUGI_TEST_PLACEHOLDER\r\nAuthorization: Bearer destination-authorization\r\nProxy-Authorization: forged\r\n\r\n`));
  });
  secure.destroy();
  expect(response).toContain("destination response");
  expect(received.at(-1)).toEqual({ key: "alpha-secret", authorization: "Bearer destination-authorization", proxyAuthorization: undefined, body: "" });
  // Hosts without selected secrets retain opaque CONNECT tunnelling.
  const withoutSecrets = createHttpHooks({ allowedInternalHosts: ["127.0.0.1"] });
  contexts.set("beta", { workspaceId: "beta", env: {}, hooks: withoutSecrets.httpHooks, secrets: [] });
  // A TLS connection established before the host gains a secret remains opaque.
  // Exercise the real CONNECT/TLS transport, not just the request hooks.
  async function connectTls() {
    const connection = await tunnel(betaPort, "127.0.0.1:443");
    expect(connection.response).toContain("200 Connection Established");
    const socket = tls.connect({ socket: connection.socket, ca: caPem, rejectUnauthorized: true });
    cleanup.push(() => { socket.destroy(); });
    await new Promise<void>((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
    return socket;
  }
  async function requestOnTls(socket: tls.TLSSocket) {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const received = (data: Buffer) => {
        output += data.toString();
        if (output.includes("destination response")) { socket.off("data", received); socket.off("error", reject); resolve(); }
      };
      socket.on("data", received);
      socket.once("error", reject);
      socket.write("GET /reuse HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\nX-Api-Key: KINTSUGI_TEST_PLACEHOLDER\r\n\r\n");
    });
  }
  const existingTls = await connectTls();
  await requestOnTls(existingTls);
  expect(received.at(-1)?.key).toBe("KINTSUGI_TEST_PLACEHOLDER");
  const addedSecret = createHttpHooks({ allowedInternalHosts: ["127.0.0.1"], secrets: { API_KEY: { value: "new-secret", placeholder: "KINTSUGI_TEST_PLACEHOLDER", hosts: ["127.0.0.1"] } } });
  contexts.set("beta", { workspaceId: "beta", env: addedSecret.env, hooks: addedSecret.httpHooks, secrets: addedSecret.secrets });
  await requestOnTls(existingTls);
  expect(received.at(-1)?.key).toBe("KINTSUGI_TEST_PLACEHOLDER");
  existingTls.destroy();
  const freshTls = await connectTls();
  await requestOnTls(freshTls);
  expect(received.at(-1)?.key).toBe("new-secret");
  freshTls.destroy();
  contexts.set("beta", { workspaceId: "beta", env: {}, hooks: withoutSecrets.httpHooks, secrets: [] });
  // A credential bridge must select TLS interception without ordinary secrets.
  let bridgeHosts = ["127.0.0.1"];
  registerWorkspaceRequestTransform("test-tls-bridge", async (request) => request, async () => bridgeHosts);
  cleanup.push(() => { registerWorkspaceRequestTransform("test-tls-bridge", async (request) => request); });
  const bridgeHooks = createHttpHooks({
    allowedInternalHosts: ["127.0.0.1"],
    onRequest: async (request) => {
      request.headers.set("x-api-key", "bridge-secret");
      return request;
    },
  });
  contexts.set("beta", { workspaceId: "beta", env: {}, hooks: bridgeHooks.httpHooks, secrets: [] });
  const bridgeTls = await connectTls();
  await requestOnTls(bridgeTls);
  expect(received.at(-1)?.key).toBe("bridge-secret");
  bridgeTls.destroy();
  // Endpoint changes apply to the next CONNECT without rebuilding the context.
  bridgeHosts = [];
  const opaqueTls = await connectTls();
  await requestOnTls(opaqueTls);
  expect(received.at(-1)?.key).toBe("KINTSUGI_TEST_PLACEHOLDER");
  opaqueTls.destroy();
  contexts.set("beta", { workspaceId: "beta", env: {}, hooks: withoutSecrets.httpHooks, secrets: [] });
  // Zig also needs the alternate path when there are no secrets: a normal
  // upstream HTTPS server would reject its plaintext after CONNECT too.
  const noSecretsZig = await tunnel(betaPort, "127.0.0.1:443", "User-Agent: zig/1.0.0 (std.http)\r\n");
  expect(noSecretsZig.response).toContain("405 Method Not Allowed");
  noSecretsZig.socket.destroy();
  const noSecretsForwarded = await proxyRequest(betaPort, "https://127.0.0.1/zig-no-secrets", {
    headers: { "User-Agent": "zig/1.0.0 (std.http)", "X-Api-Key": "KINTSUGI_TEST_PLACEHOLDER" },
  });
  expect(noSecretsForwarded.status).toBe(200);
  expect(received.at(-1)?.key).toBe("KINTSUGI_TEST_PLACEHOLDER");
  expect(received.at(-1)?.authorization).toBeUndefined();
  // The Zig compatibility path must not change non-HTTPS CONNECT tunnels.
  const plain = await tunnel(betaPort, `127.0.0.1:${httpPort}`, "User-Agent: zig/0.16.0 (std.http)\r\n");
  expect(plain.response).toContain("200 Connection Established");
  const tunneled = await new Promise<string>((resolve, reject) => {
    let body = "";
    plain.socket.on("error", reject);
    plain.socket.on("data", data => body += data.toString());
    plain.socket.on("end", () => resolve(body));
    plain.socket.write(`GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1:${httpPort}\r\nConnection: close\r\nAuthorization: Bearer destination-authorization\r\n\r\n`);
  });
  plain.socket.destroy();
  expect(tunneled).toContain("destination response");
  expect(received.at(-1)?.authorization).toBe("Bearer destination-authorization");
  const beforeBlocked = received.length;
  expect((await proxyRequest(alphaPort, "http://127.0.0.2/private")).status).toBe(403);
  const blocked = await tunnel(alphaPort, "127.0.0.2:443");
  expect(blocked.response).toContain("403"); blocked.socket.destroy();
  expect(received.length).toBe(beforeBlocked);
  // Restart only the application-side listener. The workspace relay stays up.
  await alpha.close(); alpha = await start("alpha");
  const reconnected = await proxyRequest(alphaPort, `http://127.0.0.1:${httpPort}/after-restart`, { headers });
  expect(reconnected.body).toBe("destination response");
  expect(received.at(-1)?.key).toBe("alpha-secret");
}, 20000);


test("local relay survives an unavailable socket and forwards concurrent large transfers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-relay-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "egress.sock");
  const port = await localRelay(socketPath);
  // A failed UNIX-CONNECT must only terminate that connection's child.
  await new Promise<void>((resolve, reject) => {
    const client = net.connect(port, "127.0.0.1");
    client.setTimeout(5000, () => client.destroy(new Error("Unavailable socket did not close")));
    client.on("error", error => {
      if (!("code" in error) || error.code !== "ECONNRESET") reject(error);
    });
    client.on("close", () => resolve());
    client.resume();
  });
  const connections = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.pipe(socket);
  });
  cleanup.push(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await Promise.all(Array.from({ length: 5 }, (_, index) => new Promise<void>((resolve, reject) => {
    const payload = Buffer.alloc(256 * 1024, index);
    const chunks: Buffer[] = [];
    let received = 0;
    const client = net.connect(port, "127.0.0.1", () => client.write(payload));
    client.setTimeout(5000, () => client.destroy(new Error("Relay transfer timed out")));
    client.on("error", reject);
    client.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received === payload.length) client.end();
    });
    client.on("close", () => {
      try { expect(Buffer.concat(chunks)).toEqual(payload); resolve(); }
      catch (error) { reject(error); }
    });
  })));
}, 15000);
