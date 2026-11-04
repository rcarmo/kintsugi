import { Type } from "typebox";
import { Value } from "typebox/value";
import { stopDurableWorkspaceAgent } from "./runtime.ts";
import { existingDurableController } from "./runtime.ts";
import { KintsugiCoreError, readJsonObject, requestAcceptsJson } from "@kintsugi/core";
import { turboStreamResponse } from "@kintsugi/shared";
import { matchRoute, response } from "@kintsugi/shared/http";
import { invalidateAgentView, requireAgentPresentation, requireAgentController, type AgentRouteHandler } from "./route-support.ts";
import { resolveAgent } from "./delegation.ts";
import { handleAgentTreeRequest } from "./session-tree.ts";

const abortInputSchema = Type.Object({ note: Type.Optional(Type.String()) });

export const handleSessionRequest: AgentRouteHandler = async (request, url, options) => {
  let params: string[] | undefined;
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/reveal\/([^/]+)$/)) && request.method === "GET") {
    const [workspaceId, agentId, target] = params;
    const runtime = await requireAgentPresentation(workspaceId, agentId, options);
    return Response.json({ turnId: runtime.revealTurn(target) ?? null });
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/transcript-items\/([^/]+)$/)) && request.method === "GET") {
    const runtime = await requireAgentPresentation(params[0], params[1], options);
    const count = Math.max(100, Math.min(100_000, Number(url.searchParams.get("count") ?? 100) || 100));
    const html = await runtime.detailHtml(params[2], count);
    return response(html || "not found", { status: html ? 200 : 404 });
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/session-images\/([^/]+)\/(\d+)$/)) && request.method === "GET") {
    const agent = await resolveAgent(params[0], params[1]);
    const controller = await existingDurableController(agent, options);
    return controller ? await controller.image(params[2], Number(params[3])) : new Response("not found", { status: 404 });
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/tree(\/summary|\/label|)$/))) {
    const [workspaceId, agentId, suffix] = params;
    const treeResponse = await handleAgentTreeRequest(request, url, suffix, async () => await requireAgentPresentation(workspaceId, agentId, options), async () => await requireAgentController(workspaceId, agentId, options));
    if (treeResponse && request.method === "POST") await invalidateAgentView(options, workspaceId, agentId);
    return treeResponse;
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/queued-inputs\/([^/]+)\/cancel$/)) && request.method === "POST") {
    const [workspaceId, agentId, submissionId] = params;
    const controller = await requireAgentController(workspaceId, agentId, options);
    const cancelled = await controller.cancelQueuedInput(submissionId);
    await invalidateAgentView(options, workspaceId, agentId);
    return requestAcceptsJson(request) ? Response.json({ input: { submissionId, cancelled } }) : turboStreamResponse("");
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/queued-inputs\/([^/]+)\/steer$/)) && request.method === "POST") {
    const [workspaceId, agentId, submissionId] = params;
    const controller = await requireAgentController(workspaceId, agentId, options);
    const steered = await controller.steerQueuedInput(submissionId);
    await invalidateAgentView(options, workspaceId, agentId);
    return requestAcceptsJson(request) ? Response.json({ input: { submissionId, steered } }) : turboStreamResponse("");
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/tools\/([^/]+)\/abort$/)) && request.method === "POST") {
    const [workspaceId, agentId, callId] = params;
    const controller = await requireAgentController(workspaceId, agentId, options);
    const body = request.body === null ? {} : request.headers.get("content-type")?.includes("application/json")
      ? await readJsonObject(request)
      : Object.fromEntries(await request.formData());
    if (!Value.Check(abortInputSchema, body)) {
      throw new KintsugiCoreError("invalid_arguments", "The note must be text.");
    }
    const aborted = await controller.abortTool(callId, body.note);
    await invalidateAgentView(options, workspaceId, agentId);
    return requestAcceptsJson(request) ? Response.json({ tool: { callId, aborted } }) : turboStreamResponse("");
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/abort$/)) && request.method === "POST") {
    const agent = await resolveAgent(params[0], params[1]);
    await stopDurableWorkspaceAgent(agent, options);
    await invalidateAgentView(options, params[0], params[1]);
    return requestAcceptsJson(request) ? Response.json({ agent: { agentId: params[1], state: "idle", aborted: true } }) : turboStreamResponse("");
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/rewind$/)) && request.method === "POST") {
    const form = await request.formData();
    const entry = String(form.get("entry") ?? "");
    const mode = String(form.get("rewindMode") ?? "discard") === "summary" ? "summary" : "discard";
    if (mode === "summary") throw new KintsugiCoreError("invalid_arguments", "Continue without a summary for this history.");
    const controller = await requireAgentController(params[0], params[1], options);
    if (entry) {
      await controller.navigate(entry, true);
      await invalidateAgentView(options, params[0], params[1]);
    }
    return turboStreamResponse("");
  }
  return undefined;
};
