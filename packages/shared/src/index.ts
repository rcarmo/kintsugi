import type { KintsugiEventBus, JsonObject, JsonValue } from "@kintsugi/core";
import type { TSchema } from "typebox";
import { escapeHtml } from "./html.ts";
import type { WorkspaceGateway } from "./workspace-gateway.ts";
export * from "./workspace-gateway.ts";

export { providerBadgeHtml, providerBrandIconHtml } from "./brand-icons.ts";
export { escapeHtml, turboStream } from "./html.ts";
export { errorMessage, formatBytes } from "./format.ts";
export { isHopByHopHeader, stripHopByHopHeaders } from "./proxy-headers.ts";

export const kintsugiName = "Kintsugi" as const;

export { fileReferencesIn, parseFileReference, parseWorkspaceFileTarget, workspaceFileOpenUrl, type WorkspaceFileTarget } from "./file-target.ts";
export { changesCommitUrl, commitLinkPrefix, isCommitHash, parseCommitLinkHref, parseCommitLinkSpec, shortCommit, type CommitLinkTarget } from "./commit-target.ts";

export function domId(...parts: string[]): string {
  return parts.join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function encodeWorkspaceFilePath(path: string): string {
  return path.split("/").map((part, index) => index === 0 ? part : encodeURIComponent(part)).join("/");
}

export function workspaceProxyUrl(workspaceId: string, appKey: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (appKey === "file") return `/workspaces/${encodeURIComponent(workspaceId)}/files${encodeWorkspaceFilePath(normalizedPath)}`;
  const portMatch = appKey.match(/^port-(\d+)$/)!;
  if (portMatch) return `/workspaces/${encodeURIComponent(workspaceId)}/ports/${portMatch[1]}${normalizedPath}`;
  return `/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appKey)}${normalizedPath}`;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) throw new Error("copy command failed");
}

export function looksLikeWorkspaceTemplateSpec(value: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|\/|\.\/|\.\.\/|[A-Za-z]:\\|(github\.com|gitlab\.com|bitbucket\.org)\/)/i.test(value.trim());
}

export function shouldSearchRepositories(query: string): boolean {
  const trimmed = query.trim();
  return trimmed.length >= 2 && !looksLikeWorkspaceTemplateSpec(trimmed);
}

export function turboStreamResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/vnd.turbo-stream.html; charset=utf-8");
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(body, { ...init, headers });
}

interface WorkspaceAttachContext {
  workspaceId: string;
  init?: unknown;
  events?: KintsugiEventBus;
}

export interface WorkspaceAgentTabSummary {
  id: string;
  title: string;
  /** Use the workspace title when this is the only tab. */
  untitled?: boolean;
}

/** An Agent's pane. The workspace publishes only its shell; the Agent's own live
 * presentation publishes the content, which a page places into the shell's mounts.
 * Regions render on demand: only a page render needs them. */
export interface WorkspaceAgentPane {
  html: string;
  live?: { regions(): readonly import("./live-presentation.ts").LiveRegion[]; subscriberId: string };
}

/** Durable Agent-tab seam: cheap shell metadata plus on-demand body rendering. */
export interface WorkspaceAgentTabProvider {
  list(context: { workspaceId: string }): Promise<readonly WorkspaceAgentTabSummary[]>;
  render(context: { workspaceId: string; agentId: string }): Promise<WorkspaceAgentPane>;
  close(context: { workspaceId: string; agentId: string }): Promise<void>;
}

export interface WorkspaceWorkViewPresentation {
  /** Trusted decorative markup from the contributing module. */
  iconHtml?: string;
  /** Cheap, side-effect-free metadata used to render the Workspace shell. */
  reference: WorkspaceWorkViewReference;
  sourceKey: string;
  label: string;
  /** Trusted, server-rendered label content for Work views with cached dynamic summaries. */
  kind: "resource" | "contextual";
  /** Whether this view joins the initial presentation when the Workspace has no saved view layout. */
  initiallyOpen?: boolean;
  availability?: WorkspaceWorkViewAvailability;
  actionsHtml?: string;
}

export interface WorkspaceWorkViewReference extends JsonObject {
  type: string;
}

type WorkspaceWorkViewAvailability =
  | { phase: "opening"; detail?: string }
  | { phase: "live" }
  | { phase: "reconnecting"; detail?: string }
  | { phase: "unavailable"; detail: string };

export function workspaceWorkViewLabelDomId(workspaceId: string, key: string): string {
  return domId("work_view_label", workspaceId, key);
}

export interface WorkspaceModuleWorkViewAdapter<Reference extends WorkspaceWorkViewReference = WorkspaceWorkViewReference> {
  type: Reference["type"];
  parseReference(value: JsonValue): Reference;
  identity(reference: Reference): string;
  /** Expensive body rendering is called only by the Work-view hydration endpoint. */
  render(context: { workspaceId: string; reference: Reference }): Promise<string> | string;
  close?(context: { workspaceId: string; reference: Reference }): Promise<void> | void;
}

interface WorkspaceCommandUiSurface {
  iconHtml?: string;
  /** Related command whose shortcut opens this view (when launching and opening differ). */
  shortcutCommandId?: string;
  /** Where the server-rendered web UI should place this command. */
  placement: "work-launcher" | "agent-action";
  label?: string;
}

interface WorkspaceCommandShortcutSurface {
  defaultBinding: string;
}

interface WorkspaceCommandSurfaces {
  ui?: WorkspaceCommandUiSurface;
  shortcut?: WorkspaceCommandShortcutSurface;
}

type WorkspaceCommandScope = "global" | "workspace" | "agent" | "work-view";

export interface WorkspaceCommandContribution<Input = Record<string, never>> {
  id: string;
  label: string;
  description?: string;
  scope: WorkspaceCommandScope;
  /** Runtime schema for validation and future typed form/palette generation. */
  inputSchema?: TSchema;
  surfaces?: WorkspaceCommandSurfaces;
  /** Type carrier only; command metadata stays serializable. */
  readonly __input?: Input;
}

export interface WorkspaceAttachment {
  workViews?: WorkspaceWorkViewPresentation[];
  commands?: WorkspaceCommandContribution[];
  overlayHtml?: string[];
}

export interface StaticFileContribution {
  url: URL;
  contentType: string;
  /** Browser entry point; classic IIFEs can run in opaque-origin sandboxes without CORS authority. */
  bundle?: "esm" | "iife";
}

export interface WorkspaceModuleCommandResult {
  createdAgentId?: string;
  createdWorkView?: WorkspaceWorkViewReference;
  streamHtml?: string;
}

interface WorkspaceModuleCommandContext<Input = unknown> {
  workspaceId: string;
  events?: KintsugiEventBus;
  input: Input;
}

export const emptyWorkspaceCommandInputSchema = { type: "object", additionalProperties: false } as const;

export interface WorkspaceModuleCommandHandler<Input = unknown> {
  id: string;
  /** JSON Schema used to validate automation input and advertise the command in OpenAPI. */
  inputSchema?: TSchema;
  execute(context: WorkspaceModuleCommandContext<Input>): Promise<WorkspaceModuleCommandResult> | WorkspaceModuleCommandResult;
}

/** One active module dialog, shared by module routes and the Kintsugi shell. */
export const workspaceModuleModalFrameId = "workspace_module_modal_host";

export interface WorkspaceModuleRouteContext {
  /** Full themed page with the host's fingerprinted assets. */
  renderPage?(body: string): Response;
  events?: KintsugiEventBus;
  /** Refresh server-owned Work-view presentation, opening the view if needed. */
  openWorkView(workspaceId: string, reference: WorkspaceWorkViewReference, options?: { select?: boolean }): Promise<Response>;
  /** Render a full Kintsugi page with this server-rendered dialog body in the shared modal frame. */
  renderModalPage(dialogHtml: string): Promise<Response>;
}

export interface WorkspaceModuleRouteHandler {
  handle(request: Request, url: URL, context: WorkspaceModuleRouteContext): Promise<Response | undefined> | Response | undefined;
}

export type WorkspaceDeletionAssessment =
  | { status: "clear" }
  | { status: "blocked"; fingerprint: string; details: JsonValue };

/** Supplies the local-change check and read-only evidence used by workspace deletion. */
export interface WorkspaceDeletionReview {
  inspect(workspaceId: string): Promise<WorkspaceDeletionAssessment>;
  renderEvidence(workspaceId: string, details: JsonValue): string;
}

export interface WorkspaceSocketConnection {
  send(message: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface WorkspaceServerSocketSession {
  open?(socket: WorkspaceSocketConnection): void;
  message?(socket: WorkspaceSocketConnection, message: string | Uint8Array): void;
  close?(socket: WorkspaceSocketConnection): void;
}

export type WorkspaceServerSocketHandler = (
  url: URL,
  request: Request,
) => Promise<WorkspaceServerSocketSession | undefined> | WorkspaceServerSocketSession | undefined;

export interface WorkspaceAppRef {
  appKey: string;
  workspaceId: string;
}

export interface WorkspaceHttpAppBackend {
  kind: "http";
  target: URL;
  /** Host the app expects, such as a *.localhost subdomain; defaults to localhost. */
  appHost?: string;
  gateway?: WorkspaceGateway;
  adaptRequestHeaders?(headers: Headers, request: Request): Promise<Headers> | Headers;
  adaptResponse?(response: Response, request: Request): Promise<Response> | Response;
}

interface WorkspaceFetchAppBackend {
  kind: "fetch";
  fetch(request: Request): Promise<Response> | Response;
}

export type WorkspaceAppBackend = WorkspaceHttpAppBackend | WorkspaceFetchAppBackend;

/** Resolve one durable workspace-app identity to its backend for this request. */
export type WorkspaceServerAppResolver = (
  app: WorkspaceAppRef,
  requestUrl: URL,
) => Promise<WorkspaceAppBackend | undefined> | WorkspaceAppBackend | undefined;

export type WorkspaceProvisionFailurePolicy = "continue" | "retry" | "retry-or-continue";

export interface WorkspaceServerProvisioningHook {
  id: string;
  label: string;
  failurePolicy?: WorkspaceProvisionFailurePolicy;
  run(context: { workspaceId: string; creationContext?: WorkspaceCreationContext; events?: KintsugiEventBus }): Promise<void> | void;
}

export interface GlobalSidebarContributionRegistry {
  /** Set server-rendered sidebar HTML for a module contribution; empty/undefined clears it. */
  set(contributionId: string, html?: string, regions?: readonly import("./live-presentation.ts").LiveRegion[]): void;
}

interface SettingsActionContext {
  request: Request;
  url: URL;
}

/** A section of app-level Settings, distinct from template configuration and per-Agent choices. */
export interface SettingsContribution {
  id: string;
  label: string;
  icon?: string;
  order?: number;
  render(): Promise<string>;
  handleAction?(context: SettingsActionContext): Promise<Response | undefined>;
}

export interface DeleteCurrentWorkspaceResult {
  deleted: boolean;
  blocked: boolean;
  details?: unknown;
}

/** Host-generated input; every Agent type must accept text, images and file notes. */
export interface WorkspaceAgentInput {
  text: string;
  images: { mimeType: string; data: string }[];
  attachmentNotes: string[];
}

export interface AgentWorkspaceParameters {
  agentTypeId?: string;
  /** Filled by Kintsugi before prepareWorkspace and workspace_created. */
  input?: WorkspaceAgentInput;
  initialPrompt?: string;
  initialPromptMode?: "composer";
  model?: string;
  thinkingLevel?: string;
  attachmentDraft?: string;
}

export interface WorkspaceCreationContext extends Record<string, unknown> {
  agent?: AgentWorkspaceParameters;
}

export interface WorkspaceServerModuleContext {
  events: KintsugiEventBus;
  registry: {
    setAgentBusy(workspaceId: string, agentKey: string, busy: boolean): void;
    requestSurfaceAttention(workspaceId: string, surfaceKey: string): void;
    requestAttention(workspaceId: string): void;
  };
  globalSidebarContributions: GlobalSidebarContributionRegistry;
  /** Add a Work view without selecting it or requesting attention. */
  createWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void>;
  presentWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void>;
  invalidateWorkspace(workspaceId: string): void;
  deleteCurrentWorkspace(workspaceId: string, force: boolean): Promise<DeleteCurrentWorkspaceResult>;
  registerSocketHandler(handler: WorkspaceServerSocketHandler): void;
  publishWorkspacePort(workspaceId: string, port: number, protocol?: "http" | "https", hostname?: string): Promise<string>;
  /** Origin serving workspace files; append an absolute path to load a file. */
  publishWorkspaceFiles(workspaceId: string): Promise<string>;
  registerWorkspaceAppResolver(resolver: WorkspaceServerAppResolver): void;
  registerProvisioningHook(hook: WorkspaceServerProvisioningHook): void;
  onWorkspaceRemoved(handler: (workspaceId: string) => void | Promise<void>): void;
}

export interface WorkspaceModule {
  /** Icon-only design-system actions before Settings, in module registration order.
   * Render immediately; module-owned Turbo requests load any remote state. */
  renderWorkspacePaneActions?(): string;
  cableChannels?: import("./cable.ts").CableChannelAdapter[];
  /** Declarative lazy surfaces. The host owns loading, publication, subscriptions and invalidation. */
  liveSurfaces?: { name: string; load(context: { workspaceId: string; key: string }): Promise<readonly import("./live-presentation.ts").LiveRegion[]> }[];
  openApiPaths?: Record<string, import("@kintsugi/core").JsonObject>;
  id: string;
  staticFiles?: Record<string, StaticFileContribution>;
  settingsContributions?: SettingsContribution[];
  commands?: WorkspaceModuleCommandHandler[];
  routes?: WorkspaceModuleRouteHandler[];
  workViews?: WorkspaceModuleWorkViewAdapter[];
  deletionReview?: WorkspaceDeletionReview;
  agentType?: WorkspaceAgentType;
  initialize?(context: WorkspaceServerModuleContext): Promise<void> | void;
  attachToWorkspace?(context: WorkspaceAttachContext): Promise<WorkspaceAttachment> | WorkspaceAttachment;
}

export interface WorkspaceClientController {
  element: Element;
}

export type WorkspaceClientControllerConstructor = new (...args: never[]) => WorkspaceClientController;

export interface WorkspaceClientApplication {
  register(identifier: string, controllerConstructor: WorkspaceClientControllerConstructor): void;
  getControllerForElementAndIdentifier(element: Element, identifier: string): WorkspaceClientController | null;
}

export interface WorkspaceClientSurfaceVisibilityContext {
  workspaceId: string;
  surfaceKey: string;
  region: Element;
  pane: HTMLElement;
  application: WorkspaceClientApplication;
}

export const phoneLayoutMediaQuery = "(max-width: 700px), (hover: none) and (pointer: coarse)";
/** The composer rules are about available space, not touch: mobile is a viewport of 700px or less. */
export const mobileComposerMediaQuery = "(max-width: 700px)";

/** Asks an Agent's composer to send a prompt without touching its draft. */
export const agentComposerSendPromptEvent = "agent-composer:send-prompt";
export interface AgentComposerSendPromptDetail { text: string; requestId?: string; onComplete?: (error?: Error) => void }

/** Adds a quote to the end of an Agent's draft, leaving the caret under it, after the comment's first typed text. */
export const agentComposerQuoteEvent = "agent-composer:quote";
export interface ComposerQuote { source: string; text: string; code: boolean }
export interface AgentComposerQuoteDetail { quote: ComposerQuote; comment: string }

/** Text selected inside an embedded frame, or null once it is deselected. The rectangle is in the frame's own viewport. */
export const frameSelectionEvent = "kintsugi:frame-selection";
export type FrameSelectionDetail = { text: string; code: boolean; rect: { left: number; top: number; right: number; bottom: number } } | null;

/** Scrolling over an embedded frame, which never reaches this document. A
 * synthetic wheel event would do, but iOS Chrome scrolls for those. */
export const frameScrollEvent = "kintsugi:frame-scroll";
export interface FrameScrollDetail { deltaY: number }

/** Enter inserts a newline everywhere; only ⌘↩ (Ctrl+↩ on Windows and Linux) sends. */
export function composerSubmitKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

export function isWorkspacePaneVisible(element: Element): boolean {
  const mount = element.closest(".workspace-detail-mount");
  if (mount && !mount.classList.contains("visible")) return false;
  const presentationPane = element.closest<HTMLElement>("[data-workspace-pane-role][data-workspace-pane-id]");
  if (presentationPane) {
    if (!presentationPane.classList.contains("is-active")) return false;
    const presentation = presentationPane.closest<HTMLElement>(".fixed-workspace-presentation")!;
    if (window.matchMedia(phoneLayoutMediaQuery).matches) {
      return presentationPane.dataset.workspacePaneRole === "agent"
        ? presentation.dataset.phoneDestination === "agents"
        : presentation.dataset.phoneDestination === `work:${presentationPane.dataset.workspacePaneId}`;
    }
    return presentationPane.dataset.workspacePaneRole === "agent" || presentation.classList.contains("is-work-pane-open");
  }
  return true;
}

export interface WorkspaceClientWorkspaceAppFrameContext {
  appKey: string;
  url: URL;
  frame: HTMLIFrameElement;
}

export interface WorkspacePaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  detail?: string;
  badge?: string;
  keywords?: string[];
  score?: number;
  run(): void | Promise<void>;
}

export interface WorkspacePaletteSearchContext {
  query: string;
  fuzzyScore(candidate: string): number;
}

export interface WorkspacePaletteProvider {
  id: string;
  search(context: WorkspacePaletteSearchContext): WorkspacePaletteItem[] | Promise<WorkspacePaletteItem[]>;
}

export const recentWorkspaceTemplateStorageKey = "kintsugi:recent-workspace-template-id";

/** The hot path for starting work: a launch composer seeded from the current workspace's template. */
export const launchComposerCommand = {
  id: "agent.open-launch-composer",
  label: "New workspace",
  description: "Open the launch composer, using the selected workspace’s template when available.",
  binding: "Meta+Alt+Quote",
} as const;

export interface WorkspaceClientCommand {
  id: string;
  label: string;
  description?: string;
  scope: "global" | "workspace" | "agent" | "work-view";
  binding?: string;
  run(): void | Promise<void>;
}

export interface WorkspaceClientHooks {
  onBecomeVisible(handler: (context: WorkspaceClientSurfaceVisibilityContext) => void): void;
  onNoLongerVisible(handler: (context: WorkspaceClientSurfaceVisibilityContext) => void): void;
  onWorkspaceAppFrameUrl(handler: (context: WorkspaceClientWorkspaceAppFrameContext) => void): void;
  onWorkspaceAppFrameRefresh(handler: (context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void): void;
  registerPaletteProvider(provider: WorkspacePaletteProvider): void;
  registerCommand(command: WorkspaceClientCommand): void;
  registeredCommands(): WorkspaceClientCommand[];
  /** Supplies commands that depend on the current page, evaluated whenever commands are looked up. */
  registerCommandProvider(provider: () => WorkspaceClientCommand[]): void;
}

interface WorkspaceClientModuleContext {
  application: WorkspaceClientApplication;
  Controller: WorkspaceClientControllerConstructor;
  hooks: WorkspaceClientHooks;
}

export interface WorkspaceClientModule {
  id: string;
  install(context: WorkspaceClientModuleContext): void | Promise<void>;
}

export {
  CableTopics,
  decodeCableClientMessage,
  decodeCableServerMessage,
  serializeCableIdentifier,
  type KintsugiCableClient, type CableClientMessage,
  type CableIdentifier,
  type CableServerMessage,
  type CableSubscription,
  type CableSubscriptionOptions, type WorkspaceVisibilityReport
} from "./cable.ts";

export {
  notifyInputListeners,
  setTextInputValue
} from "./text-input.ts";

export { focusLikelyOpensSoftwareKeyboard, installSoftwareKeyboardTracking, isTextEntry, softwareKeyboardArranged } from "./software-keyboard.ts";
export { anchorScrollBottom, changeLayout, layoutAfterEvent, layoutBeforeEvent } from "./layout-transaction.ts";
export { isApplePlatform } from "./platform.ts";

export type { CableChannelAdapter, CableChannelSubscription } from "./cable.ts";

/** Public context for contextual Work views. The shell owns the backing attribute and event. */
export function selectedWorkspaceAgent(element: Element): string | undefined {
  return element.closest<HTMLElement>("[data-workspace-selected-agent]")?.dataset.workspaceSelectedAgent || undefined;
}
export const workspaceAgentSelectionEvent = "kintsugi:workspace-agent-selected";

export interface AgentLaunchFooterContext {
  /** Show the submitted settings without editing or resolving current preferences. */
  readOnly?: boolean;
  frameId: string;
  formId: string;
  url: string;
  query: URLSearchParams;
}
export interface WorkspaceAgentLaunch {
  renderFooter(context: AgentLaunchFooterContext): Promise<string>;
  prepare(parameters?: JsonObject): Promise<WorkspaceCreationContext | undefined>;
  /** Validate Agent type settings; the host owns prompt, attachments and submission identity. */
  submit(form: FormData): Promise<{ prepare(): Promise<WorkspaceCreationContext> } | { response: Response }>;
  /** New-workspace provisioning only; never invoked to fill an empty pane. Input is host-prepared. */
  prepareWorkspace(workspaceId: string, context?: WorkspaceCreationContext): Promise<void>;
  refreshConfiguration?(frameId: string): Promise<string>;
}

/** Agent types own contents and lifecycle; Kintsugi owns tabs, chrome and creation UI.
 * Agent IDs must be globally unique within a workspace (UUIDs are recommended).
 * Metadata listing must not create an agent or boot a runtime.
 */
export interface WorkspaceAgentType {
  id: string;
  label: string;
  iconHtml: string;
  tabs: WorkspaceAgentTabProvider;
  create(context: { workspaceId: string; events?: KintsugiEventBus }): Promise<string>;
  launch: WorkspaceAgentLaunch;
}

export { createLivePresentation, createPublishedRefresh, liveCollection, liveRegionDigestsSchema, liveShownAttribute, placeLiveRegions, type LiveRegion, type LiveRegionDigests, type LiveSubscription } from "./live-presentation.ts";

export * from "./proxy-access.ts";
