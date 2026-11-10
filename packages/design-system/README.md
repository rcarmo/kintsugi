# Kintsugi design system

**Start here for UI work.** The package owns shared anatomy, visual roles and
browser interaction. Features own business state, forms, URLs and composition.
Prefer consistency over feature-specific visual preservation.

## Find a component

- **Humans:** run `bun run web`, open `/design-system-catalogue.html`.
  Search or scan live examples; expand **Usage & API** for contracts, executable
  examples and authoritative source. Try the available themes, narrow containers,
  RTL, browser zoom and reduced motion. Button specimens always show **Regular**
  and **Popular** side by side. Popular sizing activates on a narrow viewport or
  coarse pointer; desktop sizes remain identical (the Example width control alone
  does not activate mobile media queries).
  The edge laboratory pins a real popup
  to any viewport corner; Dialog includes a nested select and long content.
- **Agents:** search [`catalogue/entries.ts`](catalogue/entries.ts) for `id: "…"`.
  Each entry keeps **when to use**, **contract**, **imports**, **source paths** and
  **executable examples** together. The webpage renders these very functions,
  not manually maintained copies. Types live next to implementations below.

| Need | Catalogue id / public subpath | Authoritative interface |
|---|---|---|
| Rendered Markdown | `markdown` (CSS) | `.markdown` in [styles](src/markdown/markdown.css) |
| Tokens, themes, spacing | `foundations` (CSS) | [role tokens and composition](src/design-system.css) |
| Action, including icon-only | `button` | [ButtonOptions](src/button/button-html.ts), [content / variants](src/button/button-content.ts) |
| Prominent navigation, optional icon-only comparison ring | `action-link` | [ActionLinkOptions](src/action-link/action-link-html.ts) |
| Glanceable gauge, not interactive | `comparison-ring` | [ComparisonRingOptions](src/comparison-ring/comparison-ring-html.ts) |
| Related actions, not selection | `button-group` | [ButtonGroupOptions](src/button-group/button-group-html.ts) |
| Menu item / navigation / information / action row | `content-row` | [ContentRowOptions](src/content-row/content-row-html.ts) — `kind: compact / multiline` |
| Inline open/close with a compact or multiline summary and guttered body | `disclosure` | [DisclosureOptions](src/disclosure/disclosure-html.ts) |
| Leading mark for a row that creates something | `add-badge` | [addBadgeHtml](src/add-badge/add-badge-html.ts) |
| Running, still cancellable | `activity-button` | [ActivityButtonOptions](src/activity-button/activity-button-html.ts) |
| Running, cannot invoke again | `progress-button` | [ProgressButtonOptions](src/progress-button/progress-button-html.ts) |
| Completed button action + acknowledgement | `button-confirmation` | [ButtonConfirmationOptions](src/button-confirmation/button-confirmation-html.ts) |
| Clipboard + acknowledgement | `copy-button` | [CopyButtonOptions](src/copy-button/copy-button-html.ts) |
| URL as a scannable QR code | `qr-code` | [qrCodeButtonHtml / qrCodeDialogHtml](src/qr-code/qr-code-html.ts) |
| Destructive form confirmation | `destructive-confirmation` | [DestructiveConfirmationOptions](src/destructive-confirmation/destructive-confirmation-html.ts) |
| Mutually exclusive visible choices | `toggle` | [ToggleOptions](src/toggle/toggle-html.ts) |
| Anchored menu, trigger included | `popup` | [PopupOptions](src/popup/popup-html.ts) — prefer `popupHtml` |
| Many form choices | `popup-select` (native HTML) | [`select.popup-select`](src/popup/popup-controller.ts) |
| Focused modal task | `dialog` | [DialogOptions](src/dialog/dialog-html.ts) |
| Bounded surface with fixed chrome | `panel` | [PanelOptions](src/panel/panel-html.ts) |
| Search suggestions / empty state | `autocomplete` | [AutocompleteOptions](src/autocomplete/autocomplete-html.ts) |
| Explain a term on click or tap ("?") | `help-tip` | [helpTipHtml](src/help-tip/help-tip-html.ts) |
| Brief action acknowledgement | `transient-feedback` | [TransientFeedbackOptions](src/transient-feedback/transient-feedback-html.ts) |
| Input / textarea | `text-entry` (native HTML) | `.text-field` / `.textarea` in [styles](src/text-entry/text-entry.css) |
| Non-selectable records | `managed-list` (native HTML) | [anatomy and filtering contract](catalogue/entries.ts) |
| Persistent non-blocking warning | `warning-banner` | [WarningBannerOptions](src/warning-banner/warning-banner-html.ts), optional single-click dismissal |
| Status markers / step progress | `status` (native HTML) | `.status-dot` / `.status-list` in [styles](src/status/status.css) |
| Decorative SVGs | `icons` | [Icons](src/icons/icons-html.ts) |
| Pane drill-in / return motion | `page-slide/client` | [slidePageChange](src/page-slide/page-slide-client.ts) |
| Vertical focus navigation | `linear-navigation/client` | [data targets and controller](src/linear-navigation/linear-navigation-controller.ts) |

## Install the interface once

```ts
// Server integration: mount these logical URLs. Hosts may fingerprint them and
// rewrite CSS imports; individual features must not maintain asset inventories.
import { designSystemStaticFiles } from "@kintsugi/design-system/assets";

// Browser entrypoint: use the host's existing Stimulus application, once.
import { registerDesignSystemControllers } from "@kintsugi/design-system/client";
registerDesignSystemControllers(application);

// Server rendering:
import { buttonHtml } from "@kintsugi/design-system/button";
const action = buttonHtml({
  type: "submit",
  variant: "primary",
  content: { kind: "caption", caption: "Save" },
});
```

Load `/design-system.css`. Tokens and theme selectors are package-owned.
Foreign-origin diagnostic documents can embed the identical CSS/font with
`inlineDesignSystemCss()` from `@kintsugi/design-system/styles/server`, without
a second hard-coded theme or asset server.
The `styles` export identifies that stylesheet; `assets` describes the logical
URLs it imports, including its font. Renderer modules never start Stimulus.
Individual `*/client` exports are available for feature-owned browser state
(e.g. `setActivityButtonState`, `showButtonConfirmation`, `resetButtonConfirmation`, `showTransientFeedback`, `setToggleValue`).

The registration entrypoint only registers controllers. Every component's markup
carries its own `data-controller` and `data-action`, so Turbo morphs, which reset
attributes to the server's, keep it working. Renderers emit their bindings and take
extra `controllers`/`actions` instead of those attributes; native CSS interfaces
write theirs by hand (`data-controller="popup-select"`, `data-controller="managed-list"`).
The public popup interface always owns the anchor, invoking Button, disclosure
state and viewport collision handling. `trigger.attributesHtml` and
`menuAttributesHtml` are integration slots, not positioning APIs. The shared
Stimulus positioning lifecycle uses the visual viewport, repositions on scrolling
and resizing, and bounds long menus with internal scrolling. It deliberately does
not depend on CSS anchor positioning (fixed triggers misposition in WebKit).

Comparison-ring Action links retain a dim full-circle track beneath the colored
arcs, including when both values are zero.

Touch controls keep their target sizes in landscape as well as portrait.
For frequently used actions, add `data-popular-button` to the button's
`attributesHtml` or a containing group (including ButtonGroup's `attributesHtml`).
At ≤700px or with a coarse pointer, regular icon-only buttons are 42.5px with
17.85px icons; popular ones are 62.5px with 26.25px icons. Popular caption buttons
also get a 62.5px minimum height (for example, composer prompt template buttons). Use
`data-popular-button="touch"` to keep regular desktop sizing while enlarging touch targets. Untagged
caption button minimum heights are unchanged. Desktop popular controls have fixed sizes: icon buttons are 38.24px with 20.59px icons,
and caption buttons have a 36.93px minimum height with 18.38px icons. Caption controls,
including activity, progress and copy buttons, wrap long labels on mobile; perimeter
indicators follow the resulting button height. The tag applies to all descendant
buttons, so keep groups scoped to the actions that should be large. Action
items retain their shared rounded treatment and reveal truncated labels on engagement. Enhanced selects retain native form values and reset behavior.

## Rules for callers

1. Use renderers for structured components; do not hand-copy their anatomy.
   Native inputs, lists and status markers intentionally have CSS/HTML interfaces;
   do not wrap them in pass-through renderers just to avoid writing native HTML.
2. Plain text options are escaped. `*Html` and `attributesHtml` are **trusted**:
   escape external values before inserting them. Escape does not validate URLs;
   callers must validate externally supplied destinations.
3. Integration attributes connect forms, Turbo, Stimulus, IDs and ARIA.
   `class` and `style` attributes are rejected, including through `attributesHtml`.
   Never override a renderer's reserved attributes or use data hooks to style
   its internals. Selection uses native ARIA, not custom active classes.
4. Use native semantics: Button acts, Action link navigates, Toggle selects a
   value, Popup chooses an action. Accessible labels are mandatory for icon-only
   controls. Don't use placeholder text as a field label.
5. Callers may place, size and arrange containing regions. Do not fork shared
   control height, padding, border, color or typography in feature stylesheets.
   Fullscreen media, terminal surfaces and composer editing are domain layouts,
   not extra general-purpose dialog or button variants.
6. Server state changes should return HTML / Turbo Streams. Client JavaScript
   is for browser-owned behavior and must live in focused Stimulus controllers.
7. Error banners must include an accessible close button. Use the shared Button
   with the Close icon and a descriptive dismissal label; do not make users wait
   for a timeout or navigate away to dismiss an error.

## Hardened composition

Public renderers have no `className` or `bodyClassName`. Do not replace these with
feature-specific variants or selectors. Put layout on a **surrounding element**.
Panel owns its regions (`bodyLayout`, `bodyOverflow`); Dialog owns its surface.
Content row uses `kind: "compact"` for single-line pills or `kind: "multiline"`
for wrapping soft rectangles. `width` defaults to `"fit"`; opt into `"fill"` for
collection rows (menus, navigation, pickers, file/account lists) or an allocated
layout slot. Standalone actions and transcript disclosures fit their content.
Width is independent of shape, native semantics, and disclosure state; the
disclosed body uses the available space regardless of summary width. Both require
a plain-text label; multiline accepts
a plain-text `description`. Native `element` semantics and independent `primary`
controls are separate from presentation. Disclosure composes either summary
with native open/close, a chevron and the shared gutter; callers supply content
and integration attributes, never their own summary element or body styling. Its leading, metadata and engaged-action slots retain
canonical wrappers; there is no wholesale `contentHtml` replacement. For
icon-only controls use Button. Toggle options have text labels, not HTML.
Transient feedback buttons select a Button variant rather than arbitrary classes.

HTML content slots remain where composition is the purpose of the module:
Panel/Dialog bodies, popup/autocomplete items, feedback contents, decorative
icons and metadata. These fill defined regions; they do not replace anatomy.
For browser-owned label changes use `setContentRowLabel(element, text)` from
`@kintsugi/design-system/content-row/client`; for server updates target the label
ID and send escaped text, never replacement label markup.

## Package map / maintenance

- `src/<component>/`: renderer, stylesheet and optional focused controller.
- `src/design-system.css`: tokens, themes and native CSS primitives.
- `src/assets.ts`: complete package-owned asset inventory.
- `src/client.ts`: the single registration interface, not feature behavior.
- `catalogue/entries.ts`: agent-searchable index and live usage examples.
- `catalogue/page.ts`: server HTML; `client.ts` only controls the playground.

When changing an interface, migrate callers directly. Do not add compatibility
aliases, legacy variant classes or alternate renderers. Add/update a catalogue
entry in the same change. Reuse the public renderer in its examples. Keep IDs
unique, and never run real destructive operations from the catalogue.

Run `bun run check`. Review Kintsugi and the catalogue manually; **do not write UI
tests**, DOM assertions or visual snapshots (see
[UI testing policy](../../docs/ui-testing-policy.md)).
