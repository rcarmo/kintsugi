import { expect, test } from "bun:test";
import { once } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureMitmCa } from "../src/egress/mitm-ca.ts";
import { startWorkspaceEgressProxy } from "../src/egress/egress-proxy.ts";
import { createHttpHooks } from "../src/secrets/placeholder-hooks.ts";

function proxyGet(socketPath: string, url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ socketPath, path: url, headers: { host: new URL(url).host } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); }).on("error", reject).end();
  });
}

test("TLS exceptions are exact-origin, preserve DNS pinning and support configured non-default HTTPS CONNECT ports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-origin-tls-")), socketPath = join(dir, "egress.sock");
  const ca = await ensureMitmCa({ kintsugiDataDir: dir, dockerHostKintsugiDataDir: dir, dockerBridgeHost: "127.0.0.1" });
  const origin = "https://configured.example.test:8443";
  const hooks = createHttpHooks({ blockInternalRanges: false, isIpAllowed: info => info.ip === "203.0.113.8", secrets: { TOKEN: { hosts: ["configured.example.test"], origins: [origin], placeholder: "FIXTURE_TOKEN", value: "private-token" } } });
  const calls: Array<{ url: string; host: string | null; serverName?: string; rejectUnauthorized?: boolean }> = [];
  const proxy = await startWorkspaceEgressProxy({ socketPath, ca, getContext: async () => ({ workspaceId: "fixture", env: hooks.env, hooks: hooks.httpHooks, secrets: hooks.secrets, untrustedTlsOrigins: [origin] }), upstreamDnsLookup: async () => [{ address: "203.0.113.8", family: 4 }], upstreamProxyForUrl: () => "", upstreamFetch: async (url, init) => {
    calls.push({ url, host: new Headers(init.headers).get("host"), serverName: init.tls?.serverName, rejectUnauthorized: init.tls?.rejectUnauthorized });
    return new Response("ok");
  } });
  let secure: tls.TLSSocket | undefined;
  try {
    expect(await proxyGet(socketPath, `${origin}/repo`)).toBe(200);
    expect(await proxyGet(socketPath, "https://configured.example.test:9443/repo")).toBe(200);
    expect(await proxyGet(socketPath, "https://another.example.test:8443/repo")).toBe(200);
    expect(calls.map(c => c.rejectUnauthorized)).toEqual([false, undefined, undefined]);
    expect(calls[0]).toMatchObject({ url: "https://203.0.113.8:8443/repo", host: "configured.example.test:8443", serverName: "configured.example.test" });
    const socket = net.connect(socketPath);
    await once(socket, "connect");
    socket.write("CONNECT configured.example.test:8443 HTTP/1.1\r\nHost: configured.example.test:8443\r\n\r\n");
    const [response] = await once(socket, "data");
    expect(response.toString()).toContain("200 Connection Established");
    secure = tls.connect({ socket, servername: "configured.example.test", ca: await readFile(ca.certPath), rejectUnauthorized: true });
    await once(secure, "secureConnect");
    secure.write("GET /repo HTTP/1.1\r\nHost: forged.example.test\r\nAuthorization: token FIXTURE_TOKEN\r\nConnection: close\r\n\r\n");
    let body = "";
    secure.on("data", chunk => { body += chunk.toString(); });
    await once(secure, "end");
    expect(body).toContain("200 OK");
    expect(calls.at(-1)).toMatchObject({ url: "https://203.0.113.8:8443/repo", host: "configured.example.test:8443", rejectUnauthorized: false });
  } finally { secure?.destroy(); await proxy.close(); await rm(dir, { recursive: true, force: true }); }
}, 15000);
