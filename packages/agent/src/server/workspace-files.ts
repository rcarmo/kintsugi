import { posix } from "node:path";
import { shellQuote } from "@kintsugi/core";
import { resolveWorkspace, workspaceContainerName } from "@kintsugi/workspace";
import { extensionOf, imageMimeByExtension } from "@kintsugi/shared/file-metadata";

interface WorkspaceFileMimeRegistry {
  [extension: string]: string;
}

const mimeByExtension: WorkspaceFileMimeRegistry = {
  ...imageMimeByExtension,
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogv: "video/ogg",
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

/** Image-only management route: no preview port, scripts, or active-document privileges. */
export async function handleWorkspaceImageRequest(request: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/images(\/.*)$/);
  if (!match) return;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  let workspaceId: string;
  let path: string;
  try {
    workspaceId = decodeURIComponent(match[1]!);
    path = decodeURIComponent(match[2]!);
  } catch {
    return new Response("bad path", { status: 400 });
  }
  if (path.includes("..") || path.includes("\0")) return new Response("bad path", { status: 400 });
  if (!Object.hasOwn(imageMimeByExtension, extensionOf(path))) return new Response("Only image files are supported", { status: 415 });
  await resolveWorkspace(workspaceId);
  const response = await workspaceFileEndpoint(workspaceId, path, request);
  response.headers.set("cache-control", "no-store");
  response.headers.set("cross-origin-resource-policy", "same-origin");
  return response;
}

export async function workspaceFileEndpoint(workspaceId: string, path: string, request: Request): Promise<Response> {
  if (!path.startsWith("/") || path.includes("..") || path.includes("\0")) return new Response("bad path", { status: 400 });

  const container = workspaceContainerName(workspaceId);
  const quoted = shellQuote(path);
  const stat = Bun.spawnSync(["docker", "exec", container, "sh", "-c", `stat -c %s ${quoted} 2>/dev/null || stat -f %z ${quoted}`]);
  const size = Number(new TextDecoder().decode(stat.stdout).trim());
  if (stat.exitCode !== 0 || !Number.isFinite(size)) return new Response("not found", { status: 404 });

  const range = parseRange(request.headers.get("range"), size);
  const command = range ? `tail -c +${range.start + 1} ${quoted} | head -c ${range.end - range.start + 1}` : `cat ${quoted}`;
  const proc = Bun.spawn(["docker", "exec", container, "sh", "-c", command], { stdout: "pipe", stderr: "ignore" });
  const contentType = mimeByExtension[extensionOf(path)] ?? Bun.file(path).type;
  const headers = new Headers({ "content-type": contentType, "accept-ranges": "bytes", "x-content-type-options": "nosniff" });
  if (new URL(request.url).searchParams.get("download") === "1") {
    const filename = encodeURIComponent(posix.basename(path)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    headers.set("content-disposition", `attachment; filename*=UTF-8''${filename}`);
  }
  if (contentType.startsWith("image/")) {
    // SVGs are inert in <img>, but can also be navigated to directly. Keep that
    // document sandboxed, script-free, and unable to load network resources.
    headers.set("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'");
    headers.set("referrer-policy", "no-referrer");
  }
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(proc.stdout, { status: 206, headers });
  }
  headers.set("content-length", String(size));
  return new Response(proc.stdout, { headers });
}
