import { disclosureHtml } from "../src/disclosure/disclosure-html.ts";
import { highlightCodeHtml } from "@kintsugi/syntax";
import { Icons } from "../src/icons/icons-html.ts";
import { escapeHtml } from "@kintsugi/shared";
import { kintsugiThemes } from "@kintsugi/shared/theme";
import { entries } from "./entries.ts";
import { popupHtml } from "../src/popup/popup-html.ts";
import { buttonHtml } from "../src/button/button-html.ts";
import { contentRowHtml } from "../src/content-row/content-row-html.ts";
import { pageBodyStimulusHtml } from "../src/page-body/page-body-html.ts";

const code = (text: string, path = "example.ts") =>
  `<pre class="catalogue-code"><code>${highlightCodeHtml({ code: text, path }).html}</code></pre>`;

function disclosure(label: string, bodyHtml: string): string {
  return disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: label } }, bodyHtml });
}

/** Server-rendered reference; examples and shown usage share the same function. */
export async function designSystemCatalogueHtml(
  options: { reloadUrl?: string } = {},
): Promise<string> {
  const components = await Promise.all(
    entries.map(async (entry) => {
      const imports = Object.entries(entry.imports ?? {})
        .map(
          ([path, symbols]) =>
            `import { ${symbols} } from "@kintsugi/design-system/${path}";`,
        )
        .join("\n");
      const sources = [
        ...new Set([
          ...(entry.imports?.[entry.id]
            ? [`${entry.id}/${entry.id}-html.ts`]
            : []),
          ...(entry.sources ?? []),
        ]),
      ];
      const contracts = await Promise.all(
        sources.map(
          async (path) =>
            disclosure(path, code(await Bun.file(new URL(`../src/${path}`, import.meta.url)).text(), path)),
        ),
      );
      return `<article id="${entry.id}" data-catalogue-target="entry" data-search="${escapeHtml(`${entry.title} ${entry.when}`.toLowerCase())}">
      <header><h2><a href="#${entry.id}">${entry.title}</a></h2><p>${entry.when}</p>${entry.compareButtonSizes ? '<p class="catalogue-size-note">Regular and popular side by side. Popular buttons use larger fixed sizes on desktop and mobile or touch.</p>' : ""}</header>
      ${entry.examples.map((example) => `<section class="catalogue-example"><h3>${escapeHtml(example.title)}</h3>${entry.compareButtonSizes
        ? `<div class="catalogue-comparison">${["regular", "popular"].map((size) => `<section class="catalogue-size"><h4>${size === "regular" ? "Regular" : "Popular"}</h4><div class="catalogue-stage"${size === "popular" ? " data-popular-button" : ""}>${example.render(`-${size}`)}</div></section>`).join("")}</div>`
        : `<div class="catalogue-stage">${example.render()}</div>`}</section>`).join("")}
      <div class="catalogue-reference">${disclosure("Usage & API", `<div class="catalogue-reference-content"><h3>Contract</h3><p>${escapeHtml(entry.contract)}</p><h3>Example usage</h3>${entry.examples.map((example) => code(`${imports}\n\nconst renderExample = ${example.render.toString()};`)).join("")}<h3>API source</h3>${contracts.join("")}</div>`)}</div>
    </article>`;
    }),
  );
  const cornerMenu = popupHtml({
    id: "edge-menu",
    label: "Edge laboratory",
    trigger: {
      variant: "primary",
      content: { kind: "caption", caption: "Corner menu" },
    },
    contentHtml: Array.from({ length: 18 }, (_, index) =>
      contentRowHtml({
        width: "fill",
        kind: "compact",
        element: {
          tag: "button",
          attributesHtml: `type="button" role="menuitem"${index === 2 ? " disabled" : ""}`,
        },
        label: {
          kind: "text",
          text:
            index === 0
              ? "A long menu caption near a viewport edge"
              : `Action ${index + 1}`,
        },
      }),
    ).join(""),
  });
  return `<!doctype html><html lang="en" data-theme="nord"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kintsugi · Design system</title><link rel="stylesheet" href="/design-system.css"><link rel="stylesheet" href="/design-system-catalogue.css"><script type="module" src="/design-system.js"></script></head>
  <body${pageBodyStimulusHtml(["catalogue", options.reloadUrl ? "catalogue-reload" : undefined])}${options.reloadUrl ? ` data-catalogue-reload-url-value="${escapeHtml(options.reloadUrl)}"` : ""}><a class="catalogue-skip" href="#components">Skip to components</a>
  <aside class="catalogue-sidebar"><a class="catalogue-brand" href="#top">Kintsugi <span> / Interface library</span></a><p>${entries.length} components and patterns</p><label>Find a component<input class="text-field" type="search" placeholder="Search name or purpose…" data-action="input->catalogue#filter"></label><nav aria-label="Component index">${entries.map((entry) => `<a href="#${entry.id}" data-catalogue-target="nav">${entry.title}</a>`).join("")}</nav><a href="#edge-lab">↗ Popup edge laboratory</a><p><a href="/">← Back to Kintsugi</a></p></aside>
  <main id="top"><header class="catalogue-intro"><h1>Design system</h1><p>Explore the components, their interfaces, and how they behave in different environments.</p>${disclosure("Integration & contribution guidelines", `<p>Import server renderers from <code>@kintsugi/design-system/&lt;component&gt;</code>. Mount <code>designSystemStaticFiles</code> from <code>@kintsugi/design-system/assets</code>, load <code>/design-system.css</code>, and call <code>registerDesignSystemControllers(application)</code> from <code>@kintsugi/design-system/client</code> once on your Stimulus application.</p><p>Prefer server HTML and Turbo. Text options are escaped; HTML and attributesHtml slots are trusted and must be escaped at the input boundary. Caller owns URLs, forms, business state and surrounding layout; this package owns anatomy, paint, sizes, focus and interaction. No feature-specific visual variants or copied component markup.</p><p>For agents: start at <code>packages/design-system/README.md</code>, then search <code>catalogue/entries.ts</code> by id. Each entry keeps purpose, contract, imports and executable examples together. Native CSS primitives are intentional interfaces, not unfinished renderer migrations.</p>`) }</header>
  <section class="catalogue-controls" aria-label="Example environment"><label>Theme<select data-action="change->catalogue#theme">${kintsugiThemes.map(({ id, label }) => `<option value="${id}"${id === "nord" ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label><label>Example width<select data-action="change->catalogue#width"><option value="100%">Fluid</option><option value="320px">320 px · narrow</option><option value="480px">480 px</option></select></label><label>Direction<select data-action="change->catalogue#direction"><option value="ltr">LTR</option><option value="rtl">RTL</option></select></label><span>Also try browser zoom & reduced motion.</span></section>
  <p role="status" data-catalogue-target="status"></p><div id="components" class="catalogue-components">${components.join("")}</div>
  <section id="edge-lab" class="catalogue-lab"><h2>Popup edge laboratory</h2><p>Pin a real menu trigger to a browser corner. Open it, scroll the long menu, navigate with arrows, and press Escape. Change corners to check collision flipping. Reset hides the fixture.</p><label>Trigger position<select data-action="change->catalogue#corner"><option value="">Hidden / reset</option><option value="top-left">Top left</option><option value="top-right">Top right</option><option value="bottom-left">Bottom left</option><option value="bottom-right">Bottom right</option></select></label>${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Reset fixture" }, attributesHtml: 'data-action="catalogue#resetCorner"' })}<div class="catalogue-edge" data-catalogue-target="edge" hidden>${cornerMenu}</div></section>
  <footer>Kintsugi design system. <a href="#top">Back to top ↑</a></footer></main></body></html>`;
}
