import {parseOptimizerCommand,runOptimizerCommand} from "./token-optimizer-command.ts";
import { suggestAgentSlug } from "@kintsugi/agent/server/slug-suggestion";
import { knownWorkspaceAgentRequest } from "./runtime.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readJsonObject, requestAcceptsJson } from "@kintsugi/core";
import { agentAttachmentDraftId, deliverAttachmentDraft, removeStagedAttachments } from "@kintsugi/prompt/server";
import { maybeNameAgentFromPrompt, setAgentTitle } from "./agent-title-suggestion.ts";
import { turboStreamResponse } from "@kintsugi/shared";
import { removeInitialPromptDraft } from "./initial-prompt-draft.ts";
import { expandSlashCommand } from "@kintsugi/agent/server/slash-command-input";
import { parseCompactCommand } from "@kintsugi/agent/server/builtin-slash-commands";
import { runAgentNameCommand } from "@kintsugi/agent/server/agent-name-command";
import { matchRoute } from "@kintsugi/shared/http";
import { resolveAgentController, type AgentRouteHandler, type AgentRouteOptions } from "./route-support.ts";
import { resolveAgent } from "./delegation.ts";

export const handleMessageRequest: AgentRouteHandler = async (request, url, options) => {
  const params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/messages$/);
  if (!params || request.method !== "POST") return undefined;
  return await submitMessage(params[0], params[1], request, options);
};

async function submitMessage(workspaceId: string, agentId: string, request: Request, options: AgentRouteOptions): Promise<Response> {
  const agent = await resolveAgent(workspaceId, agentId);
  const json = requestAcceptsJson(request) ? await readJsonObject(request) : undefined;
  const form = json ? undefined : await request.formData();
  // Older API callers can omit the identity, but cannot retry idempotently.
  const requestId = json?.requestId ?? form?.get("requestId") ?? crypto.randomUUID();
  if (!Value.Check(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,128}$" }), requestId)) {
    const message = "Request ID must contain 1–128 letters, numbers, underscores, or hyphens";
    return json ? Response.json({ error: { code: "invalid_arguments", message } }, { status: 422 }) : turboStreamResponse("", { status: 422 });
  }
  const text = String(json?.text ?? form?.get("text") ?? "");
  const mode = json?.mode ?? form?.get("mode") ?? "steer";
  if (mode !== "send" && mode !== "steer" && mode !== "followUp") {
    const message = "Mode must be send, steer, or followUp";
    return json ? Response.json({ error: { code: "invalid_arguments", message } }, { status: 422 }) : turboStreamResponse("", { status: 422 });
  }
  const optimizerCommand = parseOptimizerCommand(text);
  if (optimizerCommand) {
    await resolveAgentController(agent,options);
    const result = await runOptimizerCommand(workspaceId,agentId,optimizerCommand,requestId);
    await removeInitialPromptDraft(workspaceId,agentId);
    return json ? Response.json({command:"tokeneconomizer",...result}) : turboStreamResponse("");
  }
  if (text.trim() === "/new") {
    const runtime = await resolveAgentController(agent, options);
    await runtime.reset();
    await removeInitialPromptDraft(workspaceId, agentId);
    return json ? Response.json({ agent: { agentId, state: "idle" } }) : turboStreamResponse("");
  }
  if (text.trim() === "/park") {
    await removeInitialPromptDraft(workspaceId, agentId);
    return new Response(null, { status: 307, headers: { Location: `/workspaces/${encodeURIComponent(workspaceId)}/park` } });
  }
  const compactCommand = parseCompactCommand(text);
  if (compactCommand) {
    const runtime = await resolveAgentController(agent, options);
    await options.events?.emit("workspace_user_activity", { workspaceId });
    await runtime.compact(compactCommand.customInstructions);
    await removeInitialPromptDraft(workspaceId, agentId);
    return json ? Response.json({ agent: { agentId, state: "idle", compacted: true } }) : turboStreamResponse("");
  }
  const nameResult = await runAgentNameCommand(text, {
    suggest: async () => {
      const runtime = await resolveAgentController(agent, options);
      const model = (await runtime.settings()).model;
      return suggestAgentSlug((await runtime.userMessages()).join("\n\n"), model && { provider: model.provider, id: model.modelId });
    },
    setTitle: async (title) => { await setAgentTitle(agent, title, { events: options.events }); },
  });
  if (nameResult) {
    if (nameResult === "no-title") return json ? Response.json({ error: { code: "invalid_arguments", message: "No prompt available to name this Agent" } }, { status: 422 }) : turboStreamResponse("", { status: 422 });
    await removeInitialPromptDraft(workspaceId, agentId);
    return json ? Response.json({ agent: { agentId, state: "idle" } }) : turboStreamResponse("");
  }

  const attachmentDraft = agentAttachmentDraftId(workspaceId, agentId);
  if (form && String(form.get("attachmentDraft") ?? "") !== attachmentDraft) return turboStreamResponse("", { status: 422 });
  // Admission wins even if the previous response was lost after attachment cleanup.
  if (await (options.knownRequest ?? knownWorkspaceAgentRequest)(agent, requestId, { events: options.events })) {
    const headers = { "x-kintsugi-attachment-draft-consumed": "true" };
    return json ? Response.json({ agent: { agentId, state: "accepted" } }, { status: 202, headers }) : turboStreamResponse("", { headers });
  }
  const attachmentIds = form?.getAll("attachment").map(String) ?? [];
  const { images, attachmentNotes } = attachmentIds.length > 0
    ? await deliverAttachmentDraft(workspaceId, attachmentDraft, attachmentIds)
    : { images: [], attachmentNotes: [] };
  const expandedText = await expandSlashCommand(workspaceId, text);
  const trimmed = expandedText.trim();
  if (!trimmed && images.length === 0 && attachmentNotes.length === 0) {
    const message = "A prompt or completed attachment is required";
    return json ? Response.json({ error: { code: "invalid_arguments", message } }, { status: 422 }) : turboStreamResponse("", { status: 422 });
  }
  const runtime = await resolveAgentController(agent, options);
  const model = (await runtime.settings()).model;
  const namingContext = trimmed ? { messages: [...await runtime.userMessages(), trimmed], agentModel: model && { provider: model.provider, id: model.modelId } } : undefined;
  // A new prompt that finds the agent busy waits its turn; only explicit steering joins the running turn.
  const submission = await runtime.submit({ text: expandedText, requestId, whenBusy: mode === "steer" ? "steer" : "followUp", images: images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType })), attachmentNotes });
  if (namingContext) {
    await options.events?.emit("workspace_user_activity", { workspaceId });
    (options.suggestTitleFromPrompt ?? maybeNameAgentFromPrompt)(agent, namingContext.messages, { events: options.events, agentModel: namingContext.agentModel });
  }
  await removeStagedAttachments(attachmentDraft, attachmentIds);
  await removeInitialPromptDraft(workspaceId, agentId);
  // The composer steers a follow-up it sent by this ID.
  const acceptedHeaders = { "x-kintsugi-attachment-draft-consumed": "true", "x-kintsugi-submission-id": String(submission.id) };
  return json
    ? Response.json({ agent: { agentId, state: "running" } }, { status: 202, headers: acceptedHeaders })
    : turboStreamResponse("", { headers: acceptedHeaders });
}
