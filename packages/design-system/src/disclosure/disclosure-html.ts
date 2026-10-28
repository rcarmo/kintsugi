import { escapeHtml } from "@kintsugi/shared";
import type { ContentRowContent } from "../content-row/content-row-html.ts";
import { contentRowClasses, contentRowContentHtml } from "../content-row/content-row-markup.ts";
import { attributesHtml } from "../html.ts";
import { Icons } from "../icons/icons-html.ts";

export type DisclosureSummary = ContentRowContent & {
  /** Integration attributes on the native summary, such as focus/navigation targets. */
  attributesHtml?: string;
};

export interface DisclosureOptions {
  element?: { id?: string; attributesHtml?: string };
  summary: DisclosureSummary;
  /** Trusted server-rendered contents. Disclosure owns their gutter and spacing. */
  bodyHtml: string;
  /** Integration attributes on the guttered region, e.g. a stable Turbo target. */
  bodyAttributesHtml?: string;
  open?: boolean;
}

/** Native disclosure composed with either Content row presentation and one shared gutter. */
export function disclosureHtml(options: DisclosureOptions): string {
  return `${disclosureOpeningHtml(options)}${options.bodyHtml}${disclosureClosingHtml}`;
}

/** Everything before a disclosure's contents, for callers that render the contents separately. */
export function disclosureOpeningHtml(options: Omit<DisclosureOptions, "bodyHtml">): string {
  const id = options.element?.id === undefined ? "" : ` id="${escapeHtml(options.element.id)}"`;
  const content: ContentRowContent = { ...options.summary, leadingHtml: `${Icons.Disclosure}${options.summary.leadingHtml ?? ""}` };
  const summary = `<summary class="${contentRowClasses(content, true, true)}"${attributesHtml(options.summary.attributesHtml)}>${contentRowContentHtml(content)}</summary>`;
  return `<details${id} class="disclosure"${options.open ? " open" : ""}${attributesHtml(options.element?.attributesHtml)}>${summary}<div class="disclosure-content"${attributesHtml(options.bodyAttributesHtml)}>`;
}

/** Everything after the contents opened by `disclosureOpeningHtml`. */
export const disclosureClosingHtml = "</div></details>";

/** Disclosure anatomy around authored `<details>`, whose summary label is already HTML. */
export interface AuthoredDisclosureParts {
  detailsClass: string;
  summaryClass: string;
  /** Inserted at the start and end of the authored summary's contents. */
  labelOpeningHtml: string;
  labelClosingHtml: string;
  /** Inserted after the summary and before `</details>`, around the remaining contents. */
  contentOpeningHtml: string;
  contentClosingHtml: string;
}

const labelSlot = "\uE000";

/** The muted single-line disclosure Markdown uses, split where an authored summary label and contents go. */
export function authoredDisclosureParts(): AuthoredDisclosureParts {
  const content: ContentRowContent = { kind: "compact", tone: "muted", label: { kind: "text", text: labelSlot }, leadingHtml: Icons.Disclosure };
  const summaryHtml = contentRowContentHtml(content);
  const label = summaryHtml.indexOf(labelSlot);
  return {
    detailsClass: "disclosure",
    summaryClass: contentRowClasses(content, true, true),
    labelOpeningHtml: summaryHtml.slice(0, label),
    labelClosingHtml: summaryHtml.slice(label + labelSlot.length),
    contentOpeningHtml: '<div class="disclosure-content">',
    contentClosingHtml: "</div>",
  };
}
