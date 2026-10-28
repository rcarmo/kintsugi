import { authoredDisclosureParts } from "@kintsugi/design-system/disclosure";
import { inlineDesignSystemCss } from "@kintsugi/design-system/styles/server";

const disclosure = authoredDisclosureParts();

let runtime: Promise<string> | undefined;
async function runtimeModule(): Promise<string> {
  runtime ??= (async () => {
    const build = await Bun.build({ entrypoints: [new URL("../client/inline-content-runtime.ts", import.meta.url).pathname], target: "browser", format: "esm", minify: true });
    if (!build.success) throw new AggregateError(build.logs, "Could not build inline-content runtime");
    return `data:text/javascript;base64,${Buffer.from(await build.outputs[0]!.text()).toString("base64")}`;
  })();
  return runtime;
}

/** The document is always loaded into an opaque-origin, scripts-only sandbox. */
export async function inlineContentDocument(fragment: string): Promise<string> {
  const [design, styles, module] = await Promise.all([
    inlineDesignSystemCss(),
    Bun.file(new URL("../client/inline-content.css", import.meta.url)).text(),
    runtimeModule(),
  ]);
  // Public semantic controls are implemented using the actual design-system classes.
  // A details element only gets a content gutter once its summary has closed, so one without
  // a summary never receives an unmatched closing tag.
  const openDetails: { summarized: boolean }[] = [];
  const enhanced = await new HTMLRewriter()
    .on("details", { element(element) {
      element.setAttribute("class", `${element.getAttribute("class") ?? ""} ${disclosure.detailsClass}`);
      const details = { summarized: false };
      openDetails.push(details);
      element.onEndTag((end) => {
        openDetails.pop();
        if (details.summarized) end.before(disclosure.contentClosingHtml, { html: true });
      });
    } })
    .on("details > summary", { element(element) {
      const details = openDetails.at(-1)!;
      if (details.summarized) return;
      details.summarized = true;
      element.setAttribute("class", `${element.getAttribute("class") ?? ""} ${disclosure.summaryClass}`);
      element.prepend(disclosure.labelOpeningHtml, { html: true });
      element.append(disclosure.labelClosingHtml, { html: true });
      element.onEndTag((end) => { end.after(disclosure.contentOpeningHtml, { html: true }); });
    } })
    .on("button", { element(element) {
      const classes = element.getAttribute("class") ?? "";
      element.setAttribute("class", `${classes} button${classes.split(/\s+/).includes("ic-primary") ? " primary" : ""}`);
      element.setAttribute("type", "button");
    } })
    .on('input:not([type=checkbox]):not([type=radio]):not([type=range]), select', { element(element) { element.setAttribute("class", `${element.getAttribute("class") ?? ""} text-field`); } })
    .on("textarea", { element(element) { element.setAttribute("class", `${element.getAttribute("class") ?? ""} textarea`); } })
    .on("[data-ic-tabs]", { element(element) { element.setAttribute("data-controller", `${element.getAttribute("data-controller") ?? ""} ic-tabs`); } })
    .on("[data-ic-tooltip]", { element(element) { element.setAttribute("data-controller", `${element.getAttribute("data-controller") ?? ""} ic-tooltip`); } })
    .transform(new Response(fragment)).text();
  const csp = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${design}\n${styles}</style><script type="importmap">${JSON.stringify({ imports: { "@kintsugi/inline-content": module } })}</script><script type="module" src="${module}"></script></head><body class="markdown" data-controller="ic-runtime"><main id="ic-content">${enhanced}</main></body></html>`;
}
