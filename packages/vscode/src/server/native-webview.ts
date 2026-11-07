let assets: Promise<{ outer: string; inner: string }> | undefined;
const webviewDirectory = "/out/vs/workbench/contrib/webview/browser/pre/";

async function nativeWebviewAssets() {
  return assets ??= (async () => {
    const build = await Bun.build({ entrypoints: [new URL("../client/native-webview-outer.ts", import.meta.url).pathname, new URL("../client/native-webview-inner.ts", import.meta.url).pathname], target: "browser", format: "iife", naming: "[name].[ext]", minify: true });
    if (!build.success) throw new AggregateError(build.logs, "Could not build isolated native webview bridge");
    return { outer: await build.outputs.find(output => output.path.endsWith("native-webview-outer.js"))!.text(), inner: await build.outputs.find(output => output.path.endsWith("native-webview-inner.js"))!.text() };
  })();
}

/** Adapt only the isolated native path client; retained legacy origins are unchanged. */
export async function patchNativeWebviewResponse(response: Response, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.includes(webviewDirectory)) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (["kintsugi-webview-outer.js", "kintsugi-webview-inner.js"].includes(name)) {
      await response.body?.cancel();
      const assets = await nativeWebviewAssets();
      return new Response(name === "kintsugi-webview-outer.js" ? assets.outer : assets.inner, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    if (name === "index.html") {
      await response.body?.cancel();
      return new Response('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{height:100%;margin:0;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style><script src="kintsugi-webview-outer.js" defer></script></head><body data-controller="native-webview-outer" data-action="message@window->native-webview-outer#receive"><iframe sandbox="allow-scripts" title="VS Code webview content" data-native-webview-outer-target="frame"></iframe></body></html>', { headers: { "content-type": "text/html; charset=utf-8" } });
    }
  }
  if (response.ok && path.endsWith("/out/vs/code/browser/workbench/workbench.js")) {
    const text = await response.text();
    const pattern = /if\(([A-Za-z_$][\w$]*)\.origin!==this\._webviewContentOrigin\(this\._encodedWebviewOrigin\)\)/g;
    const matches = [...text.matchAll(pattern)];
    if (matches.length !== 1) throw new Error("This VS Code build does not match the isolated webview protocol adapter");
    // Serialized opaque origins are all "null". Verify the actual iframe window
    // as well as the target webview ID, never just the origin string.
    const patched = text.replace(pattern, (_match, event: string) => `if(${event}.source!==this.element.contentWindow||${event}.origin!=="null")`);
    const headers = new Headers(response.headers); headers.delete("content-length"); headers.delete("content-encoding");
    return new Response(patched, { status: response.status, headers });
  }
  return response;
}
