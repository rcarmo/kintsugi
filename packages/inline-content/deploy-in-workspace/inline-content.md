# Inline content

Choose the simplest format that explains the answer well:

- Use Markdown for prose, lists, code, and ordinary tables.
- Use a normal fenced `mermaid` block when labeled nodes and connections adequately explain a static structure or process. Do not make an HTML file for that diagram.
- Use an HTML fragment for charts, spatial illustrations, meaningful visual layouts, adjustable inputs, and other interaction.
- Do not decorate ordinary prose, recreate a Markdown table, or wrap a Mermaid diagram in HTML. Split oversized diagrams instead of relying on fullscreen.
- Inline content is part of your answer, not a website. Preview independently styled deliverables with `artifact-preview:` and applications with a Browser view instead.

## File-only output

Write a UTF-8 HTML **fragment** to an absolute workspace path. No `doctype`, `html`, `head`, or `body`. Keep it under 1 MiB. Use one content root with a unique ID. Include styles and behavior in this file; relative files and network resources are not loaded. Images can use data URLs; prefer inline SVG for diagrams.

Place this reference on its own line wherever the visual belongs in your reply:

```markdown
The two approaches put the waiting in different places:

![Queue placement](inline-content:/work/explanations/queue.html)

I recommend queuing before processing so overload stays bounded.
```

The optional image description is the accessible frame title. Never use an HTML code fence to display inline content. No publishing tool or dev server is needed. Write the file **before** sending the reference. Kintsugi reads it when the visual loads; edits appear when earlier replies are reloaded, and deleting the file breaks their references. Use a new filename for each revision when earlier versions should stay intact.

Use prose outside the fragment unless its arrangement helps explain the idea. Do not repeat the same explanation inside and outside. Do not announce the file, HTML, or rendering mechanism.

## Host-owned appearance

Kintsugi supplies its font, current theme, typography, native controls, and automatic height sizing. Do not add your own stylesheet dependency, page background, app header, navigation, fullscreen button, or download toolbar. Keep the top-level surface transparent and unframed. Use as little chrome as possible; don't nest cards.

Semantic HTML gets default styling: `p`, `h2`, `h3`, lists, `dl`, links, code, tables, `details`/`summary`, labels, buttons, inputs, selects, textareas, and outputs. Use native controls. Buttons default to secondary; add `ic-primary` for the main action or `ic-quiet` for a low-emphasis action. Do not override standard control geometry, colors, or focus styles.

### Guaranteed classes

| Class | Meaning |
| --- | --- |
| `ic-stack` | Vertical flow with standard spacing |
| `ic-row` | Wrapping horizontal group |
| `ic-grid` | Equal-width peers that automatically stack when narrow |
| `ic-surface` | Restrained bounded surface, only when grouping needs it |
| `ic-controls` | Wrapping group of related labeled controls |
| `ic-table-scroll` | Local horizontal scrolling for a genuinely wide table |
| `ic-muted` | Secondary text |
| `ic-quiet` | On `details`: supporting detail, muted when opened. On `button`: a low-emphasis action |
| `ic-small` | Host-scaled secondary annotations, not essential labels |
| `ic-number` | Tabular numerals |
| `ic-sr-only` | Visually hidden accessible text |

### Guaranteed colors

Use `--ic-text`, `--ic-text-muted`, `--ic-surface`, `--ic-border`, `--ic-accent`, `--ic-on-accent`, `--ic-danger`, and `--ic-series-1` through `--ic-series-6`. They follow the user's theme. Use `currentColor` for SVG where appropriate. Series colors are for meaningful data categories, not decorating every item. Pair color with labels or shapes.

Custom CSS is allowed for diagrams and content-specific layout. Scope every rule below your unique root ID. Inherit type rather than inventing a font or type scale. Never style the host's outer document or rely on undocumented classes.

## Responsive and accessible

Your **container** can be 320px or wider independently of the browser window. Do not assume a desktop width. Stack or wrap when content stops fitting; don't shrink a desktop canvas to fit a phone. Keep text readable. For charts, measure the actual container, redraw on resize, reduce ticks, and rearrange labels rather than scaling them into tiny text.

No fixed outer width/height, viewport-height layout, fixed-position app shell, or outer scrolling region. The conversation scrolls; your frame grows to fit. Do not implement resize messaging. Everything must be readable and usable inline; there is no expansion or fullscreen control.

Use visible labels, keyboard-accessible controls, semantic headings, and accessible names/descriptions for SVG/canvas. Essential information cannot require hover. Native controls own touch sizing. Respect `prefers-reduced-motion`, don't loop animations, and announce meaningful changed results with `aria-live="polite"`, not every animation frame.

## Built-in interaction

`details`/`summary` needs no JavaScript and uses the surrounding transcript’s disclosure styling. Put `summary` first.

For tabs, place a tablist and its panels inside `data-ic-tabs`. Use buttons with `role="tab"`, unique IDs, `aria-controls`, and `aria-selected`. Panels have matching IDs, `role="tabpanel"`, `aria-labelledby`, and `hidden` when inactive. Kintsugi implements clicks and arrow/Home/End keyboard navigation. Don't hide comparison data behind tabs when users need to compare it simultaneously.

```html
<section id="platforms" data-ic-tabs>
  <div role="tablist" aria-label="Platform">
    <button id="phone-tab" role="tab" aria-controls="phone-panel" aria-selected="true">Phone</button>
    <button id="desktop-tab" role="tab" aria-controls="desktop-panel" aria-selected="false">Desktop</button>
  </div>
  <div id="phone-panel" role="tabpanel" aria-labelledby="phone-tab">Stack related sections.</div>
  <div id="desktop-panel" role="tabpanel" aria-labelledby="desktop-tab" hidden>Show peers side by side.</div>
</section>
```

Use `data-ic-tooltip="Short supplementary help"` on a labeled native control. Kintsugi handles focus, hover, and tap; essential information stays visible.

## Custom interaction

Only add JavaScript when the explanation needs custom behavior. Use a small Stimulus controller. The sandbox provides the module `@kintsugi/inline-content`, exporting `Controller`, `registerController`, and `colors`. Do not load Stimulus yourself. Use unique controller names. Keep markup in HTML rather than generating an entire UI in JavaScript.

```html
<section id="capacity" class="ic-stack" data-controller="capacity-example">
  <label>Workers
    <input type="range" min="1" max="8" value="2"
      data-capacity-example-target="workers"
      data-action="input->capacity-example#update">
  </label>
  <output class="ic-number" aria-live="polite" data-capacity-example-target="result">20 requests / second</output>
</section>
<script type="module">
import { Controller, registerController } from "@kintsugi/inline-content";
registerController("capacity-example", class extends Controller {
  static targets = ["workers", "result"];
  connect() { this.update(); }
  update() {
    this.resultTarget.textContent = `${Number(this.workersTarget.value) * 10} requests / second`;
  }
});
</script>
```

Do not assign to Stimulus-owned properties such as `this.data`, `this.element`,
`this.targets`, `this.values`, `this.scope`, `this.context`, `this.application`, or
`this.identifier`. Use descriptive private state names such as `this.measurements`
or `this.geometry` instead. Target accessors such as `this.chartTarget` are also
read-only.

For responsive drawings, observe the containing element's **width**, not every
change to the SVG's own size. Skip unchanged widths and schedule redraws with
`requestAnimationFrame` rather than writing observed geometry inside a
`ResizeObserver` callback. Cancel scheduled frames and disconnect the observer in
`disconnect()`. Input handlers can redraw immediately. This avoids resize feedback
loops when the host fits the frame's height.

For canvas rendering, `colors()` returns resolved semantic colors keyed by `text`, `accent`, `series-1`, etc. Listen to `inline-content:theme` on `document` in your controller and redraw when it changes; remove listeners/observers in `disconnect()`.

Interactions are local and temporary. Reloading resets them. There is no saved-state API, tool execution, prompt submission, parent-document access, network/API access, external library loading, or application credential access. External HTTP(S) links go through host confirmation. Use a real application preview when the task needs those capabilities.

Read your file back before presenting it. Check that IDs/targets match, calculations are correct, the initial state is useful, and controls update their outputs. Prefer a focused fragment over a miniature dashboard.
