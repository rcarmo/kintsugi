/** Translate generated data scripts without changing their data: CSP source class. */
export function rewritePreviewScriptDataUrl(input: string, rewrite: (source: string) => string): string {
  if (!input.toLowerCase().startsWith("data:")) return input;
  const url = new URL(input);
  const href = url.href; url.hash = "";
  const hash = href.slice(url.href.length);
  const value = url.href.slice(5);
  const comma = value.indexOf(",");
  if (comma < 0) return input;
  const metadata = value.slice(0, comma), payload = value.slice(comma + 1);
  const parameters = metadata.split(";");
  const mime = parameters[0]!.trim().toLowerCase();
  if (mime && !["text/javascript", "application/javascript", "application/ecmascript", "text/ecmascript", "text/plain"].includes(mime)) return input;
  const base64 = parameters.at(-1)?.trim().toLowerCase() === "base64";
  const raw = payload.replace(/%([\da-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  const bytes = Uint8Array.from(base64 ? atob(raw) : raw, character => character.charCodeAt(0));
  const charset = parameters.find(parameter => parameter.trim().toLowerCase().startsWith("charset="))?.split("=").slice(1).join("=").trim().replace(/^"|"$/g, "");
  const source = new TextDecoder(charset || "utf-8").decode(bytes);
  const translated = rewrite(source);
  if (translated === source) return input;
  return `data:${parameters.filter((parameter, index) => index === 0 || (!parameter.trim().toLowerCase().startsWith("charset=") && !(base64 && index === parameters.length - 1))).join(";")};charset=utf-8,${encodeURIComponent(translated)}${hash}`;
}
