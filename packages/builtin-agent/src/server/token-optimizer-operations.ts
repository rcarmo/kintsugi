import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, defineEntry, type ConversationView } from "@earendil-works/pi-durable";
import { fingerprint, redact } from "@kintsugi/token-economizer/core";
import type { OperationSink, OptimizerOperation } from "@kintsugi/token-economizer/pi-durable";
import { renderToolCard } from "@kintsugi/agent/server/render-tool";
import { formatCost, formatDuration, type TranscriptItem, type ToolView } from "@kintsugi/agent/server/transcript";
import { transcriptRow } from "@kintsugi/agent/server/render-markup";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isJsonObject } from "@kintsugi/core";

/** Display-only entries: never carry model messages, receipts or executable tools. */
export const OptimizerOperationEntry = defineEntry<OptimizerOperation>("kintsugi.token-optimizer.operation");
const OperationWrites = defineDoc<{ recent: Record<string, string> }>({kind:"kintsugi.token-optimizer.operation-writes",version:1,scope:"conversation",history:"latest",fork:"initial",initial:() => ({recent:{}}),checkpointWhen:() => false});

function displayData(value:JsonValue,depth = 0):JsonValue {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Recursive strict-JSON boundary: sanitize each representation before storing display data.
  if (typeof value === "string") {
    const text = redact(value);return text.length > 16_384 ? text.slice(0,16_384)+"\n[display truncated]" : text;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve strict-JSON scalars; containers are recursively bounded below.
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[display truncated]";
  if (Array.isArray(value)) return value.slice(0,64).map(item => displayData(item,depth+1));
  return Object.fromEntries(Object.entries(value).slice(0,64).map(([key,item]) => {
    const sensitive = !redact(JSON.stringify({[key]:"kintsugi_sensitive_value"})).includes("kintsugi_sensitive_value");
    return [key,sensitive ? "[REDACTED]" : displayData(item,depth+1)];
  }));
}

/** Written in the same transaction as the operation's state change, including failures and replay recovery. */
export const recordOptimizerOperation:OperationSink = async (tx,conversationId,operation) => {
  const writes = await tx.doc(OperationWrites,conversationId), key = fingerprint(operation.id);
  if (operation.status === "cancelled" && !writes.recent[key]) return; // No row for work that never started.
  const input = displayData(operation.input), output = displayData(operation.output);
  if (!isJsonObject(input)) throw new Error("Optimizer operation input must be an object");
  const signature = fingerprint(JSON.stringify([operation.name,operation.status,input,output]));
  if (writes.recent[key] === signature) return;
  await tx.appendEntry(OptimizerOperationEntry,conversationId,{data:{...operation,input,output}});
  writes.recent[key] = signature;
  // Only live/recent transitions need replay deduplication; the transcript retains the actual history.
  const keys = Object.keys(writes.recent);
  for (const old of keys.slice(0,Math.max(0,keys.length-256))) delete writes.recent[old];
};

const statuses = {queued:"Queued",running:"Running",complete:"Complete",failed:"Failed",cancelled:"Cancelled",unknown:"Interrupted · usage unknown"} satisfies Record<OptimizerOperation["status"],string>;
const costSchema = Type.Number({minimum:0});

export function optimizerOperationRows(view:ConversationView):Extract<TranscriptItem,{type:"extension"}>[] {
  const grouped = new Map<string,{first:OptimizerOperation;latest:OptimizerOperation}>();
  for (const entry of view.entries) if (OptimizerOperationEntry.is(entry)) {
    const previous = grouped.get(entry.data.id);
    if (previous) previous.latest = entry.data;
    else grouped.set(entry.data.id,{first:entry.data,latest:entry.data});
  }
  return [...grouped.values()].map(({first,latest}) => {
    const key = `optimizer:${fingerprint(first.id)}`, active = latest.status === "queued" || latest.status === "running";
    const result = isJsonObject(latest.output) ? latest.output : null;
    const model = isJsonObject(first.input.model) ? first.input.model : null;
    const summary = [latest.name,statuses[latest.status],active ? "" : formatDuration(Math.max(0,latest.at-first.startedAt)),model ? `${model.id} · ${model.provider}` : "",Value.Check(costSchema,result?.cost) ? formatCost(result!.cost) : ""].filter(Boolean).join(" · ");
    const tool:ToolView = {callId:first.id,name:latest.name,args:first.input,status:active ? "running" : latest.status === "complete" || latest.status === "cancelled" ? "ok" : "error",issuedAt:first.startedAt,
      resultText:latest.output === null ? undefined : JSON.stringify(latest.output,null,2)};
    return {type:"extension",key,timestamp:first.startedAt,render:ctx => transcriptRow(renderToolCard(ctx,key,tool,{nested:true,tone:"info",summary}))};
  });
}
