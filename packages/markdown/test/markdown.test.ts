import { describe, expect, test } from "bun:test";
import { renderMarkdown, renderMarkdownChecklist } from "../src/index.ts";

test("checklist progress counts nested tasks, not marker examples in prose or code", () => {
  const { completed, total } = renderMarkdownChecklist("workspace", [
    "# Review", "", "A literal [x] and `- [x] example`.", "",
    "- [x] Completed **review**", "  - [-] Check `main.ts`", "- [ ] Pending", "- Ordinary list item", "",
    "```markdown", "- [x] Example", "```",
  ].join("\n"));
  expect({ completed, total }).toEqual({ completed: 1, total: 3 });
  expect(renderMarkdownChecklist("workspace", "Just a paragraph.").total).toBe(0);
});

describe("renderMarkdown", () => {
  test("paragraphs, emphasis, and inline code", () => {
    expect(renderMarkdown("work 1", "Hello **world**, see `code` and *emphasis*.")).toBe(
      "<p>Hello <strong>world</strong>, see <code>code</code> and <em>emphasis</em>.</p>",
    );
  });

  test("escapes raw HTML", () => {
    const html = renderMarkdown("work 1", '<script>alert(1)</script><div onclick="bad()">x</div>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;div onclick=&quot;bad()&quot;&gt;");
    expect(html).not.toContain("<script>");
  });

  test("does not parse Markdown emphasis inside fenced code", () => {
    const html = renderMarkdown("work 1", "```bash\nls **/work**\n```");
    expect(html).toContain("/work");
    expect(html).not.toContain("<strong>");
  });

  test("accepts an explicit filename attribute without displaying its syntax", () => {
    const html = renderMarkdown("work 1", "```typescript filename=\"src/hello.ts\"\nexport const hello = 'world';\n```");
    expect(html).toContain(`<div class="agent-code-block-header" title="src/hello.ts">src/hello.ts</div>`);
    expect(html).not.toContain("filename=&quot;");
  });

  test("escapes filenames in fenced code blocks", () => {
    const html = renderMarkdown("work 1", "```html <demo>.html\n<p>Hello</p>\n```");
    expect(html).toContain(`data-kintsugi-fullscreen-title-value="&lt;demo&gt;.html"`);
    expect(html).toContain(`title="&lt;demo&gt;.html"`);
    expect(html).not.toContain(`<demo>`);
  });

  test("plain fenced code has no metadata header", () => {
    const html = renderMarkdown("work 1", "```\nhello world\n```");
    expect(html).not.toContain("agent-code-block-header");
  });

  test("fenced code highlighting supports C# aliases", () => {
    const html = renderMarkdown("work 1", "```cs\npublic class Demo {}\n```");
    expect(html).toContain(`data-lang="cs" class="language-csharp"`);
    expect(html).toContain("syntax-keyword");
  });

  test("GitHub-style tables receive a horizontal scroll container", () => {
    const html = renderMarkdown("work 1", [
      "| Provider | Model ID |",
      "|---|---|",
      "| Kimi For Coding | `k3` |",
      "| OpenRouter | `moonshotai/kimi-k3` |",
    ].join("\n"));
    expect(html).toContain('<div class="agent-table-scroll"><table>');
    expect(html).toContain("<thead>");
    expect(html).toContain("<td><code>k3</code></td>");
    expect(html.endsWith("</table></div>")).toBe(true);
  });

  test("preserves semantic heading levels", () => {
    const html = renderMarkdown("work 1", "# Title\n\n#### Detail");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h4>Detail</h4>");
  });

  test("omits frontmatter when requested", () => {
    const html = renderMarkdown("work 1", "---\ntitle: Example\ntags:\n  - docs\n---\n# Guide", { frontmatter: true });
    expect(html).toBe("<h1>Guide</h1>");
  });

  test("only recognizes a complete frontmatter block at the start of the document", () => {
    const html = renderMarkdown("work 1", "---\ntitle: Not closed\n# Guide", { frontmatter: true });
    expect(html).toContain("title: Not closed");
  });

  test("leaves same-document anchors as preview links", () => {
    const html = renderMarkdown("work 1", "[Setup](#setup)", { sourcePath: "/work/README.md" });
    expect(html).toContain('href="#setup"');
  });

  test("does not rewrite Kintsugi links inside inline code", () => {
    const html = renderMarkdown("work 1", "`[render.ts:55](kintsugi://file/work/render.ts?line=55&column=1)`");
    expect(html).toContain("<code>[render.ts:55](kintsugi://file/work/render.ts?line=55&amp;column=1)</code>");
    expect(html).not.toContain("data-turbo-stream");
  });

  test("escapes special characters in code-formatted link labels", () => {
    const html = renderMarkdown("work 1", "[`<tag>&\"`](kintsugi://file/work/render.ts)");
    expect(html).toContain("<code>&lt;tag&gt;&amp;&quot;</code>");
  });

  test("routes eligible workspace-local links through their canonical preview", () => {
    const html = renderMarkdown("work-1", "[app](http://localhost:3004/path?x=1#top)");
    expect(html).toContain(`href="/workspaces/work-1/ports/3004/path?x=1#top"`);
    expect(html).toContain(`target="_blank"`);
    expect(renderMarkdown("work-1", "[app](http://agents.localhost:3004/path)")).toContain(`href="/workspaces/work-1/apps/port-3004%40agents.localhost/path"`);
  });

  test("opens HTTP links in a new tab and rejects unsafe links", () => {
    const html = renderMarkdown("work 1", "[x](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(renderMarkdown("work 1", "[x](javascript:alert(1))")).not.toContain("href");
  });

  test("ordinary Markdown images retain their normal behavior", () => {
    expect(renderMarkdown("work 1", "![alt](https://example.com/a.png)")).toContain('<img src="https://example.com/a.png" alt="alt">');
  });
});
