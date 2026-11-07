interface FileMimeTypeRegistry {
  [extension: string]: string;
}

export const imageMimeByExtension: FileMimeTypeRegistry = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
};

export const mediaMimeByExtension: FileMimeTypeRegistry = {
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v", ogv: "video/ogg",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
};

export function extensionOf(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

function workspaceResourceUrl(kind: "images" | "media" | "downloads", workspaceId: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const encodedPath = normalizedPath.split("/").map(part => encodeURIComponent(part)).join("/");
  return `/workspaces/${encodeURIComponent(workspaceId)}/${kind}${encodedPath}`;
}

/** Resources use management transport without granting workspace documents management-origin privileges. */
export function workspaceImageUrl(workspaceId: string, path: string): string { return workspaceResourceUrl("images", workspaceId, path); }
export function workspaceMediaUrl(workspaceId: string, path: string): string { return workspaceResourceUrl("media", workspaceId, path); }
export function workspaceDownloadUrl(workspaceId: string, path: string): string { return workspaceResourceUrl("downloads", workspaceId, path); }
