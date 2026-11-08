import { parseSrcset, stringifySrcset } from "srcset";
import { Type } from "typebox";
import { previewPolicyDirectives, previewPolicyName } from "./preview-policy.ts";
import { previewSourcePrefix, previewSourceHost } from "./preview-source.ts";
import { tokenize, isTokenURL, isTokenString, isTokenFunction, isTokenAtKeyword, isTokenWhitespace, isTokenComment, type CSSToken } from "@csstools/css-tokenizer";
import { isWorkspaceLoopbackHost, localhostSubdomain, workspacePortAppKey, parseWorkspacePortAppKey } from "@kintsugi/shared";

export interface PreviewUrlContext {
  /** Request-derived HTTPS origin, never a configured deployment hostname. */
  publicOrigin: string;
  /** Unpredictable, server-owned workspace capability prefix, with a trailing slash. */
  root: string;
  app: string;
  /** Original app URL for relative resource resolution. */
  upstream: string;
  cookies?: string;
  /** Window URL aliases are installed before this script executes. */
  windowGlobals?: boolean;
  /** Trusted adapter nonce and effective header policy, scoped to this document. */
  nonce?: string;
  policy?: string;
  /** Server-owned generated-code capability for this document. */
  source?: string;
  /** Earlier capability roots when this document traversed nested transports. */
  aliases?: Array<{ origin: string; root: string }>;
}

export const previewUrlContextSchema = Type.Object({ publicOrigin: Type.String(), root: Type.String(), app: Type.String(), upstream: Type.String(), cookies: Type.Optional(Type.String()), windowGlobals: Type.Optional(Type.Boolean()), nonce: Type.Optional(Type.String()), policy: Type.Optional(Type.String()), source: Type.Optional(Type.String()), aliases: Type.Optional(Type.Array(Type.Object({ origin: Type.String(), root: Type.String() }))) });
export const previewProtocolHeader = "x-kintsugi-preview-protocol";
export const previewProtocolVersion = "1";
export const previewWindowParameter = "__kintsugi_window";

/** Protocol/custom-element attributes named action or data are not URLs. */
export function isPreviewUrlAttribute(tag: string, name: string): boolean {
  if (name === "action") return tag === "form";
  if (name === "formaction") return tag === "button" || tag === "input";
  if (name === "data") return tag === "object";
  return ["src", "href", "xlink:href", "poster"].includes(name);
}

export function mapPreviewSrcset(value: string, context: PreviewUrlContext): string {
  return stringifySrcset(parseSrcset(value).map(candidate => ({ ...candidate, url: mapPreviewUrl(candidate.url, context) })));
}

export function previewAppPath(context: PreviewUrlContext, app = context.app): string {
  return `${context.root}${encodeURIComponent(app)}`;
}

/** A nested host must match the canonical app URL of its actual containing iframe. */
export function previewNestedFrameScope(input: string, context: PreviewUrlContext): string | undefined {
  const url = URL.parse(input, context.publicOrigin), prefix = previewAppPath(context);
  if (!url || url.origin !== context.publicOrigin || !url.pathname.startsWith(`${prefix}/`)) return;
  const match = /^\/workspaces\/([^/]+)\/(?:apps\/([^/]+)|ports\/(\d+)|files)(?:\/|$)/.exec(url.pathname.slice(prefix.length));
  if (!match) return;
  try { return `${decodeURIComponent(match[1]!)}:${match[2] ? decodeURIComponent(match[2]) : match[3] ? `port-${match[3]}` : "file"}`; }
  catch { return; }
}

/** Route only this workspace's virtual origins; arbitrary external origins remain external. */
export function mapPreviewUrl(input: string, context: PreviewUrlContext): string {
  if (!input || input.startsWith("#")) return input;
  const current = new URL(context.upstream);
  const target = URL.parse(input, current);
  if (!target || !["http:", "https:", "ws:", "wss:", "file:"].includes(target.protocol)) return input;
  const websocket = target.protocol === "ws:" || target.protocol === "wss:";
  if (target.protocol === "ws:") target.protocol = "http:";
  if (target.protocol === "wss:") target.protocol = "https:";
  const publicResource = target.pathname.startsWith("/vscode-public-resources/") || target.pathname.startsWith("/~preview-assets/") || target.pathname.startsWith(previewSourcePrefix);
  if (publicResource && (target.origin === context.publicOrigin || target.origin === current.origin || context.aliases?.some(alias => new URL(alias.origin).host === target.host))) {
    return new URL(target.pathname + target.search + target.hash, context.publicOrigin).href;
  }
  if (target.origin === context.publicOrigin && target.pathname.startsWith(context.root)) {
    if (websocket) target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    return target.href;
  }
  const alias = context.aliases?.find(alias => (target.host === new URL(alias.origin).host || target.origin === context.publicOrigin) && target.pathname.startsWith(alias.root));
  if (alias) {
    const mapped = new URL(context.publicOrigin);
    mapped.pathname = `${context.root}${target.pathname.slice(alias.root.length)}`;
    mapped.search = target.search; mapped.hash = target.hash;
    if (websocket) mapped.protocol = mapped.protocol === "https:" ? "wss:" : "ws:";
    return mapped.href;
  }
  let app = context.app;
  const publicUrl = new URL(context.publicOrigin);
  const visibleHost = target.hostname === publicUrl.hostname;
  if (target.origin === context.publicOrigin || (visibleHost && target.port === publicUrl.port)) {
    // App code often builds root URLs from location.origin. Keep these inside
    // the workspace instead of allowing them to address management endpoints.
  } else if (target.protocol === "file:" && !target.host) app = "file";
  else if (target.origin === current.origin) {
    // The resource belongs to the current logical app.
  } else if (/^(?:file|vscode-remote)\+.*\.vscode-resource\.vscode-cdn\.net$/.test(target.hostname)) app = "file";
  else if (isWorkspaceLoopbackHost(target.hostname) || visibleHost) {
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    const currentPort = Number(current.port || (current.protocol === "https:" ? 443 : 80));
    const host = visibleHost ? isWorkspaceLoopbackHost(current.hostname) ? current.hostname : "localhost" : target.hostname;
    if (!(isWorkspaceLoopbackHost(current.hostname) && port === currentPort && (target.protocol === current.protocol || websocket) && localhostSubdomain(host) === localhostSubdomain(current.hostname))) {
      app = `${target.protocol === "https:" ? "https~" : ""}${workspacePortAppKey(port, host)}`;
    }
  } else return input;
  const mapped = new URL(context.publicOrigin);
  mapped.pathname = `${previewAppPath(context, app)}${target.pathname}`;
  mapped.search = target.search;
  mapped.hash = target.hash;
  if (websocket) mapped.protocol = mapped.protocol === "https:" ? "wss:" : "ws:";
  return mapped.href;
}

export function mapPreviewScriptUrl(input: string, context: PreviewUrlContext): string {
  const mapped = mapPreviewUrl(input, context);
  const target = URL.parse(mapped, context.upstream);
  if (context.windowGlobals !== true || !target || target.origin !== context.publicOrigin || !target.pathname.startsWith(context.root)) return mapped;
  target.searchParams.set(previewWindowParameter, "1");
  return target.href;
}

export function mapPreviewModuleUrl(input: string, context: PreviewUrlContext): string {
  // Bare imports still belong to the browser's import map/package resolver.
  if (!/^(?:\.{1,2}\/|\/|https?:\/\/|file:\/\/)/.test(input)) return input;
  return mapPreviewScriptUrl(input, context);
}

export function previewWorkerContext(entry: string, context: PreviewUrlContext): PreviewUrlContext {
  const source = new URL(entry);
  if (source.origin !== context.publicOrigin || !source.pathname.startsWith(context.root)) return context;
  const start = context.root.length;
  const end = source.pathname.indexOf("/", start);
  const app = decodeURIComponent(source.pathname.slice(start, end));
  const key = app.startsWith("https~") ? app.slice(6) : app;
  const port = parseWorkspacePortAppKey(key);
  let upstream = new URL(context.upstream);
  if (port) upstream = new URL(`${app.startsWith("https~") ? "https" : "http"}://${port.host ?? "localhost"}:${port.port}`);
  else if (app === "file") upstream = new URL("file:///");
  else if (app !== context.app) throw new Error("Unsupported cross-app worker source");
  upstream.pathname = source.pathname.slice(end); upstream.search = source.search; upstream.hash = source.hash;
  return { ...context, app, upstream: upstream.href, cookies: app === context.app ? context.cookies : "" };
}

/** Preserve the application's policy while allowing the injected compatibility runtime. */
export function previewContentPolicy(policy: string, context: PreviewUrlContext, nonce: string): string {
  if (policy.includes(",")) return policy.split(",").map(part => previewContentPolicy(part, context, nonce)).join(", ");
  const directives = previewPolicyDirectives(policy);
  // Opaque ancestors cannot be named in frame-ancestors. The capability and
  // immutable sandbox replace framing restrictions, not script/form policies.
  directives.delete("frame-ancestors");
  for (const [name, values] of directives) directives.set(name, values.map(value => value === "'self'" ? `${context.publicOrigin}${context.root}` : /^(?:https?|wss?):\/\//.test(value) ? mapPreviewUrl(value, context) : value));
  const scriptSources = (values: string[], workers: boolean): string[] => {
    const sources = values.filter(value => value !== "'none'");
    // Adding a nonce disables CSP's otherwise-effective unsafe-inline. Keep
    // that existing permission intact rather than breaking the app's scripts.
    if (!sources.includes("'unsafe-inline'") || sources.some(value => /^'(?:nonce-|sha(?:256|384|512)-)/.test(value))) sources.push(`'nonce-${nonce}'`);
    if (workers) sources.push("data:", "blob:");
    sources.push(`${context.publicOrigin}/~preview-assets/runtime.js`, `${context.publicOrigin}/~preview-assets/worker.js`);
    return sources;
  };
  const scripts = directives.get("script-src") ?? directives.get("default-src") ?? [];
  const elements = directives.get("script-src-elem") ?? scripts;
  const restricted = directives.has("script-src") || directives.has("default-src");
  if (restricted) directives.set("script-src", scriptSources(scripts, true));
  // Data/blob are needed inside opaque workers, not as a new permission for
  // attacker-injected document script elements.
  if (restricted || directives.has("script-src-elem")) directives.set("script-src-elem", scriptSources(elements, false));
  for (const name of ["style-src", "style-src-elem"]) {
    const values = directives.get(name) ?? (name === "style-src" ? directives.get("default-src") : undefined);
    if (values?.some(value => /^'(?:nonce-|sha(?:256|384|512)-)/.test(value))) directives.set(name, [...values.filter(value => value !== "'none'"), `'nonce-${nonce}'`]);
  }
  if (context.source) {
    const frames = directives.get("frame-src") ?? directives.get("child-src") ?? directives.get("default-src");
    if (frames) directives.set("frame-src", [...frames.filter(value => value !== "\'none\'"), `${context.publicOrigin}${previewSourceHost}`]);
    for (const name of ["script-src", "script-src-elem"]) {
      const values = directives.get(name);
      if (values && (name === "script-src" ? scripts : elements).includes("blob:")) directives.set(name, [...values, `${context.publicOrigin}${previewSourcePrefix}${context.source}/`]);
    }
  }
  const trusted = directives.get("trusted-types");
  if (trusted && !trusted.includes("'none'")) directives.set("trusted-types", [...trusted, previewPolicyName(nonce)]);
  const workers = directives.get("worker-src");
  directives.set("worker-src", workers?.every(source => source === "'none'") ? ["'none'"] : [`${context.publicOrigin}${context.root}`, `${context.publicOrigin}/~preview-assets/worker.js`, "data:", "blob:"]);
  return [...directives].map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

export function rewritePreviewCss(text: string, context: PreviewUrlContext): string {
  const edits: Array<{ start: number; end: number; value: string }> = [];
  let previous: CSSToken | undefined;
  for (const token of tokenize({ css: text })) {
    if (isTokenWhitespace(token) || isTokenComment(token)) continue;
    const quotedUrl = isTokenString(token) && ((isTokenFunction(previous) && previous[4].value.toLowerCase() === "url") || (isTokenAtKeyword(previous) && previous[4].value.toLowerCase() === "import"));
    if (isTokenURL(token) || (isTokenString(token) && quotedUrl)) {
      const original = token[4].value;
      const mapped = mapPreviewUrl(original, context);
      if (mapped !== original) edits.push({ start: token[2], end: token[3] + 1, value: isTokenURL(token) ? `url(${JSON.stringify(mapped)})` : JSON.stringify(mapped) });
    }
    previous = token;
  }
  for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}
