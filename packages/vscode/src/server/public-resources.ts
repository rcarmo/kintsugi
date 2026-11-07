const resources = new Map([
  ["chat.json", "https://main.vscode-cdn.net/extensions/chat.json"],
  ["marketplace.json", "https://main.vscode-cdn.net/extensions/marketplace.json"],
  ["mcp.json", "https://main.vscode-cdn.net/mcp/servers.json"],
]);
export const vscodePublicResourcePrefix = "/vscode-public-resources/";
const maxResourceBytes = 8 * 1024 * 1024;
export interface PublicCatalogOptions extends RequestInit { proxy: string }
export type PublicCatalogFetcher = (input: string, init: PublicCatalogOptions) => Promise<Response>;

/** Public VS Code catalogs only: never accept a URL or forward browser credentials. */
export async function handleVSCodePublicResource(request: Request, url: URL, fetcher: PublicCatalogFetcher = fetch): Promise<Response | undefined> {
  if (!url.pathname.startsWith(vscodePublicResourcePrefix)) return;
  const name = url.pathname.slice(vscodePublicResourcePrefix.length);
  const gallery = name === "gallery/extensionquery";
  const target = gallery ? "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" : resources.get(name);
  if (!target || url.search) return new Response("Not found", { status: 404 });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": gallery ? "POST, OPTIONS" : "GET, OPTIONS", "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "", "cache-control": "no-store" } });
  const method = gallery ? "POST" : "GET";
  if (request.method !== method) return new Response("Method not allowed", { status: 405, headers: { allow: method } });
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (gallery) {
    if (!request.body) return new Response("Missing extension query", { status: 400 });
    body = await limitedBody(request.body, 1024 * 1024);
    if (!body) return new Response("Extension query is too large", { status: 413 });
    try { JSON.parse(new TextDecoder().decode(body)); }
    catch { return new Response("Invalid extension query", { status: 400 }); }
  }
  const headers = new Headers({ accept: request.headers.get("accept") ?? "application/json" });
  if (gallery) headers.set("content-type", "application/json");
  const upstream = await fetcher(target, { method, body, headers, credentials: "omit", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]), proxy: "" });
  if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); return new Response("VS Code public catalog is unavailable", { status: 502 }); }
  const content = await limitedBody(upstream.body, maxResourceBytes);
  if (!content) return new Response("VS Code public catalog is too large", { status: 502 });
  try { JSON.parse(new TextDecoder().decode(content)); }
  catch { return new Response("Invalid VS Code public catalog", { status: 502 }); }
  return new Response(content, { headers: {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    "cache-control": gallery ? "no-store" : "public, max-age=300",
  } });
}

async function limitedBody(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let bytes = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > limit) { await reader.cancel(); return; }
    chunks.push(result.value);
  }
  const content = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
  return content;
}
