import { parseSrcset, stringifySrcset } from "srcset";
import { Type } from "typebox";
import { tokenize, isTokenURL, isTokenString, isTokenFunction, isTokenAtKeyword, isTokenWhitespace, isTokenComment, type CSSToken } from "@csstools/css-tokenizer";
import { isWorkspaceLoopbackHost, localhostSubdomain, workspacePortAppKey } from "@kintsugi/shared";

export interface PreviewUrlContext {
  /** Request-derived HTTPS origin, never a configured deployment hostname. */
  publicOrigin: string;
  /** Unpredictable, server-owned workspace capability prefix, with a trailing slash. */
  root: string;
  app: string;
  /** Original app URL for relative resource resolution. */
  upstream: string;
  cookies?: string;
  /** Earlier capability roots when this document traversed nested transports. */
  aliases?: Array<{ origin: string; root: string }>;
}

export const previewUrlContextSchema = Type.Object({ publicOrigin: Type.String(), root: Type.String(), app: Type.String(), upstream: Type.String(), cookies: Type.Optional(Type.String()), aliases: Type.Optional(Type.Array(Type.Object({ origin: Type.String(), root: Type.String() }))) });
export const previewProtocolHeader = "x-kintsugi-preview-protocol";
export const previewProtocolVersion = "1";

export function mapPreviewSrcset(value: string, context: PreviewUrlContext): string {
  return stringifySrcset(parseSrcset(value).map(candidate => ({ ...candidate, url: mapPreviewUrl(candidate.url, context) })));
}

export function previewAppPath(context: PreviewUrlContext, app = context.app): string {
  return `${context.root}${encodeURIComponent(app)}`;
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
  const publicResource = target.pathname.startsWith("/vscode-public-resources/") || target.pathname.startsWith("/~preview-assets/");
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
  if (target.origin === context.publicOrigin) {
    // App code often builds root URLs from location.origin. Keep these inside
    // the workspace instead of allowing them to address management endpoints.
  } else if (target.protocol === "file:" && !target.host) app = "file";
  else if (target.origin === current.origin) {
    // The resource belongs to the current logical app.
  } else if (/^(?:file|vscode-remote)\+.*\.vscode-resource\.vscode-cdn\.net$/.test(target.hostname)) app = "file";
  else if (isWorkspaceLoopbackHost(target.hostname)) {
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    const currentPort = Number(current.port || (current.protocol === "https:" ? 443 : 80));
    if (!(isWorkspaceLoopbackHost(current.hostname) && port === currentPort && target.protocol === current.protocol && localhostSubdomain(target.hostname) === localhostSubdomain(current.hostname))) {
      app = `${target.protocol === "https:" ? "https~" : ""}${workspacePortAppKey(port, target.hostname)}`;
    }
  } else return input;
  const mapped = new URL(context.publicOrigin);
  mapped.pathname = `${previewAppPath(context, app)}${target.pathname}`;
  mapped.search = target.search;
  mapped.hash = target.hash;
  if (websocket) mapped.protocol = mapped.protocol === "https:" ? "wss:" : "ws:";
  return mapped.href;
}

/** Preserve the application's policy while allowing the injected compatibility runtime. */
export function previewContentPolicy(policy: string, context: PreviewUrlContext, nonce: string): string {
  if (policy.includes(",")) return policy.split(",").map(part => previewContentPolicy(part, context, nonce)).join(", ");
  const directives = new Map(policy.split(";").map(part => part.trim().split(/\s+/)).filter(part => part[0]).map(([name, ...values]) => [name!.toLowerCase(), values]));
  // Opaque ancestors cannot be named in frame-ancestors. The capability and
  // immutable sandbox replace framing restrictions, not script/form policies.
  directives.delete("frame-ancestors");
  for (const [name, values] of directives) directives.set(name, values.map(value => value === "'self'" ? `${context.publicOrigin}${context.root}` : /^https?:\/\//.test(value) ? mapPreviewUrl(value, context) : value));
  const scripts = directives.get("script-src") ?? directives.get("default-src") ?? [];
  if (directives.has("script-src") || directives.has("default-src")) directives.set("script-src", [...scripts.filter(value => value !== "'none'"), `'nonce-${nonce}'`, "data:", "blob:"]);
  if (directives.has("script-src-elem")) directives.set("script-src-elem", [...directives.get("script-src-elem")!.filter(value => value !== "'none'"), `'nonce-${nonce}'`]);
  directives.set("worker-src", [`${context.publicOrigin}${context.root}`, "data:", "blob:"]);
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
