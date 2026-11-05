import { expect, test } from "bun:test";
import { once } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { startWorkspaceEgressProxy } from "../src/egress/egress-proxy.ts";
import { ensureLeafCertificate, ensureMitmCa } from "../src/egress/mitm-ca.ts";
import { createHttpHooks } from "../src/secrets/placeholder-hooks.ts";

/**
 * DNS rebinding: the policy check and the upstream connection must use the
 * same address. Every test answers the first lookup with a public address and
 * later lookups with a private one; if the proxy re-resolved anywhere, the
 * request would either be blocked or reach a destination the policy never saw.
 */
function rebindingLookup(hostnames: Record<string, { first: string; later: string }>, stableCalls = 1) {
  let calls = 0;
  const lookup = async (hostname: string): Promise<Array<{ address: string; family: number }>> => {
    const rebind = hostnames[hostname];
    if (rebind) {
      calls++;
      const address = calls <= stableCalls ? rebind.first : rebind.later;
      return [{ address, family: net.isIP(address) === 6 ? 6 : 4 }];
    }
    if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) === 6 ? 6 : 4 }];
    throw new Error(`unexpected lookup: ${hostname}`);
  };
  return { lookup, calls: () => calls };
}

type Recorded = {
  fetches: Array<{ url: string; host: string | null; serverName?: string }>;
  connects: Array<{ port: number; address: string }>;
  lookups: string[];
};

async function proxiedWorkspace(hostnames: Record<string, { first: string; later: string }>, options: { mitmHost?: string; stableCalls?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-pin-"));
  const ca = await ensureMitmCa({ kintsugiDataDir: directory, dockerHostKintsugiDataDir: directory, dockerBridgeHost: "127.0.0.1" });
  const rebind = rebindingLookup(hostnames, options.stableCalls ?? 1);
  const hooks = createHttpHooks(options.mitmHost ? { secrets: { API_KEY: { hosts: [options.mitmHost], value: "mitm-secret", placeholder: "KINTSUGI_PIN_PLACEHOLDER" } } } : {});
  const recorded: Recorded = { fetches: [], connects: [], lookups: [] };
  // A local sink accepts tunnel connections so tests need no real upstream network.
  const sinkConnections = new Set<net.Socket>();
  const sink = net.createServer(socket => { sinkConnections.add(socket); socket.once("close", () => sinkConnections.delete(socket)); socket.pipe(socket); });
  sink.listen(0, "127.0.0.1");
  await once(sink, "listening");
  // SAFETY: The listener is bound to a TCP address, so address() is an AddressInfo.
  const sinkPort = (sink.address() as net.AddressInfo).port;
  const proxy = await startWorkspaceEgressProxy({
    socketPath: join(directory, "egress.sock"),
    ca,
    getContext: async () => ({ workspaceId: "pin", env: hooks.env, hooks: hooks.httpHooks, secrets: hooks.secrets }),
    upstreamDnsLookup: rebind.lookup,
    upstreamProxyForUrl: () => "",
    upstreamFetch: async (url, init) => {
      recorded.fetches.push({ url, host: new Headers(init.headers).get("host"), serverName: init.tls?.serverName });
      return new Response("pinned response");
    },
    upstreamConnect: (port, address) => {
      recorded.connects.push({ port, address });
      return net.connect(sinkPort, "127.0.0.1");
    },
    upstreamUpgrade: (url, options) => {
      const lookup = options.lookup;
      if (!lookup) throw new Error("pinned lookup missing from upgrade options");
      for (const all of [false, true]) {
        lookup(url.hostname, { all }, (error, address) => {
          if (error) return;
          // SAFETY: The proxy's pinned lookup answers with the policy-checked address —
          // bare for a single-address lookup, or a one-element array for {all: true}.
          recorded.lookups.push(all ? (address as Array<{ address: string }>).map(entry => entry.address).join(",") : String(address));
        });
      }
      throw new Error("upgrade fixture only captures the pinned lookup");
    },
  });
  const dispose = async () => {
    await proxy.close();
    for (const socket of sinkConnections) socket.destroy();
    await new Promise<void>(resolve => sink.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  return { socketPath: join(directory, "egress.sock"), ca, recorded, calls: rebind.calls, dispose };
}

function proxyFetch(socketPath: string, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ socketPath, path: target, method: "GET", headers: { host: new URL(target).host } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    }).on("error", reject).end();
  });
}

function proxyConnect(socketPath: string, target: string): Promise<{ response: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("error", reject);
    socket.setTimeout(5000, () => socket.destroy(new Error("CONNECT timeout")));
    socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let response = "";
    function received(data: Buffer) {
      response += data.toString();
      if (response.includes("\r\n\r\n")) { socket.off("data", received); socket.off("error", reject); resolve({ socket, response }); }
    }
    socket.on("data", received);
  });
}

test("HTTP egress connects to the address the policy checked, keeping the routed Host and serverName", async () => {
  const workspace = await proxiedWorkspace({ "rebind.test": { first: "93.184.215.14", later: "10.6.6.6" } }, { stableCalls: 2 });
  try {
    const plain = await proxyFetch(workspace.socketPath, "http://rebind.test/data");
    expect(plain.status).toBe(200);
    expect(plain.body).toBe("pinned response");
    const secure = await proxyFetch(workspace.socketPath, "https://rebind.test/data");
    expect(secure.status).toBe(200);
    expect(workspace.calls()).toBe(2);
    expect(workspace.recorded.fetches).toEqual([
      { url: "http://93.184.215.14/data", host: "rebind.test", serverName: undefined },
      { url: "https://93.184.215.14/data", host: "rebind.test", serverName: "rebind.test" },
    ]);
    expect(workspace.recorded.connects).toEqual([]);
  } finally {
    await workspace.dispose();
  }
});

test("CONNECT tunnels use the checked address, and forbidden destinations never connect", async () => {
  const workspace = await proxiedWorkspace({ "rebind.test": { first: "93.184.215.14", later: "10.6.6.6" } });
  try {
    const accepted = await proxyConnect(workspace.socketPath, "rebind.test:443");
    expect(accepted.response).toContain("200 Connection Established");
    accepted.socket.destroy();
    expect(workspace.calls()).toBe(1);
    expect(workspace.recorded.connects).toEqual([{ port: 443, address: "93.184.215.14" }]);
    // A destination that is already private on the first answer is refused outright.
    const refused = await proxyConnect(workspace.socketPath, "10.9.9.9:443");
    expect(refused.response).toContain("403");
    refused.socket.destroy();
    expect(workspace.recorded.connects.length).toBe(1);
  } finally {
    await workspace.dispose();
  }
});

test("WebSocket upgrades resolve through the pinned address only", async () => {
  // Bun's node:http server only emits `upgrade` for TLS listeners, so like every
  // other WebSocket test this goes through the MITM path: CONNECT, then TLS,
  // then the upgrade request. Two policy checks see the hostname (CONNECT and
  // upgrade); both stable answers are the public address, and anything after
  // that would answer privately.
  const workspace = await proxiedWorkspace({ "rebind.test": { first: "93.184.215.14", later: "10.6.6.6" } }, { mitmHost: "rebind.test", stableCalls: 2 });
  try {
    await ensureLeafCertificate(workspace.ca, "rebind.test");
    const caPem = await readFile(workspace.ca.certPath, "utf8");
    const tunnel = await proxyConnect(workspace.socketPath, "rebind.test:443");
    expect(tunnel.response).toContain("200 Connection Established");
    const secure = tls.connect({ socket: tunnel.socket, ca: caPem, servername: "rebind.test", rejectUnauthorized: true });
    await once(secure, "secureConnect");
    secure.write("GET /socket HTTP/1.1\r\nHost: rebind.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    const rejection = await new Promise<string>(resolve => {
      let response = "";
      secure.on("data", (chunk: Buffer) => {
        response += chunk.toString();
        if (response.includes("\r\n\r\n")) resolve(response);
      });
      secure.once("close", () => resolve(response));
      secure.once("error", () => resolve(response));
    });
    expect(rejection).toContain("upgrade fixture only captures the pinned lookup");
    expect(workspace.calls()).toBe(2);
    expect(workspace.recorded.lookups).toEqual(["93.184.215.14", "93.184.215.14"]);
    secure.destroy();
  } finally {
    await workspace.dispose();
  }
});

test("blocked destinations are refused before any upstream connection", async () => {
  const workspace = await proxiedWorkspace({ "private.test": { first: "10.0.0.5", later: "10.0.0.5" } });
  try {
    const result = await proxyFetch(workspace.socketPath, "http://private.test/data");
    expect(result.status).toBe(403);
    expect(workspace.recorded.fetches).toEqual([]);
    expect(workspace.recorded.connects).toEqual([]);
  } finally {
    await workspace.dispose();
  }
});
