import { disclosureHtml } from "../src/disclosure/disclosure-html.ts";
/** Search by id. Each entry co-locates WHEN, contract, imports and executable examples.
 * page.ts renders these functions AND displays their source: no parallel demo markup.
 * Native CSS primitives intentionally do not have pass-through renderers. */
import { tabHtml, tabStripHtml } from "../src/tab-strip/tab-strip-html.ts";
import { buttonConfirmationHtml } from "../src/button-confirmation/button-confirmation-html.ts";
import { buttonHtml } from "../src/button/button-html.ts";
import { actionLinkHtml } from "../src/action-link/action-link-html.ts";
import { comparisonRingHtml } from "../src/comparison-ring/comparison-ring-html.ts";
import { buttonGroupHtml } from "../src/button-group/button-group-html.ts";
import { contentRowHtml } from "../src/content-row/content-row-html.ts";
import { addBadgeHtml } from "../src/add-badge/add-badge-html.ts";
import { activityButtonHtml } from "../src/activity-button/activity-button-html.ts";
import { progressButtonHtml } from "../src/progress-button/progress-button-html.ts";
import { copyButtonHtml } from "../src/copy-button/copy-button-html.ts";
import { helpTipHtml } from "../src/help-tip/help-tip-html.ts";
import { qrCodeButtonHtml, qrCodeDialogHtml } from "../src/qr-code/qr-code-html.ts";
import { destructiveConfirmationHtml } from "../src/destructive-confirmation/destructive-confirmation-html.ts";
import { dialogHtml } from "../src/dialog/dialog-html.ts";
import { panelHtml } from "../src/panel/panel-html.ts";
import { popupHtml } from "../src/popup/popup-html.ts";
import { toggleHtml } from "../src/toggle/toggle-html.ts";
import { autocompleteHtml } from "../src/autocomplete/autocomplete-html.ts";
import { transientFeedbackHtml } from "../src/transient-feedback/transient-feedback-html.ts";
import { warningBannerHtml } from "../src/warning-banner/warning-banner-html.ts";
import { kintsugiBrandIconHtml, builtinAgentIconHtml, Icons } from "../src/icons/icons-html.ts";

export interface CatalogueEntry {
  id: string;
  title: string;
  when: string;
  contract: string;
  imports?: Record<string, string>;
  sources?: string[];
  /** Compare the same specimen with and without the popular group marker. */
  compareButtonSizes?: boolean;
  examples: { title: string; render: (idSuffix?: string) => string }[];
}
export const entries: CatalogueEntry[] = [
  {
    id: "scrollbar", title: "Scrollbars", when: "Any native scrolling region: lists, panels, code, tabs and transcripts.",
    contract: "Shared automatic enhancement follows the hovered scroll viewport on pointer movement, including regions inserted by Turbo. Scrolling content under a stationary cursor does not switch tracks; non-overflowing nested regions do not steal an ancestor’s scrollbar. Four-pixel thumbs have twelve-pixel drag targets. Tracks overlay content in the browser top layer; neither hidden nor visible tracks reserve space. Native gutters are disabled even before overflow begins. Normal mouse wheels scroll horizontal-only regions sideways and stay horizontal at either end, without scrolling the surrounding page vertically. Two-axis regions, Shift+wheel, horizontal trackpad gestures and Ctrl+wheel stay native. Touch and keyboard scrolling remain native. Touch scrolling, including momentum, reveals the scrolled region’s tracks, which fade once scrolling settles; programmatic scrolling alone does not. Horizontal dragging follows physical direction in RTL. Use overflow: auto on a bounded region; no scrollbar markup or feature controller is needed.",
    sources: ["scrollbar/scrollbar-controller.ts", "scrollbar/scroll-geometry.ts", "scrollbar/scrollbar.css"],
    examples: [{ title: "Expand the list, then hover and drag · wheel over the wide row", render: () => `<div style="width: min(100%, 360px); height: 180px; overflow: auto; border: 1px solid var(--line); padding: 12px"><p>Content keeps its full width.</p>${disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Show more rows" } }, bodyHtml: Array.from({ length: 15 }, (_, i) => `<p>List item ${i + 1}</p>`).join("") })}</div><div style="width: min(100%, 360px); overflow: auto; border: 1px solid var(--line); padding: 12px"><div style="width: 700px">A wide row — use your mouse wheel here to scroll sideways.</div></div>` }],
  },
  {
    id: "tab-strip", title: "Tab strip", when: "Horizontal closable views, including Agent and Work views.",
    contract: "Provide a page-unique stable id for Turbo updates. Content-sized short tabs; long titles shrink to 7rem (maximum 20rem) before scrolling. The strip owns edge fades, title fades and Left/Right/Home/End navigation. Shared scrollbars own overlay tracks and mouse-wheel scrolling. Busy and attention share one status slot; desktop close replaces status on engagement without resizing tabs. On mobile/touch, only the selected tab shows close; unselected tabs retain status. Features supply selection, status, icons and close forms, with fixed pane actions beside the strip—no tab styling overrides.",
    imports: { "tab-strip": "tabHtml, tabStripHtml", "tab-strip/client": "setTabStatus", button: "buttonHtml", "button-group": "buttonGroupHtml", "destructive-confirmation": "destructiveConfirmationHtml", panel: "panelHtml", icons: "Icons" },
    sources: ["tab-strip/tab-strip-controller.ts", "tab-strip/tab-strip.css"],
    examples: [{
      title: "Content sizing · hover, scroll and change the selected tab’s status",
      render: () => `<div class="form-stack" data-catalogue-tab-demo data-action="submit->catalogue#submit">
        ${buttonGroupHtml({ semantics: "group", label: "Selected tab status", orientation: "horizontal", itemsHtml: '<label><input type="checkbox" data-tab-busy data-action="change->catalogue#tabStatus"> Busy</label><label><input type="checkbox" data-tab-attention data-action="change->catalogue#tabStatus"> Attention</label>' })}${panelHtml({
          element: { tag: "section" },
          headerHtml: tabStripHtml({
            id: "catalogue_work_views", label: "Example work views",
            tabsHtml: ["Shell", "Investigate terminal reconnect and attention handling", "Files", "Dev server", "Changes"].map((text, index) => tabHtml({
              label: { kind: "text", text }, selected: index === 0,
              primary: { tag: "button", attributesHtml: 'type="button" data-action="catalogue#selectTab"' },
              iconHtml: index === 1 ? Icons.Browser : Icons.Terminal,
              status: { busy: index === 1, requestingAttention: index === 1 || index === 2 },
              closeHtml: `<form>${destructiveConfirmationHtml({
                id: `catalogue_tab_close_${index}`,
                trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: Icons.Close, label: `Close ${text}` } },
                confirmCaption: "Yes, close", cancelCaption: "Oops",
              })}</form>`,
            })).join(""),
          }) + `<form>${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: "New view" } })}</form>`,
          bodyLayout: "padded", bodyHtml: '<span data-tab-selected-title>Shell</span><output></output>',
        })}</div>`,
    }],
  },
  {
    id: "page-slide", title: "Page slide", when: "Drill into a bounded pane, then return, with fixed header chrome. Works with persistent pages and server-rendered replacements.",
    contract: "slidePageChange(currentBody, render, direction) snapshots only the outgoing/incoming body and slides it 280ms with the shared easing. currentBody resolves the current body; render updates feature-owned state/markup and returns the incoming body, which may be the same element. Headers update in place. Features retain ownership of URLs, dirty guards, inert state and focus. Forward/back reverse in RTL; reduced motion and browsers without View Transitions render immediately. New navigation finishes the previous animation without canceling its render. No copied forms, duplicate controllers or outgoing DOM is retained.",
    imports: { "page-slide/client": "slidePageChange", panel: "panelHtml", button: "buttonHtml", "content-row": "contentRowHtml", icons: "Icons" },
    sources: ["page-slide/page-slide-client.ts", "page-slide/page-slide.css"],
    examples: [{ title: "Drill in, then Back · try RTL and reduced motion", render: () => `<div data-page-slide-demo>${panelHtml({
      element: { tag: "section" },
      headerHtml: '<span hidden data-page-slide-back>' + buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Back, label: "Back to template settings" }, attributesHtml: 'data-catalogue-back-param="true" data-action="catalogue#pageSlide"' }) + '</span><h3 class="panel__title" tabindex="-1" data-page-slide-title>Template settings</h3>',
      bodyLayout: "padded",
      bodyHtml: `<div data-page-slide-body style="height: 160px; overflow: hidden">
        <section data-page-slide-page="index">${contentRowHtml({ kind: "compact", width: "fill", label: { kind: "text", text: "Secrets" }, element: { tag: "button", attributesHtml: 'type="button" data-catalogue-back-param="false" data-action="catalogue#pageSlide"' } })}</section>
        <section data-page-slide-page="detail" hidden><p>Choose a secret to edit.</p>${contentRowHtml({ kind: "multiline", label: { kind: "text", text: "PAYMENTS_API_KEY" }, description: "Required", element: { tag: "div" } })}</section>
      </div>`,
    })}</div>` }],
  },
  {
    id: "motion",
    title: "Motion · state changes",
    when: "Try the transitions.dev-inspired animations across the shared components. Open, dismiss and repeat; these are the real shared components.",
    contract:
      "Menus grow from their resolved trigger edge (250ms), dialogs scale from 96% with a fading backdrop (250ms), and both dismiss faster (150ms). Feedback rises 4px while fading in. Shared motion tokens live in design-system.css. All motion respects the operating system’s reduced-motion preference, with no delayed actions or focus restoration. Native discrete CSS transitions keep closing surfaces visible without JavaScript timers. Toggles slide their selection, disclosures animate intrinsic height where supported, stateful buttons crossfade labels and soften perimeter changes, suggestions and warnings reveal gently, and enabled buttons compress while pressed. Warning regions ease to their new height after a successful Turbo Stream update.",
    imports: {
      popup: "popupHtml",
      dialog: "dialogHtml",
      button: "buttonHtml",
      "copy-button": "copyButtonHtml",
      "content-row": "contentRowHtml",
      "transient-feedback": "transientFeedbackHtml",
      icons: "Icons",
      toggle: "toggleHtml",
      "activity-button": "activityButtonHtml",
      "progress-button": "progressButtonHtml",
      autocomplete: "autocompleteHtml",
      "warning-banner": "warningBannerHtml",
    },
    sources: [
      "design-system.css",
      "popup/popup.css",
      "dialog/dialog.css",
      "transient-feedback/transient-feedback.css",
      "toggle/toggle.css",
      "perimeter-button/perimeter-button.css",
      "perimeter-button/perimeter-button-controller.ts",
      "autocomplete/autocomplete.css",
      "warning-banner/warning-banner-controller.ts",
      "button/button.css",
    ],
    examples: [
      {
        title: "01 · Menu grows from its anchor — open, choose or press Escape",
        render: () =>
          popupHtml({
            id: "motion-menu",
            label: "Motion menu",
            trigger: {
              variant: "secondary",
              content: { kind: "caption", caption: "Open animated menu" },
            },
            contentHtml: ["Edit details", "Duplicate", "Archive"]
              .map((text) =>
                contentRowHtml({
                  width: "fill",
                  kind: "compact",
                  element: {
                    tag: "button",
                    attributesHtml: 'type="button" role="menuitem"',
                  },
                  label: { kind: "text", text },
                }),
              )
              .join(""),
          }),
      },
      {
        title: "02 · Modal settles in, backdrop fades — open and close",
        render: () =>
          buttonHtml({
            type: "button",
            variant: "secondary",
            content: { kind: "caption", caption: "Open animated dialog" },
            attributesHtml:
              'data-action="catalogue#openDialog" data-catalogue-dialog-param="motion-dialog"',
          }) +
          dialogHtml({
            element: { id: "motion-dialog" },
            iconHtml: Icons.Plus,
            titleCaption: "A softer change of focus",
            bodyHtml:
              "<p>A small scale change introduces the focused surface. The backdrop fades with it. Close with × or Escape, then open again.</p><p>Focus returns immediately; motion never delays the action.</p>",
          }),
      },
      {
        title: "03 · Acknowledgement fades and rises — resets after two seconds",
        render: () =>
          transientFeedbackHtml({
            element: {
              tag: "button",
              attributesHtml: 'type="button" data-action="catalogue#feedback"',
            },
            state: "initial",
            initialContent: { kind: "text", text: "Acknowledge" },
            feedbackContent: { kind: "text", text: "Done!" },
          }) +
          copyButtonHtml({
            label: "Copy example text",
            caption: "Copy text",
            copyText: "Small motion, clear feedback.",
          }),
      },
      {
        title: "04 · Selection slides — try different label widths",
        render: () =>
          toggleHtml({
            variant: "button",
            label: "Motion view",
            name: "motion-view",
            value: "list",
            options: [
              { value: "list", label: "List" },
              { value: "board", label: "Board" },
              { value: "timeline", label: "Timeline" },
            ],
          }),
      },
      {
        title: "05 · Expand and collapse — native disclosure",
        render: () =>
          disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Advanced options" } }, bodyHtml: '<div class="form-stack"><p>The arrow rotates as the section expands. Height follows the actual content, rather than a guessed maximum.</p><label>Display name<input class="text-field" value="My workspace"></label><p>Close and reopen, including with the keyboard.</p></div>' }),
      },
      {
        title: "06 · Running states soften — activity stays cancellable",
        render: () =>
          activityButtonHtml({
            state: "initial",
            variant: "secondary",
            initialContent: { kind: "text", text: "Start activity" },
            activeContent: { kind: "text", text: "Stop activity" },
            type: "button",
            actions: "catalogue#activity",
          }),
      },
      {
        title: "07 · Progress — use the controls to step through a task",
        render: () =>
          '<div class="form-stack">' +
          progressButtonHtml({
            id: "motion-progress",
            type: "button",
            state: "initial",
            variant: "secondary",
            initialContent: { kind: "text", text: "Run task" },
            progressContent: { kind: "text", text: "Working…" },
            actions: "catalogue#progress",
            attributesHtml: 'data-catalogue-progress-param="25"',
          }) +
          '<div class="form-actions">' +
          [
            { caption: "Start · 25%", value: "25" },
            { caption: "Advance · 75%", value: "75" },
            { caption: "Finish / reset", value: "idle" },
          ]
            .map((step) =>
              buttonHtml({
                type: "button",
                variant: "secondary",
                content: { kind: "caption", caption: step.caption },
                attributesHtml: `data-action="catalogue#progress" data-catalogue-progress-param="${step.value}"`,
              }),
            )
            .join("") +
          "</div></div>",
      },
      {
        title: "08 · Suggestions reveal — preview server-rendered results",
        render: () =>
          '<div class="form-stack">' +
          buttonHtml({
            type: "button",
            variant: "secondary",
            content: { kind: "caption", caption: "Show / hide suggestions" },
            attributesHtml:
              'aria-expanded="false" aria-controls="motion-suggestions" data-action="catalogue#suggestions"',
          }) +
          autocompleteHtml({
            kind: "results",
            label: "Example suggestions",
            attributesHtml: 'id="motion-suggestions" hidden',
            contentHtml: ["kintsugi/design-system", "kintsugi/workspace"]
              .map((text) =>
                contentRowHtml({
                  kind: "compact",
                  element: {
                    tag: "div",
                    attributesHtml: 'role="option" aria-selected="false"',
                  },
                  primary: false,
                  label: { kind: "text", text },
                }),
              )
              .join(""),
          }) +
          "</div>",
      },
      {
        title:
          "09 · Warning enters and its space collapses — confirm dismissal, then restore",
        render: () =>
          '<div class="form-stack"><div id="motion-warning-region" data-action="submit->catalogue#dismissWarning">' +
          warningBannerHtml({
            title: "Example warning",
            message:
              "This demo changes no saved settings. Real dismissals animate only after the server confirms them.",
            dismiss: {
              action: "/catalogue/warnings/dismiss",
              state: "motion-example",
            },
          }) +
          "</div><p>Content below follows the changing warning height.</p>" +
          buttonHtml({
            type: "button",
            variant: "secondary",
            content: { kind: "caption", caption: "Restore warning" },
            attributesHtml:
              'id="motion-warning-reset" data-action="catalogue#resetWarning"',
          }) +
          "</div>",
      },
      {
        title: "10 · Tactile press — hold a button; disabled stays still",
        render: () =>
          buttonHtml({
            type: "button",
            variant: "primary",
            content: { kind: "caption", caption: "Press and hold" },
          }) +
          buttonHtml({
            type: "button",
            variant: "secondary",
            disabled: true,
            content: { kind: "caption", caption: "Disabled" },
          }),
      },
    ],
  },
  {
    id: "warning-banner", title: "Warning banner",
    when: "Persistent, non-blocking problems or configuration notices that need user attention.",
    contract: "Title and message are escaped text. Optional actionsHtml composes server-rendered actions. Supplying dismiss adds an ×: action/state posts immediately without confirmation; buttonAttributesHtml binds a local browser dismissal. The feature owns persistence or local removal. role defaults to status; use alert for errors needing immediate attention. Dismissal does not resolve the condition.",
    imports: { "warning-banner": "warningBannerHtml" },
    sources: ["warning-banner/warning-banner-html.ts", "warning-banner/warning-banner.css"],
    examples: [{ title: "Missing configuration", render: () => `<div data-action="submit->catalogue#submit">${warningBannerHtml({ title: "Required secrets need values", message: "Your workspace can run, but features needing these secrets may not work.", dismiss: { action: "/catalogue/warnings/dismiss", state: "example" } })}<output aria-live="polite"></output></div>` }],
  },
  {
    id: "markdown",
    title: "Markdown",
    when: "Rendered Markdown in user and assistant messages, file previews, or other rich-text surfaces.",
    contract: "Apply markdown to the rendered-content container. It styles semantic HTML without rendering or sanitizing it. Set --markdown-block-spacing to customize paragraph, list and blockquote spacing; the default is 12px. Enhanced code blocks, media and table-scroll wrappers remain owned by their feature.",
    sources: ["markdown/markdown.css"],
    examples: [{
      title: "Shared typography · lists and nested content",
      render: () => '<div class="markdown"><h3>Review checklist</h3><p>Run <code>bun run check</code> before continuing.</p><ol><li>Review the changes.<ul><li>Check list indentation.</li><li>Check wrapping on narrow screens.</li></ul></li><li>Report the result.</li></ol><blockquote><p>Shared formatting, regardless of author.</p></blockquote><pre><code>bun run check</code></pre><p><a href="#markdown">Markdown reference</a></p></div>',
    }],
  },
  {
    id: "foundations",
    title: "Foundations & composition",
    when: "Role tokens and shared layout primitives, not a second set of component sizes.",
    contract:
      "Use --bg, --panel, --elev, --text, --text-bright, --text-muted, --accent, --success, --warning and --danger by semantic role. Theme is data-theme on the root. surface-lighting.css owns the shared rim, inner-glow and background-image roles for panels, Content rows, buttons and domain surfaces. Typography uses --font-sans / --font-mono, --text-body / --text-title / --text-code. title supplies visual heading style, not heading semantics. Action lists use a single bounded grid column so long row contents cannot widen the collection. form-stack, form-section, form-actions, action-list, work-view-toolbar and empty-state own composition spacing. viewport-overlay bounds browser-owned overlays.",
    sources: ["design-system.css", "surface-lighting.css"],
    examples: [
      {
        title: "Semantic colors · title · form spacing",
        render: () =>
          '<div class="form-stack"><h3 class="title">A consistent visual title</h3><div class="catalogue-swatches">' +
          [
            "accent",
            "success",
            "warning",
            "danger",
            "text-bright",
            "text",
            "text-muted",
          ]
            .map(
              (role) =>
                `<span style="color:var(--${role})"><span class="status-dot" style="color:inherit" aria-hidden="true"></span> ${role}</span>`,
            )
            .join("") +
          '</div><div class="form-section"><span>Fields in a form section</span><span>Share a smaller gap than sections.</span></div></div>',
      },
    ],
  },
  {
    id: "button",
    compareButtonSizes: true,
    title: "Button",
    when: "An action with a quiet directional rim and background light, not navigation. Primary for the main action, secondary for supporting actions, danger for destructive actions. Progress and usage rings retain their own perimeter treatment.",
    contract:
      "Choose caption OR icon-only with a mandatory accessible label. On narrow screens (≤700px) or coarse pointers, regular icon-only controls are 42.5px with 17.85px icons. Add data-popular-button to a button (via attributesHtml) or containing group for 62.5px controls and 26.25px icons. Popular caption buttons also have a 62.5px minimum height; ordinary caption buttons are unchanged. Desktop popular sizes are fixed: 38.24px icon controls with 20.59px icons, and 36.93px minimum-height caption controls with 18.38px icons. Native type and disabled are explicit. Do not add classes or override component anatomy via attributesHtml.",
    imports: { button: "buttonHtml", icons: "Icons" },
    sources: ["button/button-content.ts"],
    examples: [
      {
        title: "Icon-only · grouped icon and caption",
        render: () =>
          buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: "Add item" } }) +
          buttonGroupHtml({
            semantics: "group", label: "Quick actions", orientation: "horizontal",
            itemsHtml: buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: "Add grouped item" } }) +
              buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "/land" } }),
          }),
      },
      {
        title: "Variants · disabled · icon-only · long caption",
        render: () =>
          buttonHtml({
            type: "button",
            variant: "primary",
            content: { kind: "caption", caption: "Primary" },
          }) +
          buttonHtml({
            type: "button",
            variant: "secondary",
            content: { kind: "caption", caption: "Secondary" },
          }) +
          buttonHtml({
            type: "button",
            variant: "danger",
            content: { kind: "caption", caption: "Danger" },
          }) +
          buttonHtml({
            type: "button",
            variant: "secondary",
            disabled: true,
            content: { kind: "caption", caption: "Unavailable" },
          }) +
          buttonHtml({
            type: "button",
            variant: "secondary",
            content: {
              kind: "icon-only",
              iconHtml: Icons.Plus,
              label: "Add item",
            },
          }) +
          buttonHtml({
            type: "button",
            variant: "secondary",
            content: {
              kind: "caption",
              caption: "A deliberately long translated action caption",
            },
          }),
      },
    ],
  },
  {
    id: "comparison-ring",
    title: "Comparison ring",
    when: "Glanceable, non-interactive progress against a schedule, such as several usage limits in one row. For a link, use Action link's perimeterComparison.",
    contract: "referencePercent and valuePercent (0–100) share one ring clockwise from twelve, drawn exactly like Action link's comparison. caption is at most three characters inside the ring. label is the accessible name and tooltip; include both values and their meaning.",
    imports: { "comparison-ring": "comparisonRingHtml" },
    sources: ["comparison-ring/comparison-ring-html.ts", "comparison-ring/comparison-ring.css"],
    examples: [{
      title: "Limits · ahead, behind and unused",
      render: () => `<div style="display:flex;gap:6px">${[
        { caption: "5h", referencePercent: 60, valuePercent: 80 },
        { caption: "7d", referencePercent: 73, valuePercent: 32 },
        { caption: "Op", referencePercent: 20, valuePercent: 0 },
      ].map((ring) => comparisonRingHtml({ ...ring, label: `${ring.caption}: Time ${ring.referencePercent}%, Usage ${ring.valuePercent}%` })).join("")}</div>`,
    }],
  },
  {
    id: "action-link",
    compareButtonSizes: true,
    title: "Action link",
    when: "Navigation that deserves button emphasis. Use normal links for prose.",
    contract:
      "A native anchor: href is navigation, never a click handler masquerading as navigation. No disabled links. Same content and variants as Button. Icon-only links may use perimeterComparison: referencePercent and valuePercent (0–100) share one ring clockwise from twelve. Their overlap is neutral; reference beyond value is green, value beyond reference is red. A dim full-circle track preserves the button outline, including at zero. Include both values and their meaning in the accessible label; focus has a separate outline.",
    imports: { "action-link": "actionLinkHtml" },
    examples: [
      {
        title: "Navigate to popup examples",
        render: () =>
          actionLinkHtml({
            href: "#popup",
            variant: "secondary",
            content: { kind: "caption", caption: "Explore Popup" },
          }),
      },
      {
        title: "Comparison ring · behind, ahead, equal, zero, full and unavailable",
        render: () => buttonGroupHtml({ orientation: "horizontal", semantics: "group", label: "Comparison ring states", itemsHtml: [
          { referencePercent: 75, valuePercent: 40 },
          { referencePercent: 40, valuePercent: 75 },
          { referencePercent: 50, valuePercent: 50 },
          { referencePercent: 0, valuePercent: 0 },
          { referencePercent: 100, valuePercent: 100 },
          undefined,
        ].map((comparison) => actionLinkHtml({ href: "#action-link", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Usage, label: comparison ? `Time ${comparison.referencePercent}%, Usage ${comparison.valuePercent}%` : "Usage unavailable" }, perimeterComparison: comparison })).join("") }),
      },
    ],
  },
  {
    id: "button-group",
    compareButtonSizes: true,
    title: "Button group",
    when: "Related actions sharing horizontal or vertical spacing. For mutually exclusive values, use Toggle.",
    contract:
      "Use semantics: group with a label for a meaningful group; layout for spacing only. Wrapping forms are allowed in itemsHtml.",
    imports: { "button-group": "buttonGroupHtml", button: "buttonHtml" },
    examples: [
      {
        title: "Vertical group · caption · icon-only · wrapped form",
        render: () => buttonGroupHtml({
          orientation: "vertical",
          semantics: "group",
          label: "Workspace actions",
          itemsHtml:
            buttonHtml({ type: "button", variant: "primary", content: { kind: "caption", caption: "Open workspace" } }) +
            activityButtonHtml({
              variant: "secondary", iconOnly: true, state: "active",
              initialLabel: "Start", activeLabel: "Stop",
              initialContent: { kind: "html", html: Icons.Agent },
              activeContent: { kind: "html", html: Icons.Close },
              actions: "catalogue#activity",
            }) +
            '<form data-action="submit->catalogue#submit">' +
            buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Save workspace" } }) +
            '<output aria-live="polite"></output></form>',
        }),
      },
      {
        title: "Horizontal action group",
        render: () =>
          buttonGroupHtml({
            orientation: "horizontal",
            semantics: "group",
            label: "Editing actions",
            itemsHtml:
              buttonHtml({
                type: "button",
                variant: "primary",
                content: { kind: "caption", caption: "Save" },
              }) +
              buttonHtml({
                type: "button",
                variant: "secondary",
                content: { kind: "caption", caption: "Cancel" },
              }),
          }),
      },
    ],
  },
  {
    id: "content-row",
    title: "Content row",
    when: "Menu items, navigation entries, action rows, tree entries, standalone information and disclosure summaries. Compact is a single-line pill; multiline is an intrinsic-height soft rectangle. Both share selection, keyboard focus and quiet directional lighting.",
    contract:
      "kind chooses compact or multiline, never the number of actions. width defaults to fit; use fill for rows in a collection or an allocated layout slot. Width is independent of shape and interaction. Compact labels truncate and reveal on engagement; multiline labels and optional descriptions wrap. element supplies native semantics (button/a/div/span); primary: false renders information without primary-action behavior. For independent controls, supply primary as an element instead of element, with optional leadingActionsHtml and engagedActionsHtml. Never nest buttons. Plain labels/descriptions are escaped; leadingHtml and trailingHtml fill bounded visual/status slots. A sole hidden trailing element collapses its slot while preserving its update target. Roles, selection and integration attributes belong to the caller; no class/style overrides. Use Disclosure for native open/close and guttered content, not a hand-built summary. Search terms: row, menu item, list item, action item, navigation row, compact, multiline.",
    imports: {
      "content-row": "contentRowHtml",
      button: "buttonHtml",
      "copy-button": "copyButtonHtml",
      icons: "Icons",
    },
    examples: [
      {
        title: "Fit by default · explicit fill · both shapes",
        render: () => '<div class="form-stack">' + ([undefined, "fill"] as const).map(width =>
          `<div><p>${width === "fill" ? "Fill — collection rows use the allocated lane" : "Fit — standalone rows use only the space they need"}</p><div class="action-list">` +
          contentRowHtml({ kind: "compact", width, element: { tag: "button", attributesHtml: 'type="button"' }, label: { kind: "text", text: "Connection settings" }, trailingHtml: "Connected" }) +
          contentRowHtml({ kind: "multiline", width, element: { tag: "button", attributesHtml: 'type="button"' }, label: { kind: "text", text: "Connection settings" }, description: "Connected with your account.", trailingHtml: "Connected" }) +
          '</div></div>').join("") + '</div>',
      },
      {
        title: "Tones · muted for secondary rows, brightening on hover · danger",
        render: () => '<div class="action-list">' +
          contentRowHtml({ kind: "compact", tone: "muted", element: { tag: "button", attributesHtml: 'type="button"' }, label: { kind: "text", text: "Why not Redis?" } }) +
          contentRowHtml({ kind: "compact", tone: "danger", element: { tag: "button", attributesHtml: 'type="button"' }, label: { kind: "text", text: "Delete workspace" } }) + '</div>',
      },
      {
        title: "Label-only multiline · centered beside a tall visual",
        render: () => contentRowHtml({ kind: "multiline", element: { tag: "button", attributesHtml: 'type="button"' }, label: { kind: "text", text: "Connect a provider" }, leadingHtml: '<span aria-hidden="true" style="display: grid; place-items: center; width: 34px; height: 34px">' + Icons.Cloud + '</span>' }),
      },
      {
        title: "Fit row · independent controls keep their space",
        render: () => contentRowHtml({ kind: "compact", primary: { tag: "button", attributesHtml: 'type="button"' }, label: { kind: "text", text: "Workspace record" }, engagedActionsHtml: copyButtonHtml({ label: "Copy record name", copyText: "Workspace record" }) }),
      },
      {
        title: "Same long label · compact truncation versus multiline wrapping",
        render: () => '<div class="form-section">' +
          contentRowHtml({ kind: "compact", element: { tag: "button", attributesHtml: 'type="button"' }, label: { kind: "text", text: "packages/design-system/src/content-row/content-row-html.ts" } }) +
          contentRowHtml({ kind: "multiline", element: { tag: "button", attributesHtml: 'type="button"' }, label: { kind: "text", text: "packages/design-system/src/content-row/content-row-html.ts" }, description: "A wrapping row with a soft rectangular shape. Hover and focus keep the same shared lighting as the compact pill." }) + '</div>',
      },
      {
        title: "Compact · multiline information · disabled · independent controls",
        render: () =>
          '<div class="action-list">' +
          contentRowHtml({
            width: "fill",
            kind: "compact",
            element: { tag: "button", attributesHtml: 'type="button"' },
            label: { kind: "text", text: "Open workspace" },
          }) +
          contentRowHtml({
            width: "fill",
            kind: "multiline",
            primary: false,
            element: { tag: "div" },
            leadingHtml: '<span class="status-dot running" aria-label="In progress"></span>',
            label: { kind: "text", text: "Reading workspace files" },
            description: "This information stays readable at narrow widths. Its height follows the text, without turning into a pill when the text happens to fit.",
            trailingHtml: "In progress",
          }) +
          contentRowHtml({
            width: "fill",
            kind: "compact",
            element: {
              tag: "button",
              attributesHtml: 'type="button" disabled',
            },
            label: { kind: "text", text: "Unavailable action" },
          }) +
          contentRowHtml({
            width: "fill",
            kind: "compact",
            primary: { tag: "a", attributesHtml: 'href="#content-row"' },
            label: {
              kind: "text",
              text: "A very long record name that needs to remain readable inside a narrow container",
            },
            trailingHtml: '<span hidden><span class="status-indicator"></span></span>',
            engagedActionsHtml: copyButtonHtml({
              label: "Copy record name",
              copyText: "Long record name",
            }),
          }) +
          contentRowHtml({
            width: "fill",
            kind: "compact",
            primary: { tag: "button", attributesHtml: 'type="button"' },
            label: { kind: "text", text: "Row with a leading control" },
            leadingActionsHtml: buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Star, label: "Favorite" } }),
          }) +
          "</div>",
      },
    ],
  },
  {
    id: "disclosure", title: "Disclosure",
    when: "Open and close related prose, forms, tool output or nested records in place. Either Content row presentation can be the summary.",
    contract: "Native details/summary. summary.kind is compact or multiline; summary.width defaults to fit and can be fill independently of body size. Disclosure supplies the leading chevron and owns one shared guttered body. Summary content is structured Content row content, not arbitrary HTML. bodyHtml is trusted server HTML. The body always has flush block edges (no top/bottom margin or padding), while preserving the inline gutter. open sets initial state. element supplies details id/attributes; summary.attributesHtml and bodyAttributesHtml supply integration hooks, never classes/styles. Lazy frames and independently subscribed Turbo regions remain feature-owned. For commentary outside a disclosure, disclosure-content is the same native CSS gutter anatomy. No separate sizing, body paint, or gutter variants.",
    imports: { disclosure: "disclosureHtml", button: "buttonHtml" },
    sources: ["disclosure/disclosure.css"],
    examples: [
      {
        title: "Compact summary · workspace handoff in a transcript",
        render: () => '<div class="markdown"><p>I’ve finished reviewing the workspace settings. Here’s the handoff for the next session.</p></div>' + disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Compaction summary" } }, bodyHtml: '<div class="markdown"><p>The workspace settings now separate repository access from commit identity. GitHub connects once for all workspaces; each workspace template chooses its own repository.</p><ul><li><strong>Done:</strong> moved the GitHub connection into app settings and updated the repository picker.</li><li><strong>Checked:</strong> existing templates still open with their saved repository and branch.</li><li><strong>Next:</strong> review the empty state when no repositories are available, then verify the layout on a narrow screen.</li></ul><p>Keep the current commit author name and email. No credentials or repository contents were changed.</p></div>', open: true }) + '<div class="markdown"><p>Next I’ll check the repository picker on mobile.</p></div>',
      },
      {
        title: "Multiline summary · wrapping provider description · account action",
        render: () => disclosureHtml({ summary: { kind: "multiline", width: "fill", label: { kind: "text", text: "OpenAI" }, description: "Connected with your subscription. Usage is shared across the models you use with this account.", trailingHtml: comparisonRingHtml({ caption: "5h", referencePercent: 60, valuePercent: 32, label: "5-hour limit: 60% of the period elapsed, 32% used" }) }, bodyHtml: '<div class="form-section"><p>5-hour limit: 32% used. Resets in 2h.</p><div>' + buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Account settings" } }) + '</div></div>', open: true }),
      },
      {
        title: "Compact collection · flush body edges",
        render: () => disclosureHtml({ summary: { kind: "compact", width: "fill", label: { kind: "text", text: "Subagents" } }, open: true, bodyHtml: disclosureHtml({ summary: { kind: "compact", width: "fill", label: { kind: "text", text: "/root/review" } }, bodyHtml: "Review transcript" }) + disclosureHtml({ summary: { kind: "compact", width: "fill", label: { kind: "text", text: "/root/research" } }, bodyHtml: "Research transcript" }) }),
      },
      {
        title: "Nested disclosures · shared gutter keeps the hierarchy visible",
        render: () => disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Worked for 1m23s" } }, bodyHtml: '<p>I checked the Models panel and the shared row styles.</p>' + disclosureHtml({ summary: { kind: "multiline", label: { kind: "text", text: "read · packages/design-system/src/content-row/content-row-html.ts" } }, bodyHtml: '<pre><code>contentRowHtml({ kind: "multiline", … })</code></pre>', open: true }), open: true }),
      },
    ],
  },
  {
    id: "add-badge", title: "Add badge", when: "Lead a row that creates something new, so it stands apart from rows for existing things.",
    contract: "Usually a content row's leadingHtml. Decorative: the row's label names the action. Grows slightly while its content row is hovered. --add-badge-size exposes its size for aligning it with neighbouring icons or text.",
    imports: { "add-badge": "addBadgeHtml", "content-row": "contentRowHtml", icons: "Icons" },
    sources: ["add-badge/add-badge.css"],
    examples: [{
      title: "Leading a create row",
      render: () => '<div class="action-list">'
        + contentRowHtml({ kind: "compact", element: { tag: "button", attributesHtml: 'type="button"' }, leadingHtml: addBadgeHtml(), label: { kind: "text", text: "New workspace" } })
        + contentRowHtml({ kind: "compact", element: { tag: "button", attributesHtml: 'type="button"' }, leadingHtml: Icons.Cloud, label: { kind: "text", text: "Existing workspace" } })
        + "</div>",
    }],
  },
  {
    id: "activity-button",
    compareButtonSizes: true,
    title: "Activity button",
    when: "A running operation that can still be stopped. For uninterruptible operations use Progress button.",
    contract:
      "Both captions participate in sizing. Active is busy but NOT disabled. Render state on the server or use activity-button/client for browser-owned operations.",
    imports: { "activity-button": "activityButtonHtml" },
    sources: ["activity-button/activity-button-client.ts"],
    examples: [
      {
        title: "Long caption · stable width across states",
        render: () => activityButtonHtml({
          variant: "secondary",
          state: "active",
          initialContent: { kind: "text", text: "Start preparing the development workspace" },
          activeContent: { kind: "text", text: "Stop preparing the development workspace" },
          actions: "catalogue#activity",
        }),
      },
      {
        title: "Grouped activity and progress perimeters",
        render: () =>
          buttonGroupHtml({
            semantics: "group",
            label: "Running actions",
            orientation: "horizontal",
            itemsHtml:
              activityButtonHtml({
                variant: "primary",
                iconOnly: true,
                state: "active",
                initialLabel: "Start agent",
                activeLabel: "Stop agent",
                initialContent: { kind: "html", html: Icons.Agent },
                activeContent: { kind: "html", html: Icons.Close },
                actions: "catalogue#activity",
              }) +
              progressButtonHtml({
                variant: "secondary",
                iconOnly: true,
                state: "in-progress",
                initialLabel: "Start processing",
                progressLabel: "Processing",
                initialContent: { kind: "html", html: Icons.Refresh },
                progressContent: { kind: "html", html: Icons.Refresh },
              }),
          }),
      },
      {
        title: "Initial and active",
        render: () =>
          activityButtonHtml({
            variant: "primary",
            state: "initial",
            initialContent: { kind: "text", text: "Start" },
            activeContent: { kind: "text", text: "Stop operation" },
            actions: "catalogue#activity",
          }) +
          activityButtonHtml({
            variant: "primary",
            state: "active",
            initialContent: { kind: "text", text: "Start" },
            activeContent: { kind: "text", text: "Stop operation" },
            actions: "catalogue#activity",
          }),
      },
    ],
  },
  {
    id: "progress-button",
    compareButtonSizes: true,
    title: "Progress button",
    when: "An operation whose action must not be invoked again while running.",
    contract:
      "In-progress always disables the control. Omit progress for indeterminate; otherwise use a finite number from 0 to 100. Server-render new states with Turbo.",
    imports: { "progress-button": "progressButtonHtml" },
    examples: [
      {
        title: "Icon-only · initial · indeterminate · 0% · 50% · 100%",
        render: () =>
          (["initial", undefined, 0, 50, 100] as const).map((progress) =>
            progressButtonHtml({
              variant: "primary",
              iconOnly: true,
              state: progress === "initial" ? "initial" : "in-progress",
              progress: progress === "initial" ? undefined : progress,
              initialLabel: "Install",
              progressLabel: progress === "initial" || progress === undefined ? "Installing" : `Installing ${progress}%`,
              initialContent: { kind: "html", html: Icons.ArrowDown },
              progressContent: { kind: "html", html: Icons.ArrowDown },
            }),
          ).join(""),
      },
      {
        title: "Long caption · stable width across states",
        render: () => progressButtonHtml({
          variant: "secondary",
          state: "in-progress",
          progress: 50,
          initialContent: { kind: "text", text: "Install all dependencies for this workspace" },
          progressContent: { kind: "text", text: "Installing all dependencies for this workspace…" },
        }),
      },
      {
        title: "Indeterminate · 0% · 50% · 100%",
        render: () =>
          [undefined, 0, 50, 100]
            .map((progress) =>
              progressButtonHtml({
                variant: "primary",
                state: "in-progress",
                progress,
                initialContent: { kind: "text", text: "Install" },
                progressContent: {
                  kind: "text",
                  text:
                    progress === undefined
                      ? "Installing…"
                      : `Installing ${progress}%`,
                },
              }),
            )
            .join(""),
      },
    ],
  },
  {
    id: "button-confirmation",
    compareButtonSizes: true,
    title: "Button confirmation",
    when: "A completed action acknowledged in place: Save, Add or Copy. Not a permission prompt; use Destructive confirmation for that.",
    contract: "Uses canonical Button content and variants. Initial content lifts/fades out, a centered success check pops in for 1200 ms, then content returns; both layers reserve a fixed hit target. Reduced motion swaps directly. Native disabled and busy state belong to the caller, never the confirmation timer. Render confirmed after a server-side success, or call showButtonConfirmation only after browser-side success. Repeated successes refresh the hold without flashing; resetButtonConfirmation clears stale feedback on new edits. confirmationLabel is the accessible acknowledgement; label optionally provides a more descriptive accessible name for captioned controls. Copy button uses this same module after a successful clipboard write.",
    imports: { "button-confirmation": "buttonConfirmationHtml", "button-confirmation/client": "showButtonConfirmation, resetButtonConfirmation", icons: "Icons" },
    sources: ["button-confirmation/button-confirmation-html.ts", "button-confirmation/button-confirmation-markup.ts", "button-confirmation/button-confirmation-controller.ts", "button-confirmation/button-confirmation.css"],
    examples: [
      { title: "Caption → centered check → caption", render: () => buttonConfirmationHtml({ type: "button", variant: "primary", content: { kind: "caption", caption: "Save changes" }, confirmationLabel: "Changes saved", attributesHtml: 'data-action="catalogue#confirmButton"' }) },
      { title: "Icon-only · keyboard and repeated confirmations", render: () => buttonConfirmationHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Copy, label: "Confirm example action" }, confirmationLabel: "Action completed", attributesHtml: 'data-action="catalogue#confirmButton"' }) },
      { title: "Long caption · wrapping without resizing", render: () => buttonConfirmationHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Save the complete workspace configuration", iconHtml: Icons.Cloud }, confirmationLabel: "Configuration saved", attributesHtml: 'data-action="catalogue#confirmButton"' }) },
    ],
  },
  {
    id: "copy-button",
    compareButtonSizes: true,
    title: "Copy button",
    when: "Copy a known value, with automatic transient success feedback.",
    contract:
      "Provide label and copyText; caption is optional. Clipboard needs a secure context and permission. Errors are not presented as success. Uses Button confirmation: the whole caption/icon is replaced by a centered check for 1200 ms without changing size. Repeated copies refresh confirmation. Try copying, then paste into Text entry.",
    imports: { "copy-button": "copyButtonHtml" },
    examples: [
      {
        title: "Long caption · initial and copied feedback",
        render: () => copyButtonHtml({
          label: "Copy workspace setup command",
          caption: "Copy the complete workspace setup command",
          copyText: "bun run web",
        }),
      },
      {
        title: "Icon-only and caption",
        render: () =>
          copyButtonHtml({
            label: "Copy example",
            copyText: "Copied from Kintsugi design system",
          }) +
          copyButtonHtml({
            label: "Copy command",
            caption: "Copy command",
            copyText: "bun run web",
          }),
      },
    ],
  },
  {
    id: "help-tip", title: "Help tip", when: "Explain a term or metric in a sentence. Works on touch screens, unlike title tooltips.",
    contract: "Place right after the text it explains. label names the question for screen readers; text is plain. Click or tap toggles; outside click or Escape closes.",
    imports: { "help-tip": "helpTipHtml" },
    sources: ["help-tip/help-tip-controller.ts", "help-tip/help-tip.css", "popup/popup-position.ts"],
    examples: [{ title: "Inline with a metric", render: () => `<span>Estimated time to hit limit: 2h 10m ${helpTipHtml({ label: "What is estimated time to hit limit?", text: "An estimate based on your average usage rate so far. It does not project beyond the next reset." })}</span>` }],
  },
  {
    id: "qr-code", title: "QR code", when: "Let people open a URL on their phone.",
    contract: "Point qrCodeButtonHtml at a qrCodeDialogHtml rendered outside any form. Opens natively via commandfor; no controller.",
    imports: { "qr-code": "qrCodeButtonHtml, qrCodeDialogHtml" },
    examples: [{ title: "Button and dialog", render: (suffix = "") => qrCodeButtonHtml(`catalogue_qr${suffix}`, "Show QR code") + qrCodeDialogHtml(`catalogue_qr${suffix}`, "https://example.com/preview") }],
  },
  {
    id: "destructive-confirmation",
    compareButtonSizes: true,
    title: "Destructive confirmation",
    when: "A two-step destructive form action with an in-place opt-out and an adjacent confirmation button. Use Dialog for explanations or additional input.",
    contract:
      "Place inside a form. The trigger becomes Cancel, keeping its original size as a minimum and growing for a longer caption. This growth may nudge neighbors; use short cancel captions. Only the confirm button stays out of layout. The bare confirm button prefers the nearest container that fits both controls, then the viewport. It follows scrolling/resizing and dismisses when the trigger leaves view. Its anchor-aware scale/fade entrance takes 250ms and stays inert; dismissal fades out in 150ms. Cancel reveals in place. All motion respects reduced motion. Focus stays on Cancel. Escape, outside click, or Cancel dismisses; confirm submits natively, with an optional action override. Demos intercept submission.",
    imports: { "destructive-confirmation": "destructiveConfirmationHtml" },
    sources: ["destructive-confirmation/destructive-confirmation-controller.ts", "destructive-confirmation/destructive-confirmation.css", "popup/popup-position.ts"],
    examples: [
      {
        title: "Animated confirmation · open, cancel or Escape, then repeat (safe demo)",
        render: (suffix = "") =>
          '<form data-action="submit->catalogue#submit">' +
          destructiveConfirmationHtml({
            id: `catalogue_confirm_record${suffix}`,
            trigger: {
              type: "button",
              variant: "danger",
              content: { kind: "caption", caption: "Delete record" },
            },
            confirmCaption: "Confirm deletion",
            cancelCaption: "Keep record",
          }) +
          '<output aria-live="polite"></output></form>',
      },
      {
        title: "Clipped toolbar · icon opt-out stays compact",
        render: (suffix = "") => '<form data-action="submit->catalogue#submit"><div style="display:flex; align-items:center; gap:8px; overflow:hidden; height:64px; border:1px solid var(--line)"><span>Workspace</span>' +
          destructiveConfirmationHtml({
            id: `catalogue_confirm_workspace${suffix}`,
            trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Delete workspace" } },
            confirmCaption: "Delete workspace permanently",
            cancelCaption: "Keep workspace",
          }) + '<span>Neighbor stays here</span></div><output aria-live="polite"></output></form>',
      },
      {
        title: "A longer opt-out can grow",
        render: (suffix = "") => '<form data-action="submit->catalogue#submit"><div style="display:flex; align-items:center; gap:8px">' +
          destructiveConfirmationHtml({
            id: `catalogue_confirm_long_caption${suffix}`,
            trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Delete" } },
            confirmCaption: "Confirm deletion",
            cancelCaption: "Keep record",
          }) + '<span>Neighbor may move slightly</span></div><output aria-live="polite"></output></form>',
      },
    ],
  },
  {
    id: "toggle",
    title: "Toggle",
    when: "Mutually exclusive values, all visible at once. For many options use a native select with popup enhancement.",
    contract:
      "Unique values; current value must exist. Element mode emits bubbling change with detail {name,value}. Form mode submits through Turbo. Labels are plain text; there are no per-option classes or HTML replacements. Arrow keys skip disabled options.",
    imports: { toggle: "toggleHtml" },
    sources: ["toggle/toggle-controller.ts"],
    examples: [
      {
        title: "Button · persistent hover · disabled option",
        render: () =>
          toggleHtml({
            variant: "button",
            label: "View",
            name: "view",
            value: "list",
            options: [
              { value: "list", label: "List" },
              { value: "grid", label: "Grid" },
              { value: "map", label: "Map", disabled: true },
            ],
          }),
      },
      {
        title: "Text",
        render: () =>
          toggleHtml({
            variant: "text",
            label: "View",
            name: "view",
            value: "list",
            options: [
              { value: "list", label: "List" },
              { value: "grid", label: "Grid" },
            ],
          }),
      },
      {
        title: "Subtle text",
        render: () =>
          toggleHtml({
            variant: "text-subtle",
            label: "View",
            name: "view",
            value: "list",
            options: [
              { value: "list", label: "List" },
              { value: "grid", label: "Grid" },
            ],
          }),
      },
    ],
  },
  {
    id: "popup",
    compareButtonSizes: true,
    title: "Popup",
    when: "Compact choices anchored to a disclosure. Prefer popupHtml: one call owns trigger, anchor, ARIA and native popover behavior.",
    contract:
      "Unique id per instance. Items need menuitem or menuitemradio roles and native actions. Escape closes; arrows move through enabled items. Placement flips at viewport edges. Use width: \"content\" for wider comparisons; content remains bounded by the viewport. Trigger captions stay on one line and truncate in constrained containers; menus expose the full choices. The package owns trigger linkage and positioning; trigger.attributesHtml and menuAttributesHtml connect application behavior without supplying class or style. Try the REAL viewport corners in the edge laboratory.",
    imports: { popup: "popupHtml", "content-row": "contentRowHtml" },
    examples: [
      {
        title: "Content-width comparison · viewport bounded",
        render: (idSuffix = "") => popupHtml({
          id: `catalogue-popup-content${idSuffix}`, label: "Agent comparison", width: "content",
          trigger: { variant: "secondary", content: { kind: "caption", caption: "Compare agents" } },
          contentHtml: contentRowHtml({ kind: "multiline", width: "fill", label: { kind: "text", text: "Builtin" },
            trailingHtml: '<span style="width: 420px; max-width: 60vw; white-space: normal">Pi Durable + rich inline rendering · All models</span>',
            element: { tag: "button", attributesHtml: 'type="button" role="menuitem"' },
          }),
        }),
      },
      {
        title: "Constrained trigger · single-line caption",
        render: (idSuffix = "") => `<div style="width: 180px; max-width: 100%">${popupHtml({
          id: `catalogue-popup-constrained${idSuffix}`,
          label: "Model",
          trigger: { variant: "secondary", content: { kind: "caption", caption: "An unusually long model name" } },
          contentHtml: contentRowHtml({ kind: "compact", width: "fill", label: { kind: "text", text: "An unusually long model name" }, element: { tag: "button", attributesHtml: 'type="button" role="menuitemradio" aria-checked="true"' } }),
        })}</div>`,
      },
      {
        title: "Anchored menu · disabled · long option",
        render: (idSuffix = "") =>
          popupHtml({
            id: `catalogue-popup${idSuffix}`,
            label: "Example actions",
            trigger: {
              variant: "secondary",
              content: { kind: "caption", caption: "Open menu" },
            },
            contentHtml: [
              "Open record",
              "An unusually long translated menu item caption",
              "Unavailable",
            ]
              .map((text, index) =>
                contentRowHtml({
                  width: "fill",
                  kind: "compact",
                  label: { kind: "text", text },
                  element: {
                    tag: "button",
                    attributesHtml: `type="button" role="menuitem"${index === 2 ? " disabled" : ""}`,
                  },
                }),
              )
              .join(""),
          }),
      },
    ],
  },
  {
    id: "popup-select",
    compareButtonSizes: true,
    title: "Popup select",
    when: "A native form select enhanced into a consistent popover. Prefer Toggle for a few short options.",
    contract:
      "Native interface: select.popup-select with data-controller=popup-select, an accessible label, named options, selected and disabled. Wrap each select in its own span. data-popup-placement=above is optional. Native change and form value remain authoritative; never manipulate generated menu DOM.",
    sources: ["popup/popup-controller.ts", "popup/popup-position.ts"],
    examples: [
      {
        title: "Select with disabled option",
        render: () =>
          '<span><select class="popup-select" data-controller="popup-select" name="environment" aria-label="Environment"><option>Development</option><option>Staging</option><option disabled>Production (restricted)</option></select></span>',
      },
      {
        title: "Long choices · native form reset · disabled select",
        render: () =>
          '<form class="form-stack" data-action="submit->catalogue#submit"><span><select class="popup-select" data-controller="popup-select" name="region" aria-label="Region"><option value="local">Local development</option><option value="remote">A remote development environment with a deliberately long regional name</option></select></span><span><select class="popup-select" data-controller="popup-select" aria-label="Unavailable environment" disabled><option>Unavailable environment</option></select></span>' +
          buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml:
            buttonHtml({ type: "reset", variant: "secondary", content: { kind: "caption", caption: "Reset selection" } }) +
            buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Submit selection" } })
          }) + '<output aria-live="polite"></output></form>',
      },
    ],
  },
  {
    id: "dialog",
    title: "Dialog",
    when: "A focused task temporarily blocking page interaction. Not for small menus or ordinary navigation.",
    contract:
      "Native dialog plus Panel. Open with showModal() in Stimulus or data-dialog-auto-show on server insertion. Escape and close dismiss; focus returns to opener. Provide titleCaption for the accessible name; titleParts can compose escaped before/after text around a trusted inline control. The header and title always use regular body-text typography, owned by Dialog rather than callers. Full-bleed is for regions owning layout, not a size variant.",
    imports: { dialog: "dialogHtml", button: "buttonHtml", icons: "Icons" },
    examples: [
      {
        title: "Modal · long body · nested popup",
        render: () =>
          buttonHtml({
            type: "button",
            variant: "secondary",
            content: { kind: "caption", caption: "Open dialog" },
            attributesHtml: 'data-action="catalogue#openDialog" data-catalogue-dialog-param="catalogue-dialog"',
          }) +
          dialogHtml({
            element: { id: "catalogue-dialog" },
            iconHtml: Icons.Plus,
            titleCaption: "A focused task",
            titleParts: {
              before: "Edit record in",
              controlHtml: '<select class="popup-select" data-controller="popup-select" aria-label="Record environment"><option>Development</option><option>Staging</option></select>',
              after: ", then save.",
            },
            bodyHtml:
              '<label>Record name<input class="text-field" autofocus placeholder="Enter a name"></label><p>Resize, tab through controls, and press Escape.</p><span><select class="popup-select" data-controller="popup-select" aria-label="Dialog environment"><option>Development</option><option>Staging</option></select></span>' +
              "<p>Long content inside the modal.</p>".repeat(15),
          }),
      },
    ],
  },
  {
    id: "panel",
    title: "Panel",
    when: "A bounded surface with a continuous outline, soft upper-left rim reflection and faint localized background light, fixed chrome and flexible body. Dialog composes this; workspace panes use it directly.",
    contract:
      "Supply semantic element tag, trusted header/body and optional footer. Use an outer layout container for dimensions. bodyLayout: padded/full-bleed and bodyOverflow: scroll/contained are the supported body behaviors. No root or body classes. panel__title uses normal body text and accepts a leading icon; strong.panel__title adds emphasis for the Kintsugi identity.",
    imports: { panel: "panelHtml", icons: "Icons" },
    examples: [
      {
        title: "Header · body · footer",
        render: () =>
          panelHtml({
            element: { tag: "section" },
            headerHtml: `<h3 class="panel__title">${Icons.WorkspaceTemplates}Templates</h3>`,
            bodyHtml: "<p>A flexible content region.</p>",
            bodyLayout: "padded",
            footerHtml: "Optional footer",
          }),
      },
    ],
  },
  {
    id: "autocomplete",
    title: "Autocomplete",
    when: "Server-rendered search suggestions or search status. Not a floating action menu.",
    contract:
      "Results provide listbox semantics; caller supplies options, combobox linkage and keyboard selection. Return HTML in a Turbo Frame. Message is a separate variant, optionally role status. No search protocol is hidden here.",
    imports: {
      autocomplete: "autocompleteHtml",
      "content-row": "contentRowHtml",
    },
    examples: [
      {
        title: "Results · empty · loading",
        render: () =>
          autocompleteHtml({
            kind: "results",
            label: "Repositories",
            contentHtml: contentRowHtml({
              kind: "compact",
              label: { kind: "text", text: "kintsugi/design-system" },
              element: {
                tag: "div",
                attributesHtml: 'role="option" aria-selected="false"',
              },
              primary: false,
            }),
          }) +
          autocompleteHtml({
            kind: "message",
            role: "status",
            content: { kind: "text", text: "No matching repositories" },
          }) +
          autocompleteHtml({
            kind: "message",
            role: "status",
            content: { kind: "text", text: "Searching…" },
          }),
      },
    ],
  },
  {
    id: "transient-feedback",
    compareButtonSizes: true,
    title: "Transient feedback",
    when: "Brief acknowledgement of a completed action. Prefer Copy button for clipboard actions.",
    contract:
      "Only current content affects layout. Feedback resets automatically. Use transient-feedback/client helpers for browser operations; server renders initial or feedback. Buttons disable during feedback unless explicitly kept enabled; acknowledgement remains full contrast while disabled. Prefer Button confirmation for completed button actions.",
    imports: { "transient-feedback": "transientFeedbackHtml" },
    sources: ["transient-feedback/transient-feedback-html.ts", "transient-feedback/transient-feedback-controller.ts", "transient-feedback/transient-feedback.css"],
    examples: [
      {
        title: "Activate feedback",
        render: () =>
          transientFeedbackHtml({
            element: {
              tag: "button",

              attributesHtml: 'type="button" data-action="catalogue#feedback"',
            },
            state: "initial",
            initialContent: { kind: "text", text: "Acknowledge" },
            feedbackContent: { kind: "text", text: "Done!" },
          }),
      },
    ],
  },
  {
    id: "text-entry",
    title: "Text entry",
    when: "Native single-line input or multiline textarea. CSS-first: preserve native form semantics without pass-through renderers.",
    contract:
      "input.text-field or textarea.textarea with associated label. Caller owns native type, name, value, required, disabled and validation. Explain errors with aria-describedby and aria-invalid. Do not fork height, border, radius or background per feature.",
    sources: ["text-entry/text-entry.css"],
    examples: [
      {
        title: "Normal · invalid · disabled · multiline",
        render: () =>
          '<div class="form-stack"><label>Name<input class="text-field" placeholder="Paste copied text"></label><label>Invalid value<input class="text-field" value="Not valid" aria-invalid="true" aria-describedby="catalogue-input-error"></label><span id="catalogue-input-error">Explain how to correct the value.</span><label>Unavailable<input class="text-field" value="Unavailable operation" disabled></label><label>Notes<textarea class="textarea" placeholder="Long multiline content"></textarea></label></div>',
      },
    ],
  },
  {
    id: "managed-list",
    title: "Managed list",
    when: "Non-selectable records with metadata and actions. Use Content row when the row itself is actionable.",
    contract:
      "CSS anatomy: managed-list (with data-controller=managed-list), __filter, __items, __item, __content, __label / __label-text, __description, __meta, __actions, __empty. Local filter uses data-search-text or row text. Server search sets data-managed-list-server-filter=true and uses Turbo. __label-text truncates.",
    sources: [
      "managed-list/managed-list-controller.ts",
      "managed-list/managed-list.css",
    ],
    examples: [
      {
        title: "Filter · long label · empty result",
        render: () =>
          '<div class="managed-list" data-controller="managed-list"><div class="managed-list__filter"><input class="text-field" type="search" aria-label="Filter records" placeholder="Filter records…"></div><div class="managed-list__items"><div class="managed-list__item"><div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">A deliberately long record label for checking narrow layouts</span></div><div class="managed-list__description">Development environment</div></div><span class="managed-list__meta">Ready</span></div><div class="managed-list__item"><div class="managed-list__content">Staging</div></div></div><div class="managed-list__empty" hidden>No matching records</div></div>',
      },
    ],
  },
  {
    id: "status",
    title: "Status & progress lists",
    when: "Compact status markers and multi-step summaries. Pair color with visible text.",
    contract:
      "status-dot with success, warning, danger or running; add static to running for a non-animated snapshot marker. Decorative dots use aria-hidden. status-list has __item and __marker; use status-list--compact for dense progress histories. aria-busy for running, data-status=failed for failure, aria-checked=true only with checkbox role. Use Icons.Check, Icons.Close and Icons.Exclamation inside markers, not text glyphs. Reduced motion disables spinning.",
    sources: ["status/status.css"],
    examples: [
      {
        title: "Success · warning · danger · running · snapshot",
        render: () =>
          '<div class="form-section">' +
          ["success", "warning", "danger", "running"]
            .map(
              (state) =>
                `<span><span class="status-dot ${state}" aria-hidden="true"></span> ${state}</span>`,
            )
            .join("") +
          '<span><span class="status-dot running static" aria-hidden="true"></span> In progress at snapshot</span>' +
          `<ul class="status-list"><li class="status-list__item" role="checkbox" aria-checked="true"><span class="status-list__marker">${Icons.Check}</span>Complete</li><li class="status-list__item" aria-busy="true"><span class="status-list__marker"></span>Running</li><li class="status-list__item" data-status="failed"><span class="status-list__marker">${Icons.Close}</span>Failed</li></ul></div>`,
      },
    ],
  },
  {
    id: "icons",
    title: "Icons",
    when: "Shared decorative vocabulary. Use icon-only Button for standalone icon actions.",
    contract:
      "Icons exports trusted decorative SVG strings. WorkspaceTemplates uses a repository/book outline; Files uses a folder; Server uses a single rack for host diagnostics and administration. kintsugiBrandIconHtml is the compact raster product mark for app branding. builtinAgentIconHtml reuses the monochrome Agent SVG for Builtin agent tabs and launchers. Put the accessible name on the containing control. Never use an unlabeled icon as an action.",
    imports: { icons: "Icons" },
    examples: [
      {
        title: "Product brand mark",
        render: () => `<span class="catalogue-icon">${kintsugiBrandIconHtml}<span>Kintsugi</span></span>`,
      },
      {
        title: "Builtin agent mark",
        render: () => `<span class="catalogue-icon">${builtinAgentIconHtml}<span>Builtin</span></span>`,
      },
      {
        title: "Icon vocabulary",
        render: () =>
          Object.entries(Icons)
            .map(
              ([name, svg]) =>
                `<span class="catalogue-icon">${svg}<span>${name}</span></span>`,
            )
            .join(""),
      },
    ],
  },
  {
    id: "linear-navigation",
    title: "Linear navigation",
    when: "Keyboard behavior for a vertical sequence whose semantics and content are caller-owned.",
    contract:
      "data-controller=linear-navigation on the sequence; data-linear-navigation-target=item on focusable children. Up/Down move without wrapping; hidden, disabled and aria-disabled items are skipped. This does not implement selection or a tree protocol.",
    sources: ["linear-navigation/linear-navigation-controller.ts"],
    imports: { "content-row": "contentRowHtml" },
    examples: [
      {
        title: "Focus, then Up / Down",
        render: () =>
          '<div class="action-list" data-controller="linear-navigation">' +
          ["First", "Second", "Last"]
            .map((text) =>
              contentRowHtml({
                kind: "compact",
                element: {
                  tag: "button",
                  attributesHtml:
                    'type="button" data-linear-navigation-target="item"',
                },
                label: { kind: "text", text },
              }),
            )
            .join("") +
          "</div>",
      },
    ],
  },
];
