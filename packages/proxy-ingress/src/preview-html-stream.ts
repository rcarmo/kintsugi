import { Parser } from "htmlparser2";

export interface PreviewHtmlStreamRewriter {
  tag(name: string, attributes: Record<string, string>, source: string): string;
  block(source: string): string;
}

/** Retain incomplete HTML tokens and raw-text blocks across document.write calls. */
export function createPreviewHtmlStream(rewriter: PreviewHtmlStreamRewriter) {
  let buffer = "", base = 0, consumed = 0, output = "";
  let block: string | undefined;
  const raw = (end: number) => buffer.slice(consumed - base, end - base);
  const flush = (end: number) => { if (!block) { output += raw(end); consumed = end; } };
  const parser = new Parser({
    onopentag(name, attributes) {
      if (block) return;
      flush(parser.startIndex);
      if (name === "script" || name === "style") { block = name; return; }
      const end = parser.endIndex + 1;
      output += rewriter.tag(name, attributes, raw(end)); consumed = end;
    },
    onclosetag(name, implied) {
      if (block === name) {
        const end = parser.endIndex + 1;
        output += rewriter.block(raw(end)); consumed = end; block = undefined;
      } else if (!implied) flush(parser.endIndex + 1);
    },
    ontext() { flush(parser.endIndex + 1); },
    oncommentend() { flush(parser.endIndex + 1); },
    onprocessinginstruction() { flush(parser.endIndex + 1); },
    onerror(error) { throw error; },
  }, { decodeEntities: true, lowerCaseAttributeNames: false });
  return { write(source: string) {
    buffer += source; output = ""; parser.write(source);
    buffer = buffer.slice(consumed - base); base = consumed;
    return output;
  } };
}

/** Attribute values may contain >; do not find the end of a start tag with a regexp. */
export function previewHtmlStartTag(source: string): string {
  let end = 0;
  const parser = new Parser({ onopentag() { end = parser.endIndex + 1; parser.pause(); } });
  parser.write(source);
  if (!end) throw new Error("Preview HTML serialization did not contain a start tag");
  return source.slice(0, end);
}
