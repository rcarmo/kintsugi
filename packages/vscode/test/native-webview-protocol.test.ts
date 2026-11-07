import { expect, test } from "bun:test";
import { patchNativeWebviewResponse } from "../src/server/native-webview.ts";

const workbenchRequest = new Request("https://dynamic.example/~preview/scoped/vscode/static/out/vs/code/browser/workbench/workbench.js");

test("opaque webview handshakes require the expected iframe window, not merely a null origin", async () => {
  const upstream = 'return function(event){if(event.data.target!==this.id)return false;if(event.origin!==this._webviewContentOrigin(this._encodedWebviewOrigin))return false;return true}';
  const response = await patchNativeWebviewResponse(new Response(upstream, { headers: { "content-type": "text/javascript", "content-length": String(upstream.length) } }), workbenchRequest);
  // Execute only the standalone protocol predicate, not a browser or UI fixture.
  const accepts = new Function(await response.text())();
  const expected = {}, sibling = {};
  const owner = { id: "owned-webview", element: { contentWindow: expected } };
  expect(accepts.call(owner, { data: { target: owner.id }, source: expected, origin: "null" })).toBe(true);
  expect(accepts.call(owner, { data: { target: owner.id }, source: sibling, origin: "null" })).toBe(false);
  expect(accepts.call(owner, { data: { target: "another-webview" }, source: expected, origin: "null" })).toBe(false);
  expect(accepts.call(owner, { data: { target: owner.id }, source: expected, origin: "https://dynamic.example" })).toBe(false);
  expect(response.headers.get("content-length")).toBeNull();
});

test("unsupported or ambiguous VS Code message protocols fail closed", async () => {
  for (const source of ["unrecognized protocol", "if(i.origin!==this._webviewContentOrigin(this._encodedWebviewOrigin)){}if(j.origin!==this._webviewContentOrigin(this._encodedWebviewOrigin)){}"])
    await expect(patchNativeWebviewResponse(new Response(source), workbenchRequest)).rejects.toThrow("does not match the isolated webview protocol adapter");
});

test("the native webview adapter leaves unrelated resources and backend errors intact", async () => {
  const response = new Response("backend unavailable", { status: 503 });
  expect(await patchNativeWebviewResponse(response, workbenchRequest)).toBe(response);
  const other = new Response("ordinary application code");
  expect(await patchNativeWebviewResponse(other, new Request("https://dynamic.example/app.js"))).toBe(other);
});
