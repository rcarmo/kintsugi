import { expect, test } from "bun:test";
import { createKintsugiEventBus } from "@kintsugi/core";
import { managementOriginRejection } from "@kintsugi/proxy-ingress";
import { browserTransportCookie, browserTransportFromCookies, browserTransportSetCookie } from "../src/browser-transport.ts";
import { handleBrowserTransportSettings } from "../src/server/settings/browser-transport.ts";
import { createWebApp } from "../src/server/app.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

test("browser transport preference is scoped to its exact cookie and preserves the existing default", () => {
  expect(browserTransportFromCookies("")).toBe("websocket");
  expect(browserTransportFromCookies(`${browserTransportCookie}=sse`)).toBe("sse");
  expect(browserTransportFromCookies(`other=sse; ${browserTransportCookie}=websocket; unrelated=1`)).toBe("websocket");
  for (const cookie of [`${browserTransportCookie}=invalid`, `${browserTransportCookie}=`, `other-${browserTransportCookie}=sse`]) expect(browserTransportFromCookies(cookie)).toBe("websocket");
  const value = browserTransportSetCookie("sse", true);
  expect(value).toContain(`${browserTransportCookie}=sse; Path=/;`);
  expect(value).toContain("SameSite=Lax");
  expect(value).toEndWith("; Secure");
  expect(value).not.toContain("Domain=");
  expect(browserTransportSetCookie("websocket", false)).not.toContain("Secure");
});

test("transport selection uses native HTTP redirects and a browser cookie, including TLS termination", async () => {
  for (const transport of ["websocket", "sse"]) {
    const request = new Request("https://management.example/settings/browser-transport", { method: "POST", body: new URLSearchParams({ transport }) });
    const response = (await handleBrowserTransportSettings(request, new URL(request.url)))!;
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings?section=browser-transport");
    expect(response.headers.get("set-cookie")).toBe(browserTransportSetCookie(transport === "sse" ? "sse" : "websocket", true));
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  const proxied = new Request("http://localhost/settings/browser-transport", { method: "POST", headers: { "x-forwarded-proto": "https" }, body: new URLSearchParams({ transport: "sse" }) });
  expect((await handleBrowserTransportSettings(proxied, new URL(proxied.url)))!.headers.get("set-cookie")).toEndWith("; Secure");
});

test("invalid transport values and methods cannot persist a preference", async () => {
  for (const transport of ["", "auto", "ws", "sse; injected=1"]) {
    const request = new Request("http://localhost/settings/browser-transport", { method: "POST", body: new URLSearchParams({ transport }) });
    const response = (await handleBrowserTransportSettings(request, new URL(request.url)))!;
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  const request = new Request("http://localhost/settings/browser-transport");
  const response = (await handleBrowserTransportSettings(request, new URL(request.url)))!;
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("POST");
});

test("HTTP Settings and transport changes do not touch an unavailable workspace or require Cable", async () => {
  let workspaceCalls = 0;
  const registry = createWorkspaceRegistry();
  const app = createWebApp({ registry, events: createKintsugiEventBus(),
    workspaceModules: [{ id: "unresponsive", attachToWorkspace: async () => { workspaceCalls++; throw new Error("Workspace transport unavailable"); } }],
    provisionWorkspace: async () => {}, destroyWorkspace: async () => {},
    deletionReview: { inspect: async () => ({ status: "clear" }), renderEvidence: () => "" },
  });
  await registry.seed([{ id: "transport-fixture", title: "Unavailable workspace" }]);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
    return managementOriginRejection(request, server.requestIP(request)?.address) ?? app.fetch(request);
  } });
  const origin = server.url.origin;
  try {
    for (const path of ["/settings", "/settings?section=browser-transport", "/settings/sections/browser-transport"]) {
      expect((await fetch(new URL(path, origin))).status).toBe(200);
    }
    for (const caller of [undefined, "null", "https://foreign.example"]) {
      const headers = new Headers();
      if (caller !== undefined) headers.set("origin", caller);
      const denied = await fetch(new URL("/settings/browser-transport", origin), { method: "POST", headers, body: new URLSearchParams({ transport: "sse" }), redirect: "manual" });
      expect(denied.status).toBe(403);
      expect(denied.headers.get("set-cookie")).toBeNull();
    }
    const response = await fetch(new URL("/settings/browser-transport", origin), { method: "POST", headers: { origin }, body: new URLSearchParams({ transport: "sse" }), redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain(`${browserTransportCookie}=sse`);
    expect(workspaceCalls).toBe(0);
  } finally { await server.stop(true); }
});
