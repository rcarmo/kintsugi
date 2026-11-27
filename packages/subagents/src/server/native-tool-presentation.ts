import { Type } from "typebox";
import { Value } from "typebox/value";
import { isJsonObject } from "@kintsugi/core";
import type { AgentToolPresentation } from "@kintsugi/agent/server";
import { communicationBodyHtml, communicationCardHtml, communicationTraceHtml } from "./render-markup.ts";

const detailsSchema = Type.Object({ recipientId: Type.String(), receiptId: Type.String(), path: Type.String(), message: Type.String() });
const communication: AgentToolPresentation = {
  summary(tool) {
    if (Value.Check(detailsSchema, tool.details)) return tool.details.path;
    const args = isJsonObject(tool.args) ? tool.args : undefined;
    const peer = args?.task_name ?? args?.target;
    return Value.Check(Type.String(), peer) ? peer : undefined;
  },
  detail(ctx, tool) {
    if (!Value.Check(detailsSchema, tool.details)) return undefined;
    const { recipientId, receiptId, path, message } = tool.details;
    return communicationCardHtml([
      { label: "Body", html: communicationBodyHtml(ctx, message) },
      { label: "Recipient", html: communicationTraceHtml(ctx, recipientId, receiptId, `Find message recipient · ${path}`) },
    ]);
  },
};
export const nativeToolPresentations = new Map(["spawn_agent", "send_message", "followup_task"].map(name => [name, communication]));
