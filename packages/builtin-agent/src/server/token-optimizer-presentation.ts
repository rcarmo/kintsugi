import type { JsonValue } from "@earendil-works/chord/json";
import { Type, type TSchema, type Static } from "typebox";
import { Value } from "typebox/value";
import { isJsonObject, type JsonObject } from "@kintsugi/core";
import { escapeHtml } from "@kintsugi/shared";
import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import type { AgentToolPresentation } from "@kintsugi/agent/server";
import { codeBlockHtml } from "@kintsugi/agent/server/render-markup";
import { readableRawRegion } from "@kintsugi/agent/server/render-tool";
import { formatCost, formatDuration, formatTokens, type ToolView } from "@kintsugi/agent/server/transcript";
import type { OptimizerOperation } from "@kintsugi/token-economizer/pi-durable";

/** Persisted display entries are external input: read each field through a schema. */
function read<S extends TSchema>(schema:S,value:JsonValue|undefined):Static<S>|undefined {return Value.Check(schema,value) ? value : undefined;}
const text = (value:JsonValue|undefined) => read(Type.String(),value);
const count = (value:JsonValue|undefined) => read(Type.Number({minimum:0}),value);
const flag = (value:JsonValue|undefined) => read(Type.Boolean(),value);
const list = (value:JsonValue|undefined) => read(Type.Array(Type.Unknown()),value)?.filter((item):item is JsonValue => item !== undefined) ?? [];
const names = (value:JsonValue|undefined) => list(value).flatMap(item => text(item) ?? []);
const object = (value:JsonValue|undefined):JsonObject|undefined => isJsonObject(value) ? value : undefined;
const plural = (n:number,one:string,many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const operationSchema = Type.Object({id:Type.String(),name:Type.String(),status:Type.Enum(["queued","running","complete","failed","cancelled","unknown"]),startedAt:Type.Number(),at:Type.Number(),input:Type.Unknown(),output:Type.Unknown()});

const modelPurposes = new Map([
  ["optimizer.proposer",{asked:"for repository facts",doing:"Suggesting facts"}],
  ["optimizer.loop-judge",{asked:"whether the run is stuck",doing:"Checking whether the run is stuck"}],
  ["optimizer.writer",{asked:"to write a nudge",doing:"Writing a nudge"}],
  ["optimizer.tool-judge",{asked:"which tools this task needs",doing:"Picking tools"}],
  ["optimizer.classifier",{asked:"to classify a decision",doing:"Classifying"}],
  ["optimizer.audit",{asked:"to double-check a local decision",doing:"Double-checking"}],
]);
const factStates = new Map([["CANDIDATE","still learning"],["ACTIVE","in use"],["RETIRED","retired"]]);

function modelName(input:JsonObject|undefined) {
  const model = object(input?.model);
  return model ? text(model.id) ?? "a model" : "a model";
}
type Fact = {id:string;state:string;claim:string};
function facts(output:JsonObject|undefined):Fact[] {
  return list(output?.facts).flatMap(item => {
    const row = object(item), id = text(row?.id);
    return id ? [{id,state:text(row?.state) ?? "",claim:text(row?.claim) ?? id}] : [];
  });
}
function newFacts(output:JsonObject|undefined):Fact[] {
  const known = facts(output);
  return names(output?.newFacts).map(id => known.find(fact => fact.id === id) ?? {id,state:"CANDIDATE",claim:id});
}
/** The model's reply, parsed for the operations whose output has a known shape. */
function parsedReply(output:JsonObject|undefined):JsonValue|undefined {
  const reply = text(output?.result);if (!reply) return undefined;
  const json = reply.match(/\{[\s\S]*\}/)?.[0];if (!json) return undefined;
  try {const value:JsonValue = JSON.parse(json);return value;} catch {return undefined;}
}
function toolVerdicts(output:JsonObject|undefined) {
  const reply = object(parsedReply(output)), hide:string[] = [], keep:string[] = [];
  for (const [name,value] of Object.entries(reply ?? {})) {const load = flag(object(value)?.load);if (load === false) hide.push(name);else if (load === true) keep.push(name);}
  return {hide,keep};
}

/** The collapsed row: what happened, in a few words. */
export function optimizerSummary(operation:OptimizerOperation):string {
  const input = object(operation.input), output = object(operation.output), done = operation.status === "complete";
  const purpose = modelPurposes.get(operation.name);
  let what: string;
  if (operation.name === "optimizer.learn" || operation.name === "optimizer.fold") {
    const label = operation.name === "optimizer.fold" ? "session" : "new work";
    const learned = newFacts(output).length;
    what = done ? `Learned from ${label} · ${learned ? plural(learned,"new fact") : "nothing new"}` : `Learning from ${label}`;
  } else if (purpose) {
    const model = modelName(input);
    what = operation.status === "queued" || operation.status === "running" ? `${purpose.doing} with ${model}` : `Asked ${model} ${purpose.asked}`;
    const reply = object(parsedReply(output));
    if (done && operation.name === "optimizer.loop-judge" && reply) what += flag(reply.stuck) ? " · looks stuck" : " · making progress";
    if (done && operation.name === "optimizer.tool-judge") {const {hide} = toolVerdicts(output);what += hide.length ? ` · could hide ${plural(hide.length,"tool")}` : " · keep all";}
  } else if (operation.name === "optimizer.nudge") {
    what = text(output?.delivery) === "simulated" ? "Would have nudged the Agent (Watch only)" : "Nudged the Agent";
  } else if (operation.name === "optimizer.prepare-tools") {
    const hidden = names(output?.hidden).length;
    what = `Picked tools for this task${done ? ` · ${hidden ? `${plural(hidden,"tool")} hidden` : "nothing hidden"}` : ""}`;
  } else if (operation.name === "optimizer.apply-tools") {
    const hidden = names(output?.hidden).length || names(input?.tools).length;
    what = done ? `Hid ${plural(hidden,"tool")} from the next session` : "Hiding tools";
  } else if (operation.name === "optimizer.restore-tools") {
    what = `Restored ${plural(names(output?.restored).length || names(input?.tools).length,"hidden tool")}`;
  } else if (operation.name === "optimizer.fit") {
    what = done ? "Retrained local classifiers" : "Retraining local classifiers";
  } else what = operation.name.replace(/^optimizer\./,"").replaceAll("-"," ");
  const status = {queued:"waiting",running:"",complete:"",failed:"failed",cancelled:"cancelled",unknown:"interrupted"}[operation.status];
  const active = operation.status === "queued" || operation.status === "running";
  const cost = count(output?.cost);
  return ["Token optimizer",what,status,active ? "" : formatDuration(Math.max(0,operation.at-operation.startedAt)),cost === undefined ? "" : formatCost(cost)].filter(Boolean).join(" · ");
}

type Row = {label:string;html:string};
const para = (value:string) => `<p>${escapeHtml(value)}</p>`;
const bullets = (items:string[]) => items.length ? `<ul>${items.map(item => `<li>${item}</li>`).join("")}</ul>` : "";
const code = (value:string) => `<code>${escapeHtml(value)}</code>`;
const toolList = (tools:string[]) => tools.map(code).join(", ");
function folded(label:string,body:string) {
  return disclosureHtml({summary:{kind:"compact",label:{kind:"text",text:label}},bodyHtml:body});
}

function learningRows(operation:OptimizerOperation,input:JsonObject|undefined,output:JsonObject|undefined):Row[] {
  const rows:Row[] = [], seen = count(input?.observations) ?? 0, prompts = count(input?.prompts);
  rows.push({label:"Checked",html:para(`${plural(seen,"tool result")}${prompts ? ` from ${plural(prompts,"prompt")}` : ""}.`)});
  const evidence = list(input?.evidence).flatMap(item => {
    const row = object(item), command = text(row?.command);if (!command) return [];
    const exit = read(Type.Number(),row?.exitCode), outcome = exit === undefined ? "" : exit === 0 ? " — succeeded" : ` — exit ${exit}`;
    const line = text(row?.output)?.trim().split("\n").find(Boolean) ?? "";
    return [`${code(command.split("\n")[0]!.slice(0,160))}${escapeHtml(outcome)}${line ? `<br><span class="token-optimizer-op__muted">${escapeHtml(line.slice(0,160))}</span>` : ""}`];
  });
  if (evidence.length) rows.push({label:"Evidence",html:folded(`Tool results (${evidence.length})`,bullets(evidence))});
  if (operation.status !== "complete") return rows;
  const added = newFacts(output), all = facts(output);
  rows.push({label:"Learned",html:added.length ? bullets(added.map(fact => `${escapeHtml(fact.claim)} <span class="token-optimizer-op__muted">(${escapeHtml(factStates.get(fact.state) ?? "new")})</span>`)) : para("No new facts. Existing facts were checked against this work.")});
  const byState = [...factStates].map(([state,label]) => [label,all.filter(fact => fact.state === state).length] as const).filter(([,n]) => n);
  if (byState.length) rows.push({label:"Known facts",html:para(byState.map(([label,n]) => `${n} ${label}`).join(" · "))});
  const suggested = names(output?.toolSuggestions), hidden = names(output?.hiddenTools);
  if (suggested.length) rows.push({label:"Suggestions",html:`<p>Could hide ${toolList(suggested)}; ${suggested.length === 1 ? "it hasn’t" : "they haven’t"} been used.</p>`});
  if (hidden.length) rows.push({label:"Hidden",html:`<p>${toolList(hidden)}</p>`});
  rows.push({label:"This Agent",html:para("Its current facts stay as they are, so its prompt cache keeps working. New facts apply from the next session.")});
  return rows;
}

function modelRows(operation:OptimizerOperation,input:JsonObject|undefined,output:JsonObject|undefined):Row[] {
  const model = object(input?.model), rows:Row[] = [];
  if (model) rows.push({label:"Model",html:para(`${text(model.id) ?? "?"} · ${text(model.provider) ?? "?"}`)});
  if (operation.status === "queued") rows.push({label:"Status",html:para("Waiting for an earlier optimizer call to finish.")});
  if (operation.status === "running") rows.push({label:"Status",html:para("Running in the background. The Agent isn’t waiting for it.")});
  const reply = parsedReply(output), replyObject = object(reply);
  if (operation.status === "complete") {
    let result = "";
    if (operation.name === "optimizer.proposer") {
      const claims = list(replyObject?.facts).flatMap(item => text(object(item)?.claim) ?? text(object(item)?.id) ?? []);
      result = claims.length ? `<p>Suggested ${plural(claims.length,"fact")}. Each needs repeated evidence before it’s used:</p>${bullets(claims.map(escapeHtml))}` : para("No new facts suggested.");
    } else if (operation.name === "optimizer.loop-judge" && replyObject) {
      const confidence = count(replyObject.confidence), reason = text(replyObject.reason);
      result = para(`${flag(replyObject.stuck) ? "Looks stuck" : "Making progress"}${confidence === undefined ? "" : ` (${Math.round(Math.min(1,confidence)*100)}% confident)`}.${reason ? ` ${reason}` : ""}`);
    } else if (operation.name === "optimizer.tool-judge") {
      const {hide,keep} = toolVerdicts(output);
      result = `${hide.length ? `<p>Not needed: ${toolList(hide)}</p>` : ""}${keep.length ? `<p>Keep: ${toolList(keep)}</p>` : ""}` || para("No tool changes suggested.");
    } else if (operation.name === "optimizer.classifier" && replyObject) {
      const label = text(replyObject.label), probabilities = object(replyObject.probabilities), score = label ? count(probabilities?.[label]) : undefined;
      result = para(label ? `${label}${score === undefined ? "" : ` (${Math.round(score*100)}%)`}` : "Unsure.");
    }
    const reply = text(output?.result);
    if (!result && reply) result = `<p class="token-optimizer-op__quote">${escapeHtml(reply.slice(0,2000))}</p>`;
    if (result) rows.push({label:"Result",html:result});
  }
  const usage = object(output?.usage), parts:string[] = [];
  const inputTokens = count(usage?.input), outputTokens = count(usage?.output), cached = count(usage?.cacheRead), cost = count(output?.cost), duration = count(output?.durationMs);
  if (inputTokens !== undefined) parts.push(`${formatTokens(inputTokens)} in`);
  if (cached) parts.push(`${formatTokens(cached)} cached`);
  if (outputTokens !== undefined) parts.push(`${formatTokens(outputTokens)} out`);
  if (cost !== undefined) parts.push(formatCost(cost));
  if (duration !== undefined) parts.push(formatDuration(duration));
  if (parts.length) rows.push({label:"Usage",html:para(parts.join(" · "))});
  else if (operation.status === "unknown") rows.push({label:"Usage",html:para("Unknown: a restart interrupted the call. It wasn’t retried.")});
  const prompt = text(input?.prompt);
  if (prompt) rows.push({label:"Sent",html:folded("Prompt",codeBlockHtml(prompt,undefined,"agent-tool-code"))});
  return rows;
}

function otherRows(operation:OptimizerOperation,input:JsonObject|undefined,output:JsonObject|undefined):Row[] {
  const rows:Row[] = [];
  if (operation.name === "optimizer.nudge") {
    const delivery = text(output?.delivery), message = text(output?.text), reason = text(input?.reason);
    rows.push({label:"Message",html:message ? `<p class="token-optimizer-op__quote">${escapeHtml(message)}</p>` : para("A notice that the run still looks stuck.")});
    if (reason) rows.push({label:"Why",html:para(reason)});
    rows.push({label:"Delivery",html:para(delivery === "simulated" ? "Not sent: the optimizer is in Watch only." : delivery === "undelivered" ? "Not delivered: the run ended first." : "Sent to the Agent during its run.")});
  } else if (operation.name === "optimizer.prepare-tools") {
    const task = text(input?.task), hidden = names(output?.hidden), decisions = object(output?.decisions) ?? {};
    const keep = Object.entries(decisions).filter(([,value]) => flag(value) === true).map(([name]) => name);
    if (task) rows.push({label:"Task",html:`<p class="token-optimizer-op__quote">${escapeHtml(task.slice(0,600))}</p>`});
    rows.push({label:"Hidden",html:hidden.length ? `<p>${toolList(hidden)}</p>` : para("Nothing.")});
    if (keep.length) rows.push({label:"Kept",html:`<p>${toolList(keep)}</p>`});
    if (flag(output?.applied) === false) rows.push({label:"Effect",html:para("Watch only: nothing was hidden.")});
  } else if (operation.name === "optimizer.apply-tools" || operation.name === "optimizer.restore-tools") {
    const restore = operation.name === "optimizer.restore-tools", tools = names(restore ? output?.restored : output?.hidden), requested = names(input?.tools);
    rows.push({label:restore ? "Restored" : "Hidden",html:`<p>${toolList(tools.length ? tools : requested)}</p>`});
    if (!restore) rows.push({label:"Why",html:para(flag(input?.automatic) ? "Automatic: these tools went unused across enough sessions." : "You asked for it in Settings.")});
    rows.push({label:"Takes effect",html:para(restore ? "From the next session or resume. They won’t be suggested again unless you ask." : "From the next session or resume. Running work keeps its tools.")});
  } else if (operation.name === "optimizer.fit") {
    rows.push({label:"Training data",html:para(`${plural(count(input?.samples) ?? 0,"example")} from ${plural(count(input?.groups) ?? 0,"session group")}, ${plural(count(input?.tools) ?? 0,"tool")}.`)});
    if (operation.status === "complete") {
      const published = flag(output?.published), models = list(output?.toolModels).flatMap(item => {const row = object(item), tool = text(row?.tool);return tool ? [`${code(tool)}: ${escapeHtml((text(row?.state) ?? "").replaceAll("_"," "))}`] : [];});
      rows.push({label:"Result",html:para(published === false ? "Not published: settings or evidence changed while training." : "Published. Local classifiers only act once their checks pass.")});
      if (models.length) rows.push({label:"Tool models",html:bullets(models)});
    }
  }
  return rows;
}

/** Human-readable detail for an optimizer operation; raw values stay available, folded away. */
export function optimizerDetail(operation:OptimizerOperation):string {
  const input = object(operation.input), output = object(operation.output);
  const rows = operation.name === "optimizer.learn" || operation.name === "optimizer.fold" ? learningRows(operation,input,output)
    : modelPurposes.has(operation.name) ? modelRows(operation,input,output) : otherRows(operation,input,output);
  const error = text(output?.error) ?? text(output?.reason);
  if (error && operation.status !== "complete") rows.unshift({label:operation.status === "cancelled" ? "Cancelled" : "Problem",html:para(error)});
  const readable = `<table class="token-optimizer-op"><tbody>${rows.map(row => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${row.html}</td></tr>`).join("")}</tbody></table>`;
  return `<div class="agent-tool-detail">${readableRawRegion("Details",readable,JSON.stringify({input:operation.input,output:operation.output},null,2))}</div>`;
}

function operationOf(tool:ToolView):OptimizerOperation|undefined {
  const value = tool.details?.operation;
  // SAFETY: Display entries are strict JSON; the schema confirms the operation shape before use.
  return Value.Check(operationSchema,value) ? value as OptimizerOperation : undefined;
}
const presentation:AgentToolPresentation = {
  summary(tool) {const operation = operationOf(tool);return operation ? optimizerSummary(operation) : undefined;},
  detail(_ctx,tool) {const operation = operationOf(tool);return operation ? optimizerDetail(operation) : undefined;},
};
export const optimizerOperationNames = ["optimizer.learn","optimizer.fold","optimizer.nudge","optimizer.prepare-tools","optimizer.apply-tools","optimizer.restore-tools","optimizer.fit",...modelPurposes.keys()];
export const optimizerToolPresentations = new Map(optimizerOperationNames.map(name => [name,presentation]));
