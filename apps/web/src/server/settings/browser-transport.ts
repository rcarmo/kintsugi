import { toggleHtml } from "@kintsugi/design-system/toggle";
import { kintsugiUrl } from "@kintsugi/proxy-ingress";
import { browserTransportFromCookies, browserTransportSetCookie } from "../../browser-transport.ts";

export const browserTransportSectionId = "browser-transport";

/** Inline and HTTP-only: recovery must not depend on a working live subscription or section loader. */
export function renderBrowserTransportSettings(request: Request): string {
  const toggle = toggleHtml({
    variant: "button", label: "Browser live-update transport", name: "transport",
    value: browserTransportFromCookies(request.headers.get("cookie") ?? ""),
    form: { action: "/settings/browser-transport", turbo: false },
    options: [{ value: "websocket", label: "WebSocket" }, { value: "sse", label: "SSE" }],
  });
  return `<section class="settings-sec" id="settings-sec-${browserTransportSectionId}"><h2>Browser connection</h2>
    <p class="browser-transport-status" role="status">Live updates are paused. You can still change this setting.</p>
    <p>Use SSE if WebSockets cannot connect, for example on iOS with a self-signed certificate. HTTPS still needs to be accepted by your browser.</p>
    ${toggle}<p>Saved for this browser. Switching reloads the page; Agents keep running.</p></section>`;
}

export async function handleBrowserTransportSettings(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname !== "/settings/browser-transport") return;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const transport = String((await request.formData()).get("transport") ?? "");
  if (transport !== "websocket" && transport !== "sse") return new Response("Unsupported browser transport", { status: 400 });
  return new Response(null, { status: 303, headers: {
    location: `/settings?section=${browserTransportSectionId}`,
    "set-cookie": browserTransportSetCookie(transport, new URL(kintsugiUrl(request)).protocol === "https:"),
    "cache-control": "no-store",
  } });
}
