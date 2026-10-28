export interface WorkspaceFileTarget {
  path: string;
  line?: number;
  column?: number;
  /** A page anchor as written in a URL, without the leading #. Only HTML files opened as pages use it. */
  fragment?: string;
}

function positiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse a link target; path resolution belongs to the workspace open operation. */
export function parseWorkspaceFileTarget(params: URLSearchParams): WorkspaceFileTarget {
  return {
    path: params.get("path") ?? "",
    line: positiveInteger(params.get("line")),
    column: positiveInteger(params.get("column")),
    fragment: params.get("fragment") || undefined,
  };
}

// File-shaped plain text: an optional /, ./ or ../ prefix, folders, and a name with a
// letter-led extension, then an optional :line, :line:column or #anchor.
const fileReferenceSource = String.raw`((?:\/|\.\.?\/)?(?:[^\s<>:"'\`()[\]{},;!?/]+\/)*[^\s<>:"'\`()[\]{},;!?/]+\.[a-zA-Z][\w+-]*)(?::(\d+)(?::(\d+))?|#([\w-]+))?`;
const embeddedFileReference = new RegExp(String.raw`(?:^|[\s([\`'"=])${fileReferenceSource}(?=$|[\s.)\]}'"\`,;!?])`, "g");
const wholeFileReference = new RegExp(`^${fileReferenceSource}$`);

export interface FileReference extends WorkspaceFileTarget {
  /** Offsets of the reference, including any position suffix, in the searched text. */
  start: number;
  end: number;
}

function fileReference(match: RegExpMatchArray): FileReference {
  const path = match[1]!;
  // An embedded match may begin with one delimiter before the path; the suffix ends the match.
  const start = match.index! + match[0].indexOf(path);
  return { path, line: positiveInteger(match[2] ?? null), column: positiveInteger(match[3] ?? null), fragment: match[4], start, end: match.index! + match[0].length };
}

/** File references in prose. The path is unresolved; it may not name an existing file. */
export function* fileReferencesIn(text: string): Generator<FileReference> {
  for (const match of text.matchAll(embeddedFileReference)) yield fileReference(match);
}

/** A file reference that is the whole of `text`, such as the content of inline code. */
export function parseFileReference(text: string): FileReference | undefined {
  const match = text.match(wholeFileReference);
  return match ? fileReference(match) : undefined;
}

export function workspaceFileOpenUrl(workspaceId: string, path: string, position: Omit<WorkspaceFileTarget, "path"> = {}, filesViewId?: string): string {
  const query = new URLSearchParams({ path });
  if (position.line) query.set("line", String(position.line));
  if (position.column) query.set("column", String(position.column));
  if (position.fragment) query.set("fragment", position.fragment);
  if (filesViewId) query.set("filesView", filesViewId);
  const endpoint = filesViewId ? "files-view/open" : "file/open";
  return `/workspaces/${encodeURIComponent(workspaceId)}/${endpoint}?${query}`;
}
