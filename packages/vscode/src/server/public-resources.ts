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
  const target = resources.get(url.pathname.slice(vscodePublicResourcePrefix.length));
  if (!target || url.search) return new Response("Not found", { status: 404 });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  const upstream = await fetcher(target, { headers: { accept: "application/json" }, credentials: "omit", redirect: "error", signal: request.signal, proxy: "" });
  if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); return new Response("VS Code public catalog is unavailable", { status: 502 }); }
  const chunks: Uint8Array[] = [];
  const reader = upstream.body.getReader();
  let bytes = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > maxResourceBytes) { await reader.cancel(); return new Response("VS Code public catalog is too large", { status: 502 }); }
    chunks.push(result.value);
  }
  const content = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
  try { JSON.parse(new TextDecoder().decode(content)); }
  catch { return new Response("Invalid VS Code public catalog", { status: 502 }); }
  return new Response(content, { headers: {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=300",
  } });
}
