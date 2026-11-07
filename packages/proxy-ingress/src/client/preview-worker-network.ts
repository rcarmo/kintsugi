import { Type } from "typebox";
import { Value } from "typebox/value";
import { mapPreviewUrl, previewUrlContextSchema, previewWorkerContext } from "../preview-url.ts";
import { installPreviewRequests } from "./preview-requests.ts";
import { previewImportSpecifier } from "./preview-imports.ts";

declare global {
  var __kintsugiPreviewWorkerContext: unknown;
  function importScripts(...urls: string[]): void;
  function __kintsugiPreviewWorkerReady(nonce: string): void;
}

if ("document" in globalThis || globalThis.origin !== "null") throw new Error("Worker transport requires an opaque worker");
const configuration = Value.Parse(Type.Object({ context: previewUrlContextSchema, entry: Type.String(), name: Type.Optional(Type.String()) }), globalThis.__kintsugiPreviewWorkerContext ?? JSON.parse(self.name.slice("kintsugi-worker:".length)));
if (configuration.name !== undefined) Object.defineProperty(globalThis, "name", { value: configuration.name });
const nativePost = globalThis.postMessage.bind(globalThis);
Object.defineProperty(globalThis, "__kintsugiPreviewWorkerReady", { value: (nonce: string) => nativePost({ previewReady: nonce }) });
const context = { ...previewWorkerContext(configuration.entry, configuration.context), windowGlobals: false };
globalThis.__kintsugiPreviewImportSpecifier = (value, module) => previewImportSpecifier(value, module, context);
let cookie = context.cookies ?? "";
installPreviewRequests(context, () => context.upstream, { read: () => cookie, write(value) { cookie = value; } });
const imports = globalThis.importScripts.bind(globalThis);
globalThis.importScripts = (...urls) => imports(...urls.map(url => mapPreviewUrl(String(url), context)));
