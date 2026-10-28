import { posix } from "node:path";
import { parseFileReference, workspaceFileOpenUrl, workspaceProxyUrl, type WorkspaceFileTarget } from "@kintsugi/shared";

const workspaceRoot = "/work";

interface MarkdownFileTarget extends WorkspaceFileTarget {
  suffix: string;
}

function workspaceFileTarget(rawHref: string, sourcePath?: string): MarkdownFileTarget | undefined {
  let url: URL | undefined;
  try {
    url = new URL(rawHref);
  } catch {
    if (rawHref.startsWith("#") || rawHref.startsWith("?") || rawHref.startsWith("//")) return undefined;
  }
  if (url) {
    const isFileUrl = url.protocol === "file:" && (url.hostname === "" || url.hostname === "localhost");
    if (!isFileUrl && (url.protocol !== "kintsugi:" || url.hostname !== "file")) return undefined;
  }

  const suffixStart = rawHref.search(/[?#]/);
  const pathname = url?.pathname ?? (suffixStart < 0 ? rawHref : rawHref.slice(0, suffixStart));
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (!path || path.includes("\0")) return undefined;

  const target: MarkdownFileTarget = {
    path: url ? path : posix.resolve(sourcePath ? posix.dirname(sourcePath) : workspaceRoot, path),
    suffix: url ? `${url.search}${url.hash}` : suffixStart < 0 ? "" : rawHref.slice(suffixStart),
  };
  for (const name of ["line", "column"] as const) {
    const value = url?.searchParams.get(name);
    if (value && /^\d+$/.test(value)) target[name] = Number(value);
  }
  target.fragment = target.suffix.match(/#(.+)/)?.[1];
  return target;
}

export function kintsugiFileHref(workspaceId: string, rawHref: string, sourcePath?: string, filesViewId?: string): string | undefined {
  const target = workspaceFileTarget(rawHref, sourcePath);
  return target ? workspaceFileOpenUrl(workspaceId, target.path, target, filesViewId) : undefined;
}

/** Inline code naming a file, such as `src/main.ts:12`, with the absolute paths it may mean, most specific first. */
export function inlineCodeFileReference(code: string, sourcePath?: string): Omit<WorkspaceFileTarget, "path"> & { candidates: string[] } | undefined {
  const reference = parseFileReference(code.trim());
  if (!reference) return undefined;
  const bases = reference.path.startsWith("/") ? ["/"] : [sourcePath ? posix.dirname(sourcePath) : workspaceRoot, workspaceRoot];
  return { line: reference.line, column: reference.column, candidates: [...new Set(bases.map((base) => posix.resolve(base, reference.path)))] };
}

export function workspaceFileImageSrc(workspaceId: string, rawSrc: string, sourcePath?: string): string | undefined {
  const target = workspaceFileTarget(rawSrc, sourcePath);
  return target ? workspaceProxyUrl(workspaceId, "file", target.path) + target.suffix : undefined;
}
