import { expect, test } from "bun:test";
import { parse as parseJavaScript } from "@babel/parser";
import { PreviewSources } from "../src/ingress/preview-sources.ts";
import { previewBlobIdentity, previewSourceUrl } from "../src/preview-source.ts";
import { previewContentPolicy } from "../src/preview-url.ts";

const context = { publicOrigin: "https://dynamic.example", root: "/~preview/cap/", app: "port-3152", upstream: "http://localhost:3152/index.html", windowGlobals: true, policy: "script-src-elem blob:" };
const id = () => crypto.randomUUID();
const resolve = async (_workspaceId: string) => {};

test("generated sources are opaque capabilities and are compiled for their server-owned context", async () => {
  const sources = new PreviewSources(); const document = sources.create("one", context), key = id();
  const url = previewSourceUrl(context.publicOrigin, document, key);
  const read = sources.request(new Request(url, { headers: { origin: "null", cookie: "management=private" } }), resolve);
  const put = await sources.request(new Request(url, { method: "PUT", headers: { origin: "null", "content-type": "text/javascript" }, body: 'import x from "/module.js"; window.path=location.pathname;' }), resolve);
  expect(put!.status).toBe(204);
  const response = (await read)!; const body = await response.text();
  expect(response.headers.get("content-type")).toBe("text/javascript");
  expect(response.headers.get("access-control-allow-origin")).toBe("null");
  expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(body).toContain("https://dynamic.example/~preview/cap/port-3152/module.js");
  expect(body).toContain("__kintsugiPreviewGlobals.location.pathname");
  expect(body).not.toContain("management=private");
  expect((await sources.request(new Request(previewSourceUrl(context.publicOrigin, "x".repeat(43), key)), resolve))!.status).toBe(403);
  expect((await sources.request(new Request(url, { method: "PUT", body: "changed" }), resolve))!.status).toBe(409);
});

test("CSP wildcards cannot turn a blocked Blob into an allowed HTTPS script", async () => {
  for (const policy of ["script-src-elem 'none'", "script-src-elem https:", "script-src-elem *", "script-src-elem blob:, script-src-elem 'none'"]) {
    const sources = new PreviewSources(), document = sources.create("one", { ...context, policy });
    expect((await sources.request(new Request(previewSourceUrl(context.publicOrigin, document, id())), resolve))!.status).toBe(403);
  }
  const sources = new PreviewSources(); const document = sources.create("one", { ...context, policy: "script-src-elem 'nonce-author' 'nonce-platform'", nonce: "platform" });
  const url = previewSourceUrl(context.publicOrigin, document, id());
  await sources.request(new Request(url, { method: "PUT", body: "location.pathname", headers: { "content-type": "text/javascript" } }), resolve);
  expect((await sources.request(new Request(url + "?nonce=author"), resolve))!.status).toBe(200);
  expect((await sources.request(new Request(url + "?nonce=platform"), resolve))!.status).toBe(403);
});

test("generated source preflight, foreign origin denial, MIME and revocation stay native", async () => {
  const sources = new PreviewSources(), document = sources.create("one", context), url = previewSourceUrl(context.publicOrigin, document, id());
  expect((await sources.request(new Request(url, { method: "OPTIONS", headers: { origin: "null" } }), resolve))!.status).toBe(204);
  expect((await sources.request(new Request(url, { method: "PUT", headers: { origin: "https://foreign.example" }, body: "true" }), resolve))!.status).toBe(403);
  await sources.request(new Request(url, { method: "PUT", body: "true", headers: { "content-type": "text/plain" } }), resolve);
  expect((await sources.request(new Request(url), resolve))!.headers.get("content-type")).toBe("text/plain");
  expect((await sources.request(new Request(url, { method: "DELETE" }), resolve))!.status).toBe(204);
  expect((await sources.request(new Request(url), resolve))!.status).toBe(410);
  expect((await sources.request(new Request(url, { method: "PUT", body: "false" }), resolve))!.status).toBe(410);
  sources.remove("one"); expect((await sources.request(new Request(url), resolve))!.status).toBe(403);
});

test("workspace suspension revokes pending sources and checks ownership for every request", async () => {
  const sources = new PreviewSources(), one = sources.create("one", context), two = sources.create("two", context);
  const url = previewSourceUrl(context.publicOrigin, one, id());
  const reads: string[] = []; const ownership = async (workspaceId: string) => { reads.push(workspaceId); };
  const pending = sources.request(new Request(url), ownership); await Promise.resolve();
  sources.remove("one"); expect((await pending)!.status).toBe(502);
  expect((await sources.request(new Request(url), ownership))!.status).toBe(403);
  expect((await sources.request(new Request(previewSourceUrl(context.publicOrigin, two, id()), { method: "OPTIONS" }), ownership))!.status).toBe(204);
  expect(reads).toEqual(["one", "two"]);
});

test("uploads are bounded and failed registration is observable by the native reader", async () => {
  const sources = new PreviewSources(), document = sources.create("one", context), url = previewSourceUrl(context.publicOrigin, document, id());
  expect((await sources.request(new Request(url, { method: "PUT", body: new Uint8Array(8 * 1024 * 1024 + 1) }), resolve))!.status).toBe(413);
  expect((await sources.request(new Request(url), resolve))!.status).toBe(502);
});

test("only blob-authorised documents gain their exact generated-code prefix", () => {
  const source = "s".repeat(43);
  const allowed = previewContentPolicy("default-src 'none'; script-src blob:; frame-src 'none'", { ...context, source }, "runtime");
  expect(allowed).toContain(`https://dynamic.example/~preview-source/${source}/`);
  expect(allowed).toContain("frame-src https://dynamic.example/~preview-assets/source-host.html");
  const denied = previewContentPolicy("default-src 'none'; script-src 'none'", { ...context, source }, "runtime");
  expect(denied).not.toContain("/~preview-source/");
  expect(denied).not.toContain("allow-same-origin");
});

test("Blob identities normalise native URLs without dropping module fragments or conflating queries", () => {
  const original = `blob:null/${id()}`;
  expect(previewBlobIdentity(` \t${original}#one\n`)).toEqual({ url: original, hash: "#one" });
  expect(previewBlobIdentity(`${original}#`)).toEqual({ url: original, hash: "#" });
  expect(previewBlobIdentity(`${original}?version=1#two`)).toEqual({ url: `${original}?version=1`, hash: "#two" });
  expect(previewBlobIdentity(`BLOB:${original.slice(5)}#encoded%2Ffragment`)).toEqual({ url: original, hash: "#encoded%2Ffragment" });
  expect(previewBlobIdentity("https://dynamic.example/source.js")).toBeUndefined();
  expect(previewBlobIdentity("not a URL")).toBeUndefined();
});

test("native Blob module fragments retain distinct module identities through alias resolution", async () => {
  const sources = new PreviewSources(), document = sources.create("one", context), child = id(), parent = id();
  const original = `blob:null/${id()}`, childUrl = previewSourceUrl(context.publicOrigin, document, child), parentUrl = previewSourceUrl(context.publicOrigin, document, parent);
  await sources.request(new Request(childUrl, { method: "PUT", headers: { "x-kintsugi-source-original": original }, body: "export const value = 1;" }), resolve);
  await sources.request(new Request(parentUrl, { method: "PUT", body: `import {value as first} from '${original}#one'; import {value as second} from '${original}#two';` }), resolve);
  const response = (await sources.request(new Request(parentUrl), resolve))!;
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain(`${childUrl}#one`);
  expect(body).toContain(`${childUrl}#two`);
});

test("Blob aliases retain query identity and valid quoting for module fragments", async () => {
  const sources = new PreviewSources(), document = sources.create("one", context);
  const original = `blob:null/${id()}`, plain = id(), query = id(), parent = id();
  for (const [key, url] of [[plain, original], [query, `${original}?version=1`]] as const) {
    const response = (await sources.request(new Request(previewSourceUrl(context.publicOrigin, document, key), {
      method: "PUT", headers: { "x-kintsugi-source-original": url }, body: "export const value = 1;",
    }), resolve))!;
    expect(response.status).toBe(204);
  }
  const parentUrl = previewSourceUrl(context.publicOrigin, document, parent);
  await sources.request(new Request(parentUrl, { method: "PUT", body: `import {value as plain} from '${original}#it\\'s'; import {value as query} from "${original}?version=1#two"; import("${original}#it's");` }), resolve);
  const response = (await sources.request(new Request(parentUrl), resolve))!;
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain(`${previewSourceUrl(context.publicOrigin, document, plain)}#it\\'s`);
  expect(body).toContain(`${previewSourceUrl(context.publicOrigin, document, query)}#two`);
  expect(() => parseJavaScript(body, { sourceType: "module" })).not.toThrow();
});

test("revocation while ownership is pending cannot revive a document capability", async () => {
  const sources = new PreviewSources(), document = sources.create("one", context), url = previewSourceUrl(context.publicOrigin, document, id());
  let release!: () => void;
  const pending = sources.request(new Request(url), () => new Promise<void>(resolve => { release = resolve; }));
  sources.remove("one"); release();
  expect((await pending)!.status).toBe(403);
});
