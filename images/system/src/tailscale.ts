import { request } from "node:http";
type ServeConfig = {
  TCP?: Record<string, { HTTPS: boolean }>;
  Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
};
async function localApi(
  socketPath: string,
  method: string,
  body?: string,
  etag?: string,
) {
  const headers: import("node:http").OutgoingHttpHeaders = { host: "local-tailscaled.sock" };
  if (body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }
  if (etag) headers["if-match"] = etag;
  return new Promise<{ status: number; etag?: string; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: "/localapi/v0/serve-config",
          method,
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("error", reject);
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              etag: response.headers.etag,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.setTimeout(5000, () =>
        req.destroy(new Error("Tailscale Serve request timed out")),
      );
      req.on("error", reject);
      req.end(body);
    },
  );
}
// The app independently manages preview ports. Compare-and-set preserves its
// concurrent updates without sharing locks across process/PID namespaces.
export async function setSupervisorRoutes(
  host: string,
  target: number,
  socket = "/var/run/tailscale/tailscaled.sock",
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const read = await localApi(socket, "GET");
    if (read.status !== 200 || !read.etag)
      throw new Error(
        `Tailscale Serve read failed (${read.status}): ${read.body}`,
      );
    const config: ServeConfig = JSON.parse(read.body) ?? {};
    config.TCP ??= {};
    config.Web ??= {};
    for (const [port, upstream] of [
      [443, target],
      [8443, 3001],
    ]) {
      config.TCP[String(port)] = { HTTPS: true };
      config.Web[`${host}:${port}`] = {
        Handlers: { "/": { Proxy: `http://127.0.0.1:${upstream}` } },
      };
    }
    const write = await localApi(
      socket,
      "POST",
      JSON.stringify(config),
      read.etag,
    );
    if (write.status === 412) continue;
    if (write.status !== 200)
      throw new Error(
        `Tailscale Serve write failed (${write.status}): ${write.body}`,
      );
    return;
  }
  throw new Error("Tailscale Serve configuration kept changing during update");
}
