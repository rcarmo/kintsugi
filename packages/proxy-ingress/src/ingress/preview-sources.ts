import { randomBytes } from "node:crypto";
import { parse } from "es-module-lexer/minimal/js";
import { previewBlobAllowed } from "../preview-policy.ts";
import { previewSourcePrefix, previewSourceUrl } from "../preview-source.ts";
import { rewritePreviewGlobals } from "../preview-globals.ts";
import { rewritePreviewJavaScript } from "../preview-javascript.ts";
import type { PreviewUrlContext } from "../preview-url.ts";

const maxSourceBytes = 8 * 1024 * 1024;
const maxWorkspaceBytes = 64 * 1024 * 1024;
interface Source { ready: Promise<string>; resolve?: (body: string) => void; reject?: (error: Error) => void; complete: boolean; uploaded: boolean; revoked: boolean; bytes: number; mime: string }
interface Alias { ready: Promise<string>; resolve(id: string): void }
interface Document { workspaceId: string; context: PreviewUrlContext; sources: Map<string, Source>; aliases: Map<string, Alias>; readers: Set<ReadableStreamDefaultReader<Uint8Array>>; active: boolean }

/** Read-only generated code capabilities, distinct from management and backend routes. */
export class PreviewSources {
  private readonly documents = new Map<string, Document>();
  private readonly bytes = new Map<string, number>();
  private totalBytes = 0;
  private sourceCount = 0;
  create(workspaceId: string, context: PreviewUrlContext): string {
    if (this.documents.size >= 4096) throw new Error("Preview source document capacity exceeded");
    if ([...this.documents.values()].filter(document => document.workspaceId === workspaceId).length >= 2048) throw new Error("Preview source document capacity exceeded");
    const id = randomBytes(32).toString("base64url");
    this.documents.set(id, { workspaceId, context: { ...context, source: id }, sources: new Map(), aliases: new Map(), readers: new Set(), active: true }); return id;
  }
  context(id: string, context: PreviewUrlContext): void {
    const document = this.documents.get(id);
    if (!document) throw new Error("Unknown source document");
    document.context = { ...context, source: id };
  }
  private source(document: Document, id: string): Source {
    let source = document.sources.get(id);
    if (!source) {
      if (this.sourceCount >= 8192 || document.sources.size >= 1024) throw new Error("Preview generated source capacity exceeded");
      let resolve!: Source["resolve"], reject!: Source["reject"];
      const ready = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
      // Registration can fail before the browser starts a GET; retain the rejection for that reader.
      void ready.catch(() => {});
      source = { ready, resolve, reject, complete: false, uploaded: false, revoked: false, bytes: 0, mime: "application/octet-stream" }; document.sources.set(id, source); this.sourceCount++;
    }
    return source;
  }
  private alias(document: Document, url: string): Alias {
    let alias = document.aliases.get(url);
    if (!alias) {
      if (document.aliases.size >= 1024) throw new Error("Generated module alias capacity exceeded");
      let resolve!: Alias["resolve"]; const ready = new Promise<string>(yes => { resolve = yes; });
      alias = { ready, resolve }; document.aliases.set(url, alias);
    }
    return alias;
  }
  async request(request: Request, resolveWorkspace: (workspaceId: string) => Promise<void>): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(previewSourcePrefix)) return;
    const match = /^\/~preview-source\/([a-zA-Z0-9_-]{43})\/([a-fA-F0-9-]{36})\.js$/.exec(url.pathname);
    const document = match ? this.documents.get(match[1]!) : undefined;
    const headers = { "access-control-allow-origin": "null", "cache-control": "no-store", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "cross-origin", "content-security-policy": "sandbox allow-scripts" };
    if (!document || !match) return new Response("Unknown generated source capability", { status: 403, headers });
    await resolveWorkspace(document.workspaceId);
    if (!document.active || this.documents.get(match[1]!) !== document) return new Response("Generated source capability revoked", { status: 403, headers });
    const origin = request.headers.get("origin");
    if (origin && origin !== "null" && origin !== url.origin) return new Response("Forbidden source origin", { status: 403, headers });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "GET, HEAD, PUT, DELETE, OPTIONS", "access-control-allow-headers": "content-type,x-kintsugi-source-original" } });
    const source = this.source(document, match[2]!);
    if (request.method === "DELETE") { source.revoked = true; if (source.complete) this.release(document, source); return new Response(null, { status: 204, headers }); }
    if (source.revoked) return new Response("Generated source revoked", { status: 410, headers });
    if (request.method === "PUT") {
      if (source.uploaded) return new Response("Generated sources are immutable", { status: 409, headers });
      source.uploaded = true;
      // Only the first registration owns this pending promise; completed entries are immutable.
      const publish = source.resolve!, fail = source.reject!;
      const original = request.headers.get("x-kintsugi-source-original");
      if (original?.startsWith("blob:") && original.length <= 2048) this.alias(document, original).resolve(match[2]!);
      source.mime = request.headers.get("content-type") ?? "application/octet-stream";
      let uploadTimer: ReturnType<typeof setTimeout> | undefined;
      const reader = request.body?.getReader();
      try {
        if (!reader) throw new Error("Generated source body missing");
        document.readers.add(reader);
        const deadline = new Promise<never>((_resolve, reject) => { uploadTimer = setTimeout(() => { reject(new Error("Generated source upload timed out")); void reader.cancel().catch(error => console.error("Source cancellation failed", error)); }, 10000); });
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const chunk = await Promise.race([reader.read(), deadline]); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (!document.active || size > maxSourceBytes || (this.bytes.get(document.workspaceId) ?? 0) + chunk.value.byteLength > maxWorkspaceBytes || this.totalBytes + chunk.value.byteLength > 2 * maxWorkspaceBytes) { await reader.cancel(); throw new Error("Generated source byte limit exceeded or document revoked"); }
          source.bytes += chunk.value.byteLength; this.totalBytes += chunk.value.byteLength;
          this.bytes.set(document.workspaceId, (this.bytes.get(document.workspaceId) ?? 0) + chunk.value.byteLength);
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        if (!document.active) throw new Error("Generated source document revoked");
        publish(new TextDecoder().decode(bytes)); source.complete = true;
        if (source.revoked) this.release(document, source);
        return new Response(null, { status: 204, headers });
      } catch (error) {
        this.releaseBytes(document, source);
        fail(error instanceof Error ? error : new Error(String(error))); return new Response("Generated source registration failed", { status: 413, headers });
      } finally { clearTimeout(uploadTimer); if (reader) document.readers.delete(reader); }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers });
    const nonce = url.searchParams.get("nonce") ?? "";
    if (!previewBlobAllowed([document.context.policy ?? ""], nonce === document.context.nonce ? "" : nonce)) return new Response("Blob script denied by document policy", { status: 403, headers });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const input = await Promise.race([source.ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Generated source upload timed out")), 10000); })]);
      clearTimeout(timer);
      if (!document.active) throw new Error("Generated source capability revoked");
      const context = document.context;
      const aliases = new Map<string, string>();
      for (const imported of parse(input)[0]) if (imported.n?.startsWith("blob:")) {
        const id = await Promise.race([this.alias(document, imported.n).ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Generated module registration timed out")), 10000); })]);
        aliases.set(imported.n, previewSourceUrl(context.publicOrigin, context.source!, id));
        clearTimeout(timer);
      }
      const body = rewritePreviewJavaScript(context.app === "vscode" ? input : rewritePreviewGlobals(input), context, url => aliases.get(url)!);
      return new Response(request.method === "HEAD" ? null : body, { headers: { ...headers, "content-type": source.mime } });
    } catch (error) { return new Response(error instanceof Error ? error.message : String(error), { status: 502, headers }); }
    finally { clearTimeout(timer); }
  }
  private releaseBytes(document: Document, source: Source): void {
    if (source.bytes) { this.totalBytes -= source.bytes; this.bytes.set(document.workspaceId, (this.bytes.get(document.workspaceId) ?? 0) - source.bytes); source.bytes = 0; }
  }
  private release(document: Document, source: Source): void {
    this.releaseBytes(document, source);
    // Existing GETs retain their captured promise. A revoked entry serves only 410.
    source.ready = Promise.resolve(""); source.resolve = undefined; source.reject = undefined;
  }
  remove(workspaceId: string): void {
    for (const [id, document] of this.documents) if (document.workspaceId === workspaceId) {
      document.active = false;
      for (const reader of document.readers) void reader.cancel().catch(error => console.error("Source cancellation failed", error));
      for (const source of document.sources.values()) { this.totalBytes -= source.bytes; source.bytes = 0; source.reject?.(new Error("Workspace source capability revoked")); }
      this.sourceCount -= document.sources.size;
      this.documents.delete(id);
    }
    this.bytes.delete(workspaceId);
  }
}
