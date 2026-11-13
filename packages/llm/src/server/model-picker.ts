import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { buttonHtml } from "@kintsugi/design-system/button";
import { popupHtml } from "@kintsugi/design-system/popup";
import { escapeHtml, providerBrandIconHtml } from "@kintsugi/shared";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createPiModelRuntime } from "./pi-config-models.ts";
import { parseModelRef } from "./model-reference.ts";
import type { ModelRef } from "./model-reference.ts";

export interface ComposerModelOption {
  provider: string;
  id: string;
  name: string;
  selected: boolean;
  available?: boolean;
  unavailableReason?: string;
}

interface SharedComposerSelectionsOptions {
  readOnly?: boolean;
  modelFormId: string;
  thinkingLevelFormId: string;
  models: ComposerModelOption[];
  thinkingLevels: string[];
  selectedThinkingLevel: string;
  autosubmitThinking?: boolean;
  connectedProvider?: boolean;
  /** Keep client-enhanced controls until their server-rendered settings change. */
  preserveControls?: boolean;
}

function renderModelSelection(formId: string, models: ComposerModelOption[], connectedProvider = false, readOnly = false): string {
  const selected = models.find((model) => model.selected) ?? models[0];
  if (readOnly) return buttonHtml({ type: "button", variant: "secondary", disabled: true,
    content: { kind: "caption", caption: selected?.name ?? "Model", iconHtml: selected ? providerBrandIconHtml(selected.provider) : undefined } });
  const hasAvailableModel = models.some((model) => model.available !== false);
  const menuId = `${formId}_popup`;
  const setupAction = 'data-controller="agent-model-setup" data-action="click->agent-model-setup#open"';
  const configure = contentRowHtml({ width: "fill", kind: "compact", label: { kind: "text", text: "Manage models…" }, element: { tag: "button", attributesHtml: `type="button" role="menuitem" ${setupAction}` } });
  const modelItems = models.map((model) => {
    return contentRowHtml({
      width: "fill",
      kind: "compact",
      label: { kind: "text", text: model.name },
      leadingHtml: providerBrandIconHtml(model.provider),
      element: { tag: "button", attributesHtml: `type="submit" name="model" value="${escapeHtml(`${model.provider}::${model.id}`)}" form="${escapeHtml(formId)}" role="menuitemradio" aria-checked="${model.selected}"${model.available === false ? " disabled" : ""}` },
    });
  }).join("");
  if (!hasAvailableModel) return buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: connectedProvider ? "Choose models" : "Connect a model" }, attributesHtml: setupAction });
  return popupHtml({ id: menuId, label: "Model", placement: "above",
    trigger: { variant: "secondary", content: { kind: "caption", caption: selected?.name ?? "Model", iconHtml: selected ? providerBrandIconHtml(selected.provider) : undefined } },
    contentHtml: `${configure}<hr class="popup-menu__separator">${modelItems}`,
  });
}

export function renderSharedComposerSelections(options: SharedComposerSelectionsOptions): string {
  const autosubmit = options.autosubmitThinking && !options.readOnly
    ? ` data-controller="composer-selection-autosubmit" data-composer-selection-autosubmit-form-id-value="${escapeHtml(options.thinkingLevelFormId)}" data-action="change->composer-selection-autosubmit#submit"`
    : "";
  const thinkingSelection = options.readOnly
    ? (options.selectedThinkingLevel ? buttonHtml({ type: "button", variant: "secondary", disabled: true,
      content: { kind: "caption", caption: options.selectedThinkingLevel } }) : "")
    : options.thinkingLevels.length > 0
    ? `<span class="composer-selection-field"${autosubmit}><select class="composer-selection popup-select" data-controller="popup-select" data-popup-placement="above" name="thinkingLevel" form="${escapeHtml(options.thinkingLevelFormId)}" title="Thinking level">${options.thinkingLevels.map((level) => `<option value="${escapeHtml(level)}"${level === options.selectedThinkingLevel ? " selected" : ""}>${escapeHtml(level)}</option>`).join("")}</select></span>`
    : "";
  const ready = options.models.some((model) => model.selected && model.available !== false);
  const content = `${renderModelSelection(options.modelFormId, options.models, options.connectedProvider, options.readOnly)}
${ready ? thinkingSelection : ""}`;
  // Popup selects add their own button and menu. Morphing those enhancements
  // away would leave a retained select without its controls. A content-keyed
  // island keeps them for usage updates, but replaces them for new settings.
  const island = options.preserveControls
    ? ` id="${escapeHtml(`${options.modelFormId}_controls_${Bun.hash(`${ready}:${content}`).toString(36)}`)}" data-turbo-permanent`
    : "";
  return `<span class="composer-selections" data-model-ready="${ready}"${island}>
${content}
</span>`;
}

export function renderLaunchModelSettings(options: {
  frameId: string; formId: string; url: string; agentTypeId: string; selectedValue: string;
  models: ComposerModelOption[]; thinkingLevels: string[]; selectedThinkingLevel: string; connectedProvider: boolean;
}): string {
  const modelFormId = `${options.frameId}_model_form`;
  return `<turbo-frame id="${escapeHtml(options.frameId)}" class="launch-model-settings" data-agent-type="${escapeHtml(options.agentTypeId)}">
<form id="${escapeHtml(modelFormId)}" method="get" action="${escapeHtml(options.url)}" data-turbo-frame="${escapeHtml(options.frameId)}" hidden></form>
<input type="hidden" name="agentTypeId" value="${escapeHtml(options.agentTypeId)}" form="${escapeHtml(modelFormId)}">
<input type="hidden" name="model" value="${escapeHtml(options.selectedValue)}" form="${escapeHtml(options.formId)}">
${renderSharedComposerSelections({ ...options, modelFormId, thinkingLevelFormId: options.formId })}</turbo-frame>`;
}

export async function modelThinkingLevels(ref: ModelRef) {
  const model = (await createPiModelRuntime()).getModel(ref.provider, ref.id);
  return model ? getSupportedThinkingLevels(model) : [];
}

/** Render the actual launch values, independent of enabled models and remembered preferences. */
export async function renderReadOnlyLaunchModelSettings(modelValue: string | undefined, thinkingLevel: string | undefined): Promise<string> {
  const ref = modelValue ? parseModelRef(modelValue) : undefined;
  const model = ref ? (await createPiModelRuntime()).getModel(ref.provider, ref.id) : undefined;
  return renderSharedComposerSelections({
    readOnly: true, modelFormId: "", thinkingLevelFormId: "",
    models: ref ? [{ ...ref, name: model?.name ?? ref.id, selected: true }] : [],
    thinkingLevels: thinkingLevel ? [thinkingLevel] : [], selectedThinkingLevel: thinkingLevel ?? "",
  });
}
