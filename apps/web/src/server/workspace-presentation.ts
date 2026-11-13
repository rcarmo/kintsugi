import { workspaceTemplateChoiceHtml, workspaceTemplateIconHtml } from "./workspace-template-presentation.ts";
import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { addBadgeHtml } from "@kintsugi/design-system/add-badge";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { buttonHtml, type ButtonVariant } from "@kintsugi/design-system/button";
import { buttonGroupHtml } from "@kintsugi/design-system/button-group";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { Icons } from "@kintsugi/design-system/icons";
import { panelHtml } from "@kintsugi/design-system/panel";
import { popupHtml } from "@kintsugi/design-system/popup";
import { tabHtml, tabStripHtml } from "@kintsugi/design-system/tab-strip";
import { domId, escapeHtml, turboStream, workspaceWorkViewLabelDomId } from "@kintsugi/shared";
import { formatShortcutBinding } from "../shortcut-binding.ts";
import { agentPaneSlotDomId, renderAgentPane, renderMobileAgentAttention, type AgentPaneContribution } from "./agent-pane.ts";
import { renderLayoutPicker } from "./layout-picker.ts";
import type { WorkspaceDeletionState } from "./workspace-registry.ts";
import { outdatedImageMessage } from "./workspace-warnings.ts";
import type { WorkspaceWorkViewState } from "@kintsugi/workspace";
import { barButton, behaviorTurboStream, busyAttentionIndicator, fullscreenViewAttributes, LiveIslands, paneContentHtml, selectorCloseForm, type ViewCloseAction } from "./workspace-view-markup.ts";

export type WorkViewAvailability =
  | { phase: "opening"; detail?: string }
  | { phase: "live" }
  | { phase: "reconnecting"; detail?: string }
  | { phase: "unavailable"; detail: string };

export interface WorkspacePaneEntry {
  id: string;
  title: string;
  active?: boolean;
  parked: boolean;
  workspaceTemplate?: { id: string; title: string };
  busy?: boolean;
  requestingAttention?: boolean;
  attentionAt?: number;
  lastActivityAt?: number;
  busyAgentKeys?: readonly string[];
  outdated?: boolean;
  warnings?: readonly { message: string }[];
}

export interface WorkspacePaneWorkspaceTemplate {
  id: string;
  title: string;
  swatchColor?: string;
  lastUsedAt?: number;
}

export interface WorkPaneContribution {
  iconHtml?: string;
  /** Stable, type-native serialized identity supplied by the resource adapter. */
  key: string;
  label: string;
  kind: "resource" | "contextual";
  requestingAttention?: boolean;
  attentionSequence?: number;
  availability: WorkViewAvailability;
  sourceKey?: string;
  actionsHtml?: string;
  close?: ViewCloseAction;
}

export interface WorkspacePanePresentation {
  workspaceTemplates: readonly WorkspacePaneWorkspaceTemplate[];
  /** Already ordered by the workspace registry. */
  workspaces: readonly WorkspacePaneEntry[];
}

export interface WorkspacePresentation {
  workspace: Pick<WorkspacePaneEntry, "id" | "title">;
  agents: readonly AgentPaneContribution[];
  agentTypes: readonly { id: string; label: string; iconHtml: string }[];
  workViews: readonly WorkPaneContribution[];
  commands?: readonly { id: string; label: string; description?: string; scope: string; iconHtml?: string; placement?: "work-launcher" | "agent-action"; binding?: string; shortcutCommandId?: string }[];
  overlayHtml?: readonly string[];
  warningsHtml?: string;
  workPresentationIntent?: { key: string; revision: string };
}

function closeForm(close: ViewCloseAction, buttonHtml: string): string {
  return `<form data-turbo="true" method="post" action="${escapeHtml(close.action)}" data-close-label="${escapeHtml(close.label)}" data-action="submit->workspace-presentation#confirmClose">${buttonHtml}</form>`;
}

function workspaceStatusSlot(content: string): string {
  return `<span class="fixed-shell-workspace-status content-row__status">${content}</span>`;
}

function renderWorkspaceRowStatus(workspace: WorkspacePaneEntry): string {
  if (workspace.busy || workspace.requestingAttention) {
    return workspaceStatusSlot(busyAttentionIndicator(workspace));
  }
  const warnings = (workspace.warnings ?? []).map((warning) => warning.message);
  if (workspace.outdated) warnings.push(outdatedImageMessage);
  return warnings.length
    ? workspaceStatusSlot(`<i class="fixed-shell-workspace-warning" aria-label="${escapeHtml(warnings.join("\n"))}" title="${escapeHtml(warnings.join("\n"))}">⚠︎</i>`)
    : "";
}

function renderWorkspaceRow(workspace: WorkspacePaneEntry, index: number): string {
  const { parked, workspaceTemplate } = workspace;
  const id = workspaceRowDomId(workspace.id);
  const attentionAt = workspace.attentionAt === undefined ? "" : ` data-workspace-attention-at="${workspace.attentionAt}"`;
  const lastActivityAt = workspace.lastActivityAt === undefined ? "" : ` data-workspace-last-activity-at="${workspace.lastActivityAt}"`;
  const workspaceTemplateAttribute = workspaceTemplate ? ` data-workspace-template-id="${escapeHtml(workspaceTemplate.id)}"` : "";
  const busyAgents = workspace.busyAgentKeys?.length ? ` data-workspace-busy-agents="${escapeHtml(JSON.stringify(workspace.busyAgentKeys))}"` : "";
  const label = parked ? `Unpark and open ${workspace.title}` : workspace.title;
  const tooltip = [workspaceTemplate?.title, label].filter(Boolean).join(" · ");
  const newFromTemplate = workspaceTemplate ? `New workspace from ${workspaceTemplate.title}` : "New empty workspace";
  const row = contentRowHtml({
    width: "fill",
    kind: "compact",
    container: parked ? undefined : { attributesHtml: `data-workspace-order="${index}"` },
    label: { kind: "text", text: workspace.title },
    trailingHtml: renderWorkspaceRowStatus(workspace),
    engagedActionsHtml: actionLinkHtml({ href: `/workspaces/${encodeURIComponent(workspace.id)}/properties`, variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Settings, label: `Workspace properties for ${workspace.title}` }, attributesHtml: 'data-turbo-stream="true" data-turbo-frame="_top"' }),
    leadingActionsHtml: `<button type="button" class="workspace-template-icon-button" title="${escapeHtml(newFromTemplate)}" aria-label="${escapeHtml(newFromTemplate)}" data-action="workspace-pane#openPickerFor" data-workspace-pane-workspace-template-param="${escapeHtml(workspaceTemplate?.id ?? "")}">${workspaceTemplateIconHtml(workspaceTemplate)}</button>`,
    primary: {
      tag: "button",
      attributesHtml: `${parked ? 'data-workspace-parked' : `id="${id}"`} type="${parked ? "submit" : "button"}" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(label)}"${workspace.active ? ' aria-current="page"' : ""} data-workspace-entry-id="${escapeHtml(workspace.id)}" data-workspace-title="${escapeHtml(workspace.title)}"${attentionAt}${lastActivityAt}${busyAgents}${workspaceTemplateAttribute}${parked ? "" : ' data-action="click->workspace-navigation#selectWorkspace"'}`,
    },
  });
  return parked
    ? `<form id="${id}" method="post" action="/workspaces/${encodeURIComponent(workspace.id)}/unpark" data-action="submit->workspace-navigation#unparkWorkspace">${row}</form>`
    : row;
}

const workspaceTemplateDialogTarget = 'data-turbo-frame="_top" data-turbo-stream="true"';

function workspaceRowDomId(id: string): string { return domId("workspace_row", id); }

function renderWorkspaceRows(presentation: WorkspacePanePresentation): string {
  const active = presentation.workspaces.filter((workspace) => !workspace.parked);
  const parked = presentation.workspaces.filter((workspace) => workspace.parked);
  const parkedGroup = parked.length ? disclosureHtml({
    element: { id: "workspace_pane_parked" },
    summary: { kind: "compact", width: "fill", attributesHtml: "data-workspace-parked", label: { kind: "text", text: "Parked" } },
    bodyHtml: parked.map(renderWorkspaceRow).join(""),
  }) : "";
  return `${active.map(renderWorkspaceRow).join("")}${parkedGroup}`;
}

function renderNewWorkspaceRow(presentation: WorkspacePanePresentation): string {
  const guide = presentation.workspaces.length ? "" : ' data-first-workspace-destination="new-workspace"';
  return contentRowHtml({
    width: "fill",
    kind: "compact",
    leadingHtml: `<span class="workspace-pane-new-workspace-icon">${addBadgeHtml()}</span>`,
    label: { kind: "text", text: "New workspace" },
    element: { tag: "button", attributesHtml: `type="button" data-workspace-pane-target="newWorkspace" data-action="workspace-pane#openPicker"${guide}` },
  });
}

function renderWorkspaceTemplateOption(workspaceTemplate?: WorkspacePaneWorkspaceTemplate): string {
  return workspaceTemplateChoiceHtml(workspaceTemplate, {
    emptyLabel: "Nothing",
    primaryAttributesHtml: `type="submit" role="radio" aria-checked="false" tabindex="-1" data-workspace-pane-target="option" data-workspace-template-id="${escapeHtml(workspaceTemplate?.id ?? "")}" data-action="workspace-pane#choose keydown->workspace-pane#optionKeydown"`,
  });
}

function renderWorkspaceTemplateOptions(presentation: WorkspacePanePresentation): string {
  const ordered = [...presentation.workspaceTemplates].sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) || left.title.localeCompare(right.title));
  // Until the first template exists, the add action explains what a template is.
  const addWorkspaceTemplate = ordered.length
    ? contentRowHtml({
      width: "fill",
      kind: "compact",
      leadingHtml: addBadgeHtml(),
      label: { kind: "text", text: "A repo I haven’t added yet…" },
      element: { tag: "a", attributesHtml: `href="/workspace-templates/new" ${workspaceTemplateDialogTarget}` },
    })
    : `<a class="workspace-template-first" href="/workspace-templates/new" ${workspaceTemplateDialogTarget} data-workspace-pane-target="addFirst" data-action="click->workspace-pane#addFirstTemplate"${presentation.workspaces.length ? "" : ' data-first-workspace-destination="first-template"'}>${addBadgeHtml()}<span><strong>Add your first template</strong><span>Point us at a git repo once. Every new workspace can start as a fresh clone of it.</span></span></a>`;
  return `<div id="${workspaceTemplateOptionsDomId}" class="workspace-template-options action-list" role="radiogroup" aria-labelledby="workspace_template_question">
    <p class="workspace-template-question" id="workspace_template_question">What should we put in your new workspace?</p>
    ${addWorkspaceTemplate}
    ${ordered.map((workspaceTemplate) => renderWorkspaceTemplateOption(workspaceTemplate)).join("")}
    ${renderWorkspaceTemplateOption()}
  </div>`;
}

function renderWorkspaceTemplatePicker(presentation: WorkspacePanePresentation, launchComposerBinding: string | undefined): string {
  const tip = launchComposerBinding
    ? `<p class="workspace-template-picker-tip">Tip: <kbd>${escapeHtml(formatShortcutBinding(launchComposerBinding))}</kbd> starts one from the current workspace’s template, with a prompt.</p>`
    : "";
  return `<form class="workspace-template-picker" method="get" action="/launch-composer" data-turbo-frame="launch_composer" data-turbo="true" data-action="submit->workspace-pane#submitted keydown.esc->workspace-pane#back">
    <input type="hidden" name="workspaceTemplate" value="" data-workspace-pane-target="value">
    <input type="hidden" name="autoSelect" value="true">
    <div class="workspace-template-picker-scroll">${renderWorkspaceTemplateOptions(presentation)}</div>
  </form>${tip}`;
}

const workspacePaneScrollDomId = "fixed_shell_workspace_scroll";
const workspacePaneNewWorkspaceDomId = "fixed_shell_new_workspace";
const workspaceTemplateOptionsDomId = "workspace_template_options";

export function renderWorkspacePane(presentation: WorkspacePanePresentation, sidebarContributionsHtml = "", moduleActionsHtml = "", launchComposerBinding?: string): string {
  const settings = actionLinkHtml({
    href: "/settings",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: Icons.Settings, label: "Settings" },
    attributesHtml: 'data-turbo="false" data-controller="settings-prefetch" data-action="pointerenter->settings-prefetch#prefetch focus->settings-prefetch#prefetch click->settings-prefetch#open"',
  });
  const back = buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Back, label: "Back to workspaces" }, attributesHtml: 'data-action="workspace-pane#back"' });
  return `<div class="fixed-shell-workspace-pane" data-controller="workspace-pane"><div class="fixed-shell-workspace-main">${panelHtml({
    element: { tag: "aside",  attributesHtml: 'aria-label="Workspaces"' },
    headerHtml: `<div class="workspace-pane-header" data-workspace-pane-target="workspacesHeader"><span class="panel__title">${Icons.Cloud}<span>Workspaces</span></span>${buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml: `${renderLayoutPicker()}${moduleActionsHtml}${settings}${barButton("Collapse Workspace pane", "click->workspace-navigation#toggleWorkspacePaneCollapsed", Icons.Panel, "data-collapse-workspace-pane")}` })}</div>
      <div class="workspace-pane-header" data-workspace-pane-target="pickerHeader" hidden>${back}<span class="panel__title">New workspace</span></div>`,
    bodyHtml: `<div class="workspace-pane-viewport" data-workspace-pane-target="body"><div class="workspace-pane-slides">
      <section class="workspace-pane-slide" data-workspace-pane-target="workspaces" aria-label="Workspaces">
        <div id="${workspacePaneNewWorkspaceDomId}" class="workspace-pane-new-workspace">${renderNewWorkspaceRow(presentation)}</div>
        <div class="fixed-shell-pane-collections" data-workspace-pane-collections>
          <div id="${workspacePaneScrollDomId}" class="fixed-shell-workspace-scroll" data-workspace-navigation-target="scroll">${renderWorkspaceRows(presentation)}</div>
          <section id="global_sidebar_contributions">${sidebarContributionsHtml}</section>
        </div>
      </section>
      <section class="workspace-pane-slide" data-workspace-pane-target="picker" aria-label="New workspace" inert>${renderWorkspaceTemplatePicker(presentation, launchComposerBinding)}</section>
    </div></div>`,
  })}</div></div>`;
}

const kintsugiNextAttentionDomId = "fixed_shell_kintsugi_next_attention";

function renderKintsugiNextAttentionButton(): string {
  const icon = `${Icons.Next}<i class="status-dot attention" aria-hidden="true"></i>`;
  return barButton("Next workspace requesting attention", "click->kintsugi-shortcuts#openAttentionWorkspace", icon, `id="${kintsugiNextAttentionDomId}" disabled`);
}

export function renderKintsugiBar(): string {
  const close = barButton("Close workspace list", "click->workspace-navigation#closeWorkspacePane", Icons.Close, "data-close-workspace-pane disabled");
  const newWorkspace = barButton("New workspace", "click->kintsugi-shortcuts#runCommand", Icons.Plus, 'data-command-id="agent.open-launch-composer"');
  return `<nav class="fixed-shell-mobile-nav fixed-shell-kintsugi-bar" data-popular-button aria-label="Kintsugi">${close}${renderKintsugiNextAttentionButton()}${newWorkspace}</nav>`;
}

export function workspacePresentationDomId(workspaceId: string): string {
  return domId("fixed_workspace", workspaceId);
}

function workspaceRegionDomId(workspaceId: string, part: string): string {
  return domId("fixed_workspace", workspaceId, part);
}

function renderAvailability(view: WorkPaneContribution): string {
  const { availability } = view;
  if (availability.phase === "live") return "";
  const label = availability.phase === "opening" ? "Opening" : availability.phase === "reconnecting" ? "Reconnecting" : "Unavailable";
  const detail = availability.detail ?? (availability.phase === "opening" ? `Opening ${view.label}…` : `Reconnecting ${view.label}…`);
  return `<div class="fixed-shell-availability empty-state fixed-shell-availability-${availability.phase}" role="${availability.phase === "unavailable" ? "alert" : "status"}">
    <span class="fixed-shell-availability-mark" aria-hidden="true"></span><strong>${label}</strong><p>${escapeHtml(detail)}</p>
  </div>`;
}

function renderWorkViewSelector(workspaceId: string, view: WorkPaneContribution): string {
  const textAttributesHtml = `id="${workspaceWorkViewLabelDomId(workspaceId, view.key)}"`;
  return tabHtml({
    selected: false,
    label: { kind: "text", text: view.label, textAttributesHtml },
    iconHtml: view.iconHtml ?? Icons.Plus,
    status: { requestingAttention: view.attentionSequence !== undefined },
    containerAttributesHtml: `id="${workViewSelectorDomId(workspaceId, view.key)}" draggable="true" data-work-view-reorder-key="${escapeHtml(view.key)}" data-action="dragstart->workspace-presentation#beginWorkReorder dragover->workspace-presentation#allowWorkReorder drop->workspace-presentation#finishWorkReorder"`,
    primary: { tag: "button", attributesHtml: `type="button" data-work-view-key="${escapeHtml(view.key)}" data-work-view-kind="${view.kind}"${view.attentionSequence === undefined ? "" : ` data-attention-sequence="${view.attentionSequence}"`} ${fullscreenViewAttributes(view.sourceKey ?? view.key, view.label)} data-action="click->workspace-presentation#selectWorkView"` },
    closeHtml: view.close ? selectorCloseForm(view.close) : "",
  });
}

function renderWorkViewSelectors(workspaceId: string, views: readonly WorkPaneContribution[]): string {
  return views.map((view) => renderWorkViewSelector(workspaceId, view)).join("");
}


function renderWorkViewPane(islands: LiveIslands, workspaceId: string, view: WorkPaneContribution): string {
  const source = view.sourceKey ? ` data-source-work-view-key="${escapeHtml(view.sourceKey)}"` : "";
  return `<section id="${workViewPaneDomId(workspaceId, view.key)}" class="fixed-shell-surface" data-workspace-pane-role="work" data-workspace-pane-id="${escapeHtml(view.key)}" data-work-view-kind="${view.kind}" data-kintsugi-fullscreen-view-key="${escapeHtml(view.sourceKey ?? view.key)}" data-workspace-logically-visible="false"${source} tabindex="-1">${islands.island(workViewAvailabilityDomId(workspaceId, view.key), renderAvailability(view), "div")}${islands.island(workViewActionsDomId(workspaceId, view.key), view.actionsHtml ?? "", "div", "fixed-shell-work-actions")}${paneContentHtml(workspaceId, "work-view-body", view.key)}</section>`;
}



function workViewDomId(workspaceId: string, part: string): string {
  return workspaceRegionDomId(workspaceId, part);
}

export function workViewSelectorDomId(workspaceId: string, key: string): string {
  return domId("work_view_selector", workspaceId, key);
}

export function workViewPaneDomId(workspaceId: string, key: string): string {
  return domId("work_view_pane", workspaceId, key);
}

export function workViewAvailabilityDomId(workspaceId: string, key: string): string {
  return domId("work_view_availability", workspaceId, key);
}

export function workViewActionsDomId(workspaceId: string, key: string): string {
  return domId("work_view_actions", workspaceId, key);
}

function workViewType(view: WorkPaneContribution): string {
  return view.key.slice(0, view.key.indexOf(":"));
}

function renderWorkLauncherCommand(command: NonNullable<WorkspacePresentation["commands"]>[number], workspaceId: string, action = ""): string {
  const item = contentRowHtml({ width: "fill", kind: "compact", label: { kind: "text", text: command.label }, leadingHtml: `<span class="popup-menu__icon">${command.iconHtml ?? Icons.Plus}</span>`, element: { tag: "button", attributesHtml: 'type="submit" role="menuitem"' } });
  const actionAttribute = action ? ` data-action="${action}"` : "";
  return `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/commands/${encodeURIComponent(command.id)}"${actionAttribute}>${item}</form>`;
}

function renderEmptyWorkPane(workspaceId: string, commands: NonNullable<WorkspacePresentation["commands"]>): string {
  const launchers = commands.filter((command) => command.placement === "work-launcher").map((command) => {
    const shortcutCommand = command.shortcutCommandId
      ? commands.find((candidate) => candidate.id === command.shortcutCommandId)!
      : command;
    const item = contentRowHtml({
      width: "fill",
      kind: "compact",
      label: { kind: "text", text: command.label },
      leadingHtml: command.iconHtml ?? Icons.Plus,
      trailingHtml: shortcutCommand.binding
        ? `<span class="work-launcher-shortcut">${escapeHtml(formatShortcutBinding(shortcutCommand.binding))}</span>`
        : undefined,
      element: { tag: "button", attributesHtml: 'type="submit"' },
    });
    return `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/commands/${encodeURIComponent(command.id)}">${item}</form>`;
  }).join("");
  return `<div id="${workViewDomId(workspaceId, "empty")}" class="fixed-shell-empty-work empty-state"><div class="fixed-shell-empty-work-content"><div class="fixed-shell-empty-work-launchers action-list">${launchers}</div></div></div>`;
}

function renderWorkPane(islands: LiveIslands, presentation: WorkspacePresentation): string {
  const selectors = renderWorkViewSelectors(presentation.workspace.id, presentation.workViews);
  const panes = presentation.workViews.map((view) => renderWorkViewPane(islands, presentation.workspace.id, view)).join("");
  const workCommands = (presentation.commands ?? []).filter((command) => command.placement === "work-launcher");
  const addMenuId = workViewDomId(presentation.workspace.id, "add_menu");
  const addMenu = workCommands.length ? popupHtml({
    id: addMenuId,
    label: "Open Work view",
    trigger: { variant: "primary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: "Open Work view" } },
    contentHtml: workCommands.map((command) => renderWorkLauncherCommand(command, presentation.workspace.id)).join(""),
  }) : "";
  return `<div class="fixed-shell-work-pane">${panelHtml({
    element: { tag: "section",  attributesHtml: 'data-workspace-role-region="work" data-workspace-presentation-target="workPane" aria-label="Work"' },
    headerHtml: `${presentation.workViews.length ? "" : '<span class="panel__title">Work views</span>'}${islands.island(workViewDomId(presentation.workspace.id, "selector_tabs"), tabStripHtml({ id: workViewDomId(presentation.workspace.id, "selectors"), label: "Work views", tabsHtml: selectors }), "span", "contents")}<span id="${workViewDomId(presentation.workspace.id, "launchers")}">${addMenu}</span>${barButton("Collapse Work pane", "click->workspace-presentation#toggleWorkPane", Icons.Panel, "data-collapse-work-pane")}`,
    bodyHtml: `<div id="${workViewDomId(presentation.workspace.id, "bodies")}" class="fixed-shell-work-bodies">${panes || renderEmptyWorkPane(presentation.workspace.id, presentation.commands ?? [])}</div><div class="fixed-shell-work-resizer" role="separator" aria-label="Resize Work pane" aria-orientation="vertical" tabindex="0" data-action="pointerdown->workspace-presentation#beginWorkResize keydown->workspace-presentation#resizeWorkWithKeyboard"></div>`,
  })}</div>`;
}

function renderMobileDestination(label: string, destination: string, iconHtml: string, attention = false, workKey?: string): string {
  const attentionHtml = attention ? '<i class="status-dot attention" aria-label="Attention"></i>' : "";
  const workKeyAttribute = workKey === undefined ? "" : ` data-mobile-work-key="${escapeHtml(workKey)}"`;
  return buttonHtml({
    type: "button", variant: "secondary",
    content: { kind: "icon-only", iconHtml: `${iconHtml}${attentionHtml}`, label },
    attributesHtml: `${workKeyAttribute} data-mobile-destination="${escapeHtml(destination)}" data-action="click->workspace-presentation#selectMobileDestination"`,
  });
}

function mobileNavigationPriority(view: WorkPaneContribution): number {
  const type = workViewType(view);
  if (type === "browser") return 0;
  return 2;
}

function renderMobileWorkViews(views: readonly WorkPaneContribution[]) {
  const ordered = [...views].sort((left, right) => mobileNavigationPriority(left) - mobileNavigationPriority(right));
  return {
    destinations: ordered.map((view) => renderMobileDestination(view.label, `work:${view.key}`, view.iconHtml ?? Icons.Plus, view.attentionSequence !== undefined, view.key)).join(""),
    overflowItems: ordered.map((view) => {

      const attention = view.attentionSequence === undefined ? "" : '<i class="status-dot attention content-row__status" aria-label="Attention"></i>';
      return contentRowHtml({
        width: "fill",
        kind: "compact",
        label: { kind: "text", text: view.label },
        leadingHtml: view.iconHtml ?? Icons.Plus,
        trailingHtml: attention,
        element: { tag: "button", attributesHtml: `type="button" role="menuitemradio" aria-checked="false" hidden data-more-work-key="${escapeHtml(view.key)}" data-more-work-kind="${view.kind}" data-action="click->workspace-presentation#selectMoreWorkView"` },
      });
    }).join(""),
  };
}

function renderMobileCloser(destination: string, close: ViewCloseAction): string {
  const item = contentRowHtml({ width: "fill", kind: "compact", tone: "danger", label: { kind: "text", text: "Close current view" }, leadingHtml: `<span class="popup-menu__icon">${Icons.Close}</span>`, element: { tag: "button",  attributesHtml: 'type="submit" role="menuitem"' } });
  return `<div data-more-close-destination="${escapeHtml(destination)}" hidden>${closeForm(close, item)}</div>`;
}

function renderMobileWorkViewCloser(view: WorkPaneContribution): string {
  return view.close ? renderMobileCloser(`work:${view.key}`, view.close) : "";
}

const mobileMoreAttentionHtml = '<i class="status-dot attention" aria-label="Hidden Attention" data-mobile-overflow-attention hidden></i>';

export function renderMobileWorkspaceBar(destinationsHtml = "", moreMenuHtml = "", inert = false): string {
  const workspace = barButton("Show workspaces", "click->workspace-navigation#showWorkspacePane", Icons.Workspace, "data-show-workspace-list");
  return `<nav class="fixed-shell-mobile-nav fixed-shell-workspace-bar" data-popular-button aria-label="Current Workspace destinations"${inert ? " inert" : ""}>
    <div class="fixed-shell-mobile-scroll" data-mobile-overflow-container>${workspace}${destinationsHtml}</div>
    ${moreMenuHtml}
  </nav>`;
}

function renderWorkspaceBar(islands: LiveIslands, presentation: WorkspacePresentation, inert = false): string {
  const agentsDestination = renderMobileDestination("Agents", "agents", `${Icons.Agent}${renderMobileAgentAttention(islands, presentation.workspace.id, presentation.agents)}`);
  const workViews = renderMobileWorkViews(presentation.workViews);
  const launchers = (presentation.commands ?? []).filter((command) => command.placement === "work-launcher").map((command) => renderWorkLauncherCommand(command, presentation.workspace.id, "submit->workspace-presentation#closeMore")).join("");
  const closers = presentation.workViews.map(renderMobileWorkViewCloser).join("");
  const moreMenuId = workViewDomId(presentation.workspace.id, "mobile_more_menu");
  const moreMenu = popupHtml({
    id: moreMenuId, label: "More", placement: "above",
    trigger: { variant: "secondary", content: { kind: "icon-only", iconHtml: `${Icons.More}<span id="${workViewDomId(presentation.workspace.id, "mobile_more_attention")}">${mobileMoreAttentionHtml}</span>`, label: "More" }, attributesHtml: "data-mobile-more" },
    menuAttributesHtml: 'data-workspace-presentation-target="moreMenu" data-action="toggle->workspace-presentation#syncMore"',
    contentHtml: `${islands.island(workViewDomId(presentation.workspace.id, "mobile_overflow"), workViews.overflowItems, "span", "contents action-list")}
      ${launchers ? `<hr class="popup-menu__separator" data-mobile-overflow-separator hidden>${launchers}` : ""}
      ${islands.island(workViewDomId(presentation.workspace.id, "mobile_closers"), closers, "div", "fixed-shell-more-close-section")}`,
  });
  return renderMobileWorkspaceBar(`${agentsDestination}${islands.island(workViewDomId(presentation.workspace.id, "mobile_destinations"), workViews.destinations, "span", "contents")}`, moreMenu, inert);
}

export function renderWorkspaceDeletionPresentation(workspaceId: string, deletion: WorkspaceDeletionState, evidenceHtml = ""): string {
  const id = encodeURIComponent(workspaceId);
  const deletionButton = (caption: string, variant: ButtonVariant = "secondary") => buttonHtml({
    type: "submit",
    variant,
    content: { kind: "caption", caption },
  });
  let content: string;
  if (deletion.status === "checking") {
    content = '<div class="workspace-deletion-heading"><span class="status-spinner" aria-hidden="true"></span><h1>Checking if it’s safe to delete…</h1><p>Kintsugi is checking for local Git work and saved review comments.</p></div>';
  } else if (deletion.status === "deleting") {
    const title = deletion.forced ? "Force deleting workspace…" : "Deleting workspace…";
    const detail = deletion.forced ? "Local changes may be discarded." : "The safety check passed. Kintsugi is removing the workspace.";
    content = `<div class="workspace-deletion-heading"><span class="status-spinner" aria-hidden="true"></span><h1>${title}</h1><p>${detail}</p></div>`;
  } else if (deletion.status === "blocked") {
    content = `<div class="workspace-deletion-evidence" aria-label="Work that may be lost">${evidenceHtml}</div><footer class="workspace-deletion-actions"><form method="post" action="/workspaces/${id}/delete/cancel" data-turbo="true">${deletionButton("Cancel deletion")}</form><form method="post" action="/workspaces/${id}/delete/confirm" data-turbo="true" data-controller="submit-shortcut" data-action="keydown@window->submit-shortcut#windowKeydown submit->submit-shortcut#submit turbo:submit-end->submit-shortcut#submitted"><input type="hidden" name="fingerprint" value="${escapeHtml(deletion.fingerprint)}">${deletionButton("Delete anyway", "danger")}</form></footer>`;
  } else {
    const bypass = deletion.operation === "checking" ? `<form method="post" action="/workspaces/${id}/delete?force=1" data-turbo="true">${deletionButton("Delete without review", "danger")}</form>` : "";
    content = `<div class="workspace-deletion-heading"><h1>${deletion.operation === "checking" ? "Deletion review failed" : "Workspace deletion failed"}</h1><p class="workspace-deletion-error">${escapeHtml(deletion.error)}</p></div><footer class="workspace-deletion-actions"><form method="post" action="/workspaces/${id}/delete/cancel" data-turbo="true">${deletionButton("Cancel deletion")}</form><form method="post" action="/workspaces/${id}/delete/retry" data-turbo="true">${deletionButton("Retry review")}</form>${bypass}</footer>`;
  }
  const role = deletion.status === "failed" ? ' role="alert"' : deletion.status === "blocked" ? "" : ' role="status"';
  return `<div id="${domId("fixed_workspace", workspaceId)}" class="fixed-workspace-presentation workspace-deletion-presentation" data-workspace-id="${escapeHtml(workspaceId)}" data-workspace-commands="[]"><main class="workspace-deletion-state" data-deletion-status="${deletion.status}"${role}>${content}</main>${renderMobileWorkspaceBar()}</div>`;
}

/** The workspace chrome, and the islands within it that are published as their own regions. */
export function renderWorkspacePresentation(presentation: WorkspacePresentation) {
  const islands = new LiveIslands();
  const id = workspacePresentationDomId(presentation.workspace.id);
  const trustPending = presentation.overlayHtml?.some(html => html.includes('class="workspace-ssh-trust-overlay"')) ?? false;
  const html = `<div id="${id}" class="fixed-workspace-presentation" data-controller="workspace-presentation" data-phone-destination="agents" data-workspace-presentation-work-intent-value="${escapeHtml(JSON.stringify(presentation.workPresentationIntent ?? {}))}" data-workspace-presentation-workspace-id-value="${escapeHtml(presentation.workspace.id)}" data-workspace-id="${escapeHtml(presentation.workspace.id)}" data-workspace-title="${escapeHtml(presentation.workspace.title)}" data-workspace-commands="${escapeHtml(JSON.stringify(presentation.commands ?? []))}">
    <div class="fixed-shell-main"${trustPending ? " inert" : ""}>${renderAgentPane(islands, presentation)}${renderWorkPane(islands, presentation)}</div>
    ${renderWorkspaceBar(islands, presentation, trustPending)}
    ${islands.island(workspaceRegionDomId(presentation.workspace.id, "overlays"), (presentation.overlayHtml ?? []).join(""), "div", "contents")}
  </div>`;
  return { html, islands: islands.regions };
}

export interface InitialWorkspaceSelection { agent?: string; workView?: string }

/** Marks a server-rendered page's selected panes for its first paint. The presentation owns
 * these marks, so the published chrome leaves them out. */
export function presentInitialWorkspaceSelection(html: string, workspaceId: string, { agent, workView }: InitialWorkspaceSelection): string {
  const active = new Set([...agent ? [agentPaneSlotDomId(workspaceId, agent)] : [], ...workView ? [workViewPaneDomId(workspaceId, workView)] : []]);
  return new HTMLRewriter().on("[id]", { element(element) {
    const id = element.getAttribute("id")!;
    if (active.has(id)) element.setAttribute("class", `${element.getAttribute("class")} is-active`);
    if (id === workspacePresentationDomId(workspaceId) && workView) {
      element.setAttribute("class", `${element.getAttribute("class")} is-work-pane-open`);
      element.setAttribute("data-phone-destination", `work:${workView}`);
    }
  } }).transform(html);
}

export function presentWorkViewTurboStream(workspaceId: string, key: string): string {
  return behaviorTurboStream("present-work-view", workspaceId, { "work-view-key": key });
}

export function workspacePaneCollectionsRegions(presentation: WorkspacePanePresentation): import("@kintsugi/shared").LiveRegion[] {
  return [
    { target: workspacePaneScrollDomId, html: renderWorkspaceRows(presentation) },
    { target: workspacePaneNewWorkspaceDomId, html: renderNewWorkspaceRow(presentation) },
    { target: workspaceTemplateOptionsDomId, html: renderWorkspaceTemplateOptions(presentation), action: "replace" },
  ];
}

export function renderWorkspaceParkConfirmation(id: string, title: string, workViews: readonly WorkspaceWorkViewState[]): string {
  const terminals = workViews.filter(({ reference }) => reference.type === "terminal").length;
  const editors = workViews.filter(({ reference }) => reference.type === "vscode").length;
  const openViews = [
    ...(terminals ? [`${terminals} terminal ${terminals === 1 ? "session" : "sessions"}`] : []),
    ...(editors ? [`${editors} VS Code ${editors === 1 ? "editor" : "editors"}`] : []),
  ].join(" and ");
  const singular = terminals + editors === 1;
  return dialogHtml({
    element: { id: domId("workspace_park_confirmation", id), attributesHtml: "data-dialog-auto-show" },
    iconHtml: Icons.Park,
    titleCaption: `Park “${title}”?`,
    bodyHtml: `<p>You have ${openViews} open in this workspace.</p><p>Parking will close ${singular ? "it" : "them"}. ${singular ? "It" : "They"} won’t reopen when you unpark.</p>`,
    footerHtml: `<form method="dialog">${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Cancel" } })}</form><form method="post" action="/workspaces/${encodeURIComponent(id)}/park?force=1" data-action="submit->workspace-navigation#parkWorkspace">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Force park" } })}</form>`,
  });
}

export function dismissWorkspaceParkConfirmationTurboStream(id: string): string {
  return turboStream("remove", domId("workspace_park_confirmation", id));
}
