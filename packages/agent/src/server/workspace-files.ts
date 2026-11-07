import { posix } from "node:path";
import { shellQuote } from "@kintsugi/core";
import { resolveWorkspace, workspaceContainerName } from "@kintsugi/workspace";
import { extensionOf, imageMimeByExtension, mediaMimeByExtension } from "@kintsugi/shared/file-metadata";

interface WorkspaceFileMimeRegistry {
  [extension: string]: string;
}

const mimeByExtension: WorkspaceFileMimeRegistry = {
  ...imageMimeByExtension,
  ...mediaMimeByExtension,
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  pdf: "application/pdf",
};

function parseRange(header: string | null, size: number): { start: number; end: number } | undefined {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return undefined;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isFinite(start) || start > end) return undefined;
  return { start, end };
}

/** Media and sandboxed SVGs use HTTPS subpaths; arbitrary files are attachment-only. */
export async function handleWorkspaceResourceRequest(request: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/(images|media|downloads)(\/.*)$/);
  if (!match) return;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  let workspaceId: string;
  let path: string;
  try {
    workspaceId = decodeURIComponent(match[1]!);
    path = decodeURIComponent(match[3]!);
  } catch {
    return new Response("bad path", { status: 400 });
  }
  if (path.includes("..") || path.includes("\0")) return new Response("bad path", { status: 400 });
  const kind = match[2]!;
  const mediaType = Object.hasOwn(mediaMimeByExtension, extensionOf(path)) ? mediaMimeByExtension[extensionOf(path)]! : Bun.file(path).type;
  if ((kind === "images" && !Object.hasOwn(imageMimeByExtension, extensionOf(path))) || (kind === "media" && !mediaType.startsWith("audio/") && !mediaType.startsWith("video/"))) return new Response("Unsupported preview format", { status: 415 });
  await resolveWorkspace(workspaceId);
  const fileUrl = new URL(request.url);
  if (kind === "downloads") fileUrl.searchParams.set("download", "1");
  const response = await workspaceFileEndpoint(workspaceId, path, new Request(fileUrl, { method: request.method, headers: request.headers, signal: request.signal }));
  if (kind === "downloads") {
    response.headers.set("content-type", "application/octet-stream");
    response.headers.set("content-security-policy", "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  } else if (kind === "media") {
    response.headers.set("content-security-policy", "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");
  }
  response.headers.set("cache-control", "no-store");
  response.headers.set("cross-origin-resource-policy", "same-origin");
  return response;
}

export async function workspaceFileEndpoint(workspaceId: string, path: string, request: Request): Promise<Response> {
  if (!path.startsWith("/") || path.includes("..") || path.includes("\0")) return new Response("bad path", { status: 400 });

  const container = workspaceContainerName(workspaceId);
  const quoted = shellQuote(path);
  const stat = Bun.spawnSync(["docker", "exec", container, "sh", "-c", `test -f ${quoted} || exit 44; stat -Lc %s ${quoted} 2>/dev/null || stat -Lf %z ${quoted}`]);
  const size = Number(new TextDecoder().decode(stat.stdout).trim());
  if (stat.exitCode !== 0 || !Number.isFinite(size)) return new Response("not found", { status: 404 });

  const rangeHeader = request.headers.get("range");
  const range = parseRange(rangeHeader, size);
  if (rangeHeader && (!range || size === 0)) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" } });
  const command = range ? `tail -c +${range.start + 1} ${quoted} | head -c ${range.end - range.start + 1}` : `cat ${quoted}`;
  const proc = request.method === "HEAD" ? undefined : Bun.spawn(["docker", "exec", container, "sh", "-c", command], { stdout: "pipe", stderr: "ignore" });
  const contentType = Object.hasOwn(mimeByExtension, extensionOf(path)) ? mimeByExtension[extensionOf(path)]! : Bun.file(path).type;
  const headers = new Headers({ "content-type": contentType, "accept-ranges": "bytes", "x-content-type-options": "nosniff" });
  if (new URL(request.url).searchParams.get("download") === "1") {
    const filename = encodeURIComponent(posix.basename(path)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    headers.set("content-disposition", `attachment; filename*=UTF-8''${filename}`);
  }
  if (contentType.startsWith("image/")) {
    // SVG scripts may run when framed or opened directly, but never acquire
    // the management origin. Network access remains disabled.
    const scripts = contentType === "image/svg+xml" ? " allow-scripts" : "";
    const scriptSource = contentType === "image/svg+xml" ? " script-src 'unsafe-inline';" : "";
    headers.set("content-security-policy", `sandbox${scripts}; default-src 'none';${scriptSource} style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`);
    headers.set("referrer-policy", "no-referrer");
  }
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(proc?.stdout ?? null, { status: 206, headers });
  }
  headers.set("content-length", String(size));
  return new Response(proc?.stdout ?? null, { headers });
}
