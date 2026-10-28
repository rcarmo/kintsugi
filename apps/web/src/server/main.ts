import { assertSystemCompatible, requiredSystemVersion } from "@kintsugi/shared/system-version";
import { readSystemVersion } from "../../../../packages/update/src/server/supervisor.ts";
import { configureAgentMcp, handleAgentMcpRequest } from "@kintsugi/agent/server";
import { createKintsugiEventBus, getKintsugiRuntimeContext, withCommandSignal, waitForCommand } from "@kintsugi/core";
import { designSystemCatalogueHtml } from "@kintsugi/design-system/catalogue";
import { deliverAttachmentDraft, removeAttachmentDraft, validDraftId } from "@kintsugi/prompt/server";
import { requestWorkspaceSshTrust } from "@kintsugi/workspace-templates";
import {
  createFileOriginIdentityStore,
  createWorkspaceIngress,
  createWorkspaceIngressSockets,
  detectParentOriginPublisher,
  defaultPublicOriginPortRange,
  managementOriginRejection,
  handleCanonicalWorkspaceRequest,
  StoppedWorkspaceError,
} from "@kintsugi/proxy-ingress/server";
import { proxyAccessSchema, validateProxyAccess, kintsugiName, errorMessage, type WorkspaceAppBackend, type WorkspaceAppRef, type WorkspaceServerAppResolver, type WorkspaceServerProvisioningHook, type WorkspaceServerSocketHandler, type WorkspaceServerSocketSession } from "@kintsugi/shared";
import { response, textResponse } from "@kintsugi/shared/http";
import { kintsugiThemes, readThemeSetting } from "@kintsugi/shared/theme";
import { prepareWorkspaceRuntime, createWorkspace, ensureWorkspaceStarted, deleteWorkspace, ensureHostInotifyLimit, isWorkspaceRunning, listWorkspaces, resolveWorkspace, stopWorkspaceContainer, setWorkspaceParked, workspaceImageOutdated, workspacePortBackend, workspaceSetupProvisioningHook } from "@kintsugi/workspace";
import { ensureDefaultWorkspaceImage } from "@kintsugi/workspace-image";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createAdminStore } from "./admin/store.ts";
import { startOptionalAdminBindings } from "./admin/bindings.ts";
import { connectionModeManaged } from "./settings/connection-mode.ts";
import { getAgentType, rememberAgentType } from "./agent-types.ts";
import { createWebApp, type WebApp } from "./app.ts";
import { parseAssetManifest } from "./asset-manifest.ts";
import { createCableServer, type CableSocketData } from "./cable.ts";
import { createCableSseTransport } from "./cable-sse.ts";
import { clientEntrypoints, legacyStaticFiles } from "./static-files.ts";
import { workspaceModules } from "./workspace-modules.generated.ts";
import { prepareWorkspaceForUse, reprovisionWorkspaces } from "./workspace-preparation.ts";
import { createFileWorkspaceActivityStore, createFileWorkspaceAttentionStore, createFileWorkspaceDeletionStore, createWorkspaceRegistry } from "./workspace-registry.ts";

const requestedPort = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";
const devReloadFile = process.argv.find((argument) => argument.startsWith("--kintsugi-dev-reload-file="))?.slice("--kintsugi-dev-reload-file=".length);

function displayUrl(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const formattedHost = displayHost.includes(":") && !displayHost.startsWith("[") ? `[${displayHost}]` : displayHost;
  return `http://${formattedHost}${port === 80 ? "" : `:${port}`}`;
}
const kintsugiEvents = createKintsugiEventBus();
configureAgentMcp(kintsugiEvents);
const socketHandlers: WorkspaceServerSocketHandler[] = [];
const workspaceAppResolvers: WorkspaceServerAppResolver[] = [];
const provisioningHooks: WorkspaceServerProvisioningHook[] = [workspaceSetupProvisioningHook];
const workspaceRemovedHandlers: Array<(workspaceId: string) => void | Promise<void>> = [];

const runtimeContext = getKintsugiRuntimeContext();


const parentOriginPublisher = await detectParentOriginPublisher(defaultPublicOriginPortRange);
// Check before constructing the app registry or loading persisted app state. Development without System is unaffected.
if (parentOriginPublisher.kind === "system" && requiredSystemVersion > 0) assertSystemCompatible(await readSystemVersion(), requiredSystemVersion);
let parentOriginPortRange = defaultPublicOriginPortRange;
if (parentOriginPublisher.kind === "system") {
  const response = await fetch("http://127.0.0.1:3001/access");
  if (!response.ok) throw new Error("System access configuration is unavailable");
  const access = await response.json();
  if (access.mode === "proxy") {
    if (!Value.Check(proxyAccessSchema, access.proxy)) throw new Error("Invalid System proxy access configuration");
    parentOriginPortRange = validateProxyAccess(access.proxy).previewPorts;
  }
}

const registry = createWorkspaceRegistry({
  activityStore: createFileWorkspaceActivityStore(join(runtimeContext.kintsugiDataDir, "view-state", "workspace-activity.json")),
  attentionStore: createFileWorkspaceAttentionStore(join(runtimeContext.kintsugiDataDir, "view-state", "workspace-attention.json")),
  deletionStore: createFileWorkspaceDeletionStore(join(runtimeContext.kintsugiDataDir, "view-state", "workspace-deletions.json")),
});
let app: WebApp;
const workspaceStartupOperations = {
  ensureStarted: ensureWorkspaceStarted,
  stop: stopWorkspaceContainer,
  prepareRuntime: prepareWorkspaceRuntime,
  runtimePrepared: (workspaceId: string) => kintsugiEvents.emit("workspace_runtime_ready", { workspaceId }),
  imageOutdated: (id: string) => workspaceImageOutdated(id, undefined, kintsugiEvents),
  get provisioning() { return app.provisioning; },
};
const cableServer = createCableServer({ registry, channels: [...workspaceModules.flatMap((module) => module.cableChannels ?? []), { name: "surface", subscribe: (identifier, listener, _events, shown) => app.subscribeSurface(identifier, listener, shown) }, { name: "shell", subscribe: (_identifier, listener) => app.subscribeShell(listener) }], events: kintsugiEvents });

app = createWebApp({
  registry,
  events: kintsugiEvents,
  devReload: devReloadFile !== undefined,
  workspaceRemovedHandlers,
  async provisionWorkspace(id, options) {
    await createWorkspace({ id, events: kintsugiEvents, init: options.init, context: options.context, run: options.run });
    for (const hook of provisioningHooks) {
      const work = () => hook.run({ workspaceId: id, creationContext: options.context, events: kintsugiEvents });
      await options.run.step(hook.id, hook.label, work, hook.failurePolicy);
    }
    await options.run.step("workspace.integrations", "Run workspace startup integrations", () => kintsugiEvents.emit("workspace_created", { workspaceId: id, init: options.init, context: options.context }));
    await rememberAgentType(options.context?.agent?.agentTypeId ?? "builtin", kintsugiEvents);
    const draft = options.context?.agent?.attachmentDraft;
    if (draft && validDraftId(draft)) await removeAttachmentDraft(draft);
  },
  async persistWorkspaceParked(id, parked, recover = false, force = false) {
    if (parked) {
      const suspend = () => kintsugiEvents.emit("workspace_suspending", { workspaceId: id });
      if (force) {
        try { await withCommandSignal(AbortSignal.timeout(3000), () => waitForCommand(suspend())); }
        catch (error) { console.error("Agent suspension did not finish before force parking", error); }
      } else await suspend();
    }
    await setWorkspaceParked(id, parked, recover);
    if (!parked && registry.get(id)!.phase.kind === "runningPhase") {
      registry.startProvisioning(id);
      resumeWorkspace(id);
    }
  },
  destroyWorkspace: async (id) => {
    await deleteWorkspace(id, { force: true, events: kintsugiEvents });
  },
});


kintsugiEvents.on("workspace_user_activity", ({ workspaceId }) => registry.touch(workspaceId));
kintsugiEvents.on("workspace_title_changed", ({ workspaceId, title }) => registry.setTitle(workspaceId, title || null));
// Discover identity and template metadata before serving. Runtime health is checked in the background.
const persistedWorkspaces = (await listWorkspaces({ inspectImages: false })).workspaces;
await registry.seed(persistedWorkspaces.map((workspace) => ({ ...workspace, provisioning: !workspace.parked })));

for (const module of workspaceModules) {
  await module.initialize?.({
    events: kintsugiEvents,
    registry,
    globalSidebarContributions: app.globalSidebarContributions,
    createWorkView: (workspaceId, reference) => app.createWorkView(workspaceId, reference),
    presentWorkView: (workspaceId, reference) => app.presentWorkViewFromAgent(workspaceId, reference),
    invalidateWorkspace: workspaceId => app.invalidateWorkspace(workspaceId),
    deleteCurrentWorkspace: (workspaceId, force) => app.deleteCurrentWorkspaceFromAgent(workspaceId, force),
    registerSocketHandler: (handler) => socketHandlers.push(handler),
    publishWorkspacePort: (workspaceId, port, protocol, hostname) => workspaceIngress.publishPort(workspaceId, port, protocol, hostname),
    publishWorkspaceFiles: (workspaceId) => workspaceIngress.publishFiles(workspaceId),
    registerWorkspaceAppResolver: (resolver) => workspaceAppResolvers.push(resolver),
    registerProvisioningHook: (hook) => provisioningHooks.push(hook),
    onWorkspaceRemoved: (handler) => workspaceRemovedHandlers.push(handler),
  });
}

provisioningHooks.push({ id: "workspace.agent", label: "Prepare agent", async run({ workspaceId, creationContext }) {
  const parameters = creationContext?.agent;
  const agentType = getAgentType(parameters?.agentTypeId ?? "builtin");
  if (parameters) {
    const attachments = parameters.attachmentDraft && validDraftId(parameters.attachmentDraft)
      ? await deliverAttachmentDraft(workspaceId, parameters.attachmentDraft)
      : { images: [], attachmentNotes: [] };
    parameters.input = { text: parameters.initialPrompt ?? "", ...attachments };
  }
  await agentType.launch.prepareWorkspace(workspaceId, creationContext);
} });

app.resumeWorkspaceDeletions();

function contentTypeForStaticPath(pathname: string): string {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function requestAcceptsGzip(request: Request): boolean {
  return request.headers.get("accept-encoding")?.split(",").some((encoding) => {
    const [name, ...parameters] = encoding.split(";").map((part) => part.trim());
    return name?.toLowerCase() === "gzip" && !parameters.some((parameter) => /^q\s*=\s*0(?:\.0+)?$/i.test(parameter));
  }) ?? false;
}

async function serveStatic(pathname: string, request: Request): Promise<Response | undefined> {
  if (pathname === "/design-system-catalogue.html") return response(await designSystemCatalogueHtml({ reloadUrl: devReloadFile ? "/__kintsugi_dev_reload" : undefined }));
  let assetCacheControl = "public, max-age=31536000, immutable";
  if (pathname === "/design-system.js" || clientEntrypoints[pathname]?.bundle) {
    const manifest = parseAssetManifest(await Bun.file(new URL("../../public/assets-manifest.json", import.meta.url)).text());
    pathname = manifest[pathname]!;
    assetCacheControl = "no-store";
  }
  if (pathname.startsWith("/assets/")) {
    const file = Bun.file(new URL(`../../public${pathname}`, import.meta.url));
    if (!(await file.exists())) return textResponse("not found", { status: 404 });
    const headers = new Headers({
      "content-type": contentTypeForStaticPath(pathname),
      "cache-control": assetCacheControl,
      "vary": "Accept-Encoding",
    });
    if (requestAcceptsGzip(request)) {
      const compressed = Bun.file(new URL(`../../public${pathname}.gz`, import.meta.url));
      if (await compressed.exists()) {
        headers.set("content-encoding", "gzip");
        return new Response(compressed, { headers });
      }
    }
    return new Response(file, { headers });
  }

  const entry = legacyStaticFiles[pathname];
  if (!entry) return undefined;
  // Installed apps paint their system bars from the manifest, so it follows the chosen theme.
  if (pathname === "/manifest.webmanifest") {
    const theme = readThemeSetting();
    const { background } = kintsugiThemes.find(({ id }) => id === theme)!;
    const manifest = { ...await Bun.file(entry.url).json(), background_color: background, theme_color: background };
    return new Response(JSON.stringify(manifest), { headers: { "content-type": entry.contentType, "cache-control": "no-store" } });
  }
  const file = Bun.file(entry.url);
  if (!(await file.exists())) return textResponse("not found", { status: 404 });
  const headers = new Headers({ "content-type": entry.contentType });
  if (["/workspace.js", "/service-worker.js", "/manifest.webmanifest", "/design-system-catalogue.html", "/design-system.css"].includes(pathname)) headers.set("cache-control", "no-store");
  return new Response(file, { headers });
}

async function compressDynamicResponse(request: Request, response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  // Event streams stay open; buffering them for compression prevents delivery.
  if (contentType.startsWith("text/event-stream")) return response;
  const compressible = contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("javascript") || contentType.includes("xml");
  if (request.method === "HEAD" || !response.body || !compressible || response.headers.has("content-encoding")) return response;
  const headers = new Headers(response.headers);
  const vary = headers.get("vary")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  headers.set("vary", [...new Set([...vary, "Accept-Encoding"])].join(", "));
  if (!requestAcceptsGzip(request)) return new Response(response.body, { status: response.status, statusText: response.statusText, headers });

  const body = new Uint8Array(await response.arrayBuffer());
  headers.delete("content-length");
  if (body.byteLength < 1024) return new Response(body, { status: response.status, statusText: response.statusText, headers });
  headers.set("content-encoding", "gzip");
  return new Response(gzipSync(body, { level: 6 }), { status: response.status, statusText: response.statusText, headers });
}

type WorkspaceModuleSocketData = WorkspaceServerSocketSession & { kind: "workspace-module" };
type SocketData = WorkspaceModuleSocketData | CableSocketData;

async function resolveWorkspaceApp(app: WorkspaceAppRef, requestUrl: URL): Promise<WorkspaceAppBackend | undefined> {
  for (const resolver of workspaceAppResolvers) {
    const backend = await resolver(app, requestUrl);
    if (backend) return backend;
  }
  return undefined;
}

const workspaceIngress = createWorkspaceIngress({
  workspaceName: (id) => registry.get(id)?.title ?? undefined,
  hostname: "127.0.0.1",
  resolveWorkspace: async (workspaceId) => {
    await resolveWorkspace(workspaceId);
    if (!await isWorkspaceRunning(workspaceId)) throw new StoppedWorkspaceError(workspaceId);
  },
  resolveApp: resolveWorkspaceApp,
  originPortRange: parentOriginPortRange,
  parentOriginPublisher,
  resolvePort: (id, port, protocol, url) => workspacePortBackend(id, port, url.pathname + url.search, `${protocol}:`),
  originIdentityStore: createFileOriginIdentityStore(),
});

const ingressSockets = createWorkspaceIngressSockets(workspaceIngress, join(runtimeContext.kintsugiDataDir, "workspace-sockets"), async (request, workspaceId) => {
  if (new URL(request.url).pathname === "/ssh/host-keys" && request.method === "POST") {
    const form = await request.formData();
    const host = form.get("host");
    const port = form.get("port");
    const keys = form.get("keys");
    if (!Value.Check(Type.String(), host) || !Value.Check(Type.String(), port) || !Value.Check(Type.String(), keys)) return new Response("Invalid SSH host keys", { status: 400 });
    try {
      return textResponse(await requestWorkspaceSshTrust(workspaceId, host, Number(port), keys));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "invalid_arguments") return new Response(error.message, { status: 400 });
      throw error;
    }
  }
  return handleAgentMcpRequest(request, workspaceId);
});
kintsugiEvents.on("workspace_plan_prepare", ({ workspaceId }) => ingressSockets.ensure(workspaceId));
kintsugiEvents.on("workspace_deleted", ({ workspaceId }) => ingressSockets.remove(workspaceId));

async function validateSocket(request: Request, url: URL): Promise<SocketData | undefined> {

  for (const handler of socketHandlers) {
    const session = await handler(url, request);
    if (session) return { kind: "workspace-module", ...session };
  }
  return undefined;
}

const defaultWorkspaceImage = await ensureDefaultWorkspaceImage({ buildOutput: "inherit" });
await ensureHostInotifyLimit(defaultWorkspaceImage);
for (const workspace of persistedWorkspaces) await ingressSockets.ensure(workspace.id);
await workspaceIngress.initialize();
const handleCable = createCableSseTransport(cableServer);
const server = Bun.serve<SocketData>({
  hostname,
  port: requestedPort,
  // Keep long-lived upgraded sockets and slow workspace app proxy requests
  // alive well beyond Bun's short default idle timeout.
  idleTimeout: 255,
  async fetch(request, server) {
    const url = new URL(request.url);
    // MCP has a separate bearer-token boundary; it is not a management route.
    const mcpResponse = await handleAgentMcpRequest(request);
    if (mcpResponse) return mcpResponse;

    const originRejection = managementOriginRejection(request, server.requestIP(request)?.address);
    if (originRejection) return originRejection;

    const canonical = await handleCanonicalWorkspaceRequest(request, workspaceIngress);
    if (canonical) return canonical;

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const socketData = await validateSocket(request, url);
      if (!socketData) return textResponse("not found", { status: 404 });
      if (server.upgrade(request, { data: socketData })) return undefined;
      return textResponse("websocket upgrade failed", { status: 400 });
    }

    const cableResponse = await handleCable(request);
    if (cableResponse) return cableResponse;

    if (url.pathname === "/debug/connections" && request.method === "GET") {
      return new Response(JSON.stringify({ cable: cableServer.stats(), ingress: workspaceIngress.inspect() }, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }

    if (devReloadFile && url.pathname === "/__kintsugi_dev_reload" && request.method === "GET") {
      return new Response(Bun.file(devReloadFile), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }

    const staticResponse = await serveStatic(url.pathname, request);
    if (staticResponse) return staticResponse;

    return await compressDynamicResponse(request, await app.fetch(request));
  },
  websocket: {
    perMessageDeflate: true,
    open(ws) {
      if (ws.data.kind === "cable") cableServer.open(ws, ws.data);
      else ws.data.open?.(ws);
    },
    message(ws, message) {
      if (ws.data.kind === "workspace-module") ws.data.message?.(ws, message);
    },
    close(ws) {
      if (ws.data.kind === "cable") cableServer.close(ws);
      else ws.data.close?.(ws);
    },
  },
});
const adminServers = await startOptionalAdminBindings({
  store: createAdminStore(join(runtimeContext.kintsugiDataDir, "admin-bindings.json")),
  auditPath: join(runtimeContext.kintsugiDataDir, "admin-audit.jsonl"),
  app,
  systemAvailable: connectionModeManaged,
  reportError: error => console.error(error.message),
});
for (const listener of adminServers) console.log(`Admin API listening on ${listener.hostname}:${listener.port}`);
const serverPort = server.port ?? requestedPort;

void kintsugiEvents.emit("kintsugi_host_started", {
  workspaces: persistedWorkspaces.map(({ id, parked }) => ({ id, parked: Boolean(parked) })),
}).catch((error) => console.error("Kintsugi startup handlers failed", error));

console.log(`${kintsugiName} is available at ${displayUrl(hostname, serverPort)}`);

void reprovisionWorkspaces(registry, workspaceStartupOperations).catch((error) => console.error("Workspace reprovisioning failed", error));

function resumeWorkspace(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  void prepareWorkspaceForUse(id, registry, workspaceStartupOperations).then(() => {
    if (registry.get(id) === entry && !entry.phase.deletion && !entry.parked) registry.startRunning(id);
  }).catch((error) => console.error(`Workspace startup failed for ${id}`, error));
}

// Drain preparation before releasing durable writer leases; shutdown is not user Stop.
let hostStopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (hostStopping) return;
  hostStopping = true;
  server.stop();
  for (const listener of adminServers) listener.stop();
  void app.provisioning.drain().then(() => kintsugiEvents.emit("kintsugi_host_stopping", {})).then(() => process.exit(0), error => {
    console.error("Kintsugi shutdown failed", error);
    process.exit(1);
  });
});
