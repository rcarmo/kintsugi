export type BrowserTransport = "websocket" | "sse";
export const browserTransportCookie = "kintsugi-live-transport";

/** A browser preference, not an installation/provider setting. Unknown values retain the default. */
export function browserTransportFromCookies(cookies: string): BrowserTransport {
  const prefix = `${browserTransportCookie}=`;
  const value = cookies.split(";").map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
  return value === "sse" ? "sse" : "websocket";
}

export function browserTransportSetCookie(transport: BrowserTransport, secure: boolean): string {
  return `${browserTransportCookie}=${transport}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}
