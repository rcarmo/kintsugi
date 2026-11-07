import { expect, test } from "bun:test";
import { handleVSCodePublicResource, type PublicCatalogFetcher } from "../src/server/public-resources.ts";

function request(path: string, method = "GET") {
  const url = new URL(path, "https://dynamic-host.example");
  return { url, request: new Request(url, { method, headers: { cookie: "management=private", authorization: "Bearer private" } }) };
}

test("public catalogs have a fixed upstream allowlist and no ambient credentials", async () => {
  for (const [name, upstream] of [["chat.json", "extensions/chat.json"], ["marketplace.json", "extensions/marketplace.json"], ["mcp.json", "mcp/servers.json"]]) {
    const input = request(`/vscode-public-resources/${name}`);
    const fetcher: PublicCatalogFetcher = async (url, init) => {
      expect(String(url)).toBe(`https://main.vscode-cdn.net/${upstream}`);
      expect(new Headers(init?.headers).get("cookie")).toBeNull();
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      return new Response('{"public":true}', { headers: { "set-cookie": "upstream=not-forwarded" } });
    };
    const response = (await handleVSCodePublicResource(input.request, input.url, fetcher))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ public: true });
  }
});

test("catalog routing rejects URL substitution, methods, non-JSON and oversized replies", async () => {
  const forbidden: PublicCatalogFetcher = async () => { throw new Error("must not fetch"); };
  for (const path of ["https://other.example", "chat.json?url=http://127.0.0.1/", "unknown.json", "chat.json/extra"]) {
    const input = request(`/vscode-public-resources/${path}`);
    expect((await handleVSCodePublicResource(input.request, input.url, forbidden))!.status).toBe(404);
  }
  const post = request("/vscode-public-resources/chat.json", "POST");
  expect((await handleVSCodePublicResource(post.request, post.url, forbidden))!.status).toBe(405);
  for (const content of ["<html>not JSON</html>", "x".repeat(8 * 1024 * 1024 + 1)]) {
    const input = request("/vscode-public-resources/chat.json");
    const fetcher: PublicCatalogFetcher = async () => new Response(content);
    expect((await handleVSCodePublicResource(input.request, input.url, fetcher))!.status).toBe(502);
  }
});
