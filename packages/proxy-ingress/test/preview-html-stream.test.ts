import { describe, expect, test } from "bun:test";
import { createPreviewHtmlStream, previewHtmlStartTag } from "../src/preview-html-stream.ts";

describe("incremental preview HTML", () => {
  const identity = () => createPreviewHtmlStream({ tag: (_name, _attributes, source) => source, block: source => source });
  for (const source of [
    '<img src="/image?a=>&amp;b=2">tail',
    '<table><tr><td>one</td></tr></table>',
    '<script>const s="<img src=/not-an-image>";</script><img src=/real>',
    '<style>.a{background:url(/image)}</style>',
    '<textarea><img src=/text></textarea><title>&amp; title</title>',
    '<!-- <img src=/comment> -->text &amp; more &#x1f600;!',
    '<svg><image href="/image"/><script>let x=1;</script></svg>',
    '<!doctype html><html><body><p>one<div>two</div></body></html>',
  ]) test(`preserves every chunk boundary: ${source.slice(0, 45)}`, () => {
    for (let boundary = 0; boundary <= source.length; boundary++) {
      const stream = identity();
      expect(stream.write(source.slice(0, boundary)) + stream.write(source.slice(boundary))).toBe(source);
    }
    const stream = identity();
    expect([...source].map(character => stream.write(character)).join("")).toBe(source);
  });
  test("only rewrites completed tags and complete executable/raw CSS blocks", () => {
    const tags: Array<[string, Record<string, string>]> = [], blocks: string[] = [];
    const stream = createPreviewHtmlStream({ tag: (name, attributes, source) => { tags.push([name, attributes]); return source.replace('/old', '/new'); }, block: source => { blocks.push(source); return source.replace('/old', '/new'); } });
    expect(stream.write('<img src="/ol')).toBe("");
    expect(stream.write('d"><script>fetch("/ol')).toBe('<img src="/new">');
    expect(stream.write('d")</script>')).toBe('<script>fetch("/new")</script>');
    expect(tags).toEqual([["img", { src: "/old" }]]);
    expect(blocks).toEqual(['<script>fetch("/old")</script>']);
  });
  test("retains attribute case and decodes values without executing markup", () => {
    const tags: Array<Record<string, string>> = [];
    const stream = createPreviewHtmlStream({ tag: (_name, attributes, source) => { tags.push(attributes); return source; }, block: source => source });
    stream.write('<svg viewBox="0 0 10 10"><image href="/image?a=1&amp;b=2"/></svg>');
    expect(tags).toEqual([{ viewBox: "0 0 10 10" }, { href: "/image?a=1&b=2" }]);
  });
  test("finds serialized tag boundaries without treating quoted > as delimiters", () => {
    expect(previewHtmlStartTag('<div title="a > b" data-value="&quot;>">body</div>')).toBe('<div title="a > b" data-value="&quot;>">');
    expect(() => previewHtmlStartTag("text only")).toThrow("start tag");
  });
});
