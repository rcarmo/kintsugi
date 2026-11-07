import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { agentToolPresentation } from "./tool-presentations.ts";
import { copyButtonHtml } from "@kintsugi/design-system/copy-button";
import { buttonGroupHtml } from "@kintsugi/design-system/button-group";
import { buttonHtml } from "@kintsugi/design-system/button";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { Icons } from "@kintsugi/design-system/icons";
import { toggleHtml } from "@kintsugi/design-system/toggle";
import { isJsonObject, type JsonObject } from "@kintsugi/core";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { parseDiffFromFile, processPatch, type FileDiffMetadata } from "@pierre/diffs";
import { diffStats, type DiffOperation } from "./diff.ts";
import { embeddedBashCommand, formatBashCommandForDisplay, formatCodemodeScriptForDisplay, highlightedBashCommandHtml } from "./embedded-code.ts";
import { domId, escapeHtml } from "@kintsugi/shared";
import { terminalProcessSocketPath } from "@kintsugi/observable-terminal/shared";
import { terminalOutputHtml } from "@kintsugi/observable-terminal/server";
import { isBashTool, formatCost, formatDuration, formatTokens, toolOutcomeLabel, type ScriptFileView, type ToolView } from "./transcript.ts";
import { agentPath, ids, sessionImageUrl, transcriptItemPath, type AgentRenderContext } from "./render-context.ts";
import { codeBlockHtml, detailFullscreen, fullscreenAttributes, transcriptRowContent, transcriptTimestampAttributes } from "./render-markup.ts";

type ToolArgumentKey = "code" | "command" | "path" | "file_path" | "content" | "offset" | "limit" | "timeout" | "edits" | "oldText" | "newText";

const toolStringArgumentSchema = Type.String();
const toolNumberArgumentSchema = Type.Number();
const diffOperationSchema = Type.Object({
  oldText: Type.String(),
  newText: Type.String(),
});

function statusHtml(status: ToolView["status"], readOnly = false): string {
  const state = status === "streaming" || status === "running" ? "running" : status === "error" ? "danger" : "success";
  return `<span class="status-dot ${state}${state === "running" && readOnly ? " static" : ""}" aria-label="${state === "running" ? "In progress" : state === "danger" ? "Failed" : "Complete"}"></span>`;
}

function summaryHtml(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

function bashSummary(tool: ToolView): string {
  const details = tool.details;
  const timeout = numberArg(toolArgs(tool), "timeout") ?? 600;
  const elapsed = tool.status === "running" && tool.issuedAt !== undefined ? Date.now() - tool.issuedAt : tool.durationMs;
  const duration = elapsed === undefined ? "" : `${formatDuration(elapsed)} / ${formatDuration(timeout * 1000)}`;
  return summaryHtml([duration, toolOutcomeLabel(details, false)]);
}

function toolSummaryHtml(tool: ToolView): string {
  if (isBashTool(tool.name)) return bashSummary(tool);
  if (tool.name === "codemode") return codemodeSummary(tool);
  if (tool.name === "plan") return planSummary(tool);
  // Code mode's `models.*` calls name the model they run.
  if (codemodeModelCall.test(tool.name) && Value.Check(modelCallArgumentsSchema, tool.args)) return tool.args.model.id;
  if (tool.name === "read") {
    const image = tool.resultImages?.[0];
    const imageMeta = image ? [image.width && image.height ? `${image.width}×${image.height}` : "", image.mimeType ?? ""].filter(Boolean).join(" · ") : "";
    return summaryHtml([pathSummary(tool, formatReadRange(toolArgs(tool))), imageMeta]);
  }
  if (tool.name === "write") return pathSummary(tool);
  if (tool.name === "edit") {
    const operations = getEditOperations(toolArgs(tool));
    const stats = diffStats(operations);
    const editCount = operations.length ? `${operations.length} ${operations.length === 1 ? "edit" : "edits"}` : "";
    const changes = operations.length ? `+${stats.added} −${stats.deleted}` : "";
    return summaryHtml([pathSummary(tool), editCount, changes]);
  }
  return genericToolSummary(tool);
}

function planSummary(tool: ToolView): string {
  const args = toolArgs(tool);
  const action = args?.action ?? (Array.isArray(args?.plan) ? "update" : Array.isArray(args?.patches) ? "patch" : "read");
  switch (action) {
    case "read": return "Read checklist";
    case "reset": return "Reset checklist";
    case "write": return "Replace checklist from Markdown";
    case "edit": {
      const count = Array.isArray(args?.edits) ? args.edits.length : 1;
      return `Edit checklist · ${count} ${count === 1 ? "change" : "changes"}`;
    }
    case "update": return Array.isArray(args?.plan) ? `Update checklist · ${args.plan.length} ${args.plan.length === 1 ? "step" : "steps"}` : "Update checklist";
    case "patch": {
      const patches = Array.isArray(args?.patches) ? args.patches : [];
      if (patches.length !== 1) return patches.length ? `Change ${patches.length} steps` : "Change checklist";
      const patch = patches[0];
      if (!isJsonObject(patch)) return "Change checklist";
      const verb = patch.operation === "add" ? "Add" : patch.operation === "remove" ? "Remove" : "Update";
      const index = Value.Check(Type.Integer({ minimum: 1 }), patch.index) ? ` ${patch.index}` : "";
      const status = patch.status === "completed" ? "complete" : patch.status === "in_progress" ? "in progress" : patch.status === "pending" ? "pending" : "";
      const step = Value.Check(toolStringArgumentSchema, patch.step) ? patch.step : Value.Check(toolStringArgumentSchema, patch.match) ? patch.match : "";
      return truncateOneLine(`${verb} step${index}${status ? ` · ${status}` : ""}${step ? ` — ${step}` : ""}`, 120);
    }
    default: return "Update checklist";
  }
}

function toolSummaryText(tool: ToolView): string {
  return [codemodeCallName(tool.name) || "tool", toolSummaryHtml(tool)].filter(Boolean).join(" · ");
}

interface ToolPresentation {
  showsDetail: boolean;
  autoOpenOnReveal: boolean;
}

function toolPresentation(tool: ToolView): ToolPresentation {
  const active = tool.status === "streaming" || tool.status === "running";
  const showsDetail = !(active && (tool.name === "read" || tool.name === "edit"));
  return { showsDetail, autoOpenOnReveal: showsDetail && tool.name === "edit" };
}

function tailFrameAttributes(ctx: AgentRenderContext, key: string): string {
  return `id="${ids.detailFrame(ctx, key)}" data-controller="agent-tail-frame" data-action="turbo:frame-load->agent-tail-frame#loaded"`;
}

function lazyTranscriptItemFrame(ctx: AgentRenderContext, key: string): string {
  return `<turbo-frame ${tailFrameAttributes(ctx, key)} data-turbo-permanent data-agent-lazy-detail-target="frame" data-src="${escapeHtml(transcriptItemPath(ctx, key))}"></turbo-frame>`;
}

/**
 * A tool call's row, opening to its detail. A `nested` call, such as a script's, has no detail route: its detail is
 * inline and never paginated.
 */
export function renderToolCard(ctx: AgentRenderContext, key: string, tool: ToolView, options: { open?: boolean; live?: boolean; nested?: boolean; timestamp?: number } = {}): string {
  const liveDuration = isBashTool(tool.name) && tool.status === "running" && tool.issuedAt !== undefined && !ctx.readOnly;
  const timeout = numberArg(toolArgs(tool), "timeout") ?? 600;
  const label = {
    kind: "text" as const,
    text: toolSummaryText(tool),
    attributesHtml: liveDuration ? `data-controller="agent-elapsed" data-agent-elapsed-since-value="${tool.issuedAt}" data-agent-elapsed-prefix-value="${escapeHtml(tool.name)} · " data-agent-elapsed-suffix-value=" / ${formatDuration(timeout * 1000)}" data-agent-elapsed-format-value="duration"` : undefined,
    textAttributesHtml: liveDuration ? 'data-agent-elapsed-target="time"' : undefined,
  };
  const labelOptions = {
    leadingHtml: `<span id="${ids.itemSummaryStatus(ctx, key)}" class="agent-tool-status">${statusHtml(tool.status, ctx.readOnly)}</span>`,
    labelId: ids.itemSummaryContent(ctx, key),
    trailingHtml: tool.canAbort && !ctx.readOnly ? toolAbortHtml(ctx, key, tool) : undefined,
  };
  const active = tool.status === "streaming" || tool.status === "running";
  const content = transcriptRowContent(label, labelOptions);
  const timestamp = transcriptTimestampAttributes(tool.issuedAt ?? options.timestamp);
  if (!toolPresentation(tool).showsDetail) {
    return `<div class="agent-tool agent-tool-summary-only ${toolClass(tool.name)} active">${contentRowHtml({ ...content, element: { tag: "div", attributesHtml: timestamp }, primary: false })}</div>`;
  }
  const open = Boolean(options.open || active);
  const lazy = !options.nested && !options.live && !active && !options.open;
  return `<div class="agent-tool ${toolClass(tool.name)}${active ? " active" : ""}${tool.status === "error" ? " error" : ""}">${disclosureHtml({
    element: lazy ? { attributesHtml: 'data-controller="agent-lazy-detail" data-action="toggle->agent-lazy-detail#load"' } : undefined,
    summary: { ...content, attributesHtml: timestamp }, open,
    bodyHtml: options.nested ? renderToolDetail(ctx, key, tool, Number.MAX_SAFE_INTEGER)
      : lazy ? lazyTranscriptItemFrame(ctx, key) : `<turbo-frame ${tailFrameAttributes(ctx, key)} class="agent-tool-detail-host">${renderToolDetail(ctx, key, tool, 100)}</turbo-frame>`,
  })}</div>`;
}

function toolAbortHtml(ctx: AgentRenderContext, key: string, tool: ToolView): string {
  const id = domId(ids.item(ctx, key), "abort");
  const noteId = `${id}_note`;
  const actions = buttonGroupHtml({
    orientation: "horizontal", semantics: "layout",
    itemsHtml: buttonHtml({
      type: "button", variant: "secondary", content: { kind: "caption", caption: "Keep running" },
      attributesHtml: 'data-action="dialog#close"',
    }) + buttonHtml({
      type: "submit", variant: "danger", content: { kind: "caption", caption: "Stop tool only" },
    }),
  });
  return buttonHtml({
    type: "button", variant: "danger",
    content: { kind: "icon-only", iconHtml: Icons.Stop, label: "Stop this tool only; the agent will continue" },
    attributesHtml: `commandfor="${escapeHtml(id)}" command="show-modal"`,
  }) + dialogHtml({
    element: { id, actions: "turbo:submit-end->dialog#submitted", attributesHtml: "data-turbo-permanent" },
    iconHtml: Icons.Stop, titleCaption: "Stop this tool?", closeLabel: "Keep running",
    bodyHtml: `<p>The agent will continue. Add a note to tell it why you stopped this tool.</p>
      <form method="post" data-controller="agent-tool-abort" data-action="keydown->agent-tool-abort#keydown" action="${escapeHtml(agentPath(ctx, `/tools/${encodeURIComponent(tool.callId)}/abort`))}">
        <label for="${escapeHtml(noteId)}">Note (optional)</label>
        <textarea class="textarea" id="${escapeHtml(noteId)}" name="note" rows="3"></textarea>
        <div class="agent-tool-abort-actions">${actions}</div>
      </form>`,
  });
}

function sourceRegionHtml(title: string, body: string, className = "agent-source-region"): string {
  return detailFullscreen(title, `<section class="${className}"><div class="agent-region-header">${escapeHtml(title)}</div>${body}</section>`);
}

interface TextWindow {
  text: string;
  hidden: number;
}

function textWindow(text: string, mode: "first" | "last", count: number): TextWindow {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.length <= count) return { text, hidden: 0 };
  return mode === "first" ? { text: lines.slice(0, count).join("\n"), hidden: lines.length - count } : { text: lines.slice(-count).join("\n"), hidden: lines.length - count };
}

function moreLink(ctx: AgentRenderContext, key: string, count: number, hidden: number, direction: "first" | "last"): string {
  if (!hidden) return "";
  const increment = Math.min(500, hidden);
  const next = count + increment;
  return `<div class="agent-more-lines"><a href="${escapeHtml(transcriptItemPath(ctx, key, `?count=${next}`))}" data-turbo-frame="${ids.detailFrame(ctx, key)}" data-action="click->agent-tail-frame#prepare" data-direction="${direction}">show ${increment} more ${increment === 1 ? "line" : "lines"}</a></div>`;
}

function tailOutput(content: string, pagination: string, direction: "first" | "last"): string {
  return `<div class="agent-tail-output" data-agent-tail-direction="${direction}">${direction === "last" ? pagination : ""}${content}${direction === "first" ? pagination : ""}</div>`;
}

interface BashViews {
  display: string;
  model: string;
  same: boolean;
  resultWindow: TextWindow;
  modelWindow: TextWindow;
}

function bashViews(tool: ToolView, count: number): BashViews {
  const details = tool.details;
  const display = details?.displayAnsi?.trimEnd() ?? "";
  const model = trimResult(tool);
  return { display, model, same: !display || display === model, resultWindow: textWindow(display || model || "(no output)", "last", count), modelWindow: textWindow(model || "(no output)", "last", count) };
}

function toolCopyButton(label: string): string {
  return copyButtonHtml({ label: `Copy ${label} to clipboard` });
}

function copyableToolBody(body: string, label: string): string {
  return `<div class="copy-region">${toolCopyButton(label)}<div class="copy-source" data-copy-source>${body}</div></div>`;
}

function comparisonHeader(title: string, primaryLabel: string, secondaryLabel = "As seen by model"): string {
  const toggle = toggleHtml({
    variant: "text-subtle",
    label: `${title} view`,
    name: "agent-region-view",
    value: "primary",
    options: [
      { label: primaryLabel, value: "primary" },
      { label: secondaryLabel, value: "model" },
    ],
  });
  return `<div class="agent-region-header agent-region-tabs"><span>${escapeHtml(title)}</span>${toggle}</div>`;
}

function renderBashResultViews(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const { display, model, same, resultWindow, modelWindow } = bashViews(tool, count);
  const result = display ? `<pre class="agent-tool-result agent-tool-region-body agent-tool-ansi">${terminalOutputHtml(resultWindow.text)}</pre>` : `<pre class="agent-tool-result agent-tool-region-body">${escapeHtml(resultWindow.text)}</pre>`;
  const resultHtml = tailOutput(result, moreLink(ctx, key, count, resultWindow.hidden, "last"), "last");
  const fullResult = display ? `<pre class="agent-tool-result agent-tool-region-body agent-tool-ansi">${terminalOutputHtml(display)}</pre>` : `<pre class="agent-tool-result agent-tool-region-body">${escapeHtml(model || "(no output)")}</pre>`;
  if (same) return fullscreenSourceRegion("Result", `<section class="agent-tool-region agent-bash-output"><div class="agent-region-header">Result</div>${copyableToolBody(resultHtml, "result")}</section>`, fullResult);
  const modelHtml = tailOutput(`<pre class="agent-tool-result agent-tool-region-body">${escapeHtml(modelWindow.text)}</pre>`, moreLink(ctx, key, count, modelWindow.hidden, "last"), "last");
  return `<section class="agent-tool-region agent-bash-output">${comparisonHeader("Result", "As emitted")}<div class="agent-region-pane region-primary-pane">${fullscreenSourceRegion("Result", copyableToolBody(resultHtml, "colored result"), fullResult)}</div><div class="agent-region-pane region-model-pane">${fullscreenSourceRegion("As seen by model", copyableToolBody(modelHtml, "model result"), `<pre class="agent-tool-result agent-tool-region-body">${escapeHtml(model || "(no output)")}</pre>`)}</div></section>`;
}

/** Source as the model wrote it, beside a readable version when formatting changed it. */
function readableSourceRegion(title: string, label: string, className: string, original: string, readable?: string): string {
  if (readable === undefined) return sourceRegionHtml(title, copyableToolBody(original, label), className);
  return `<section class="${className}">${comparisonHeader(title, "Readable", "Original")}<div class="agent-region-pane region-primary-pane">${fullscreenSourceRegion(title, copyableToolBody(readable, `readable ${label}`), readable)}</div><div class="agent-region-pane region-model-pane">${fullscreenSourceRegion("Original", copyableToolBody(original, `original ${label}`), original)}</div></section>`;
}

function renderBashCommand(command: string, streaming: boolean): string {
  const bodyClass = "agent-tool-code agent-tool-region-body";
  const className = "agent-tool-region agent-bash-command";
  // Incomplete shell syntax alternates between parseable and unparseable as
  // arguments arrive. Formatting it rewrites earlier lines and toggles the
  // comparison layout, even with morph updates. Keep the source layout until
  // the command is complete, including its embedded code regions.
  if (streaming) return readableSourceRegion("Command", "command", className, highlightedBashCommandHtml(command, bodyClass));
  const formatted = formatBashCommandForDisplay(command);
  const embedded = embeddedBashCommand(command, formatted, bodyClass);
  const commandBody = embedded?.html ?? highlightedBashCommandHtml(formatted, bodyClass);
  if (formatted === command && !embedded?.differs) return readableSourceRegion("Command", "command", className, commandBody);
  return readableSourceRegion("Command", "command", className, `<pre class="${bodyClass}"><code>${escapeHtml(command)}</code></pre>`, commandBody);
}

function renderBashDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const command = stringArg(toolArgs(tool), "command") ?? "";
  const commandHtml = renderBashCommand(command, tool.status === "streaming");
  if (tool.status === "streaming") return `<div class="agent-tool-detail">${commandHtml}</div>`;
  if (tool.status === "running") {
    // The viewer owns its generated DOM and the awaiting-output visibility state.
    const terminal = tool.terminalProcessId ? `<section id="${domId(ids.item(ctx, key), "terminal", ctx.workspaceId, tool.terminalProcessId)}" data-turbo-permanent class="agent-tool-region agent-bash-output agent-terminal-awaiting-output"><div class="agent-region-header">Live terminal</div><div class="agent-terminal-viewport"><div class="agent-tool-term observable-terminal-host" data-controller="agent-term" data-agent-term-url-value="${escapeHtml(terminalProcessSocketPath(ctx.workspaceId, tool.terminalProcessId))}"></div></div></section>` : "";
    return `<div class="agent-tool-detail agent-bash-detail">${commandHtml}${terminal}</div>`;
  }
  return `<div class="agent-tool-detail agent-bash-detail">${commandHtml}${renderBashResultViews(ctx, key, tool, count)}</div>`;
}

// Code mode: the script, a row per tool call it made, and its result.

/** One call of the result's `details.calls`, as pi's coding agent and pi-durable both record them. */
const codemodeCallSchema = Type.Object({
  id: Type.Union([Type.String(), Type.Number()]),
  name: Type.String(),
  args: Type.String(),
  status: Type.Union([Type.Literal("running"), Type.Literal("ok"), Type.Literal("error"), Type.Literal("cancelled")]),
  durationMs: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
});
/** Arguments of code mode's `models.*` calls, which name the model they run. */
const modelCallArgumentsSchema = Type.Object({ model: Type.Object({ id: Type.String() }) });
const codemodeHeader = /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n\n?/;

/**
 * The script's calls: the agent's own record of them, else the list its result has, which keeps a
 * preview of each call's arguments and no results.
 */
function codemodeCalls(tool: ToolView): ToolView[] {
  if (tool.nested) return tool.nested;
  const calls = Array.isArray(tool.details?.calls) ? tool.details.calls : [];
  return calls.flatMap((call): ToolView[] => {
    if (!Value.Check(codemodeCallSchema, call)) return [];
    let args: unknown = call.args;
    try {
      args = JSON.parse(call.args);
    } catch {
      // The preview is cut for display, so long arguments are not JSON anymore.
    }
    return [{
      callId: `${tool.callId}/${call.id}`, name: call.name, args,
      status: call.status === "cancelled" ? "error" : call.status,
      durationMs: call.durationMs, resultText: call.error,
      details: call.status === "cancelled" ? { aborted: true } : undefined,
      resultUnavailable: true,
    }];
  });
}

/** Code mode's internal tools behind `models.*`, such as `pi.codemode.models.classify`, as scripts call them. */
function codemodeCallName(name: string): string {
  return name.replace(/^pi\.codemode\./, "");
}
const codemodeModelCall = /^pi\.codemode\.models\./;

function codemodeOutput(tool: ToolView): { text: string; wallMs?: number } {
  const text = trimResult(tool);
  const header = text.match(codemodeHeader);
  return header ? { text: text.slice(header[0].length).trim(), wallMs: Number(header[2]) * 1000 } : { text };
}

/** A script file as a call ran it: its path and the start of its contents' hash, like `/work/audit.js @ 3f9c2a1`. */
function scriptFileLabel(file: ScriptFileView, path = file.path): string {
  return `${path} @ ${file.sha256.slice(0, 7)}`;
}

function codemodeSummary(tool: ToolView): string {
  const calls = codemodeCalls(tool);
  const failed = calls.filter((call) => call.status === "error").length;
  const wallMs = tool.status === "ok" || tool.status === "error" ? codemodeOutput(tool).wallMs : undefined;
  return summaryHtml([
    tool.scriptFile ? scriptFileLabel(tool.scriptFile, tool.scriptFile.path.split("/").at(-1)) : "",
    calls.length ? `${calls.length} tool ${calls.length === 1 ? "call" : "calls"}` : "",
    failed ? `${failed} failed` : "",
    wallMs === undefined ? "" : formatDuration(wallMs),
  ]);
}

/** A finished call whose result was not recorded: its arguments and error. */
function renderNestedCallRecord(call: ToolView): string {
  const command = isBashTool(call.name) ? stringArg(toolArgs(call), "command") : undefined;
  const bodyClass = "agent-tool-code agent-tool-region-body";
  const args = command !== undefined ? renderBashCommand(command, false)
    : readableSourceRegion("Arguments", "arguments", "agent-tool-region", isJsonObject(call.args)
      ? codeBlockHtml(JSON.stringify(call.args, null, 2), "arguments.json", bodyClass)
      : `<pre class="${bodyClass}">${escapeHtml(String(call.args ?? ""))}</pre>`);
  const error = call.status === "error" && call.resultText ? `<pre class="agent-tool-error-output">${escapeHtml(call.resultText.trimEnd())}</pre>` : "";
  return `<div class="agent-tool-detail">${args}${error}</div>`;
}


/** What a script's calls did: how many, how many still run, and what the agents they ran used. */
function executionSummary(calls: readonly ToolView[]): string {
  const running = calls.filter(call => call.status === "running" || call.status === "streaming").length;
  const failed = calls.filter(call => call.status === "error").length;
  const agents = calls.filter(call => call.childAgentId !== undefined).length;
  const usage = calls.flatMap(call => call.usage ? [call.usage] : []);
  return summaryHtml([
    "Execution",
    `${calls.length} tool ${calls.length === 1 ? "call" : "calls"}`,
    running ? `${running} running` : "",
    failed ? `${failed} failed` : "",
    agents ? `${agents} ${agents === 1 ? "agent" : "agents"}` : "",
    usage.length ? `${formatTokens(usage.reduce((sum, item) => sum + item.outputTokens, 0))} tok` : "",
    usage.length ? formatCost(usage.reduce((sum, item) => sum + item.cost, 0)) : "",
  ]);
}

/** One part of a script's card, such as its source or result, behind a row of its own. */
function codemodeSectionHtml(className: string, label: string, open: boolean, bodyHtml: string): string {
  return `<div class="agent-codemode-section ${className}">${disclosureHtml({ summary: { kind: "compact", width: "fill", label: { kind: "text", text: label } }, open, bodyHtml })}</div>`;
}

/** A JavaScript script, highlighted, beside its readable version when there is one. */
export function scriptSourceRegion(code: string, readable: string | undefined): string {
  const bodyClass = "agent-tool-code agent-tool-region-body";
  return readableSourceRegion("Script", "script", "agent-tool-region agent-script", codeBlockHtml(code, "script.js", bodyClass), readable === undefined ? undefined : codeBlockHtml(readable, "script.js", bodyClass));
}

/** Text output, or the object or array it holds, such as a script's return value, as indented and highlighted JSON. */
function outputHtml(output: string, textClass: string, codeClass: string): string {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    // Other output shows as text.
  }
  return isJsonObject(value) || Array.isArray(value)
    ? codeBlockHtml(JSON.stringify(value, null, 2), "output.json", codeClass)
    : `<pre class="${textClass}">${escapeHtml(output)}</pre>`;
}

/**
 * A script's card: its source, the calls it made, and its result, each behind a row. Only the result starts open; while
 * the script streams its source does, and while it runs its calls do.
 */
function renderCodemodeDetail(ctx: AgentRenderContext, key: string, tool: ToolView): string {
  // A call naming a script file shows the file as the call ran it.
  const code = tool.scriptFile?.code ?? stringArg(toolArgs(tool), "code") ?? "";
  const scriptLabel = tool.scriptFile ? `Script · ${scriptFileLabel(tool.scriptFile)}` : "Script";
  // Like bash commands: keep the source layout while it streams, so lines do not jump.
  const script = codemodeSectionHtml("agent-codemode-script", scriptLabel, tool.status === "streaming",
    `<div class="agent-tool-detail">${scriptSourceRegion(code, tool.status === "streaming" ? undefined : formatCodemodeScriptForDisplay(code))}</div>`);
  const calls = codemodeCalls(tool);
  const execution = calls.length ? codemodeSectionHtml("agent-codemode-execution", executionSummary(calls), tool.status === "running",
    `<div class="agent-codemode-call-list">${calls.map((call) => renderToolCard(ctx, `${key}/${call.callId}`, call, { nested: true })).join("")}</div>`) : "";
  const done = tool.status === "ok" || tool.status === "error";
  const output = done ? codemodeOutput(tool).text : "";
  const images = done ? toolResultImagesHtml(ctx, tool) : "";
  const outputBody = !output ? "" : tool.status === "error" ? `<pre class="agent-tool-error-output">${escapeHtml(output)}</pre>` : outputHtml(output, "agent-tool-result agent-tool-region-body", "agent-tool-code agent-tool-region-body");
  const resultSection = outputBody || images ? codemodeSectionHtml("agent-codemode-result", "Result", true,
    `<div class="agent-tool-detail">${fullscreenSourceRegion("Result", `${outputBody ? copyableToolBody(outputBody, "result") : ""}${images}`, `${outputBody}${images}`)}</div>`) : "";
  return `<div class="agent-codemode-detail">${script}${execution}${resultSection}</div>`;
}

function fullscreenSourceRegion(title: string, inlineHtml: string, fullHtml: string): string {
  return `<div class="agent-detail-fullscreen"${fullscreenAttributes(title)}>${inlineHtml}<template data-kintsugi-fullscreen-target="content">${fullHtml}</template></div>`;
}

function renderReadDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const images = toolResultImagesHtml(ctx, tool);
  const result = trimResult(tool);
  if (images) {
    const text = result ? copyableToolBody(`<pre class="agent-tool-note agent-tool-region-body">${escapeHtml(result)}</pre>`, "read result") : "";
    const region = `<section class="agent-tool-region agent-read-result">${images}${text}</section>`;
    return `<div class="agent-tool-detail">${detailFullscreen("Read", region)}</div>`;
  }
  const window = textWindow(result, "first", count);
  const path = stringArg(toolArgs(tool), "path", "file_path");
  const bodyClass = "agent-tool-code agent-tool-region-body";
  const full = codeBlockHtml(result, path, bodyClass);
  const preview = window.text === result ? full : codeBlockHtml(window.text, path, bodyClass);
  const shown = tailOutput(preview, moreLink(ctx, key, count, window.hidden, "first"), "first");
  return `<div class="agent-tool-detail">${fullscreenSourceRegion("Read", `<section class="agent-tool-region agent-read-result">${copyableToolBody(shown, "read result")}</section>`, full)}</div>`;
}

function renderWriteDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const args = toolArgs(tool);
  const content = stringArg(args, "content") ?? "";
  const path = stringArg(args, "path", "file_path");
  const shown = tool.status === "streaming" || tool.status === "running" ? { text: content, hidden: 0 } : textWindow(content, "first", count);
  const bodyClass = "agent-tool-code agent-tool-region-body";
  const full = codeBlockHtml(content, path, bodyClass);
  const highlighted = shown.text === content ? full : codeBlockHtml(shown.text, path, bodyClass);
  const preview = tailOutput(highlighted, moreLink(ctx, key, count, shown.hidden, "first"), "first");
  const error = tool.status === "error" && tool.resultText ? `<pre class="agent-tool-error-output">${escapeHtml(trimResult(tool))}</pre>` : "";
  return `<div class="agent-tool-detail">${fullscreenSourceRegion("Write", `<section class="agent-tool-region agent-write-result">${copyableToolBody(preview, "written content")}</section>`, full)}${error}</div>`;
}

function editDiffs(tool: ToolView, contextual: boolean): FileDiffMetadata[] {
  const patch = tool.details?.patch;
  if (patch) return processPatch(patch).files;
  const path = stringArg(toolArgs(tool), "path", "file_path") ?? "edited-file.txt";
  return getEditOperations(toolArgs(tool)).map((operation) => parseDiffFromFile(
    { name: path, contents: operation.oldText },
    { name: path, contents: operation.newText },
    { context: contextual ? 3 : 1_000_000 },
  ));
}

function editDiffHtml(tool: ToolView, contextual: boolean): string {
  const diffs = editDiffs(tool, contextual);
  if (!diffs.length) return "";
  const model = JSON.stringify(diffs).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
  return `<div class="kintsugi-pierre-host agent-edit-pierre" data-controller="agent-edit-diff">${diffs.map(() => "<diffs-container></diffs-container>").join("")}<script type="application/json" data-agent-edit-diff-target="model">${model}</script></div>`;
}

function renderEditDetail(tool: ToolView): string {
  const preview = editDiffHtml(tool, true) || genericParamsHtml(tool);
  const full = editDiffHtml(tool, false) || genericParamsHtml(tool);
  const edits = fullscreenSourceRegion("Edit", `<section class="agent-tool-region agent-edit-result">${copyableToolBody(`<div class="agent-edit-details agent-tool-region-body">${preview}</div>`, "edit")}</section>`, `<div class="agent-edit-details agent-tool-region-body">${full}</div>`);
  const error = tool.status === "error" && tool.resultText ? `<pre class="agent-tool-error-output">${escapeHtml(trimResult(tool))}</pre>` : "";
  return `<div class="agent-tool-detail">${edits}${error}</div>`;
}

function renderGenericDetail(ctx: AgentRenderContext, tool: ToolView): string {
  const html = `${genericParamsHtml(tool)}${genericResultHtml(ctx, tool)}`;
  return `<div class="agent-tool-detail">${detailFullscreen(tool.name, html)}</div>`;
}

export function renderToolDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const custom = agentToolPresentation(tool.name)?.detail(ctx, tool);
  if (custom !== undefined) return custom;
  if (tool.resultUnavailable) return renderNestedCallRecord(tool);
  if (isBashTool(tool.name)) return renderBashDetail(ctx, key, tool, count);
  if (tool.name === "codemode") return renderCodemodeDetail(ctx, key, tool);
  if (tool.name === "read") return renderReadDetail(ctx, key, tool, count);
  if (tool.name === "write") return renderWriteDetail(ctx, key, tool, count);
  if (tool.name === "edit") return renderEditDetail(tool);
  return renderGenericDetail(ctx, tool);
}

function toolClass(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  return `tool-${slug}`;
}

function toolArgs(tool: ToolView): JsonObject | undefined {
  return isJsonObject(tool.args) ? tool.args : undefined;
}

function toolArgument<Schema extends TSchema>(args: JsonObject | undefined, schema: Schema, ...keys: ToolArgumentKey[]): Static<Schema> | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (Value.Check(schema, value)) return value;
  }
  return undefined;
}

function stringArg(args: JsonObject | undefined, ...keys: ToolArgumentKey[]): string | undefined {
  return toolArgument(args, toolStringArgumentSchema, ...keys);
}

function numberArg(args: JsonObject | undefined, key: ToolArgumentKey): number | undefined {
  return toolArgument(args, toolNumberArgumentSchema, key);
}

function formatReadRange(args: JsonObject | undefined): string {
  const offset = numberArg(args, "offset");
  const limit = numberArg(args, "limit");
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  const end = limit !== undefined ? start + limit - 1 : undefined;
  return `:${start}${end !== undefined ? `-${end}` : ""}`;
}

function pathSummary(tool: ToolView, range = ""): string {
  const args = toolArgs(tool);
  const path = stringArg(args, "path", "file_path");
  return path ? `${path}${range}` : "";
}

function truncateOneLine(text: string, limit: number): string {
  const oneLine = text.replaceAll("\n", " ");
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

function trimResult(tool: ToolView): string {
  return (tool.resultText ?? "").trimEnd();
}

function toolResultImagesHtml(ctx: AgentRenderContext, tool: ToolView): string {
  const images = tool.resultImages ?? [];
  if (images.length === 0) return "";
  const baseTitle = pathSummary(tool) || "image";
  return `<div class="agent-tool-images">${images.map((image, index) => {
    const title = images.length === 1 ? baseTitle : `${baseTitle} ${index + 1}`;
    return `<img class="agent-media-img agent-tool-image"${fullscreenAttributes(title, "media")} src="${escapeHtml(sessionImageUrl(ctx, image))}" alt="${escapeHtml(title)}" loading="lazy">`;
  }).join("")}</div>`;
}

function getEditOperations(args: JsonObject | undefined): DiffOperation[] {
  if (Array.isArray(args?.edits)) {
    return args.edits.flatMap((edit) => Value.Check(diffOperationSchema, edit) ? [edit] : []);
  }
  const oldText = stringArg(args, "oldText");
  const newText = stringArg(args, "newText");
  return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [];
}

function genericToolSummary(tool: ToolView): string {
  const args = toolArgs(tool);
  if (!args) return "";
  const custom = agentToolPresentation(tool.name)?.summary(tool);
  if (custom !== undefined) return custom;
  const direct = stringArg(args, "command", "path", "file_path");
  if (direct) return truncateOneLine(direct, 120);
  const json = JSON.stringify(args);
  return json && json !== "{}" ? truncateOneLine(json, 120) : "";
}

function genericParamsHtml(tool: ToolView): string {
  const args = toolArgs(tool);
  if (!args) return "";
  const values = Object.values(args);
  if (values.length === 0) return "";
  if (values.length === 1 && genericToolSummary(tool) === values[0]) return "";
  return codeBlockHtml(JSON.stringify(args, null, 2), "arguments.json", "agent-tool-code");
}

function genericResultHtml(ctx: AgentRenderContext, tool: ToolView): string {
  const result = trimResult(tool);
  const images = toolResultImagesHtml(ctx, tool);
  return `${result ? outputHtml(result, "agent-tool-result", "agent-tool-code") : ""}${images}`;
}
