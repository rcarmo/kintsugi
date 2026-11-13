import { Type } from "typebox";
import { Value } from "typebox/value";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { buttonHtml } from "@kintsugi/design-system/button";
import { buttonGroupHtml } from "@kintsugi/design-system/button-group";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { warningBannerHtml } from "@kintsugi/design-system/warning-banner";
import { escapeHtml as h, errorMessage, turboStream, turboStreamResponse, type SettingsContribution } from "@kintsugi/shared";
import type { JsonObject } from "@kintsugi/core";
import { readPiModelCatalogue } from "@kintsugi/llm/server";
import { modelFor, parsePolicy, type Policy } from "@kintsugi/token-economizer/core";
import type { ModelRef } from "@kintsugi/token-economizer/core";
import type { HostSession } from "@kintsugi/token-economizer/pi-durable";
import { tokenOptimizerConfiguration, parseOptimizerConfig, optimizerConfigSchema, type OptimizerConfig } from "./token-optimizer-config.ts";
import { nativeTokenOptimizers } from "./token-optimizer.ts";
import { readWorkspaceTitle } from "@kintsugi/workspace";
import { describeKnowledge, type FactSummary } from "@kintsugi/token-economizer/core";
import type { GuardDecisionRecord } from "@kintsugi/token-economizer/pi-durable";

const panel = "token_optimizer_controls";
type Mode = "off" | "observe" | "active";
type Preset = "basic" | "assisted" | "custom";
type Native = ReturnType<typeof nativeTokenOptimizers>[number][1];
type Catalogue = Awaited<ReturnType<typeof readPiModelCatalogue>>;
type Option = [value: string, label: string];
/** `focus` names the Agent disclosure to keep open; `form` places feedback beside Save. */
type View = { message?: string; error?: boolean; draft?: OptimizerConfig; focus?: string; form?: boolean };
const modeSchema = Type.Enum(["off", "observe", "active"]);
const presetSchema = Type.Enum(["basic", "assisted", "custom"]);
const modelRefSchema = Type.Object({ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const modeLabels = { off: "Off", observe: "Watch only", active: "On" } satisfies Record<Mode, string>;
const saverNames = ["localLoop", "authorizeLocalStuck", "toolPrefilter", "localToolDrops", "reuse", "templates", "novelty", "compact"] as const;
const judgeOptions: Option[] = [["generative", "Model"], ["classifier", "Classifier model"], ["cascade", "Classifier, then model if unsure"]];

function presetOf(policy: Policy): Preset {
  if (saverNames.some(name => policy.savers[name])) return "custom";
  // A fresh installation starts from the recommended preset.
  if (policy.microSkills === "off" && policy.loop === "off" && policy.pruning === "off") return "basic";
  if (policy.microSkills === "envfacts" && policy.loop === "rules" && policy.pruning === "propose" && policy.toolJudge === "none") return "basic";
  if (policy.microSkills === "both" && policy.loop === "judge" && policy.judge === "generative" && policy.pruning === "propose" && policy.toolJudge === "generative") return "assisted";
  return "custom";
}
function applyPreset(policy: Policy, preset: Exclude<Preset, "custom">) {
  const assisted = preset === "assisted";
  policy.reduceOutputs = true;policy.goalChecks = true;
  policy.microSkills = assisted ? "both" : "envfacts";
  policy.loop = assisted ? "judge" : "rules";
  policy.judge = "generative";
  policy.pruning = "propose";
  policy.toolJudge = assisted ? "generative" : "none";
  for (const name of saverNames) policy.savers[name] = false;
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function choice(name: string, value: string, checked: boolean, label: string, hint: string) {
  return `<label class="token-optimizer__choice"><input type="radio" name="${name}" value="${value}"${checked ? " checked" : ""}><span class="token-optimizer__choice-label">${h(label)}<small>${h(hint)}</small></span></label>`;
}
function choices(legend: string, body: string) {
  return `<fieldset class="token-optimizer__group"><legend class="token-optimizer__legend">${h(legend)}</legend><div class="token-optimizer__choices">${body}</div></fieldset>`;
}
function row(label: string, control: string, hint = "") {
  return `<label class="settings-field token-optimizer__row"><span class="token-optimizer__row-label">${h(label)}${hint ? `<small>${h(hint)}</small>` : ""}</span>${control}</label>`;
}
function select(name: string, label: string, value: string, options: Option[]) {
  return `<span><select class="popup-select" data-controller="popup-select" name="${h(name)}" aria-label="${h(label)}">${options.map(([option, text]) => `<option value="${h(option)}"${option === value ? " selected" : ""}>${h(text)}</option>`).join("")}</select></span>`;
}
const selectRow = (name: string, label: string, value: string, options: Option[], hint = "") => row(label, select(name, label, value, options), hint);
function numberRow(name: string, label: string, value: number | null, options: { min?: number; max?: number; step?: number; hint?: string; placeholder?: string } = {}) {
  return row(label, `<input class="text-field token-optimizer__number" type="number" name="${name}" min="${options.min ?? 1}"${options.max === undefined ? "" : ` max="${options.max}"`} step="${options.step ?? 1}" value="${value ?? ""}"${options.placeholder ? ` placeholder="${h(options.placeholder)}"` : ""}>`, options.hint);
}
const checkboxRow = (name: string, label: string, checked: boolean, hint = "", value = "true") => row(label, `<input type="checkbox" name="${name}" value="${h(value)}"${checked ? " checked" : ""}>`, hint);
const heading = (text: string) => `<h4 class="token-optimizer__subheading">${h(text)}</h4>`;
const disclosure = (label: string, body: string, open = false) => disclosureHtml({ open, summary: { kind: "compact", label: { kind: "text", text: label } }, bodyHtml: `<div class="form-stack">${body}</div>` });
const feedback = (view: View) => view.message ? `<p class="${view.error ? "settings-error" : "settings-help"}" role="${view.error ? "alert" : "status"}">${h(view.message)}</p>` : "";

function modelOptions(catalogue: Catalogue, classifier: boolean, selected: ModelRef | null, none: string): Option[] {
  const models = (classifier ? catalogue.getModelsOfType("classifier") : catalogue.getModels()).filter(model => catalogue.configuredProviderIds.has(model.provider));
  const options: Option[] = [["", none], ...models.map((model): Option => [JSON.stringify({ provider: model.provider, id: model.id }), `${model.name || model.id} · ${model.provider}`])];
  const value = selected ? JSON.stringify(selected) : "";
  if (selected && !options.some(([option]) => option === value)) options.push([value, `${selected.id} · ${selected.provider} (not connected)`]);
  return options;
}

function advancedHtml(policy: Policy, catalogue: Catalogue) {
  const savers = policy.savers, budget = policy.budget;
  const features = `<div class="token-optimizer__custom form-stack">${heading("Features")}
    <input type="hidden" name="nativeChecks" value="true">
    ${checkboxRow("reduceOutputs", "Compact test and compiler output", policy.reduceOutputs ?? false, "Keeps full logs and script results. No model calls.")}
    ${checkboxRow("goalChecks", "Keep the current task in view", policy.goalChecks ?? false, "Checks the latest request, active plan and unverified edits. Shares the nudge limit.")}
    ${selectRow("microSkills", "Repository facts", policy.microSkills, [["off", "Off"], ["envfacts", "From tool results"], ["distiller", "Written by a model"], ["both", "Both"]])}
    ${selectRow("loop", "Runs going in circles", policy.loop, [["off", "Leave alone"], ["rules", "Nudge using rules"], ["judge", "Nudge using rules and a judge"]])}
    ${selectRow("judge", "Stuck-run judge", policy.judge, judgeOptions, "Used when nudges include a judge.")}
    ${selectRow("level", "When to step in", policy.level, [["conservative", "Patiently"], ["default", "Normally"], ["aggressive", "Early"]])}
    ${numberRow("redirects", "Nudges per prompt", policy.redirects, { max: 10 })}
    ${selectRow("pruning", "Unused tools", policy.pruning, [["off", "Leave alone"], ["propose", "Suggest hiding them"], ["auto", "Hide them automatically"]], "Restore brings hidden tools back.")}
    ${selectRow("toolJudge", "Task-aware tool picks", policy.toolJudge, [["none", "Off"], ...judgeOptions], "Runs only when you pick tools for a task.")}
    ${disclosure("Call savers and local classifiers", `${heading("Call savers")}
    ${checkboxRow("savers.templates", "Use template nudges", savers.templates, "Skips the model call that writes each nudge.")}
    ${checkboxRow("savers.reuse", "Reuse identical judgements", savers.reuse)}
    ${checkboxRow("savers.novelty", "Only propose facts when something changed", savers.novelty)}
    ${checkboxRow("savers.compact", "Collapse repeated failures before judging", savers.compact)}
    ${heading("Local classifiers")}
    <p class="settings-help">These learn from the judge’s earlier decisions. Each one stays inactive until it passes its safety checks.</p>
    ${checkboxRow("savers.localLoop", "Skip the judge when a run is clearly fine", savers.localLoop)}
    ${checkboxRow("savers.authorizeLocalStuck", "Let it decide a run is stuck", savers.authorizeLocalStuck)}
    ${checkboxRow("savers.toolPrefilter", "Keep tools that clearly match the task", savers.toolPrefilter)}
    ${checkboxRow("savers.localToolDrops", "Let it hide tools by itself", savers.localToolDrops)}
    ${numberRow("savers.auditPercent", "Double-check with the model (%)", savers.auditPercent, { min: 0, max: 20 })}`)}
  </div>`;
  const limits = disclosure("Limits", `    ${numberRow("budget.callsPerSession", "Model calls per Agent session", budget.callsPerSession)}
    ${numberRow("budget.callsPerDay", "Model calls per day", budget.callsPerDay, { hint: "Per workspace." })}
    ${numberRow("budget.maxCostPerSession", "Spending cap per session (USD)", budget.maxCostPerSession, { min: 0, step: 0.01, placeholder: "No cap", hint: "Calls to models without a price are blocked when a cap is set." })}
    ${numberRow("budget.deadlineSeconds", "Time limit per call (seconds)", budget.deadlineMs / 1000, { max: 180 })}
    ${numberRow("budget.maxOutputTokens", "Output limit per call (tokens)", budget.maxOutputTokens)}`);
  const tuning = disclosure("Fine-tuning", `    ${numberRow("maxFacts", "Facts per session", policy.maxFacts)}
    ${numberRow("maxFactTokens", "Fact text limit (tokens)", policy.maxFactTokens)}
    ${numberRow("proposeEvery", "Write new facts every … sessions", policy.proposeEvery)}
    ${numberRow("evidenceMinSessions", "Sessions before suggesting a tool", policy.evidenceMinSessions)}
    ${numberRow("evidencePrompts", "…and prompts", policy.evidencePrompts)}
    ${numberRow("evidenceSessions", "Or after this many sessions", policy.evidenceSessions)}
    ${numberRow("quietMinutes", "Quiet time before hiding automatically (minutes)", policy.quietMinutes, { min: 0, hint: "Waits until the repository is idle this long, or 24 hours at most." })}`);
  const same = "Same as the main model";
  const perTask = disclosure("Models for each task", `${selectRow("classifierModel", "Classifier model", policy.classifierModel ? JSON.stringify(policy.classifierModel) : "", modelOptions(catalogue, true, policy.classifierModel, "None"))}
    ${([["proposer", "Writing facts", false], ["loopJudge", "Judging stuck runs", false], ["writer", "Writing nudges", false], ["toolJudge", "Picking tools", false], ["loopClassifier", "Classifying stuck runs", true], ["toolClassifier", "Classifying tools", true]] as const).map(([name, label, classifier]) => selectRow(`models.${name}`, label, policy.models[name] ? JSON.stringify(policy.models[name]) : "", modelOptions(catalogue, classifier, policy.models[name], classifier ? "Same as the classifier model" : same))).join("")}`);
  const expert = disclosure("Loop guard thresholds", `<label class="token-optimizer__stacked">Overrides as JSON<textarea class="textarea token-optimizer__json" name="thresholds" rows="3" spellcheck="false">${h(JSON.stringify(policy.thresholds))}</textarea></label><p class="settings-help">For example <code>{"min_turns": 30}</code>. Leave <code>{}</code> to use learned values.</p>`);
  return `${features}${limits}${tuning}${perTask}${expert}`;
}

function settingsForm(config: OptimizerConfig, catalogue: Catalogue, view: View) {
  const policy = config.policy, mode: Mode = policy.enabled ? policy.mode : "off", preset = presetOf(policy), budget = policy.budget;
  const models = modelOptions(catalogue, false, policy.generativeModel, "Choose a model…");
  const modelBlock = `<div class="token-optimizer__model form-stack">
    ${selectRow("model", "Model for optimizer calls", policy.generativeModel ? JSON.stringify(policy.generativeModel) : "", models, models.length > 1 ? "A small, fast model is plenty." : "Connect a model provider under Models first.")}
    ${checkboxRow("autoToolPicks", "Pick tools before each new prompt", policy.autoToolPicks ?? false, "Adds a short model call before the Agent starts. If it takes over 20 seconds, the prompt goes ahead anyway.")}
    ${checkboxRow("inferenceInObserve", "Use the model while watching", policy.inferenceInObserve, "Off means Watch only never costs anything.")}
    <p class="settings-help">Up to ${plural(budget.callsPerSession, "call")} per Agent session and ${budget.callsPerDay} per day. Change this in Advanced settings › Limits.</p>
  </div>`;
  return `<form method="post" action="/settings/token-optimizer" class="token-optimizer__form form-stack" data-turbo="true">
    ${choices("Status", ([["off", "Nothing new is learned or applied."], ["observe", "Learns and shows what it would do. Agents are unchanged."], ["active", "Applies what it learns to new and resumed Agent sessions."]] as const).map(([value, hint]) => choice("mode", value, mode === value, modeLabels[value], hint)).join(""))}
    <div class="token-optimizer__when-on form-stack">
      ${choices("What it does", [
        choice("preset", "basic", preset === "basic", "Basic", "Remembers facts, compacts test output, checks task progress and suggests unused tools to hide. No extra model calls."),
        choice("preset", "assisted", preset === "assisted", "Model-assisted", "Basic, plus a model that writes facts, judges stuck runs and picks tools for a task."),
        choice("preset", "custom", preset === "custom", "Custom", "Choose each feature under Advanced settings."),
      ].join(""))}
      ${modelBlock}
      ${disclosure("Advanced settings", advancedHtml(policy, catalogue))}
    </div>
    <div class="token-optimizer__save">${view.form ? feedback(view) : ""}${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Save" } })}</div>
  </form>`;
}

function hidden(workspaceId: string, agentId: string) {
  return `<input type="hidden" name="workspaceId" value="${h(workspaceId)}"><input type="hidden" name="agentId" value="${h(agentId)}">`;
}
function actionForm(workspaceId: string, agentId: string, action: string, caption: string, body = "", variant: "primary" | "secondary" = "secondary") {
  return `<form method="post" action="/settings/token-optimizer/${action}" data-turbo="true" class="token-optimizer__action">${hidden(workspaceId, agentId)}${body}${buttonHtml({ type: "submit", variant, content: { kind: "caption", caption } })}</form>`;
}
function overrideForm(workspaceId: string, agentId: string, value: string, label: string) {
  const inherit = agentId ? "Same as workspace" : "Use main setting";
  return `<form class="token-optimizer__override" method="post" action="/settings/token-optimizer/override" data-turbo="true" data-controller="settings-autosave" data-action="change->settings-autosave#save submit->settings-autosave#submit">${hidden(workspaceId, agentId)}${select("mode", label, value, [["inherit", inherit], ["off", "Off"], ["observe", "Watch only"], ["active", "On"]])}</form>`;
}

type Status = Awaited<ReturnType<Native["optimizer"]["status"]>>;
const time = (at: number) => new Date(at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const factStatus = { "in-use": "In use", quiet: "Rarely relevant, so not shown", checking: "Still checking" } satisfies Record<FactSummary["status"], string>;
const nudgeReasons = new Map([["judge-stuck", "The judge said the run was stuck."], ["envelope", "It kept repeating the same failures for longer than usual."], ["backstop", "It ran far longer than usual without making progress."], ["ambiguous-past-envelope", "Progress was unclear and it ran longer than usual."]]);
const nudgeStatus = { proposed: "Waiting for a safe moment", queued: "Sent", consumed: "Sent", simulated: "Would have sent (Watch only)", undelivered: "Not sent: the run ended first" } satisfies Record<GuardDecisionRecord["status"], string>;
const list = (items: string[]) => items.length ? `<ul class="token-optimizer__list">${items.join("")}</ul>` : "";
const item = (text: string, detail = "") => `<li>${h(text)}${detail ? `<small>${h(detail)}</small>` : ""}</li>`;

/** The facts actually in this session's context, as listed in its frozen section. */
function sessionFacts(section: string) {
  return section.split("\n").filter(line => line.startsWith("- ")).map(line => line.slice(2));
}

function factsHtml(workspaceId: string, agentId: string, data: Status, mode: Mode) {
  const shown = sessionFacts(data.session?.section ?? ""), knowledge = data.knowledge ? describeKnowledge(data.knowledge.environment, data.knowledge.distiller) : { facts: [], retired: 0 };
  // The session list already shows facts in use here; the repository list adds the rest.
  const others = knowledge.facts.filter(fact => !shown.includes(fact.claim));
  const repository = others.slice(0, 12).map(fact => item(fact.claim, `${factStatus[fact.status]}${fact.status === "checking" ? ` · seen ${plural(fact.confirmations, "time")}` : ""}${fact.source === "distilled" ? " · written by a model" : ""}`));
  const more = others.length - repository.length;
  const body = `${shown.length ? `<p>In this session:</p>${list(shown.map(line => item(line)))}` : `<p class="settings-help">${mode === "off" ? "No learned facts are being added while the optimizer is off." : "This session has no learned facts. Fresh sessions get facts once they’re confirmed."}</p>`}
    ${others.length ? `<p>${shown.length ? "Also learned" : "Learned"} for this repository:</p>${list(repository)}${more > 0 ? `<p class="settings-help">And ${more} more.</p>` : ""}` : knowledge.facts.length ? "" : `<p class="settings-help">Nothing learned for this repository yet. It learns when a session ends.</p>`}
    ${knowledge.retired ? `<p class="settings-help">${plural(knowledge.retired, "fact")} retired after being contradicted.</p>` : ""}
    ${shown.length ? actionForm(workspaceId, agentId, "remove-context", "Remove facts from this Agent", `<p class="settings-help">Only affects this Agent. Its next request won’t include them, which rebuilds the prompt cache once.</p>`) : ""}`;
  return disclosure(`Facts${shown.length ? ` (${shown.length} in this session)` : ""}`, body);
}

function toolsHtml(workspaceId: string, agentId: string, data: Status, mode: Mode, pick: ReturnType<Native["lastPick"]>) {
  const tools = data.knowledge?.tools, policy = data.policy, applied = tools?.applied ?? [], suggested = tools?.proposal ?? [], kept = tools?.kept ?? [], live = data.session?.frozenMask ?? [];
  const why = (name: string) => tools && Object.hasOwn(tools.streaks, name) ? `Not used in the last ${plural(tools.streaks[name]!, "session")} (${plural(tools.promptStreaks[name] ?? 0, "prompt")}).` : "";
  const body = `${suggested.length ? `<p>Suggested to hide:</p>${list(suggested.map(name => item(name, why(name))))}${tools?.pending ? `<p class="settings-help">Hiding automatically once the repository has been quiet for ${policy.quietMinutes} minutes, or within a day.</p>` : ""}` : ""}
    ${applied.length ? `<p>Hidden:</p>${list(applied.map(name => item(name, why(name))))}` : ""}
    ${live.some(name => !applied.includes(name)) ? `<p class="settings-help">Hidden in this session for the current task: ${h(live.filter(name => !applied.includes(name)).join(", "))}.</p>` : ""}
    ${kept.length ? `<p class="settings-help">Kept because you restored them: ${h(kept.join(", "))}.</p>` : ""}
    ${!suggested.length && !applied.length ? `<p class="settings-help">${policy.pruning === "off" ? "Unused-tool suggestions are off." : "No unused tools yet. It needs a few sessions to tell."}</p>` : ""}
    ${pick ? `<p class="settings-help">Last automatic pick, ${time(pick.at)}: ${pick.note ? h(pick.note) : pick.hidden?.length ? `hid ${h(pick.hidden.join(", "))}` : "kept every tool"} (${(pick.ms / 1000).toFixed(1)} s).</p>` : ""}
    ${mode === "active" && policy.pruning !== "off" ? actionForm(workspaceId, agentId, "apply", "Hide", row("Hide tools by name", `<input class="text-field" name="names" required placeholder="tool_one, tool_two">`, "Protected and recently used tools are never hidden.")) : ""}
    ${mode !== "off" && policy.pruning !== "off" && (policy.toolJudge !== "none" || policy.savers.toolPrefilter || policy.savers.localToolDrops) ? actionForm(workspaceId, agentId, "prepare", "Pick tools", `<label class="token-optimizer__stacked">Pick tools for a task<textarea class="textarea" name="task" rows="3" maxlength="16000" required placeholder="What will the Agent work on next?"></textarea></label><input type="hidden" name="requestId" value="${crypto.randomUUID()}"><p class="settings-help">Works while the Agent is idle.</p>`) : ""}`;
  return disclosure(`Tools${applied.length || suggested.length ? ` (${[applied.length ? `${applied.length} hidden` : "", suggested.length ? `${suggested.length} suggested` : ""].filter(Boolean).join(", ")})` : ""}`, body);
}

type Nudge = GuardDecisionRecord & { from: string | null };
function nudgesHtml(data: Status, nudges: Nudge[]) {
  const decisions = [...nudges].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 6);
  const body = decisions.length ? list(decisions.map(decision => `<li>${h(nudgeStatus[decision.status])}${decision.from ? ` · subagent ${h(decision.from)}` : ""}${decision.at ? ` · ${h(time(decision.at))}` : ""}<small>${h(nudgeReasons.get(decision.reason) ?? decision.reason)}</small>${decision.text ? `<blockquote class="token-optimizer__quote">${h(decision.text.length > 400 ? `${decision.text.slice(0, 400)}…` : decision.text)}</blockquote>` : ""}</li>`)) : `<p class="settings-help">${data.policy.loop === "off" ? "Nudges are off." : "No nudges yet. It steps in only when a run keeps repeating the same failures."}</p>`;
  return disclosure(`Nudges${decisions.length ? ` (${decisions.length})` : ""}`, body);
}

async function troubleshootingHtml(workspaceId: string, agentId: string, data: Status) {
  const policy = data.policy, budget = policy.budget, classes = data.classifiers, accounting = data.accounting;
  const artifacts = [classes?.loop?.identity, ...classes?.tools.map(tool => tool.identity) ?? [], ...classes?.text ?? []].filter(item => item !== undefined);
  const active = artifacts.filter(item => item.state === "active_bands").length;
  const on = policy.mode !== "off", usesClassifiers = on && (policy.savers.localLoop || policy.savers.toolPrefilter || policy.savers.localToolDrops || policy.judge !== "generative" || ["classifier", "cascade"].includes(policy.toolJudge));
  const checkpoint = data.session?.learning?.lastCheck;
  const lines = [
    data.session?.learning ? `Learning checkpoints: ${data.session.learning.processed} processed of ${data.session.learning.requested} requested. A completed reply is a checkpoint; /new starts a separate evidence session.` : "No learning checkpoint yet.",
    checkpoint ? `Last check: ${checkpoint.factObservations} fact-relevant results out of ${checkpoint.observations} tool results${checkpoint.incomplete ? `; ${checkpoint.incomplete} incomplete results blocked fact learning` : ""}.` : "",
    checkpoint ? `Fact proposer: ${checkpoint.proposer.replaceAll("-", " ")}${checkpoint.notes.length ? ` · ${checkpoint.notes.join("; ")}` : ""}.` : "",
    data.session?.foldError ? `Last learning error: ${data.session.foldError}` : "",
    `Model calls: ${accounting.calls} of ${budget.callsPerSession} this session, ${accounting.dailyCalls} of ${budget.callsPerDay} today in this workspace${accounting.reservations.length ? ` (${accounting.reservations.length} in progress)` : ""}.`,
    usesClassifiers || artifacts.length ? `Classifiers: ${active} active of ${artifacts.length}; ${plural(classes?.samples.filter(sample => sample.label !== null).length ?? 0, "labelled example")}; ${classes?.skipped ?? 0} judge calls saved; ${classes?.audits ?? 0} double-checks, ${classes?.disagreements ?? 0} disagreements.` : "",
    classes?.lastError ? `Last classifier note: ${classes.lastError}` : "",
  ].filter(Boolean).map(line => `<p class="settings-help">${h(line)}</p>`).join("");
  const reviewed = (classes?.samples ?? []).filter(sample => sample.label !== null).slice(-8).reverse().map(sample => {
    const loop = sample.kind === "loop", artifact = loop ? classes?.loop?.identity.id : classes?.tools.find(tool => tool.tool === sample.tool)?.identity.id;
    const options: Option[] = loop ? [["0", "Making progress"], ["1", "Stuck"]] : [["1", "Needed"], ["0", "Not needed"]];
    const title = loop ? `Run check · ${time(sample.at)}` : `Tool “${sample.tool}” · ${time(sample.at)}`;
    return actionForm(workspaceId, agentId, "review", "Save review", `<input type="hidden" name="sampleId" value="${h(sample.id)}"><p>${h(title)}</p>${selectRow("label", "What actually happened", String(sample.label), options)}${artifact ? checkboxRow("unsafeArtifactId", "A classifier acted on this wrongly", false, "Turns that classifier off until it is retrained.", artifact) : ""}`);
  }).join("");
  const classifierActions = `${usesClassifiers ? actionForm(workspaceId, agentId, "refit", "Retrain classifiers") : ""}${artifacts.length || classes?.lexical ? `<form method="post" action="/settings/token-optimizer/clear" data-turbo="true">${hidden(workspaceId, agentId)}<input type="hidden" name="confirmed" value="true">${destructiveConfirmationHtml({ id: `token_optimizer_clear_${h(workspaceId)}_${h(agentId)}`.replace(/[^\w-]/g, "_"), trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Forget classifiers" } }, confirmCaption: "Forget classifiers", cancelCaption: "Keep them" })}</form>` : ""}`;
  const body = `${lines}
    ${classifierActions ? buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml: classifierActions }) : ""}
    ${reviewed ? disclosure("Review recent decisions", reviewed) : ""}
    ${disclosure("Raw data", `<pre class="token-optimizer__raw">${h(JSON.stringify({ policy: { mode: policy.mode, microSkills: policy.microSkills, loop: policy.loop, pruning: policy.pruning, toolJudge: policy.toolJudge, autoToolPicks: policy.autoToolPicks ?? false }, accounting, jobs: data.jobs.slice(-12).map(job => ({ purpose: job.request.purpose, status: job.status, model: job.request.model, error: job.error })), usage: data.ledger.slice(-12), artifacts: artifacts.slice(-12).map(item => ({ id: item.id, tool: item.tool ?? null, state: item.state, bands: item.bands, reason: item.invalidReason })), local: classes?.local ?? null }, null, 2))}</pre>`)}`;
  return disclosure("Troubleshooting", body);
}

async function agentHtml(workspaceId: string, native: Native, host: HostSession, config: OptimizerConfig, view: View) {
  const data = await native.optimizer.status(host), title = await native.title(host), agentId = native.agentId(host), key = JSON.stringify([workspaceId, agentId]);
  const mode: Mode = data.policy.enabled ? data.policy.mode : "off", tools = data.knowledge?.tools;
  const facts = data.session?.injectedIds.length ?? 0, applied = tools?.applied ?? [], suggested = tools?.proposal ?? [];
  const subagentRuns = await Promise.all((await native.subagentsOf(host)).map(async sub => ({ label: sub.label, decisions: (await native.optimizer.status(sub.host)).run?.decisions ?? [] })));
  const nudges: Nudge[] = [...(data.run?.decisions ?? []).map(decision => ({ ...decision, from: null })), ...subagentRuns.flatMap(run => run.decisions.map(decision => ({ ...decision, from: run.label })))];
  const decisions = nudges, sent = decisions.filter(item => item.status === "queued" || item.status === "consumed").length, simulated = decisions.filter(item => item.status === "simulated").length;
  const priced = data.ledger.filter(row => row.cost !== null), cost = priced.reduce((sum, row) => sum + row.cost!, 0), unpriced = data.ledger.length - priced.length;
  const summary = [modeLabels[mode], facts ? plural(facts, "fact") : "", applied.length ? `${plural(applied.length, "tool")} hidden` : "", suggested.length ? plural(suggested.length, "suggestion") : ""].filter(Boolean).join(" · ");
  const status = [
    mode === "off" ? "Not learning while the optimizer is off." : data.session?.folded ? "Already learned from this session." : "Learns from this session when it ends, or after 10 quiet minutes.",
    sent ? `${plural(sent, "nudge")} sent.` : simulated ? `Would have sent ${plural(simulated, "nudge")}.` : "",
    data.ledger.length ? `${plural(data.ledger.length, "model call")}${priced.length ? `, about $${cost.toFixed(4)}` : ""}${unpriced ? ` (${unpriced} without a price)` : ""}.` : "",
  ].filter(Boolean).map(line => `<li>${h(line)}</li>`).join("");
  const notes = [
    data.accounting.authPaused ? warningBannerHtml({ title: "Model calls are paused", message: "The provider says you’re signed out. Reconnect it under Models, then try again.", actionsHtml: actionForm(workspaceId, agentId, "retry", "Try again") }) : "",
    mode === "off" && applied.length ? `<p class="settings-help">The optimizer is off here. Hidden tools stay hidden until you restore them.</p>` : "",
    mode === "observe" && suggested.length ? `<p class="settings-help">Switch to On to hide suggested tools.</p>` : "",
    data.lastError ? `<p class="settings-error">${h(data.lastError)}</p>` : "",
  ].join("");
  const actions = [
    mode === "active" && suggested.length ? actionForm(workspaceId, agentId, "apply", "Hide suggested tools", suggested.map(name => `<input type="hidden" name="names" value="${h(name)}">`).join(""), "primary") : "",
    applied.length ? actionForm(workspaceId, agentId, "restore", "Restore hidden tools") : "",
  ].join("");
  const body = `<div class="form-stack">${view.focus === key ? feedback(view) : ""}<ul class="token-optimizer__status">${status}</ul>${notes}${actions ? buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml: actions }) : ""}
    <div class="token-optimizer__details">${factsHtml(workspaceId, agentId, data, mode)}${toolsHtml(workspaceId, agentId, data, mode, native.lastPick(host.conversationId))}${nudgesHtml(data, nudges)}</div>
    ${row("This Agent", overrideForm(workspaceId, agentId, config.agents[key] ?? "inherit", "Optimizer for this Agent"))}
    ${await troubleshootingHtml(workspaceId, agentId, data)}</div>`;
  return disclosureHtml({ open: view.focus === key, summary: { kind: "multiline", label: { kind: "text", text: title }, description: summary }, bodyHtml: body });
}

/** Saved overrides for workspaces that aren't running, so they can still be changed or cleared. */
async function savedOverridesHtml(config: OptimizerConfig, running: Set<string>) {
  const rows: string[] = [];
  const workspaces = new Set([...Object.keys(config.workspaces), ...Object.keys(config.agents).map(key => parseOverrideKey(key)[0])].filter(id => !running.has(id)));
  for (const workspaceId of [...workspaces].sort()) {
    const name = await readWorkspaceTitle(workspaceId) || workspaceId, agents = Object.entries(config.agents).filter(([key]) => parseOverrideKey(key)[0] === workspaceId);
    rows.push(`<div class="token-optimizer__saved">${row(name, overrideForm(workspaceId, "", config.workspaces[workspaceId] ?? "inherit", `Optimizer for ${name}`))}${agents.map(([key, mode]) => { const agentId = parseOverrideKey(key)[1];return row(`Agent ${agentId}`, overrideForm(workspaceId, agentId, mode, `Optimizer for Agent ${agentId}`)); }).join("")}</div>`);
  }
  return rows.length ? disclosure(`Saved settings for other workspaces (${rows.length})`, `<p class="settings-help">These workspaces aren’t running. Choose “Use main setting” to clear an override.</p>${rows.join("")}`) : "";
}
function parseOverrideKey(key: string) {const value: unknown = JSON.parse(key);Value.Assert(Type.Tuple([Type.String(), Type.String()]), value);return value;}

async function agentsHtml(config: OptimizerConfig, view: View) {
  const groups: string[] = [], running = new Set<string>();
  for (const [workspaceId, native] of nativeTokenOptimizers()) {
    const hosts = await native.optimizerSessions();if (!hosts.length) continue;
    running.add(workspaceId);
    const rows: string[] = [];
    for (const host of hosts) rows.push(await agentHtml(workspaceId, native, host, config, view));
    groups.push(`<section class="token-optimizer__workspace"><div class="token-optimizer__workspace-head"><h4>${h(await native.workspaceTitle())}</h4>${overrideForm(workspaceId, "", config.workspaces[workspaceId] ?? "inherit", "Optimizer for this workspace")}</div>${rows.join("")}</section>`);
  }
  const refresh = actionLinkHtml({ href: "/settings/sections/token-optimizer", variant: "secondary", content: { kind: "caption", caption: "Refresh" }, attributesHtml: 'data-turbo-frame="app_settings_section_token-optimizer"' });
  return `<div class="token-optimizer__agents form-stack"><div class="token-optimizer__agents-head"><h3>Agents</h3>${refresh}</div>${groups.join("") || '<p class="settings-help">No built-in Agents are open. Your settings apply as soon as one starts.</p>'}${await savedOverridesHtml(config, running)}</div>`;
}

export async function renderTokenOptimizerSettings(view: View = {}) {
  const config = view.draft ?? await tokenOptimizerConfiguration().load(), catalogue = await readPiModelCatalogue();
  return `<section class="settings-sec token-optimizer" id="${panel}">
    <p>Saves tokens for built-in Agents. It remembers facts about each repository, nudges runs that go in circles and hides tools that never get used. CLI Agents are unaffected.</p>
    ${view.focus || view.form ? "" : feedback(view)}
    ${settingsForm(config, catalogue, view)}
    ${await agentsHtml(config, view)}
  </section>`;
}

/** Reads the progressive form. Presets own the feature choices; Advanced fields refine limits and models. */
function policyFromForm(form: FormData, current: Policy) {
  const policy = structuredClone(current);
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const number = (name: string, label: string, fallback: number, options: { min?: number; max?: number; integer?: boolean } = {}) => {
    if (!form.has(name)) return fallback;
    const raw = text(name), value = Number(raw), min = options.min ?? 1, integer = options.integer ?? true;
    if (!raw || !Number.isFinite(value) || value < min || options.max !== undefined && value > options.max || integer && !Number.isInteger(value)) throw new Error(`${label} must be ${integer ? "a whole number" : "a number"} ${options.max === undefined ? `of at least ${min}` : `from ${min} to ${options.max}`}.`);
    return value;
  };
  const model = (name: string, fallback: ModelRef | null) => {
    if (!form.has(name)) return fallback;
    if (!text(name)) return null;
    const value: unknown = JSON.parse(text(name));Value.Assert(modelRefSchema, value);return value;
  };
  const mode = text("mode");Value.Assert(modeSchema, mode);
  const preset = form.has("preset") ? text("preset") : presetOf(current);Value.Assert(presetSchema, preset);
  policy.enabled = mode !== "off";
  if (mode !== "off") policy.mode = mode;
  policy.generativeModel = model("model", policy.generativeModel);
  if (form.has("model")) {policy.inferenceInObserve = form.get("inferenceInObserve") === "true";policy.autoToolPicks = form.get("autoToolPicks") === "true";}
  policy.classifierModel = model("classifierModel", policy.classifierModel);
  for (const name of ["proposer", "loopJudge", "writer", "toolJudge", "loopClassifier", "toolClassifier"] as const) policy.models[name] = model(`models.${name}`, policy.models[name]);
  const budget = policy.budget;
  budget.callsPerSession = number("budget.callsPerSession", "Model calls per Agent session", budget.callsPerSession);
  budget.callsPerDay = number("budget.callsPerDay", "Model calls per day", budget.callsPerDay);
  if (form.has("budget.maxCostPerSession")) budget.maxCostPerSession = text("budget.maxCostPerSession") ? number("budget.maxCostPerSession", "Spending cap per session", 0, { min: 0, integer: false }) : null;
  budget.deadlineMs = Math.round(number("budget.deadlineSeconds", "Time limit per call", budget.deadlineMs / 1000, { max: 180, integer: false }) * 1000);
  budget.maxOutputTokens = number("budget.maxOutputTokens", "Output limit per call", budget.maxOutputTokens);
  policy.maxFacts = number("maxFacts", "Facts per session", policy.maxFacts);
  policy.maxFactTokens = number("maxFactTokens", "Fact text limit", policy.maxFactTokens);
  policy.proposeEvery = number("proposeEvery", "Sessions between new facts", policy.proposeEvery);
  policy.evidenceMinSessions = number("evidenceMinSessions", "Sessions before suggesting a tool", policy.evidenceMinSessions);
  policy.evidencePrompts = number("evidencePrompts", "Prompts before suggesting a tool", policy.evidencePrompts);
  policy.evidenceSessions = number("evidenceSessions", "Sessions before a tool counts as unused", policy.evidenceSessions);
  policy.quietMinutes = number("quietMinutes", "Quiet time before hiding automatically", policy.quietMinutes, { min: 0, integer: false });
  if (form.has("thresholds")) {
    let thresholds: unknown;
    try {thresholds = JSON.parse(text("thresholds") || "{}");} catch {throw new Error("Loop guard thresholds must be valid JSON, such as {}.");}
    Object.assign(policy, { thresholds });
  }
  if (preset === "custom") {
    if (form.has("nativeChecks")) {policy.reduceOutputs = form.get("reduceOutputs") === "true";policy.goalChecks = form.get("goalChecks") === "true";}
    for (const name of ["microSkills", "loop", "judge", "level", "pruning", "toolJudge"] as const) if (form.has(name)) Object.assign(policy, { [name]: text(name) });
    policy.redirects = number("redirects", "Nudges per prompt", policy.redirects, { max: 10 });
    if (form.has("savers.auditPercent")) {
      for (const name of saverNames) policy.savers[name] = form.get(`savers.${name}`) === "true";
      policy.savers.auditPercent = number("savers.auditPercent", "Double-check percentage", policy.savers.auditPercent, { min: 0, max: 20 });
    }
  } else applyPreset(policy, preset);
  return { policy: parsePolicy(policy), mode, preset };
}

const actionSchema = Type.Object({workspaceId:Type.String({minLength:1,maxLength:256}),agentId:Type.String({minLength:1,maxLength:256}),names:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:256}),{maxItems:1000})),confirmed:Type.Optional(Type.Boolean()),sampleId:Type.Optional(Type.String({maxLength:256})),label:Type.Optional(Type.Union([Type.Literal(0),Type.Literal(1)])),unsafeArtifactId:Type.Optional(Type.String({maxLength:256})),task:Type.Optional(Type.String({maxLength:16000})),requestId:Type.Optional(Type.String({maxLength:256}))},{additionalProperties:false});
const overrideSchema = Type.Object({workspaceId:Type.String({minLength:1,maxLength:256}),agentId:Type.Optional(Type.String({maxLength:256})),mode:Type.Enum(["inherit","off","observe","active"])},{additionalProperties:false});
export const tokenOptimizerSettingsContribution:SettingsContribution = {id:"token-optimizer",label:"Token optimizer",order:29,render:() => renderTokenOptimizerSettings(),renderFocused:focus => renderTokenOptimizerSettings({focus}),async handleAction({request,url}) {
  if (!/^\/settings\/token-optimizer(?:\/(?:override|apply|restore|retry|refit|clear|review|prepare|remove-context))?$/.test(url.pathname)) return;
  const service = tokenOptimizerConfiguration();await service.load();
  if (request.method === "GET" && url.pathname === "/settings/token-optimizer") return Response.json({config:service.snapshot(),workspaces:nativeTokenOptimizers().map(([id]) => id)},{headers:{"cache-control":"no-store"}});
  if (request.method !== "POST") return;
  const json = request.headers.get("content-type")?.includes("application/json");
  const view:View = {};
  try {
    const config = service.snapshot(), form = json ? null : await request.formData();view.message = "Saved.";
    if (url.pathname === "/settings/token-optimizer") {
      if (json) await service.configure(parseOptimizerConfig(await request.json()));
      else {
        view.form = true;const read = policyFromForm(form!,config.policy);config.policy = read.policy;view.draft = config;
        if (read.preset === "assisted" && read.policy.enabled && !modelFor(read.policy,"proposer")) throw new Error("Pick a model for Model-assisted, or choose Basic.");
        const saved = await service.configure(config);view.draft = undefined;
        view.message = read.mode === "active" && saved.policy.mode === "observe" ? "Started in Watch only. Switch to On once you like what it suggests." : read.mode === "off" ? "Saved. The optimizer is off." : "Saved. Agents pick this up from their next step.";
      }
    } else if (url.pathname.endsWith("/override")) {
      const raw:unknown = json ? await request.json() : {workspaceId:String(form!.get("workspaceId")),agentId:String(form!.get("agentId") ?? ""),mode:String(form!.get("mode"))};
      Value.Assert(overrideSchema,raw);
      const scope = raw.agentId ? config.agents : config.workspaces, key = raw.agentId ? JSON.stringify([raw.workspaceId,raw.agentId]) : raw.workspaceId;
      if (raw.mode === "inherit") delete scope[key];else scope[key] = raw.mode;
      if (raw.agentId) view.focus = key;
      await service.configure(config);view.message = undefined;
    } else {
      const raw:unknown = json ? await request.json() : {workspaceId:String(form!.get("workspaceId")),agentId:String(form!.get("agentId"))};
      if (form) {
        Value.Assert(Type.Record(Type.String(),Type.Unknown()),raw);
        for (const name of ["sampleId","unsafeArtifactId","task","requestId"]) if (form.has(name)) raw[name] = String(form.get(name));
        if (form.has("names")) raw.names = form.getAll("names").flatMap(value => String(value).split(",")).map(name => name.trim()).filter(Boolean);
        if (form.has("confirmed")) raw.confirmed = form.get("confirmed") === "true";
        if (form.has("label")) raw.label = Number(form.get("label"));
      }
      Value.Assert(actionSchema,raw);view.focus = JSON.stringify([raw.workspaceId,raw.agentId]);
      const native = nativeTokenOptimizers().find(([id]) => id === raw.workspaceId)?.[1];if (!native) throw new Error("This workspace isn’t running. Open one of its Agents first.");
      const host = (await native.optimizerSessions()).find(host => native.agentId(host) === raw.agentId);if (!host) throw new Error("This Agent isn’t open any more.");
      if (url.pathname.endsWith("/apply")) {if (!raw.names?.length) throw new Error("Name at least one tool to hide.");const result = await native.optimizer.apply(host,raw.names);if (result.reason) throw new Error(result.reason);view.message = result.added.length ? "Done. Those tools are hidden from the Agent’s next session or resume." : "Nothing changed: those tools are already hidden.";}
      else if (url.pathname.endsWith("/restore")) {await native.optimizer.restore(host,raw.names);view.message = "Restored. They come back on the next session or resume and won’t be suggested again.";}
      else if (url.pathname.endsWith("/remove-context")) {const removed = await native.optimizer.removeContext(host);view.message = removed ? "Removed. This Agent’s next request won’t include learned facts." : "This Agent had no learned facts to remove.";}
      else if (url.pathname.endsWith("/retry")) {await native.optimizer.retryModelCalls();view.message = "Model calls will be tried again.";}
      else if (url.pathname.endsWith("/refit")) {if (!await native.optimizer.rebuildClassifiers(host,true)) throw new Error("Turn on a local classifier first, or wait for the current retraining to finish.");view.message = "Retraining in the background.";}
      else if (url.pathname.endsWith("/clear")) {if (!raw.confirmed) throw new Error("Confirm before forgetting classifiers.");await native.optimizer.clearClassifiers(host);view.message = "Forgotten. Classifiers start learning again from scratch.";}
      else if (url.pathname.endsWith("/review")) {if (!raw.sampleId || raw.label === undefined) throw new Error("Choose what actually happened.");await native.optimizer.reviewSample(host,raw.sampleId,raw.label,raw.unsafeArtifactId || null);view.message = "Thanks, review saved.";}
      else {if (!raw.task?.trim()) throw new Error("Describe the task first.");await native.prepare(host,raw.task,raw.requestId ?? "");view.message = (await native.optimizer.status(host)).policy.mode === "active" ? "Tools picked. The Agent uses them from its next request." : "Picks recorded. Watch only leaves the toolset unchanged.";}
    }
    return json ? Response.json({config:service.snapshot(),message:view.message}) : turboStreamResponse(turboStream("replace",panel,await renderTokenOptimizerSettings(view)));
  } catch (error) {
    const message = errorMessage(error);
    return json ? Response.json({error:{code:"invalid_arguments",message}},{status:400}) : turboStreamResponse(turboStream("replace",panel,await renderTokenOptimizerSettings({...view,message,error:true})),{status:422});
  }
}};

// SAFETY: App-owned TypeBox schemas contain JSON Schema values; serialisation removes library symbols.
const configJsonSchema = JSON.parse(JSON.stringify(optimizerConfigSchema)) as JsonObject;
const requestBody = {required:true,content:{"application/json":{schema:configJsonSchema}}};
export const tokenOptimizerOpenApiPaths = {
  "/settings/token-optimizer":{get:{summary:"Inspect token optimizer configuration and attached workspaces",responses:{"200":{description:"Configuration and attached native runtimes"}}},post:{summary:"Configure the token optimizer; first enable uses Observe",requestBody,responses:{"200":{description:"Saved"},"400":{description:"Invalid configuration"}}}},
  ...Object.fromEntries(["override","apply","restore","retry","refit","clear","review","prepare","remove-context"].map(action => ["/settings/token-optimizer/"+action,{post:{summary:"Token optimizer: "+action,requestBody:{required:true,content:{"application/json":{schema:JSON.parse(JSON.stringify(action === "override" ? Type.Object({workspaceId:Type.String(),agentId:Type.Optional(Type.String()),mode:Type.Enum(["inherit","off","observe","active"])}) : actionSchema))}}},responses:{"200":{description:"Action accepted; no Agent run is started"},"400":{description:"Invalid action, unavailable scope or current policy refusal"}}}}])),
} satisfies Record<string,JsonObject>;
