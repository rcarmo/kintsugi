interface ImageMimeTypeRegistry {
  [extension: string]: string;
}

export const imageMimeByExtension: ImageMimeTypeRegistry = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
};

export function extensionOf(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

/** Passive image responses stay on the management connection; arbitrary files do not. */
export function workspaceImageUrl(workspaceId: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const encodedPath = normalizedPath.split("/").map(part => encodeURIComponent(part)).join("/");
  return `/workspaces/${encodeURIComponent(workspaceId)}/images${encodedPath}`;
}
