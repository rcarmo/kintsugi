import { contentText, createAssistantMessageEventStream, type AssistantMessage, type Message, type Models, type ToolCall } from "@earendil-works/pi-ai";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { AssistantEntry, CompactionEntry, defineEntry, ResetEntry, defineExtension, GenerationTask, hook, LiveDoc, type ConversationId, type Cursor, type EntryId, type Harness, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { KintsugiCoreError } from "@kintsugi/core";
import { codemodeTemplateScript, type PromptTemplate } from "@kintsugi/agent/server/prompt-templates";
import { withStreamSimple } from "./durable-models.ts";
import { durablePlanContextEntry } from "./durable-plan.ts";

/** Code mode calls a template made start with this, so the code mode tool can tell them from the model's own. */
const callIdPrefix = "codemode_template_";

/**
 * A response no model wrote. Its own provider and API make every provider treat it as another model's turn,
 * so they normalise its call IDs and expect no signatures.
 */
const origin = { api: "kintsugi-codemode-template", provider: "kintsugi", model: "codemode-template" } as const;

/** Written when a template's call ends its run, so the transcript ends the turn there too. */
export const codemodeTemplateRunEndEntry = defineEntry<{ callId: string }>("kintsugi.codemode-template-run-end");

/** The user messages the next response answers: those after the last message of any other kind. */
function unansweredUserMessages(messages: readonly Message[]): Message[] {
  const start = messages.findLastIndex(message => message.role !== "user") + 1;
  return messages.slice(start);
}

/**
 * The code mode calls the unanswered messages that are code mode templates ask for, as the agent's
 * response, or nothing when none are. Templates are read when the agent answers, so a message queued
 * behind other work runs the template as it is then.
 */
export function codemodeTemplateResponse(messages: readonly Message[], templates: readonly PromptTemplate[], now = Date.now()): AssistantMessage | undefined {
  const calls = unansweredUserMessages(messages).flatMap((message): ToolCall[] => {
    const code = codemodeTemplateScript(contentText(message.content), templates);
    return code === undefined ? [] : [{ type: "toolCall", id: `${callIdPrefix}${crypto.randomUUID().replaceAll("-", "")}`, name: CODEMODE_TOOL_NAME, arguments: { code } }];
  });
  if (!calls.length) return undefined;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return { role: "assistant", ...origin, content: calls, usage, stopReason: "toolUse", timestamp: now };
}

/** For a message with attachments: a template takes only its typed arguments, and an attachment would end up among them. */
export function assertNoTemplateAttachments(text: string, templates: readonly PromptTemplate[]): void {
  if (codemodeTemplateScript(text, templates) !== undefined) {
    throw new KintsugiCoreError("invalid_arguments", "Code mode templates can't take attachments. Remove them and send again.");
  }
}

/** How many calls the response holding `callId` made, and the user entries it answered. */
async function answeredEntries(tx: Tx, conversationId: ConversationId, callId: string): Promise<{ calls: number; users: EntryId[] }> {
  let calls: number | undefined;
  const users: EntryId[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId }, 100, cursor);
    for (const entry of page.items) {
      if (calls === undefined) {
        const message = AssistantEntry.is(entry) ? entry.model?.[0] : undefined;
        const content = message?.role === "assistant" ? message.content : [];
        if (content.some(part => part.type === "toolCall" && part.id === callId)) calls = content.filter(part => part.type === "toolCall").length;
        continue;
      }
      if (CompactionEntry.is(entry) || ResetEntry.is(entry)) return { calls, users };
      // Plan snapshots are context, not submitted slash commands or steering.
      if (durablePlanContextEntry.is(entry)) continue;
      // Bookkeeping and system prompt entries can sit between the messages and their response.
      if (!entry.model?.some(message => message.role !== "system")) continue;
      if (entry.model.some(message => message.role !== "user")) return { calls, users };
      users.push(entry.id);
    }
    cursor = page.next;
  } while (cursor);
  return { calls: calls ?? 0, users };
}

/**
 * Whether a finished code mode call ends its run: a template's call does when its template messages are
 * exactly the inputs that started the run, so the model has nothing to answer. A template that joined
 * running work, or came with other messages, hands its result back to the model instead. The decision
 * is recorded with the call, for the transcript.
 */
async function templateEndsRun(api: Pick<ToolExecutionApi, "callId" | "conversationId" | "commit">, harness: Harness, context: Context): Promise<boolean> {
  if (!api.callId.startsWith(callIdPrefix)) return false;
  const { inputs, calls, users } = await api.commit(async tx => ({
    inputs: [...(await tx.doc(LiveDoc, api.conversationId)).run?.inputs ?? []],
    ...await answeredEntries(tx, api.conversationId, api.callId),
  }), context);
  // A call per message: every message the response answered was a template.
  if (users.length !== calls || inputs.length !== users.length) return false;
  for (const id of inputs) {
    const input = await (await harness.submission(id, context))!.status(context);
    if (input.type !== "input" || input.status !== "placed" || !users.includes(input.entry)) return false;
  }
  await api.commit(tx => tx.appendEntry(codemodeTemplateRunEndEntry, api.conversationId, { data: { callId: api.callId } }), context);
  return true;
}

/**
 * Code mode templates answered without the model. A generation hook reads the templates before each request
 * and leaves the response for its unanswered messages; the models hand it over in place of the provider's.
 * The extension must be installed last, so its hook sees the messages the models get, and its wrap the
 * code mode tool as the workspace made it.
 */
export function createCodemodeTemplates(templates: () => Promise<readonly PromptTemplate[]>, harness: () => Harness) {
  const responses = new WeakMap<Message, AssistantMessage>();
  const extension = defineExtension({ name: "kintsugi.codemode-templates", wraps: [{ tool: CODEMODE_TOOL_NAME, wrap: (tool: ToolRegistration): ToolRegistration => ({
    ...tool,
    async execute(args, api, context) {
      const result = await tool.execute(args, api, context);
      const endsRun = await templateEndsRun(api, harness(), context);
      return endsRun ? { ...result, control: { ...result.control, terminate: true } } : result;
    },
  }) }], hooks: [hook(GenerationTask, {
    async beforeRequest(request) {
      // Only a slash command can be a template; other requests don't read the templates.
      if (!unansweredUserMessages(request.messages).some(message => contentText(message.content).trimStart().startsWith("/"))) return undefined;
      const response = codemodeTemplateResponse(request.messages, await templates());
      if (response) responses.set(request.messages.at(-1)!, response);
      return undefined;
    },
  })] });

  function models(inner: Models): Models {
    const streamSimple: Models["streamSimple"] = (model, request, options) => {
      const last = request.messages.at(-1);
      const response = last && responses.get(last);
      if (!last || !response) return inner.streamSimple(model, request, options);
      responses.delete(last);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: response });
      stream.push({ type: "done", reason: "toolUse", message: response });
      return stream;
    };
    return withStreamSimple(inner, streamSimple);
  }

  return { extension, models };
}
