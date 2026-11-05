import { expect, spyOn, test } from "bun:test";
import { request } from "node:http";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkspaceEgressProxy } from "../src/egress/egress-proxy.ts";
import { ensureMitmCa } from "../src/egress/mitm-ca.ts";
import { createHttpHooks } from "../src/secrets/placeholder-hooks.ts";

async function bridgeUnixSocket(socketPath: string): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer(client => {
    const upstream = connect(socketPath);
    sockets.add(client);
    sockets.add(upstream);
    client.once("close", () => sockets.delete(client));
    upstream.once("close", () => sockets.delete(upstream));
    client.pipe(upstream).pipe(client);
    upstream.once("error", () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  // SAFETY: this server is bound with a TCP host and port, never a Unix socket path.
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("TCP bridge did not bind to a port");
  return {
    port: address.port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test("HTTP redirect reflection is scrubbed at the wire boundary, after response transforms, with the body unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-header-test-"));
  const secret = "fake-github-credential";
  const placeholder = "KINTSUGI_PROXY_READY_GH_TOKEN";
  const hooks = createHttpHooks({
    allowedInternalHosts: ["localhost"],
    secrets: { GH_TOKEN: { allowInPath: true, value: secret, hosts: ["localhost"], placeholder } },
    onResponse(response) {
      response.headers.set("x-transformed", secret);
      return response;
    },
  });
  const socketPath = join(directory, "egress.sock");
  const ca = await ensureMitmCa({ kintsugiDataDir: directory, dockerHostKintsugiDataDir: directory, dockerBridgeHost: "127.0.0.1" });
  let calls = 0;
  const proxy = await startWorkspaceEgressProxy({ socketPath, ca,
    getContext: async () => ({ workspaceId: "test", hooks: hooks.httpHooks, env: hooks.env, secrets: hooks.secrets }),
    upstreamFetch: async (url, init) => {
      calls++;
      // The proxy resolves once and connects to the checked address, so the URL
      // carries the resolved IP while the Host header keeps the routed hostname.
      expect(["127.0.0.1", "[::1]"]).toContain(new URL(url).host);
      expect(url).toContain(`/${secret}`);
      expect(new Headers(init.headers).get("host")).toBe("localhost");
      expect(init.redirect).toBe("manual");
      const authorization = new Headers(init.headers).get("authorization")!;
      expect(Buffer.from(authorization.slice(6), "base64").toString()).toBe(`user:${secret}`);
      const response = new Response(secret, { status: 301, statusText: secret, headers: {
        location: `https://github.com/${secret}`, "x-basic-echo": authorization, "x-basic-token": authorization.slice(6), "x-echo": `${secret} ${secret}`, "x-safe": "untouched",
      } });
      response.headers.append("set-cookie", `one=${secret}; HttpOnly`);
      response.headers.append("set-cookie", "two=safe; Secure");
      response.headers.set(`x-${secret}`, "reflected header name");
      return response;
    },
  });
  const bridge = await bridgeUnixSocket(socketPath);
  try {
    const result = await new Promise<{ headers: import("node:http").IncomingHttpHeaders; body: string; status: number; statusText: string }>((resolve, reject) => {
      request({ host: "127.0.0.1", port: bridge.port, path: `http://localhost/${placeholder}`, headers: { authorization: `Basic ${Buffer.from(`user:${placeholder}`).toString("base64")}` } }, response => {
        let body = "";
        response.on("data", chunk => { body += chunk; });
        response.on("error", reject);
        response.on("end", () => resolve({ headers: response.headers, body, status: response.statusCode!, statusText: response.statusMessage! }));
      }).on("error", reject).end();
    });
    expect(result.status).toBe(301);
    expect(result.statusText).toBe("[REDACTED]");
    expect(result.headers.location).toBe("https://github.com/[REDACTED]");
    expect(result.headers["x-echo"]).toBe("[REDACTED] [REDACTED]");
    expect(result.headers["x-transformed"]).toBe("[REDACTED]");
    expect(result.headers["x-safe"]).toBe("untouched");
    expect(result.headers["x-basic-echo"]).toBe("Basic [REDACTED]");
    expect(result.headers["x-basic-token"]).toBe("[REDACTED]");
    expect(result.headers["set-cookie"]).toEqual(["one=[REDACTED]; HttpOnly", "two=safe; Secure"]);
    expect(JSON.stringify(result.headers)).not.toContain(secret);
    expect(result.body).toBe(secret);
    expect(calls).toBe(1);
  } finally {
    await bridge.close();
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an upstream body failure after headers are sent does not crash the proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-stream-failure-test-"));
  const socketPath = join(directory, "egress.sock");
  const ca = await ensureMitmCa({ kintsugiDataDir: directory, dockerHostKintsugiDataDir: directory, dockerBridgeHost: "127.0.0.1" });
  const upstreamError = new Error("upstream body failed");
  const hooks = createHttpHooks({ allowedInternalHosts: ["localhost"], secrets: {} });
  let failBody!: () => void;
  let calls = 0;
  const log = spyOn(console, "error").mockImplementation(() => {});
  const proxy = await startWorkspaceEgressProxy({
    socketPath,
    ca,
    getContext: async () => ({ workspaceId: "test", hooks: hooks.httpHooks, env: hooks.env, secrets: hooks.secrets }),
    upstreamFetch: async () => {
      calls++;
      if (calls > 1) return new Response("healthy");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          failBody = () => controller.error(upstreamError);
        },
      }));
    },
  });
  const bridge = await bridgeUnixSocket(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      const outgoing = request({ host: "127.0.0.1", port: bridge.port, path: "http://localhost/failing" }, response => {
        response.once("data", () => failBody());
        response.once("aborted", resolve);
        response.once("close", resolve);
        response.once("end", resolve);
        response.once("error", resolve);
      });
      outgoing.once("error", reject);
      outgoing.end();
    });

    const healthy = await new Promise<string>((resolve, reject) => {
      request({ host: "127.0.0.1", port: bridge.port, path: "http://localhost/healthy" }, response => {
        let body = "";
        response.on("data", chunk => { body += chunk; });
        response.once("error", reject);
        response.once("end", () => resolve(body));
      }).once("error", reject).end();
    });
    expect(healthy).toBe("healthy");
    expect(log).toHaveBeenCalledWith("Workspace egress response failed after its headers were sent", upstreamError);
  } finally {
    log.mockRestore();
    await bridge.close();
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
});
