import { popupHtml } from "@kintsugi/design-system/popup";
import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { Icons } from "@kintsugi/design-system/icons";
export function renderLayoutPicker(): string {
  const choices = [["auto", "Auto", "Follow window width"], ["desktop", "Desktop", "Show panes side by side"], ["compact", "Compact", "Show one pane at a time"]] as const;
  return `<span data-controller="layout-picker">${popupHtml({
    id: "shell_layout_picker", label: "Layout",
    trigger: { variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Desktop, label: "Layout: Auto" }, attributesHtml: 'data-layout-picker-target="trigger"' },
    contentHtml: choices.map(([value, label, description]) => contentRowHtml({kind: "multiline", width: "fill", label: {kind: "text", text: label}, description, element: {tag: "button", attributesHtml: `type="button" role="menuitemradio" aria-checked="${value === "auto"}" value="${value}" data-layout-picker-target="option" data-action="click->layout-picker#choose"`}})).join(""),
  })}</span>`;
}
