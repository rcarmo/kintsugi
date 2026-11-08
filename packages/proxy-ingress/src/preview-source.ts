import { Type } from "typebox";

export const previewSourcePrefix = "/~preview-source/";
export const previewSourceHost = "/~preview-assets/source-host.html";
export const previewSourceRequest = Type.Union([
  Type.Object({ type: Type.Literal("put"), context: Type.String({ pattern: "^[a-zA-Z0-9_-]{43}$" }), id: Type.String({ format: "uuid" }), original: Type.Optional(Type.String({ maxLength: 2048, pattern: "^blob:" })), blob: Type.Unknown() }),
  Type.Object({ type: Type.Literal("revoke"), context: Type.String({ pattern: "^[a-zA-Z0-9_-]{43}$" }), id: Type.String({ format: "uuid" }) }),
]);
export function previewSourceUrl(origin: string, context: string, id: string): string { return `${origin}${previewSourcePrefix}${context}/${id}.js`; }
