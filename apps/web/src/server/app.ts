import { handleWorkspaceProperties, handleWorkspaceResources, type WorkspaceResourceBackend } from "./workspace-properties.ts";
import { handlePrivateNetworkSettings } from "./settings/private-network.ts";
import { handleWorkspaceNetwork } from "./settings/network.ts";
import { templateSettingsHostId, templateSettingsFrameId } from "./template-settings.ts";
import { maybeNameWorkspaceFromPrompt } from "@kintsugi/builtin-agent/server";
import {
  KintsugiCoreError,
  createKeyedOperationQueue,
  withCommandSignal, waitForCommand,
  invalidArguments,
  isJsonObject,
  readJsonObject,
  requestAcceptsJson,
  type KintsugiEventBus,
  type JsonObject,
  type JsonValue,
} from "@kintsugi/core";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { buttonHtml } from "@kintsugi/design-system/button";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { panelHtml } from "@kintsugi/design-system/panel";
import { Icons } from "@kintsugi/design-system/icons";
import { warningBannerHtml } from "@kintsugi/design-system/warning-banner";
import { parseModelRef, renderModelsDialog } from "@kintsugi/llm/server";
import { workspacePageTitle } from "../page-title.ts";
import { getWorkspaceTemplateConfiguration, isGitWorkspaceTemplateInit, workspaceTemplateIdFromInit, workspaceTemplateIdOfInit, isSshAuthenticationFailure, listWorkspaceTemplates, sshHostTrustFailure, scanSshHost, trustScannedSshHost, workspaceSshTrustRequests, onWorkspaceSshTrustChanged, decideWorkspaceSshTrust, cancelWorkspaceSshTrust, workspaceInitFromTemplate, type WorkspaceTemplateConfiguration, type WorkspaceTemplateSummary } from "@kintsugi/workspace-templates";
import { validDraftId } from "@kintsugi/prompt/server";
import {
  domId,
  emptyWorkspaceCommandInputSchema,
  errorMessage,
  escapeHtml,
  parseWorkspaceFileTarget,
  turboStreamResponse,
  workspaceModuleModalFrameId,
  launchComposerCommand,
  placeLiveRegions,
  type CableIdentifier,
  type DeleteCurrentWorkspaceResult,
  type GlobalSidebarContributionRegistry,
  type LiveRegion,
  type LiveRegionDigests,
  type WorkspaceAttachment,
  type WorkspaceCommandContribution,
  type WorkspaceDeletionReview,
  type WorkspaceModule,
  type WorkspaceModuleCommandHandler,
  type WorkspaceModuleCommandResult,
  type WorkspaceModuleRouteHandler,
  type WorkspaceModuleWorkViewAdapter,
  type WorkspaceAgentPane,
  type WorkspaceWorkViewPresentation
} from "@kintsugi/shared";
import { createWorkspacePresentationStore, createWorkspaceProvisioning, generateWorkspaceId, listWorkspaces, setWorkspaceParked, setWorkspaceTitle, type WorkspaceCreationContext, type WorkspaceInitInstruction, type WorkspaceProvisioning, type WorkspaceProvisionRun, type WorkspaceWorkViewReference, type WorkspaceWorkViewState } from "@kintsugi/workspace";
import { renderWorkspaceLaunchPrompt, renderWorkspaceProvisioning } from "@kintsugi/workspace/server/provisioning";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createAgentPaneHost } from "./agent-pane-host.ts";
import { welcomeBrandHtml } from "./brand/welcome-brand.ts";
import { selectAgentTurboStream } from "./agent-pane.ts";
import { paneContentId, paneSurfaceKinds } from "./workspace-view-markup.ts";
import { getAgentType, defaultAgentType, orderedAgentTypes, registeredAgentTypes, rememberAgentType } from "./agent-types.ts";
import { openWorkspaceFile } from "./file-navigation.ts";
import { httpErrorStatus, problemJsonResponse } from "./http-responses.ts";
import { jsonResponse, matchRoute, replace, response, textResponse, update, wantsStream } from "@kintsugi/shared/http";
import { launchComposerContent, renderLaunchComposer, renderLaunchAgentType, renderLaunchWorkspaceTemplate, launchWorkspaceAction } from "./launch-composer.ts";
import { createLiveResource } from "./live-resource.ts";
import { handleOnboardingRequest, renderOnboardingDialog } from "./onboarding/routes.ts";
import { kintsugiOpenApi } from "./openapi.ts";
import { createPageLayout } from "./page-layout.ts";
import { createWorkspaceTemplateRoutes, type WorkspaceTemplateEditorOptions } from "./workspace-template-routes.ts";
import { appSettingsFrameId, renderDeveloperToolsSettings, renderAppSettings } from "./settings/page.ts";
import { handleSettingsRequest } from "./settings/routes.ts";
import { themeRegionHtml, themeRegionId } from "./settings/theme.ts";
import { parseCloseWorkViewRequest, parseReorderWorkViewRequest } from "./work-view-api.ts";
import { createWorkspaceDeletion } from "./workspace-deletion.ts";
import { workspaceModules as defaultWorkspaceModules } from "./workspace-modules.generated.ts";
import { dismissWorkspaceParkConfirmationTurboStream, presentWorkViewTurboStream, renderKintsugiBar, renderMobileWorkspaceBar, renderWorkspaceDeletionPresentation, renderWorkspacePane, renderWorkspaceParkConfirmation, renderWorkspacePresentation, workspacePaneCollectionsRegions, type InitialWorkspaceSelection, type WorkspacePresentation as FixedWorkspacePresentation, type WorkPaneContribution, type WorkspacePanePresentation, type WorkspacePaneWorkspaceTemplate } from "./workspace-presentation.ts";
import type { WorkspaceDeletionState, WorkspaceEntry, WorkspaceRegistry } from "./workspace-registry.ts";
import { workspaceWarnings, type WorkspaceWarning } from "./workspace-warnings.ts";

const jsonStringSchema = Type.String();
const connectionSettingsLink = actionLinkHtml({ href: "/settings?section=browser-transport", variant: "secondary", content: { kind: "caption", caption: "Connection settings", iconHtml: Icons.Settings }, attributesHtml: 'data-turbo="false"' });
export interface WebAppDeps {
  workspaceResourceBackend?: WorkspaceResourceBackend;
  registry: WorkspaceRegistry;
  workspaceModules?: WorkspaceModule[];
  /** Event bus passed through to the agent module routes. */
  events?: KintsugiEventBus;
  devReload?: boolean;
  /** Create the container + default agent etc. for an already-registered workspace id. */
  provisionWorkspace(id: string, options: { init?: WorkspaceInitInstruction; context?: WorkspaceCreationContext; run: WorkspaceProvisionRun }): Promise<void>;
  /** Test/embedding override. Production obtains this contribution from the Changes module. */
  deletionReview?: WorkspaceDeletionReview;
  /** Force-remove the workspace container. */
  destroyWorkspace(id: string): Promise<void>;
  /** Persist parked state and stop or start its workspace container. Defaults to setWorkspaceParked. */
  persistWorkspaceParked?(id: string, parked: boolean, recover?: boolean, force?: boolean): Promise<void>;
  /** Receives background task failures. Defaults to console.error. */
  logError?(message: string): void;
  workspaceRemovedHandlers?: Array<(workspaceId: string) => void | Promise<void>>;
}

export interface WebApp {
  fetch(request: Request): Promise<Response>;
  invalidateWorkspace(workspaceId: string): void;
  subscribeShell(listener: (html: string) => void): Promise<import("@kintsugi/shared").CableChannelSubscription>;
  subscribeSurface(identifier: CableIdentifier, listener: (html: string) => void, shown?: LiveRegionDigests): Promise<import("@kintsugi/shared").CableChannelSubscription>;
  deleteCurrentWorkspaceFromAgent(workspaceId: string, force: boolean): Promise<DeleteCurrentWorkspaceResult>;
  resumeWorkspaceDeletions(): void;
  provisioning: WorkspaceProvisioning;
  createWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void>;
  presentWorkViewFromAgent(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void>;
  globalSidebarContributions: GlobalSidebarContributionRegistry;
}

type WorkspaceCommandResponse = { id: string; workView?: WorkspaceWorkViewReference; agentId?: string };

function selectWorkspaceTurboStream(workspaceId: string): string {
  return `<turbo-stream action="select-workspace" target="workspace_detail" data-workspace-id="${escapeHtml(workspaceId)}"></turbo-stream>`;
}

export function createWebApp(deps: WebAppDeps): WebApp {
  const { registry } = deps;
  const workspaceModules = deps.workspaceModules ?? defaultWorkspaceModules;
  const logError = deps.logError ?? ((message: string) => console.error(message));
  // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
  const workViewAdapters = workspaceModules.flatMap((module) => module.workViews ?? []) as WorkspaceModuleWorkViewAdapter[];
  const moduleDeletionReviews = workspaceModules.flatMap((module) => module.deletionReview ? [module.deletionReview] : []);
  if (!deps.deletionReview && moduleDeletionReviews.length !== 1) throw new Error(`Expected one deletion safety contribution, found ${moduleDeletionReviews.length}`);
  const deletionReview = deps.deletionReview ?? moduleDeletionReviews[0]!;
  const deletion = createWorkspaceDeletion({
    registry,
    inspect: (id) => deletionReview.inspect(id),
    destroy: deps.destroyWorkspace,
    cancelPreparation: (id) => provisioning.cancel(id),
    changed: invalidatePresentation,
  });
  const agentTypes = registeredAgentTypes();
  const agentTabs = createAgentPaneHost(agentTypes);
  const presentationStore = createWorkspacePresentationStore({
    workViewContributions: workViewAdapters,
  });
  const serializePresentationMutation = createKeyedOperationQueue();

  const workPresentationIntents = new Map<string, { key: string; revision: string }>();
  type SurfaceState = { kind: "workspace"; presentation: FixedWorkspacePresentation }
    | { kind: "regions"; regions: readonly LiveRegion[]; live?: WorkspaceAgentPane["live"] };
  /** A workspace's chrome, and the Agent pane and Work view body its presentation selects. */
  const presentationSurfaceKinds = new Set<string>(["workspace", ...paneSurfaceKinds]);
  const surfaces = new Map<string, { workspaceId: string; kind: string; resource: ReturnType<typeof createLiveResource<SurfaceState>> }>();
  const reportPresentationError = (error: Error) => logError(
    `Could not refresh live state: ${errorMessage(error)}`,
  );
  const shell = createLiveResource(async () => {
    const pane = await workspacePaneCollections("");
    return [...workspacePaneCollectionsRegions(pane), ...[...globalRegions.values()].flat(),
      { target: "global_sidebar_contributions", html: renderGlobalSidebarContributions() },
      { target: "workspace_mounts", html: workspaceMounts() },
      { target: "workspace_empty_artwork", html: emptyWorkspaceArtworkHtml(pane), action: "replace" as const },
      { target: themeRegionId, html: themeRegionHtml() },
    ];
  }, regions => regions, reportPresentationError);

  function invalidatePresentation(): void {
    shell.invalidate();
    for (const { kind, resource } of surfaces.values()) if (presentationSurfaceKinds.has(kind)) resource.invalidate();
  }

  function invalidateWorkspace(workspaceId?: string): void {
    invalidatePresentation();
    for (const surface of surfaces.values()) {
      if (!presentationSurfaceKinds.has(surface.kind) && surface.workspaceId === workspaceId) surface.resource.invalidate();
    }
  }

  function surfaceFor(identifier: CableIdentifier) {
    if (identifier.channel !== "module" || identifier.name !== "surface") throw new Error("Invalid surface channel");
    const { workspaceId, params } = identifier;
    requireWorkspace(workspaceId);
    const { kind, key = "" } = params;
    const contributed = workspaceModules.flatMap(module => module.liveSurfaces ?? []).find(surface => surface.name === kind);
    if (!presentationSurfaceKinds.has(kind) && !contributed) throw new Error("Unknown surface kind");
    const cacheKey = JSON.stringify([workspaceId, kind, key]);
    let surface = surfaces.get(cacheKey);
    if (!surface) {
      const resource = createLiveResource<SurfaceState>(async () => {
        const entry = requireWorkspace(workspaceId);
        if (contributed) return { kind: "regions", regions: await contributed.load({ workspaceId, key }) };
        const running = entry.phase.kind === "runningPhase" && !entry.phase.deletion && !entry.parked && !parking.has(workspaceId);
        if (!running) return { kind: "regions", regions: kind === "workspace" ? [{ target: workspaceMountId(workspaceId), html: entry.phase.deletion ? deletionPresentation(entry, entry.phase.deletion) : workspaceBootMountHtml(entry) }] : [] };
        try {
          return await withCommandSignal(AbortSignal.timeout(10_000), () => waitForCommand((async (): Promise<SurfaceState> => {
            if (kind === "workspace") return { kind: "workspace", presentation: (await workspacePresentationBundle(workspaceId)).presentation };
            if (kind === "agent-pane") return agentPaneSurface(workspaceId, key);
            return { kind: "regions", regions: await workViewBodyRegions(workspaceId, key) };
          })()));
        } catch (error) {
          logError(`Workspace ${workspaceId} surface ${kind} is unavailable: ${errorMessage(error)}`);
          if (kind === "workspace") return { kind: "regions", regions: [{ target: workspaceMountId(workspaceId), html: workspaceUnavailableHtml(entry, errorMessage(error)) }] };
          throw error;
        }
      }, state => state.kind === "workspace"
        ? workspaceRegions(state.presentation)
        : state.regions, reportPresentationError);
      surface = { workspaceId, kind, resource };
      surfaces.set(cacheKey, surface);
    }
    return surface.resource;
  }

  async function subscribeSurface(identifier: CableIdentifier, listener: (html: string) => void, shown?: LiveRegionDigests) {
    return surfaceFor(identifier).subscribe(listener, shown);
  }

  deps.events?.on("agent_type_default_changed", invalidatePresentation);
  deps.events?.on("workspace_agent_view_invalidated", invalidatePresentation);
  deps.events?.on("workspace_agent_title_changed", invalidatePresentation);

  const pendingSshTrustIds = new Map<string, Set<string>>();
  onWorkspaceSshTrustChanged((workspaceId) => {
    const previous = pendingSshTrustIds.get(workspaceId);
    const requests = workspaceSshTrustRequests(workspaceId);
    if (requests.length) pendingSshTrustIds.set(workspaceId, new Set(requests.map(request => request.id)));
    else pendingSshTrustIds.delete(workspaceId);
    if (registry.get(workspaceId) && requests.some(request => !previous?.has(request.id))) registry.requestAttention(workspaceId);
    invalidateWorkspace(workspaceId);
  });
  const hostTrustPanels = new Map<string, Awaited<ReturnType<typeof scanSshHost>>>();
  deps.events?.on("workspace_deleted", ({ workspaceId }) => { cancelWorkspaceSshTrust(workspaceId); hostTrustPanels.delete(workspaceId); });
  const provisioningLaunchPanels = new Map<string, string>();
  const provisioning = createWorkspaceProvisioning({ events: deps.events, onChange: (workspaceId) => {
    invalidatePresentation();
    const entry = registry.get(workspaceId);
    const snapshot = provisioning.snapshot(workspaceId);
    if (entry?.phase.kind === "provisioningPhase" && snapshot) {
      registry.setProvisioningState(workspaceId, snapshot.status === "waiting" ? "waiting" : snapshot.status === "failed" || snapshot.status === "cancelled" ? "failed" : "working", snapshot.error);
    }
  } });
  const workspaceCommandModalHostId = "workspace_command_modal_host";
  const launchComposerFrameId = "launch_composer";
  // The host prompt draft supplies a stable submission identity. Retried POSTs
  // therefore join the original launch instead of provisioning another Workspace.
  const launchComposerSubmissions = new Map<string, Promise<CreatedWorkspace>>();
  const launchComposerSettingsFrameId = "launch_composer_settings";
  const launchComposerFormId = "launch_composer_form";
  const workspaceTemplateRoutes = createWorkspaceTemplateRoutes({
    referencingWorkspaces: (workspaceTemplateId) => registry.list()
      .filter((entry) => isGitWorkspaceTemplateInit(entry.init) && workspaceTemplateIdFromInit(entry.init) === workspaceTemplateId)
      .map((entry) => ({ workspaceId: entry.id, title: workspaceTitle(entry) })),
    invalidatePresentation,
    createAgentWorkspace: (workspaceTemplate, request) => createAgentWorkspaceFromForm(request, { workspaceTemplate }),
  });

  function workspaceMountId(id: string): string {
    return domId("workspace_mount", id);
  }

  const globalRegions = new Map<string, readonly LiveRegion[]>();
  const globalSidebarContributionStore = new Map<string, string>();

  function renderGlobalSidebarContributions(): string {
    return Array.from(globalSidebarContributionStore.values()).filter(Boolean).join("");
  }

  const globalSidebarContributions: GlobalSidebarContributionRegistry = {
    set(contributionId, html, regions = []) {
      globalRegions.set(contributionId, regions);
      if (html) globalSidebarContributionStore.set(contributionId, html);
      else globalSidebarContributionStore.delete(contributionId);
      invalidatePresentation();
    },
  };

  function workspaceTitle(entry: WorkspaceEntry): string {
    return entry.title || (isGitWorkspaceTemplateInit(entry.init) ? entry.init.name : undefined) || `Workspace ${entry.id}`;
  }

  const persistWorkspaceParked = deps.persistWorkspaceParked ?? setWorkspaceParked;
  /** Workspaces whose Agents are being suspended for parking, before the registry marks them parked. */
  const parking = new Set<string>();
  let suppressParkedStateCallbacks = false;

  registry.setCallbacks({
    rowChanged(entry) {
      if (entry.phase.kind === "runningPhase") provisioningLaunchPanels.delete(entry.id);
      invalidatePresentation();
    },
    listChanged() {
      if (suppressParkedStateCallbacks) return;
      invalidatePresentation();
    },
    parkedChanged(entry) {
      if (suppressParkedStateCallbacks) return;
      void persistWorkspaceParked(entry.id, entry.parked).catch((error) => logError(`could not persist parked state for workspace ${entry.id}: ${errorMessage(error)}`));
    },
    removed(id) {
      workPresentationIntents.delete(id);
      provisioningLaunchPanels.delete(id);
      provisioning.delete(id);
      for (const [key, surface] of surfaces) if (surface.workspaceId === id) { surface.resource.dispose(); surfaces.delete(key); }
      invalidatePresentation();
      for (const handler of deps.workspaceRemovedHandlers ?? []) void handler(id);
    },
  });

  // ---------------------------------------------------------------------------
  // Page shell
  // ---------------------------------------------------------------------------

  const layout = createPageLayout({ devReload: deps.devReload, workspaceModules });

  function launchComposerFooterContext(query = new URLSearchParams()) {
    return { frameId: launchComposerSettingsFrameId, formId: launchComposerFormId, url: "/launch-composer/settings", query };
  }

  async function renderLaunchComposerFrame(workspaceTemplate?: WorkspaceTemplateSummary, autoSelect = false): Promise<string> {
    const draftId = crypto.randomUUID();
    const agentTypes = await orderedAgentTypes();
    const initialPrompt = registry.list().length === 0
      ? "Hi, I think I'm about to make my first workspace in Kintsugi. Yay!\n\nIs it true that you have access to your own documentation and I can just ask you if I have a question about it?"
      : "";
    const content = await launchComposerContent({ context: launchComposerFooterContext(), draftId, agentType: agentTypes[0]!, agentTypes, workspaceTemplateId: workspaceTemplate?.id, initialPrompt });
    return `<turbo-frame id="${launchComposerFrameId}">${dialogHtml({
      element: {
        controllers: "launch-composer-dialog submit-shortcut composer-focus",
        actions: "mousedown->composer-focus#preserveInputFocus kintsugi:software-keyboard@document->launch-composer-dialog#layout resize@window->launch-composer-dialog#layout",
        attributesHtml: `data-launch-composer-dialog-discard-url-value="${escapeHtml(content.discardUrl)}"`,
      },
      iconHtml: Icons.Workspace,
      titleCaption: "Create workspace from a template, and then…",
      titleParts: {
        before: "Create workspace from",
        controlHtml: renderLaunchWorkspaceTemplate((await listWorkspaceTemplates()).workspaceTemplates, workspaceTemplate, autoSelect),
        after: ", and then…",
      },
      closeLabel: "Close launch composer",
      bodyLayout: "full-bleed",
      bodyHtml: renderLaunchComposer({ action: launchWorkspaceAction(workspaceTemplate?.id, autoSelect), formId: launchComposerFormId, content }),
    })}</turbo-frame>`;
  }

  // ---------------------------------------------------------------------------
  // Workspace detail mount host
  // ---------------------------------------------------------------------------

  async function attachWorkspaceModules(workspaceId: string): Promise<WorkspaceAttachment[]> {
    const entry = requireWorkspace(workspaceId);
    const attachments = await Promise.all(workspaceModules
      .filter((module) => module.attachToWorkspace)
      .map((module) => module.attachToWorkspace!({ workspaceId, init: entry.init, events: deps.events })));
    const initialWorkViews = attachments.flatMap(attachment => attachment.workViews ?? [])
      .filter(view => view.initiallyOpen !== false).map(view => view.reference);
    await presentationStore.initialize(workspaceId, initialWorkViews);
    return attachments;
  }

  const workViewAdapterByType = new Map(workViewAdapters.map((adapter) => [adapter.type, adapter]));

  function workViewKey(reference: WorkspaceWorkViewReference): string {
    const adapter = workViewAdapterByType.get(reference.type);
    if (!adapter) throw new KintsugiCoreError("work_view_reference_invalid", `unknown Work view type: ${reference.type}`);
    return `${reference.type}:${adapter.identity(reference)}`;
  }

  function workViewClose(workspaceId: string, reference: WorkspaceWorkViewReference, label: string) {
    const encoded = encodeURIComponent(JSON.stringify(reference));
    return { action: `/workspaces/${encodeURIComponent(workspaceId)}/work-views/${encoded}/close`, label: `${label} Work view` };
  }

  function agentClose(workspaceId: string, agentId: string, title: string) {
    return { action: `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/close`, label: `${title} Agent` };
  }

  async function workspacePaneCollections(activeWorkspaceId: string): Promise<WorkspacePanePresentation> {
    const { workspaceTemplates: savedWorkspaceTemplates } = await listWorkspaceTemplates();
    const workspaceTemplates: WorkspacePaneWorkspaceTemplate[] = savedWorkspaceTemplates.map(({ id, name, lastUsedAt, swatchColor }) => ({ id, title: name, lastUsedAt, swatchColor }));
    const workspaceTemplatesById = new Map(workspaceTemplates.map((workspaceTemplate) => [workspaceTemplate.id, workspaceTemplate]));
    const workspaces = registry.list().map((entry) => {
      let workspaceTemplate: WorkspacePaneWorkspaceTemplate | undefined;
      if (isGitWorkspaceTemplateInit(entry.init)) {
        workspaceTemplate = workspaceTemplatesById.get(workspaceTemplateIdFromInit(entry.init)) ?? { id: workspaceTemplateIdFromInit(entry.init), title: entry.init.name };
      }
      return {
        id: entry.id,
        title: workspaceTitle(entry),
        active: entry.id === activeWorkspaceId,
        parked: entry.parked,
        workspaceTemplate,
        busy: entry.phase.busy,
        requestingAttention: entry.requestingAttention,
        attentionAt: entry.attentionAt,
        lastActivityAt: entry.lastActivityAt,
        busyAgentKeys: registry.busyAgents(entry.id),
        outdated: entry.imageOutdated,
        warnings: entry.warnings,
      };
    });
    return { workspaceTemplates, workspaces };
  }

  function workViewPresentations(workspaceId: string, currentWorkViews: readonly WorkspaceWorkViewPresentation[], storedWorkViews: readonly WorkspaceWorkViewState[]): WorkPaneContribution[] {
    const currentByKey = new Map(currentWorkViews.map((view) => [workViewKey(view.reference), view]));
    return storedWorkViews.map((stored) => {
      const key = workViewKey(stored.reference);
      const contribution = currentByKey.get(key);
      const view: WorkPaneContribution = {
        key,
        iconHtml: contribution?.iconHtml,
        label: contribution?.label ?? `${stored.reference.type} unavailable`,
        kind: contribution?.kind ?? "resource",
        availability: contribution?.availability ?? { phase: "unavailable", detail: "The referenced resource is not currently available." },
        close: workViewClose(workspaceId, stored.reference, contribution?.label ?? stored.reference.type),
      };
      if (contribution?.sourceKey !== undefined) view.sourceKey = contribution.sourceKey;
      if (contribution?.actionsHtml !== undefined) view.actionsHtml = contribution.actionsHtml;
      Object.assign(view, registry.surfaceState(workspaceId, key));
      return view;
    });
  }

  interface WorkspaceWarningState {
    warnings: WorkspaceWarning[];
    dismissedWarnings: Record<string, string>;
  }

  async function workspaceWarningState(entry: WorkspaceEntry, workspaceTemplate?: WorkspaceTemplateConfiguration): Promise<WorkspaceWarningState> {
    const [configuration, dismissedWarnings] = await Promise.all([
      workspaceTemplate ?? (isGitWorkspaceTemplateInit(entry.init) ? getWorkspaceTemplateConfiguration(workspaceTemplateIdFromInit(entry.init)) : undefined),
      presentationStore.dismissedWarnings(entry.id),
    ]);
    return { warnings: workspaceWarnings(entry, configuration), dismissedWarnings };
  }

  async function agentPaneContributions(workspaceId: string) {
    return (await agentTabs.list({ workspaceId })).map((agent) => ({
      ...agent,
      ...registry.agentState(workspaceId, `agent:${agent.id}`),
      close: agentClose(workspaceId, agent.id, agent.title),
    }));
  }

  async function workspacePresentationBundle(workspaceId: string): Promise<{
    presentation: FixedWorkspacePresentation;
    commandContributions: WorkspaceCommandContribution[];
    storedWorkViews: WorkspaceWorkViewState[];
    warningState: WorkspaceWarningState;
  }> {
    const entry = requireWorkspace(workspaceId);
    const attachments = await attachWorkspaceModules(workspaceId);
    const agents = await agentPaneContributions(workspaceId);
    const currentWorkViews = attachments.flatMap((attachment) => attachment.workViews ?? []);
    const storedWorkViews = await presentationStore.listWorkViews(workspaceId);
    const commandContributions: WorkspaceCommandContribution[] = [...attachments.flatMap((attachment) => attachment.commands ?? []),
      { id: "agent.create", label: "New Agent", scope: "workspace" },
      ...agentTypes.map((agentType) => ({ id: `agent.create.${agentType.id}`, label: `New ${agentType.label} agent`, scope: "workspace" as const })),
    ];
    const commands = commandContributions.map((command) => ({
      shortcutCommandId: command.surfaces?.ui?.shortcutCommandId,
      id: command.id, label: command.surfaces?.ui?.label ?? command.label, description: command.description, scope: command.scope, placement: command.surfaces?.ui?.placement, iconHtml: command.surfaces?.ui?.iconHtml, binding: command.surfaces?.shortcut?.defaultBinding,
    }));
    const warningState = await workspaceWarningState(entry);
    const intent = workPresentationIntents.get(workspaceId);
    const workPresentationIntent = intent && registry.surfaceState(workspaceId, intent.key).requestingAttention ? intent : undefined;
    const presentation: FixedWorkspacePresentation = {
      workspace: { id: entry.id, title: workspaceTitle(entry) },
      agentTypes: await orderedAgentTypes(),
      agents,
      workViews: workViewPresentations(workspaceId, currentWorkViews, storedWorkViews),
      commands,
      workPresentationIntent,
      warningsHtml: workspaceWarningsHtml(entry.id, warningState),
      overlayHtml: [...attachments.flatMap((attachment) => attachment.overlayHtml ?? []), ...workspaceSshTrustRequests(workspaceId).slice(-1).map(request => sshTrustPanel(workspaceId, request.records, request.host, request.port, request.changed, `/workspaces/${encodeURIComponent(workspaceId)}/ssh-trust/${encodeURIComponent(request.id)}`))],
    };
    return { presentation, commandContributions, storedWorkViews, warningState };
  }

  function workspaceWarningsHtml(workspaceId: string, { warnings, dismissedWarnings }: WorkspaceWarningState): string {
    return warnings.filter((warning) => dismissedWarnings[warning.kind] !== warning.state).map((warning) => warningBannerHtml({
      title: warning.title,
      message: warning.message,
      actionsHtml: warning.action ? actionLinkHtml({ href: warning.action.href, variant: "secondary", content: { kind: "caption", caption: warning.action.caption }, attributesHtml: 'data-turbo-stream="true"' }) : undefined,
      dismiss: { action: `/workspaces/${encodeURIComponent(workspaceId)}/warnings/${encodeURIComponent(warning.kind)}/dismiss`, state: warning.state },
    })).join("");
  }

  async function dismissWorkspaceWarning(id: string, kind: string, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    const state = requestAcceptsJson(request) ? (await readJsonObject(request)).state : (await request.formData()).get("state");
    const warningState = await workspaceWarningState(entry);
    const warning = warningState.warnings.find((candidate) => candidate.kind === kind && candidate.state === state);
    if (!warning) throw invalidArguments("warning is no longer current");
    await presentationStore.dismissWarning(id, kind, warning.state);
    invalidatePresentation();
    return requestAcceptsJson(request) ? jsonResponse({ dismissed: true }) : turboStreamResponse("");
  }

  /** The chrome holds every pane, empty; the selected panes' content has surfaces of its own. */
  function workspaceRegions(presentation: FixedWorkspacePresentation): readonly LiveRegion[] {
    const { html, islands } = renderWorkspacePresentation(presentation);
    return [{ target: workspaceMountId(presentation.workspace.id), html, children: islands }];
  }

  /** An Agent pane is published as its shell; the Agent's own channel publishes its content. */
  async function agentPaneSurface(workspaceId: string, agentId: string): Promise<SurfaceState> {
    // A closed Agent's pane leaves the chrome; its subscription ends with it.
    if (!(await agentTabs.list({ workspaceId })).some(agent => agent.id === agentId)) return { kind: "regions", regions: [] };
    const pane = await agentTabs.render({ workspaceId, agentId });
    return { kind: "regions", regions: [{ target: paneContentId(workspaceId, "agent-pane", agentId), html: pane.html }], live: pane.live };
  }

  async function workViewBodyRegions(workspaceId: string, key: string): Promise<LiveRegion[]> {
    const attachments = await attachWorkspaceModules(workspaceId);
    const storedWorkViews = await presentationStore.listWorkViews(workspaceId);
    const view = workViewPresentations(workspaceId, attachments.flatMap(attachment => attachment.workViews ?? []), storedWorkViews).find(candidate => candidate.key === key);
    // A closed Work view's pane leaves the chrome; an unavailable one keeps what its body last showed.
    if (!view || view.availability.phase === "unavailable") return [];
    const { reference } = storedWorkViews.find(stored => workViewKey(stored.reference) === key)!;
    return [{ target: paneContentId(workspaceId, "work-view-body", key), html: await workViewAdapterByType.get(reference.type)!.render({ workspaceId, reference }) }];
  }

  function workspaceBootMountHtml(entry: WorkspaceEntry): string {
    const workspaceTemplateId = workspaceTemplateIdOfInit(entry.init);
    const snapshot = provisioning.snapshot(entry.id);
    const failed = entry.phase.kind === "provisioningPhase" && entry.phase.status === "failed";
    // Waiting means a step failed and needs a decision; done is not a failure.
    const needsDecision = failed || snapshot?.status === "failed" || snapshot?.status === "waiting";
    const deleteButton = buttonHtml({ type: "submit", variant: "danger", content: { kind: "caption", caption: "Delete workspace" } });
    const deleteAction = needsDecision ? `<form class="workspace-boot-actions" method="post" action="/workspaces/${encodeURIComponent(entry.id)}/delete">${deleteButton}</form>` : "";
    const sourceFailure = snapshot?.steps.find((step) => step.id === "workspace.source" && step.status === "failed");
    const sourceError = `${sourceFailure?.output ?? ""}\n${sourceFailure?.error ?? ""}`;
    const needsSshKey = !!sourceFailure?.error && isSshAuthenticationFailure(sourceFailure.error);
    const hostFailure = sourceFailure && sshHostTrustFailure(sourceError);
    const missingHost = hostFailure && !hostFailure.changed ? hostFailure : undefined;
    const changedHost = hostFailure?.changed ?? sourceError.includes("REMOTE HOST IDENTIFICATION HAS CHANGED");
    const failureActionsHtml = (failed || sourceFailure) && workspaceTemplateId
      ? actionLinkHtml({ href: hostFailure ? `/workspaces/${encodeURIComponent(entry.id)}/ssh-trust` : `/workspace-templates/${encodeURIComponent(workspaceTemplateId)}/settings?section=${needsSshKey || changedHost ? "ssh-keys" : "repository"}`, variant: "primary", content: { kind: "caption", caption: hostFailure ? changedHost ? "Investigate changed SSH identity" : "Review SSH server identity" : needsSshKey ? "Add an SSH key" : "Open template settings" }, attributesHtml: 'data-turbo-stream="true"' })
      : "";
    const sourceFailureActions = sourceFailure ? {
      stepId: sourceFailure.id,
      description: missingHost ? `Kintsugi does not yet trust ${missingHost.host}. Verify its fingerprint before trusting it and retrying.` : changedHost ? "The server's identity changed. Do not retry until your administrator verifies the new key. Update Trusted SSH servers in template settings only after verification." : needsSshKey ? "SSH authentication failed. An SSH key with access to this repository may resolve this. Add it to this template, then retry." : undefined,
      actionsHtml: failureActionsHtml,
    } : undefined;
    const inner = `${renderWorkspaceProvisioning(entry.id, snapshot, { failed, error: entry.phase.error, failureActions: sourceFailureActions })}${sourceFailure ? "" : failureActionsHtml}${deleteAction}`;
    const trustPanel = hostTrustPanels.get(entry.id);
    const overlay = trustPanel ? sshTrustPanel(entry.id, trustPanel.records, trustPanel.host, trustPanel.port, changedHost, `/workspaces/${encodeURIComponent(entry.id)}/ssh-trust`) : "";
    return `<div class="workspace-boot"><div class="main"${trustPanel ? " inert" : ""}><div class="body"><div class="workspace-boot-progress"><div class="workspace-boot-content">${inner}</div></div>${provisioningLaunchPanels.get(entry.id) ?? ""}</div></div>${renderMobileWorkspaceBar("", "", !!trustPanel)}${overlay}</div>`;
  }

  function emptyWorkspaceArtworkHtml(pane: WorkspacePanePresentation): string {
    const firstWorkspace = pane.workspaces.length === 0;
    return `<section id="workspace_empty_artwork" class="workspace-empty-artwork"${firstWorkspace ? ' data-controller="first-workspace-guide"' : ""}>
      <div${firstWorkspace ? ' data-first-workspace-guide-target="origin"' : ""}>${welcomeBrandHtml()}</div>
      ${firstWorkspace ? `<svg class="workspace-empty-arrow" aria-hidden="true" data-first-workspace-guide-target="svg">
        <defs><marker id="workspace-empty-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z"></path></marker></defs>
        <path data-first-workspace-guide-target="path" marker-end="url(#workspace-empty-arrowhead)"></path>
      </svg>` : ""}
    </section>`;
  }

  function workspaceMounts(selectedId?: string): string {
    // Mounts are invisible siblings, not the sorted workspace list. Keep their DOM order stable
    // when attention clears and the list reorders; moving a permanent mount disconnects it.
    return registry.list().filter(entry => !entry.parked).sort((a, b) => a.id.localeCompare(b.id)).map(entry => `<div id="${workspaceMountId(entry.id)}" class="workspace-detail-mount${entry.id === selectedId ? " visible" : ""}" data-turbo-permanent data-workspace-selection-target="mount" data-workspace-id="${escapeHtml(entry.id)}" data-controller="live-surface" data-live-surface-workspace-value="${escapeHtml(entry.id)}" data-live-surface-kind-value="workspace" data-live-surface-eager-value="${entry.id === selectedId}"></div>`).join("");
  }

  function workspaceUnavailableHtml(entry: WorkspaceEntry, message?: string): string {
    const retry = actionLinkHtml({ href: `/workspaces/${encodeURIComponent(entry.id)}?retryPane=1`, variant: "secondary", content: { kind: "caption", caption: "Retry workspace" } });
    const status = message ? warningBannerHtml({ title: "Workspace unavailable", message, role: "alert", actionsHtml: retry })
      : '<div class="workspace-detail-loading-status" role="status"><span class="status-spinner" aria-hidden="true"></span> Loading workspace…</div>';
    return `<div class="workspace-boot"><div class="main"><div class="body"><h2>${escapeHtml(workspaceTitle(entry))}</h2>${status}<p>You can use other workspaces and Settings while this workspace is unavailable.</p><p>${connectionSettingsLink}</p><p>Force parking stops its processes and closes terminal and VS Code views.</p><form method="post" action="/workspaces/${encodeURIComponent(entry.id)}/park?force=1" data-action="submit->workspace-navigation#parkWorkspace">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Force park workspace" } })}</form></div></div></div>`;
  }

  async function workspaceDetailHostHtml(pane: WorkspacePanePresentation, selectedId?: string, initialSelection?: InitialWorkspaceSelection): Promise<string> {
    const entry = selectedId ? requireWorkspace(selectedId) : undefined;
    // HTTP shell/navigation must not depend on a workspace container responding.
    // Its existing live surface loads the selected workspace after the shell is usable.
    const selectedHtml = !entry ? "" : entry.phase.kind === "runningPhase"
      ? workspaceUnavailableHtml(entry)
      : workspaceBootMountHtml(entry);
    return `<div id="workspace_detail" class="workspace-detail-host" data-controller="workspace-selection" data-workspace-selection-max-preloaded-value="5">
      <div class="workspace-detail-empty" data-workspace-selection-target="empty"${selectedId ? " hidden" : ""}>${emptyWorkspaceArtworkHtml(pane)}</div>
      <div class="workspace-detail-loading" data-workspace-selection-target="loading" hidden><div><div class="workspace-detail-loading-status" role="status"><span class="status-spinner" aria-hidden="true"></span> Loading workspace…</div><p>${connectionSettingsLink}</p></div></div>
      <div id="workspace_mounts" style="display:contents">${entry ? placeLiveRegions(workspaceMounts(selectedId), [{target: workspaceMountId(entry.id), html: selectedHtml}], workspaceMountId(entry.id)) : workspaceMounts(selectedId)}</div>
    </div>`;
  }

  type ShellSurface =
    | { kind: "module-modal"; dialogHtml: string }
    | { kind: "workspace-template-editor"; dialogHtml: string }
    | { kind: "template-settings"; html: string }
    | { kind: "new-workspace"; workspaceTemplate?: WorkspaceTemplateSummary }
    | { kind: "settings"; request: Request; section: string | undefined; developerTools?: true }
    | { kind: "models"; focus: string | undefined };

  async function renderWorkspaceShell(selectedId?: string, surface?: ShellSurface, initialSelection?: InitialWorkspaceSelection): Promise<string> {
    const pane = await workspacePaneCollections(selectedId ?? "");
    const workspaceTemplateEditor = surface?.kind === "workspace-template-editor" ? surface.dialogHtml : '<div id="workspace-template-editor-modal"></div>';
    const settings = surface?.kind === "settings"
      ? surface.developerTools ? await renderDeveloperToolsSettings(surface.request) : await renderAppSettings(surface.request, surface.section)
      : surface?.kind === "models" ? await renderModelsDialog({ focus: surface.focus })
      : "";
    const launchComposer = surface?.kind === "new-workspace"
      ? await renderLaunchComposerFrame(surface.workspaceTemplate)
      : `<turbo-frame id="${launchComposerFrameId}"></turbo-frame>`;
    return `<div class="app fixed-shell-app" data-controller="kintsugi-shortcuts workspace-navigation">
    ${renderWorkspacePane(pane, renderGlobalSidebarContributions(), workspaceModules.map((module) => module.renderWorkspacePaneActions?.() ?? "").join(""), launchComposerCommand.binding)}
    <main class="fixed-shell-app-main">${await workspaceDetailHostHtml(pane, selectedId, initialSelection)}${surface?.kind === "template-settings" ? surface.html : `<div id="${templateSettingsHostId}"></div>`}<div id="app_settings_host">${surface?.kind === "settings" ? settings : ""}</div></main>
    ${renderKintsugiBar()}
  </div>
  ${workspaceTemplateEditor}
  <div id="update_modal_host"></div>
  <div id="settings_modal_host">${surface?.kind === "models" ? settings : ""}</div>
  <turbo-frame id="${workspaceModuleModalFrameId}">${surface?.kind === "module-modal" ? surface.dialogHtml : ""}</turbo-frame>
  <div id="onboarding_modal_host">${await renderOnboardingDialog()}</div>
  <div id="${workspaceCommandModalHostId}"></div>
  ${launchComposer}`;
  }

  async function homePage(): Promise<Response> {
    const selected = registry.list().find((entry) => !entry.parked);
    return response(layout(await renderWorkspaceShell(selected?.id)));
  }

  async function workspaceTemplateEditorResponse(request: Request, options: WorkspaceTemplateEditorOptions): Promise<Response> {
    if (options.kind === "settings" && request.headers.get("turbo-frame") === templateSettingsFrameId) {
      return response(await workspaceTemplateRoutes.settingsFrame(options.workspaceTemplateId, options));
    }
    const html = await workspaceTemplateRoutes.editorHtml(options);
    if (options.kind === "settings") return wantsStream(request)
      ? turboStreamResponse(replace(templateSettingsHostId, html))
      : surfacePage({ kind: "template-settings", html });
    return wantsStream(request)
      ? turboStreamResponse(replace("workspace-template-editor-modal", html))
      : surfacePage({ kind: "workspace-template-editor", dialogHtml: html });
  }

  async function surfacePage(surface: ShellSurface): Promise<Response> {
    const selected = registry.list().find((entry) => !entry.parked);
    return response(layout(await renderWorkspaceShell(selected?.id, surface)));
  }

  function requireWorkspace(id: string): WorkspaceEntry {
    const entry = registry.get(id);
    if (!entry) throw new KintsugiCoreError("workspace_not_found", `workspace not found: ${id}`);
    return entry;
  }

  function workViewSummaries(id: string, views: WorkspaceWorkViewState[]) {
    return views.map((view) => ({ key: workViewKey(view.reference), ...view, ...registry.surfaceState(id, workViewKey(view.reference)) }));
  }

  function workspaceSummary(entry: WorkspaceEntry) {
    const workspace: Pick<WorkspaceEntry, "id" | "phase" | "parked" | "requestingAttention" | "warnings"> & { title: string; workspaceTemplateId?: string } = {
      id: entry.id,
      title: workspaceTitle(entry),
      phase: entry.phase,
      parked: entry.parked,
      requestingAttention: entry.requestingAttention,
    };
    if (entry.warnings?.length) workspace.warnings = entry.warnings;
    return workspace;
  }

  async function workspaceJson(id: string): Promise<Response> {
    const entry = requireWorkspace(id);
    const workspace = { ...workspaceSummary(entry), url: `/workspaces/${encodeURIComponent(entry.id)}` };
    if (entry.parked || entry.phase.kind !== "runningPhase") return jsonResponse({ workspace });

    const { presentation, commandContributions, storedWorkViews, warningState } = await workspacePresentationBundle(id);
    const handlers = new Map(workspaceModuleCommands().map((handler) => [handler.id, handler]));
    return jsonResponse({ workspace: {
      ...workspace,
      ...warningState,
      agents: presentation.agents.map(({ id, title, agentTypeId, busy, requestingAttention }) => ({ id, title, agentTypeId, busy, requestingAttention })),
      workViews: workViewSummaries(id, storedWorkViews),
      commands: commandContributions.filter((command) => handlers.has(command.id)).map((command) => ({
        id: command.id,
        label: command.label,
        description: command.description,
        scope: command.scope,
        inputSchema: handlers.get(command.id)?.inputSchema ?? command.inputSchema ?? emptyWorkspaceCommandInputSchema,
      })),
    } });
  }

  function workspaceListEndpoint(request: Request, url: URL): Response {
    if (!requestAcceptsJson(request)) return Response.redirect(new URL("/", url).toString(), 302);
    return jsonResponse({ workspaces: registry.list().map((entry) => {
      const workspace = workspaceSummary(entry);
      if (isGitWorkspaceTemplateInit(entry.init)) workspace.workspaceTemplateId = workspaceTemplateIdFromInit(entry.init);
      return workspace;
    }) });
  }

  async function workspacePage(id: string, request: Request): Promise<Response> {
    if (new URL(request.url).searchParams.get("retryPane") === "1") invalidateWorkspace(id);
    if (requestAcceptsJson(request)) return await workspaceJson(id);
    const entry = requireWorkspace(id);
    if (entry.parked) return Response.redirect(new URL("/", request.url).toString(), 302);
    const params = new URL(request.url).searchParams;
    return response(layout(await renderWorkspaceShell(id, undefined, { agent: params.get("agent") ?? undefined, workView: params.get("workView") ?? undefined }), workspacePageTitle(workspaceTitle(entry))));
  }

  // ---------------------------------------------------------------------------
  // Create / delete
  // ---------------------------------------------------------------------------

  function startWorkspaceProvisioning(id: string, options: { init?: WorkspaceInitInstruction; context?: WorkspaceCreationContext; title?: string } = {}): void {
    void (async () => {
      try {
        await provisioning.run(id, (run) => deps.provisionWorkspace(id, { init: options.init, context: options.context, run }));
        const entry = registry.get(id);
        if (!entry || entry.phase.deletion) return;
        const warnings = provisioning.snapshot(id)!.steps.filter((step) => step.status === "warning");
        if (warnings.length) registry.setWarning(id, "preparation", warnings.map((step) => `${step.label}: ${step.error} Continued despite this failure.`).join("\n"));
        if (options.title) await setWorkspaceTitle(id, options.title);
        registry.startRunning(id);
        const launchPrompt = options.context?.agent?.initialPrompt?.trim();
        if (!options.title && launchPrompt && !options.context?.agent?.initialPromptMode) {
          maybeNameWorkspaceFromPrompt(id, launchPrompt, {
            events: deps.events,
            agentModel: options.context?.agent?.model ? parseModelRef(options.context.agent.model) : undefined,
            onFailure: (message) => { if (registry.get(id)) registry.setWarning(id, "naming", `Couldn't name this workspace (${message}). You can name it with /name in the Kintsugi composer.`); },
          });
        }
        if (options.context?.agent?.initialPrompt !== undefined && !options.context.agent.initialPrompt.trim()) registry.requestAttention(id);
      } catch (error) {
        const entry = registry.get(id);
        if (!entry || entry.phase.deletion) return;
        const message = errorMessage(error);
        logError(`could not provision workspace ${id}: ${message}`);
        registry.setProvisioningState(id, "failed", message);
      }
    })();
  }

  interface CreatedWorkspace {
    id: string;
    isFirstWorkspace: boolean;
  }

  async function createWorkspaceFromCommand(command: { init?: WorkspaceInitInstruction; agent?: JsonObject; context?: WorkspaceCreationContext; title?: string }): Promise<CreatedWorkspace> {
    const isFirstWorkspace = registry.list().length === 0;
    const id = generateWorkspaceId();
    const init = command.init;
    const title = command.title?.trim() ?? "";
    let context = command.context;
    if (!context) {
      const agentTypeId = stringField(command.agent?.agentTypeId, "agent.agentTypeId");
      const agentType = agentTypeId ? getAgentType(agentTypeId) : await defaultAgentType();
      const initialPrompt = stringField(command.agent?.initialPrompt, "agent.initialPrompt");
      const attachmentDraft = stringField(command.agent?.attachmentDraft, "agent.attachmentDraft");
      if (attachmentDraft && !validDraftId(attachmentDraft)) throw invalidArguments("Invalid attachment draft");
      const prepared = await agentType.launch.prepare(command.agent);
      context = { ...prepared, agent: { ...prepared?.agent, initialPrompt, attachmentDraft, agentTypeId: agentType.id } };
    }
    if (context?.agent?.initialPrompt) {
      const agent = context.agent;
      const query = new URLSearchParams();
      if (agent.model) query.set("model", agent.model);
      if (agent.thinkingLevel) query.set("thinkingLevel", agent.thinkingLevel);
      const settingsHtml = await renderLaunchAgentType(getAgentType(agent.agentTypeId ?? "builtin"), [], {
        ...launchComposerFooterContext(query), readOnly: true,
      });
      provisioningLaunchPanels.set(id, renderWorkspaceLaunchPrompt(agent.initialPrompt, settingsHtml));
    }
    registry.add(id, title || null, init);
    const options: Parameters<typeof startWorkspaceProvisioning>[1] = {};
    if (init !== undefined) options.init = init;
    if (context) options.context = context;
    if (title) options.title = title;
    startWorkspaceProvisioning(id, options);
    return { id, isFirstWorkspace };
  }

  function workspaceCreatedJsonResponse(id: string): Response {
    const location = `/workspaces/${encodeURIComponent(id)}`;
    return jsonResponse({ workspace: { id, phase: requireWorkspace(id).phase, requestingAttention: requireWorkspace(id).requestingAttention, url: location } }, { status: 202, headers: { location } });
  }

  async function createWorkspaceEndpoint(request: Request): Promise<Response> {
    if (requestAcceptsJson(request)) {
      const body = await readWorkspaceCreateJson(request);
      const sourceType = stringField(body.source?.type, "source.type") ?? "empty";
      if (sourceType !== "empty" && sourceType !== "workspace-template") throw invalidArguments("source.type must be empty or workspace-template");
      const workspaceTemplateReference = stringField(body.source?.workspaceTemplate, "source.workspaceTemplate");
      let init: WorkspaceInitInstruction | undefined;
      if (sourceType === "workspace-template") {
        if (!workspaceTemplateReference) throw invalidArguments("source.workspaceTemplate is required for workspace-template workspaces");
        init = workspaceInitFromTemplate(await workspaceTemplateRoutes.byReference(workspaceTemplateReference));
      }
      const { id } = await createWorkspaceFromCommand({ init, title: stringField(body.title, "title"), agent: body.agent });
      return workspaceCreatedJsonResponse(id);
    }

    // The template picker posts a form; automation and older callers may post no body at all.
    const form = request.headers.get("content-type")?.includes("form") ? await request.formData() : undefined;
    const workspaceTemplateReference = String(form?.get("workspaceTemplate") ?? "");
    const init = workspaceTemplateReference ? workspaceInitFromTemplate(await workspaceTemplateRoutes.byReference(workspaceTemplateReference)) : undefined;
    const { id } = await createWorkspaceFromCommand({ init });
    const location = `/workspaces/${encodeURIComponent(id)}`;
    if (wantsStream(request)) return turboStreamResponse(selectWorkspaceTurboStream(id), { headers: { location } });
    return new Response(null, { status: 303, headers: { location } });
  }

  async function createAgentWorkspaceFromForm(request: Request, options: { workspaceTemplate?: WorkspaceTemplateSummary } = {}): Promise<Response> {
    const form = await request.formData();
    const submissionId = String(form.get("attachmentDraft") ?? "");
    if (!validDraftId(submissionId)) throw invalidArguments("Invalid attachment draft");
    const agentType = getAgentType(String(form.get("agentTypeId") ?? "builtin"));
    const submission = await agentType.launch.submit(form);
    if ("response" in submission) return submission.response;
    let launch = launchComposerSubmissions.get(submissionId);
    if (!launch) {
      launch = (async () => {
        const prepared = await submission.prepare();
        return createWorkspaceFromCommand({
          init: options.workspaceTemplate ? workspaceInitFromTemplate(options.workspaceTemplate) : undefined,
          context: { ...prepared, agent: { ...prepared.agent, agentTypeId: agentType.id, initialPrompt: String(form.get("text") ?? ""), attachmentDraft: submissionId } },
        });
      })();
      launchComposerSubmissions.set(submissionId, launch);
    }
    const { id, isFirstWorkspace } = await launch;
    return turboStreamResponse(`${update(launchComposerFrameId, "")}${isFirstWorkspace || new URL(request.url).searchParams.get("autoSelect") === "true" ? selectWorkspaceTurboStream(id) : ""}`);
  }

  async function createEmptyAgentWorkspaceEndpoint(request: Request): Promise<Response> {
    return await createAgentWorkspaceFromForm(request);
  }

  type WorkspaceCreateJsonBody = {
    source?: JsonObject;
    title?: JsonValue;
    agent?: JsonObject;
  };

  async function readWorkspaceCreateJson(request: Request): Promise<WorkspaceCreateJsonBody> {
    const record = await readJsonObject(request);
    const { source, title, agent } = record;
    if (source !== undefined && !isJsonObject(source)) throw invalidArguments("source must be an object");
    if (agent !== undefined && !isJsonObject(agent)) throw invalidArguments("agent must be an object");
    return { source, title, agent };
  }

  function stringField(value: JsonValue | undefined, name: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Value.Check(jsonStringSchema, value)) throw invalidArguments(`${name} must be a string`);
    return value.trim();
  }

  function deletionPresentation(entry: WorkspaceEntry, state: WorkspaceDeletionState): string {
    const details = state.status === "blocked" ? deletion.evidence(entry.id) : undefined;
    const evidence = details === undefined ? undefined : deletionReview.renderEvidence(entry.id, details);
    return renderWorkspaceDeletionPresentation(entry.id, state, evidence);
  }

  async function forceDeleteAllWorkspacesFromSettings(): Promise<{ deleted: number; errors: string[] }> {
    const { workspaces } = await listWorkspaces();
    return deletion.destroyAll(workspaces.map((workspace) => workspace.id));
  }

  function deleteCurrentWorkspaceFromAgent(id: string, force: boolean): Promise<DeleteCurrentWorkspaceResult> {
    return deletion.request(id, { force });
  }

  function sshTrustPanel(workspaceId: string, records: { line: string; fingerprint: string }[], host: string, port: number, changed: boolean, action: string): string {
    const server = port === 22 ? host : `${host}:${port}`;
    const keys = records.map(({ line, fingerprint }) => `<p><label><input type="checkbox" name="key" value="${escapeHtml(line)}" checked> <strong>${escapeHtml(line.split(" ")[1] ?? "SSH key")}</strong> <code>${escapeHtml(fingerprint)}</code></label></p>`).join("");
    const warning = changed
      ? `<p>Your workspace is trying to SSH into <strong>${escapeHtml(server)}</strong>.</p><p>We have ssh'd into this address in the past, but the fingerprint the remote machine reports now is different from what it reported previously.</p><p>If you updated the machine, this is expected.</p><p>If you didn't update the machine, it might mean someone may be trying to impersonate it.</p>`
      : `<p>Kintsugi received these public keys from <strong>${escapeHtml(server)}</strong>. A network scan does not prove this is the real server. Compare the fingerprints with a trusted source or your administrator before continuing.</p>`;
    const formId = domId("ssh_trust_form", workspaceId);
    const body = `${warning}<form id="${formId}" method="post" action="${escapeHtml(action)}" data-turbo="true">${keys}${changed ? `<p><label>Type <strong>${escapeHtml(server)}</strong> to confirm: <input class="text-field" name="confirmation" autocomplete="off" required></label></p>` : ""}</form>`;
    const footer = `<form method="post" action="${escapeHtml(action)}/reject" data-turbo="true">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Don't trust" } })}</form>${buttonHtml({ type: "submit", variant: changed ? "secondary" : "primary", content: { kind: "caption", caption: changed ? "Trust changed identity" : "Trust verified keys" }, attributesHtml: `form="${formId}"` })}`;
    return `<div class="workspace-ssh-trust-overlay" role="presentation" data-controller="workspace-ssh-trust">${panelHtml({ element: { tag: "section", attributesHtml: `role="dialog" aria-label="${escapeHtml(changed ? `SSH identity changed: ${server}` : `Trust SSH server ${server}?`)}"` }, headerHtml: `<h2 class="panel__title">${escapeHtml(changed ? `SSH identity changed: ${server}` : `Trust SSH server ${server}?`)}</h2>`, bodyHtml: body, bodyLayout: "padded", bodyOverflow: "scroll", footerHtml: footer })}</div>`;
  }

  async function workspaceSshTrustEndpoint(id: string, request: Request, reject = false): Promise<Response> {
    const entry = requireWorkspace(id);
    const snapshot = provisioning.snapshot(id);
    const source = snapshot?.steps.find((step) => step.id === "workspace.source" && step.status === "failed");
    const address = source && sshHostTrustFailure(`${source.output ?? ""}\n${source.error ?? ""}`);
    if (!isGitWorkspaceTemplateInit(entry.init) || !address || snapshot?.waiting?.stepId !== "workspace.source" || !snapshot.waiting.retryable) {
      throw new KintsugiCoreError("workspace_not_ready", "This workspace is not waiting for SSH server trust");
    }
    if (request.method === "POST") {
      if (!reject) {
        const candidate = await scanSshHost(address.host, address.port);
        const form = await request.formData();
        if (address.changed && form.get("confirmation") !== (address.port === 22 ? address.host : `${address.host}:${address.port}`)) throw invalidArguments("Confirm the changed server identity before trusting it");
        await trustScannedSshHost(workspaceTemplateIdFromInit(entry.init), candidate, form.getAll("key").map(String));
        provisioning.resume(id, "retry");
      }
      hostTrustPanels.delete(id);
    } else hostTrustPanels.set(id, await scanSshHost(address.host, address.port));
    invalidateWorkspace(id);
    return wantsStream(request) ? turboStreamResponse(replace(workspaceMountId(id), workspaceBootMountHtml(entry))) : workspacePage(id, request);
  }

  async function workspaceRuntimeSshTrustEndpoint(id: string, trustId: string, request: Request, reject = false): Promise<Response> {
    requireWorkspace(id);
    const pending = workspaceSshTrustRequests(id).find(item => item.id === trustId);
    if (!pending) throw new KintsugiCoreError("workspace_not_ready", "The SSH trust request has expired");
    const form = reject ? undefined : await request.formData();
    if (pending.changed && !reject && form?.get("confirmation") !== (pending.port === 22 ? pending.host : `${pending.host}:${pending.port}`)) throw invalidArguments("Confirm the changed server identity before trusting it");
    await decideWorkspaceSshTrust(id, trustId, reject ? [] : form!.getAll("key").map(String));
    return turboStreamResponse("");
  }

  function continueWorkspaceProvisioningEndpoint(id: string, request: Request): Response {
    const entry = requireWorkspace(id);
    if (entry.phase.kind !== "provisioningPhase") throw new KintsugiCoreError("workspace_not_ready", `workspace ${id} is not waiting for provisioning confirmation`);
    const action = new URL(request.url).searchParams.get("action");
    if (action !== null && action !== "retry") throw invalidArguments("Unknown provisioning action");
    const stepId = provisioning.resume(id, action === "retry" ? "retry" : "continue");
    if (requestAcceptsJson(request)) return jsonResponse({ continued: true, stepId });
    return turboStreamResponse("");
  }

  async function deleteWorkspaceEndpoint(id: string, request: Request): Promise<Response> {
    if (!deletion.canRequest(id)) {
      if (requestAcceptsJson(request)) return jsonResponse({ error: { code: "workspace_not_ready", message: `workspace ${id} is not ready for deletion` } }, { status: 409 });
      return turboStreamResponse("", { status: 409 });
    }
    const force = requestAcceptsJson(request)
      ? (await readJsonObject(request)).force === true
      : new URL(request.url).searchParams.get("force") === "1";
    const result = await deletion.request(id, { force });
    if (requestAcceptsJson(request)) return jsonResponse(result);
    return turboStreamResponse("");
  }

  function cancelWorkspaceDeletionEndpoint(id: string, request: Request): Response {
    if (!deletion.cancel(id)) return turboStreamResponse("", { status: 409 });
    // The registry phase change restores the mount through the same path as startup.
    return requestAcceptsJson(request) ? jsonResponse({ cancelled: true }) : turboStreamResponse("");
  }

  async function confirmWorkspaceDeletionEndpoint(id: string, request: Request): Promise<Response> {
    const fingerprint = String((await request.formData()).get("fingerprint") ?? "");
    const result = await deletion.request(id, { fingerprint });
    if (requestAcceptsJson(request)) return jsonResponse(result);
    return turboStreamResponse("");
  }

  async function retryWorkspaceDeletionEndpoint(id: string, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    if (entry.phase.deletion?.status !== "failed") return turboStreamResponse("", { status: 409 });
    const result = await deletion.request(id);
    if (requestAcceptsJson(request)) return jsonResponse(result);
    return turboStreamResponse("");
  }

  async function requestWorkspaceParkedState(id: string, parked: boolean, force = false): Promise<
    { kind: "confirmation"; workViews: WorkspaceWorkViewState[] } | { kind: "updated"; stream: string }
  > {
    const mutate = async () => {
      const entry = requireWorkspace(id);
      if (entry.phase.kind !== "runningPhase" && !(parked && force && !entry.phase.deletion)) throw new KintsugiCoreError("workspace_not_ready", `workspace ${id} is not ready`);
      const affected = parked ? (await presentationStore.listWorkViews(id)).filter(({ reference }) => reference.type === "terminal" || reference.type === "vscode") : [];
      if (affected.length && !force) return { kind: "confirmation" as const, workViews: affected };
      for (const { reference } of affected) {
        if (force) { await presentationStore.closeWorkView(id, reference); registry.clearSurfaceAttention(id, workViewKey(reference)); }
        else await closeWorkView(id, reference);
      }
      if (entry.parked !== parked) {
        if (parked) parking.add(id);
        try {
          await persistWorkspaceParked(id, parked, !parked, force);
        } finally {
          parking.delete(id);
        }
        suppressParkedStateCallbacks = true;
        registry.setParked(id, parked);
        if (parked && entry.phase.kind !== "runningPhase") registry.startRunning(id);
        suppressParkedStateCallbacks = false;
      }
      const parkConfirmationDismissal = parked ? dismissWorkspaceParkConfirmationTurboStream(id) : "";
      const stream = `${parkConfirmationDismissal}`;
      invalidatePresentation();
      return { kind: "updated" as const, stream };
    };
    return parked && force ? mutate() : serializePresentationMutation(id, mutate);
  }

  async function parkWorkspaceEndpoint(id: string, parked: boolean, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    if (entry.phase.kind !== "runningPhase" && !(parked && new URL(request.url).searchParams.get("force") === "1" && !entry.phase.deletion)) return requestAcceptsJson(request)
      ? jsonResponse({ error: { code: "workspace_not_ready", message: `workspace ${id} is not ready` } }, { status: 409 })
      : wantsStream(request) ? turboStreamResponse("", { status: 409 }) : response("Workspace is not ready", { status: 409 });
    const force = new URL(request.url).searchParams.get("force") === "1";
    const result = await requestWorkspaceParkedState(id, parked, force);
    if (result.kind === "confirmation") {
      if (requestAcceptsJson(request)) return jsonResponse({ error: { code: "workspace_park_confirmation_required", message: "Terminal sessions and VS Code views cannot recover after parking." }, workViews: result.workViews }, { status: 409 });
      const confirmation = renderWorkspaceParkConfirmation(id, workspaceTitle(entry), result.workViews);
      return wantsStream(request)
        ? turboStreamResponse(update(workspaceModuleModalFrameId, confirmation))
        : await surfacePage({ kind: "module-modal", dialogHtml: confirmation });
    }
    if (requestAcceptsJson(request)) return jsonResponse({ workspace: { id, parked } });
    if (wantsStream(request)) return turboStreamResponse(result.stream);
    return Response.redirect(request.headers.get("referer") ?? "/", 303);
  }

  // ---------------------------------------------------------------------------
  // Titles
  // ---------------------------------------------------------------------------

  async function updateWorkspaceSidebarTitle(id: string, request: Request): Promise<Response> {
    requireWorkspace(id);
    const title = requestAcceptsJson(request)
      ? stringField((await readJsonObject(request)).title, "title") ?? ""
      : String((await request.formData()).get("title") ?? "").trim();
    await setWorkspaceTitle(id, title);
    registry.setTitle(id, title || null);
    return requestAcceptsJson(request) ? await workspaceJson(id) : turboStreamResponse("");
  }

  function workspaceModuleCommands(): WorkspaceModuleCommandHandler[] {
    const create = async (workspaceId: string, agentTypeId?: string) => {
      const agentType = agentTypeId ? getAgentType(agentTypeId) : await defaultAgentType();
      const createdAgentId = await agentType.create({ workspaceId, events: deps.events });
      await rememberAgentType(agentType.id, deps.events);
      return { createdAgentId };
    };
    return [
      ...workspaceModules.flatMap((module) => module.commands ?? []),
      { id: "agent.create", execute: ({ workspaceId }) => create(workspaceId) },
      ...agentTypes.map((agentType): WorkspaceModuleCommandHandler => ({ id: `agent.create.${agentType.id}`, execute: ({ workspaceId }) => create(workspaceId, agentType.id) })),
    ];
  }

  function workspaceModuleRoutes(): WorkspaceModuleRouteHandler[] {
    return workspaceModules.flatMap((module) => module.routes ?? []);
  }

  async function commandInput<Input>(request: Request, command: WorkspaceModuleCommandHandler<Input>): Promise<Input> {
    let input = {};
    if (requestAcceptsJson(request)) {
      const text = await request.text();
      if (text.trim()) {
        try { input = JSON.parse(text); } catch { throw invalidArguments("valid JSON command input is required"); }
      }
    }
    if (!isJsonObject(input)) throw invalidArguments("JSON command input must be an object");
    const schema = command.inputSchema ?? emptyWorkspaceCommandInputSchema;
    // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
    if (!Value.Check(schema as never, input)) {
      // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
      const issue = [...Value.Errors(schema as never, input)][0];
      throw invalidArguments(`invalid ${command.id} input: ${issue?.message ?? "schema check failed"}`);
    }
    // SAFETY: the command-owned schema validated input against the handler's Input contract.
    return input as Input;
  }

  async function executeWorkspaceCommand(workspaceId: string, commandId: string, request: Request): Promise<WorkspaceModuleCommandResult> {
    const commands = workspaceModuleCommands();
    const command = commands.find((candidate) => candidate.id === commandId);
    if (!command) throw new KintsugiCoreError("command_not_found", `workspace command not found: ${commandId}`, { availableCommands: commands.map((candidate) => candidate.id) });
    return await command.execute({ workspaceId, events: deps.events, input: await commandInput(request, command) });
  }

  async function openAvailableWorkView(workspaceId: string, reference: WorkspaceWorkViewReference) {
    const key = workViewKey(reference);
    const attachments = await attachWorkspaceModules(workspaceId);
    const contribution = attachments.flatMap((attachment) => attachment.workViews ?? []).find((view) => workViewKey(view.reference) === key);
    if (!contribution) throw new KintsugiCoreError("work_view_not_found", `Work view is not available: ${key}`);
    await presentationStore.openWorkView(workspaceId, contribution.reference);
    return { reference: contribution.reference, key };
  }

  async function openWorkspaceModuleWorkView(workspaceId: string, reference: WorkspaceWorkViewReference, request: Request, options: { select?: boolean } = {}): Promise<Response> {
    return await serializePresentationMutation(workspaceId, async () => {
      const { key } = await openAvailableWorkView(workspaceId, reference);
      // Navigation GETs can open a view too; they do not pass through the POST invalidation path.
      invalidateWorkspace(workspaceId);
      return turboStreamResponse(options.select === false || (requestAcceptsJson(request) && !wantsStream(request)) ? "" : presentWorkViewTurboStream(workspaceId, key));
    });
  }

  async function workspaceCommandEndpoint(workspaceId: string, commandId: string, request: Request): Promise<Response> {
    const result = await executeWorkspaceCommand(workspaceId, commandId, request);
    let createdWorkView: WorkspaceWorkViewReference | undefined;
    if (result.createdWorkView) {
      ({ reference: createdWorkView } = await openAvailableWorkView(workspaceId, result.createdWorkView));
    }
    const origin = `${result.createdAgentId ? selectAgentTurboStream(workspaceId, result.createdAgentId) : ""}${createdWorkView ? presentWorkViewTurboStream(workspaceId, workViewKey(createdWorkView)) : ""}${result.streamHtml ?? ""}`;
    if (requestAcceptsJson(request) && !wantsStream(request)) {
      const command: WorkspaceCommandResponse = { id: commandId };
      if (createdWorkView) command.workView = createdWorkView;
      if (result.createdAgentId) command.agentId = result.createdAgentId;
      return jsonResponse({ command, workViews: workViewSummaries(workspaceId, await presentationStore.listWorkViews(workspaceId)) });
    }
    return turboStreamResponse(origin);
  }

  async function closeWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void> {
    await workViewAdapterByType.get(reference.type)!.close?.({ workspaceId, reference });
    await presentationStore.closeWorkView(workspaceId, reference);
    if (workPresentationIntents.get(workspaceId)?.key === workViewKey(reference)) workPresentationIntents.delete(workspaceId);
    registry.clearSurfaceAttention(workspaceId, workViewKey(reference));
  }

  async function closeWorkViewEndpoint(workspaceId: string, encodedReference: string, request: Request): Promise<Response> {
    // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
    const reference = JSON.parse(encodedReference) as WorkspaceWorkViewReference;
    const adapter = workViewAdapterByType.get(reference.type);
    if (!adapter) throw new KintsugiCoreError("work_view_reference_invalid", `unknown Work view type: ${reference.type}`);
    const parsed = adapter.parseReference(reference);
    const before = await presentationStore.listWorkViews(workspaceId);
    if (!before.some(view => workViewKey(view.reference) === workViewKey(parsed))) throw new KintsugiCoreError("work_view_not_found", `Work view is not open: ${workViewKey(parsed)}`);
    await closeWorkView(workspaceId, parsed);
    if (requestAcceptsJson(request) && !wantsStream(request)) return jsonResponse({ closed: parsed, workViews: workViewSummaries(workspaceId, await presentationStore.listWorkViews(workspaceId)) });
    return turboStreamResponse("");
  }

  async function reorderWorkViewEndpoint(workspaceId: string, request: Request): Promise<Response> {
    const body = parseReorderWorkViewRequest(await readJsonObject(request));
    const stored = (await presentationStore.listWorkViews(workspaceId)).find((view) => workViewKey(view.reference) === body.key);
    if (!stored) throw new KintsugiCoreError("work_view_not_found", `Work view is not open: ${body.key}`);
    await presentationStore.reorderWorkView(workspaceId, stored.reference, body.index);
    if (requestAcceptsJson(request) && !wantsStream(request)) return jsonResponse({ workViews: workViewSummaries(workspaceId, await presentationStore.listWorkViews(workspaceId)) });
    return turboStreamResponse("");
  }

  async function closeWorkViewJsonEndpoint(workspaceId: string, request: Request): Promise<Response> {
    const body = parseCloseWorkViewRequest(await readJsonObject(request));
    return await closeWorkViewEndpoint(workspaceId, JSON.stringify(body.reference), request);
  }

  async function createWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void> {
    await serializePresentationMutation(workspaceId, async () => {
      await openAvailableWorkView(workspaceId, reference);
      invalidatePresentation();
    });
  }

  async function presentWorkViewFromAgent(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void> {
    await serializePresentationMutation(workspaceId, async () => {
      const { key } = await openAvailableWorkView(workspaceId, reference);
      registry.setParked(workspaceId, false);
      registry.requestSurfaceAttention(workspaceId, key);
      workPresentationIntents.set(workspaceId, { key, revision: crypto.randomUUID() });
      invalidatePresentation();
    });
  }

  async function requestWorkViewAttentionEndpoint(workspaceId: string, key: string, request: Request): Promise<Response> {
    const stored = (await presentationStore.listWorkViews(workspaceId)).find((view) => workViewKey(view.reference) === key);
    if (!stored) throw new KintsugiCoreError("work_view_not_found", `Work view is not open: ${key}`);
    registry.setParked(workspaceId, false);
    registry.requestSurfaceAttention(workspaceId, key);
    return requestAcceptsJson(request) && !wantsStream(request) ? jsonResponse({ attention: stored.reference }) : turboStreamResponse("");
  }

  async function closeAgentEndpoint(workspaceId: string, agentId: string, request: Request): Promise<Response> {
    requireWorkspace(workspaceId);
    const before = await agentTabs.list({ workspaceId });
    if (!before.some(agent => agent.id === agentId)) throw new KintsugiCoreError("agent_not_found", `Agent not found: ${agentId}`);
    await agentTabs.close({ workspaceId, agentId });
    registry.clearSurfaceAttention(workspaceId, `agent:${agentId}`);
    if (requestAcceptsJson(request) && !wantsStream(request)) {
      const agents = await agentPaneContributions(workspaceId);
      return jsonResponse({ closedAgentId: agentId, agents: agents.map(({ id, title, agentTypeId, busy, requestingAttention }) => ({ id, title, agentTypeId, busy, requestingAttention })) });
    }
    return turboStreamResponse("");
  }

  async function renderModelPickerUpdates(request: Request): Promise<string> {
    const launchUpdates = (await Promise.all(agentTypes.map(agentType => agentType.launch.refreshConfiguration?.(launchComposerSettingsFrameId)))).join("");
    return requestAcceptsJson(request) && !wantsStream(request) ? "" : launchUpdates;
  }

  function openOldestAttentionWorkspaceEndpoint(): Response {
    const entry = registry.oldestAttentionWorkspace();
    if (!entry) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    return turboStreamResponse("", { headers: { location: `/workspaces/${encodeURIComponent(entry.id)}` } });
  }

  // ---------------------------------------------------------------------------
  // Errors + routing
  // ---------------------------------------------------------------------------

  function errorPage(error: Error): Response {
    const status = httpErrorStatus(error);
    const message = error.message;
    const backLink = actionLinkHtml({ href: "/", variant: "secondary", content: { kind: "caption", caption: "Back home" } });
    return response(layout(`<div class="app no-sidebar"><div class="main"><header class="header"><h1>Error</h1></header><div class="body"><p>${escapeHtml(message)}</p><p>${backLink}</p></div></div></div>`), { status });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/up" && (request.method === "GET" || request.method === "HEAD")) {
      return textResponse(request.method === "HEAD" ? "" : "ok\n");
    }
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const page = await homePage();
      return request.method === "HEAD" ? new Response(null, { status: page.status, statusText: page.statusText, headers: page.headers }) : page;
    }
    if (url.pathname === "/agent-types" && request.method === "GET") {
      const agentTypes = await orderedAgentTypes();
      return jsonResponse({ defaultAgentTypeId: agentTypes[0]!.id, agentTypes: agentTypes.map(({ id, label }) => ({ id, label })) });
    }
    if (url.pathname === "/openapi.json" && request.method === "GET") return jsonResponse(kintsugiOpenApi(workspaceModuleCommands(), Object.assign({}, ...workspaceModules.map((module) => module.openApiPaths ?? {}))));
    if (url.pathname === "/launch-composer" && request.method === "GET") {
      const workspaceTemplateReference = url.searchParams.get("workspaceTemplate");
      const autoSelect = url.searchParams.get("autoSelect") === "true";
      return response(await renderLaunchComposerFrame(workspaceTemplateReference ? await workspaceTemplateRoutes.byReference(workspaceTemplateReference) : undefined, autoSelect));
    }
    if (url.pathname === "/launch-composer/workspace-template" && request.method === "GET") {
      const reference = url.searchParams.get("workspaceTemplate");
      return response(renderLaunchWorkspaceTemplate((await listWorkspaceTemplates()).workspaceTemplates, reference ? await workspaceTemplateRoutes.byReference(reference) : undefined, url.searchParams.get("autoSelect") === "true"));
    }
    if (url.pathname === "/launch-composer/agent-type" && request.method === "GET") return response(await renderLaunchAgentType(getAgentType(url.searchParams.get("agentTypeId") ?? "builtin"), await orderedAgentTypes(), launchComposerFooterContext()));
    if (url.pathname === "/launch-composer/settings" && request.method === "GET") return response(await getAgentType(url.searchParams.get("agentTypeId") ?? "builtin").launch.renderFooter(launchComposerFooterContext(url.searchParams)));
    const workspaceTemplateSettingsMatch = matchRoute(url, /^\/workspace-templates\/([^/]+)\/settings$/);
    if (workspaceTemplateSettingsMatch && request.method === "GET") {
      const workspaceTemplateId = workspaceTemplateSettingsMatch[0]!;
      const section = url.searchParams.get("section") ?? undefined;
      return workspaceTemplateEditorResponse(request, { kind: "settings", workspaceTemplateId, section, editor: url.searchParams.get("editor") ?? undefined });
    }
    const workspaceTemplateWorkspaceMatch = matchRoute(url, /^\/workspace-templates\/([^/]+)\/workspaces\/new$/);
    if (workspaceTemplateWorkspaceMatch && request.method === "GET") return await surfacePage({ kind: "new-workspace", workspaceTemplate: await workspaceTemplateRoutes.byReference(workspaceTemplateWorkspaceMatch[0]!) });
    if (url.pathname === "/workspaces/new" && request.method === "GET") return await surfacePage({ kind: "new-workspace" });
    if (url.pathname === "/workspace-templates/new" && request.method === "GET") {
      return workspaceTemplateEditorResponse(request, { kind: "new" });
    }
    if (url.pathname === "/settings" && request.method === "GET" && !wantsStream(request) && request.headers.get("turbo-frame") !== appSettingsFrameId) return await surfacePage({ kind: "settings", request, section: url.searchParams.get("section") ?? undefined });
    if (url.pathname === "/models" && request.method === "GET" && !wantsStream(request) && !url.searchParams.has("host")) return await surfacePage({ kind: "models", focus: url.searchParams.get("focus") ?? undefined });
    if ((url.pathname === "/settings/developer-tools" || url.pathname === "/settings/development") && request.method === "GET" && !wantsStream(request)) return await surfacePage({ kind: "settings", request, section: undefined, developerTools: true });
    if (url.pathname === "/workspaces" && request.method === "GET") return workspaceListEndpoint(request, url);
    if (url.pathname === "/workspaces" && request.method === "POST") return await createWorkspaceEndpoint(request);
    if (url.pathname === "/workspaces/open-oldest-attention" && request.method === "POST") return openOldestAttentionWorkspaceEndpoint();

    const privateNetworkResponse = await handlePrivateNetworkSettings(request, url);
    if (privateNetworkResponse) return privateNetworkResponse;
    const workspaceTemplateResponse = await workspaceTemplateRoutes.handle(request, url);
    if (workspaceTemplateResponse) return workspaceTemplateResponse;

    const routeParam = (values: string[], index: number): string => {
      const value = values[index];
      if (value === undefined) throw new Error(`Route parameter ${index} is missing`);
      return value;
    };

    const settingsResponse = await handleSettingsRequest(request, url, { forceDeleteAllWorkspaces: forceDeleteAllWorkspacesFromSettings, renderModelPickerUpdates: () => renderModelPickerUpdates(request), themeChanged: () => shell.invalidate() });
    if (settingsResponse) return settingsResponse;

    const onboardingResponse = await handleOnboardingRequest(request, url);
    if (onboardingResponse) return onboardingResponse;

    for (const moduleRoute of workspaceModuleRoutes()) {
      const moduleResponse = await moduleRoute.handle(request, url, {
        events: deps.events,
        renderPage: (body) => response(layout(body)),
        renderModalPage: (dialogHtml) => surfacePage({ kind: "module-modal", dialogHtml }),
        openWorkView: (workspaceId, reference, options) => openWorkspaceModuleWorkView(workspaceId, reference, request, options),
      });
      if (moduleResponse) return moduleResponse;
    }

    let params: string[] | undefined;
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/resources$/))) {
      const entry = requireWorkspace(params[0]!);
      return handleWorkspaceResources(request, entry.id, deps.workspaceResourceBackend);
    }
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/properties(?:\/(?:resources|network|dns))?$/))) {
      const entry = requireWorkspace(params[0]!);
      return handleWorkspaceProperties(request, url, entry.id, workspaceTitle(entry), html => surfacePage({kind: "module-modal", dialogHtml: html}), deps.workspaceResourceBackend);
    }

    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/network$/))) {
      const entry = requireWorkspace(params[0]!);
      return await handleWorkspaceNetwork(request, entry.id, workspaceTitle(entry), html => surfacePage({ kind: "module-modal", dialogHtml: html }));
    }

    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/file\/open$/))) {
      if (request.method !== "GET") return response("Method not allowed", { status: 405, headers: { allow: "GET" } });
      return await openWorkspaceFile(routeParam(params, 0), parseWorkspaceFileTarget(url.searchParams),
        (workspaceId, reference) => openWorkspaceModuleWorkView(workspaceId, reference, request), url.searchParams.get("existing") === "1");
    }

    if (url.pathname === "/agent-workspaces" && request.method === "POST") return await createEmptyAgentWorkspaceEndpoint(request);

    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/sidebar-title$/)) && request.method === "POST") return await updateWorkspaceSidebarTitle(params[0], request);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/commands\/([^/]+)$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      const commandId = routeParam(params, 1);
      return await serializePresentationMutation(workspaceId, async () => await workspaceCommandEndpoint(workspaceId, commandId, request));
    }
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/close$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      const agentId = routeParam(params, 1);
      return await serializePresentationMutation(workspaceId, async () => await closeAgentEndpoint(workspaceId, agentId, request));
    }
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/work-views\/close$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      return await serializePresentationMutation(workspaceId, async () => await closeWorkViewJsonEndpoint(workspaceId, request));
    }
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/work-views\/(.+)\/attention\/request$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      const key = routeParam(params, 1);
      return await serializePresentationMutation(workspaceId, async () => await requestWorkViewAttentionEndpoint(workspaceId, key, request));
    }
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/work-views\/(.+)\/close$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      const reference = routeParam(params, 1);
      return await serializePresentationMutation(workspaceId, async () => await closeWorkViewEndpoint(workspaceId, reference, request));
    }
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/work-views\/reorder$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      return await serializePresentationMutation(workspaceId, async () => await reorderWorkViewEndpoint(workspaceId, request));
    }
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/park$/)) && request.method === "POST") return parkWorkspaceEndpoint(params[0], true, request);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/unpark$/)) && request.method === "POST") return parkWorkspaceEndpoint(params[0], false, request);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/warnings\/([^/]+)\/dismiss$/)) && request.method === "POST") return dismissWorkspaceWarning(params[0], params[1], request);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/ssh-trust\/([^/]+)\/reject$/)) && request.method === "POST") return workspaceRuntimeSshTrustEndpoint(params[0]!, params[1]!, request, true);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/ssh-trust\/([^/]+)$/)) && request.method === "POST") return workspaceRuntimeSshTrustEndpoint(params[0]!, params[1]!, request);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/ssh-trust\/reject$/)) && request.method === "POST") return workspaceSshTrustEndpoint(params[0]!, request, true);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/ssh-trust$/))) {
      if (request.method === "GET" || request.method === "POST") return await workspaceSshTrustEndpoint(params[0]!, request);
    }
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/provisioning\/continue$/)) && request.method === "POST") return continueWorkspaceProvisioningEndpoint(params[0], request);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/delete\/cancel$/)) && request.method === "POST") return await cancelWorkspaceDeletionEndpoint(params[0], request);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/delete\/confirm$/)) && request.method === "POST") return await confirmWorkspaceDeletionEndpoint(params[0], request);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/delete\/retry$/)) && request.method === "POST") return await retryWorkspaceDeletionEndpoint(params[0], request);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteWorkspaceEndpoint(params[0], request);
    if ((params = matchRoute(url, /^\/workspaces\/([^/]+)$/)) && request.method === "GET") return await workspacePage(params[0], request);

    return textResponse("not found", { status: 404 });
  }

  return {
    subscribeShell: listener => shell.subscribe(listener),
    subscribeSurface,
    invalidateWorkspace,
    deleteCurrentWorkspaceFromAgent,
    resumeWorkspaceDeletions: deletion.resume,
    provisioning,
    createWorkView,
    presentWorkViewFromAgent,
    globalSidebarContributions,
    async fetch(request) {
      try {
        const result = await route(request);
        if (request.method !== "GET" && request.method !== "HEAD") {
          invalidateWorkspace(new URL(request.url).pathname.match(/^\/workspaces\/([^/]+)/)?.[1]);
        }
        return result;
      } catch (thrown) {
        const error = thrown instanceof Error ? thrown : new Error(String(thrown));
        if (error instanceof KintsugiCoreError && error.code === "agent_setup_required" && !requestAcceptsJson(request)) {
          const setup = await route(new Request(new URL(String(error.details!.setupUrl), request.url), { headers: { accept: "text/vnd.turbo-stream.html" } }));
          // A rejected launch must keep its prompt and attachment draft intact.
          return new Response(setup.body, { status: 422, headers: setup.headers });
        }
        return requestAcceptsJson(request) ? problemJsonResponse(error) : errorPage(error);
      }
    },
  };
}
