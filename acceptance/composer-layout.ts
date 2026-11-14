/**
 * Acceptance script, Tier 1: composer, transcript, floating buttons and terminal
 * sizing in the workspace's Chrome (CDP), in a mobile (393×852, touch) and a
 * desktop (1440×900) layout. Soft-keyboard behaviour is Tier 2
 * (acceptance/soft-keyboard.ts).
 *
 * Run by hand or by an agent against a running Kintsugi; never part of a test suite or CI:
 *
 *   kintsugi-desktop start            # prints the CDP URL
 *   bun acceptance/composer-layout.ts [--kintsugi http://localhost:3000] [--cdp http://127.0.0.1:9222]
 *     [--workspace <id>] [--model provider::model] [--out <dir>] [--only <regex>]
 *     [--layout-only] # explicitly partial: no sends, busy states or long-transcript checks
 *
 * Layout-only uses Set up later on the acceptance instance and stages no Pi agent
 * or inference. These layout/pointer scenarios are partial, never full acceptance.
 *
 * Every transition is checked on a per-frame trace: each tracked element changes
 * at most once, all changes land in the same frame, and the settled arrangement
 * matches the spec. Terminal resize messages and tmux window sizes are counted
 * in every scenario. The report folder is printed at the end.
 */
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChromePage } from "./lib/cdp.ts";
import { Report, type ScenarioRecorder } from "./lib/report.ts";
import { stage, tmuxSizes, type Stage } from "./lib/stage.ts";
import { analyseTransition, check, close, oneStepChecks, settled, type Box, type Frame } from "./lib/trace.ts";

const { values: args } = parseArgs({
  options: {
    kintsugi: { type: "string", default: "http://localhost:3000" },
    cdp: { type: "string", default: "http://127.0.0.1:9222" },
    workspace: { type: "string" },
    model: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    "layout-only": { type: "boolean", default: false },
  },
});

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = args.out ?? `/persistent/acceptance-reports/composer-layout-${stamp}`;
await mkdir(out, { recursive: true });
const log = (message: string): void => console.log(`[composer-layout] ${message}`);

const setup: Stage = await stage({ kintsugi: args.kintsugi, workspaceId: args.workspace, model: args.model, layoutOnly: args["layout-only"], log });
log(`workspace ${setup.workspaceId}: built-in ${setup.builtinId}, Pi ${setup.piId ?? "not staged (partial)"}, terminal ${setup.terminalKey}`);
const report = new Report(out, args["layout-only"] ? "Composer layout acceptance (partial, no inference)" : "Composer layout acceptance (Tier 1, Chrome)", {
  scope: args["layout-only"] ? "Only no-inference layout scenarios; send, busy, long-transcript and iOS keyboard acceptance are not covered" : "Full Tier 1 Chrome acceptance",
  kintsugi: args.kintsugi, workspace: setup.workspaceId, "built-in agent": setup.builtinId, "Pi agent": setup.piId ?? "not staged (partial mode)", "Terminal view": setup.terminalKey, started: new Date().toISOString(),
});

if (args["layout-only"]) {
  // Use the app’s Set up later operation on this operator-selected acceptance instance.
  const response = await fetch(new URL("/onboarding/finish", args.kintsugi), { method: "POST", headers: { Origin: new URL(args.kintsugi).origin } });
  if (!response.ok) throw new Error(`Could not dismiss acceptance-instance onboarding (HTTP ${response.status})`);
}

const page = await ChromePage.open(args.cdp);
const builtinUrl = `${setup.kintsugi}/workspaces/${setup.workspaceId}?agent=${setup.builtinId}`;
if (!args["layout-only"] && !setup.piId) throw new Error("Full acceptance requires a staged Pi agent");
const piUrl = `${setup.kintsugi}/workspaces/${setup.workspaceId}?agent=${setup.piId}`;
const terminalUrl = `${setup.kintsugi}/workspaces/${setup.workspaceId}?workView=${encodeURIComponent(setup.terminalKey)}`;
const draftKey = `kintsugi.agentComposerText:${JSON.stringify([setup.workspaceId, setup.builtinId])}`;

const sel = {
  pane: ".agent-composer-pane",
  transcript: ".agent-pane .agent-transcript",
  opener: '.agent-composer-pane [data-agent-composer-target="opener"]',
  draftDot: ".agent-composer-opener[data-draft] .agent-composer-draft-dot",
  close: '.agent-composer-pane .composer-close button',
  input: ".agent-composer-pane .composer-input",
  send: ".agent-composer-pane .composer-send button:not([data-action])",
  followLatest: '.floating-stack :is([data-agent-pane-target="transcriptEnd"], [data-cli-terminal-target="transcriptEnd"])',
  terminal: ".observable-terminal-host",
  viewTranscript: '.floating-stack [data-action~="cli-terminal#showTranscript"]',
  showTerminal: '.floating-stack [data-cli-transcript-button="terminal"]',
  cliTranscript: ".cli-agent-body.cli-transcript-mode .cli-transcript-view .agent-transcript-content",
};

const bottom = (box: Box): number => box ? box[1] + box[3] : Number.NaN;
/** Floating buttons keep the workspace bar's outer inset: 4px on mobile, 10px on desktop. */
let floatingInset = 4;
const floatingLabel = { opener: "Open composer", followLatest: "Follow latest", pendingTranscript: "Will autoswitch to transcript when agent is done" };

const layoutOnlyScenarios = new Set(["mobile-D1-selection", "mobile-H1-H7-height", "mobile-terminal-tab", "desktop-D1-selection", "mobile-launch-editor", "desktop-launch-editor", "tablet-H6-divider", "desktop-H6-divider"]);

async function scenario(name: string, description: string, body: (recorder: ScenarioRecorder) => Promise<void>): Promise<void> {
  if (args["layout-only"] && !layoutOnlyScenarios.has(name)) return;
  if (args.only && !new RegExp(args.only).test(name)) return;
  log(`scenario ${name}`);
  const recorder = await report.scenario(name, description);
  const resizesBefore = page.resizes.length;
  const tmuxBefore = await tmuxSizes(setup.workspaceId);
  try {
    await body(recorder);
  } catch (error) {
    recorder.add(check("Scenario completed", false, error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)));
  }
  await recorder.file("after.png", await page.screenshot());
  const resizes = page.resizes.slice(resizesBefore);
  const tmuxAfter = await tmuxSizes(setup.workspaceId);
  recorder.add(check("0 terminal resize messages", resizes.length === 0, resizes.length ? resizes.map((item) => `${item.payload} on ${item.url}`).join("; ") : "no {\"type\":\"resize\"} frames sent on terminal WebSockets"));
  const changed = Object.keys({ ...tmuxBefore, ...tmuxAfter }).filter((session) => tmuxBefore[session] !== tmuxAfter[session]);
  recorder.add(check("tmux window sizes unchanged", changed.length === 0, Object.entries(tmuxAfter).map(([session, size]) => `${session}: ${tmuxBefore[session] ?? "—"} → ${size}`).join("; ")));
}

/** Runs an action while tracing, and applies the one-step pass criteria to it. */
async function transition(recorder: ScenarioRecorder, label: string, action: () => Promise<void>, options: { waitMs?: number; expectChange?: boolean; endAtContentChange?: boolean } = {}): Promise<{ before: Frame; after: Frame }> {
  await page.startTrace();
  await Bun.sleep(80); // Capture the pre-action arrangement before an immediate CDP edit.
  const t = await page.mark(label);
  await action();
  await Bun.sleep(options.waitMs ?? 700);
  const trace = await page.takeTrace();
  const analysis = analyseTransition(trace, t, Number.POSITIVE_INFINITY, { endAtContentChange: options.endAtContentChange });
  await recorder.trace(trace, label);
  recorder.add(...oneStepChecks(analysis, { expectChange: options.expectChange }).map((result) => ({ ...result, name: `${label} — ${result.name}` })));
  return { before: analysis.window[0]!, after: settled(analysis) };
}

async function resetComposerText(): Promise<void> {
  await page.evaluate<boolean>(`(() => { const input = [...document.querySelectorAll(${JSON.stringify(sel.input)})].find((e) => e.checkVisibility()); if (!input) return false; input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
}

async function pinToBottom(): Promise<void> {
  if (await page.visible(sel.followLatest)) {
    await page.tap(sel.followLatest);
    await Bun.sleep(1500);
  }
}

async function scrollPartway(): Promise<void> {
  await page.wheel(sel.transcript, -900);
  await Bun.sleep(900);
}

async function openComposer(): Promise<void> {
  if (await page.visible(sel.opener)) {
    await page.tap(sel.opener);
    await Bun.sleep(400);
  }
}

async function closeComposer(): Promise<void> {
  if (await page.visible(sel.close)) {
    await page.tap(sel.close);
    await Bun.sleep(400);
  }
}

async function resizeComposerDivider(deltaHeight: number, pointer: "mouse" | "touch" | "pen" = "mouse"): Promise<void> {
  const { x, y: startY } = await page.center('.agent-composer-pane .composer-divider');
  if (pointer === "touch") {
    await page.cdp.send("Input.dispatchTouchEvent", { type:"touchStart",touchPoints:[{x,y:startY}] });
    for (let step=1;step<=4;step++) await page.cdp.send("Input.dispatchTouchEvent", {type:"touchMove",touchPoints:[{x,y:startY-deltaHeight*step/4}]});
    await page.cdp.send("Input.dispatchTouchEvent", {type:"touchEnd",touchPoints:[]});
    await Bun.sleep(300);
    return;
  }
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: startY, pointerType:pointer });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y: startY, button: "left", buttons: 1, clickCount: 1, pointerType:pointer });
  for (let step = 1; step <= 4; step++) {
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: startY - deltaHeight * step / 4, button: "left", buttons: 1, pointerType:pointer });
  }
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: startY - deltaHeight, button: "left", clickCount: 1, pointerType:pointer });
  await Bun.sleep(300);
}

/** Floating stack slots, bottom to top. */
const floatingOrder = [[floatingLabel.opener], ["View transcript", "Back to terminal", floatingLabel.pendingTranscript], [floatingLabel.followLatest]];

function floatingStackChecks(frame: Frame, composerOpen: boolean, surface: Box = frame.transcript): ReturnType<typeof check>[] {
  const opener = frame.floating[floatingLabel.opener] ?? null;
  const shown = Object.entries(frame.floating).filter((entry): entry is [string, NonNullable<Box>] => entry[1] !== null);
  const rank = (label: string): number => floatingOrder.findIndex((labels) => labels.includes(label));
  const lowestFirst = [...shown].sort((a, b) => bottom(b[1]) - bottom(a[1]));
  const lowest = lowestFirst[0]?.[1] ?? null;
  const results = [
    check("D21: floating stack bottom to top: open composer, view switch, follow latest", lowestFirst.every(([label], index) => index === 0 || rank(label) > rank(lowestFirst[index - 1]![0])) && lowestFirst.every(([, box]) => close(box[0] + box[2] / 2, lowest![0] + lowest![2] / 2, 2)), lowestFirst.map(([label, box]) => `${label} ${JSON.stringify(box)}`).join(" ↑ ") || "no floating buttons"),
  ];
  if (composerOpen) {
    results.push(check("D22: open-composer hidden while the composer is open", !opener, opener ? `visible at ${JSON.stringify(opener)}` : "hidden"));
    if (lowest && surface) results.push(check("D22: the stack sits just above the composer, bottom right", close(bottom(lowest), frame.composer![1] - 12, 2) && close(lowest[0] + lowest[2], surface[0] + surface[2] - floatingInset, 3), `lowest button bottom ${bottom(lowest)}, composer top ${frame.composer![1]}; button right ${lowest[0] + lowest[2]}, surface right ${surface[0] + surface[2]}`));
  } else {
    results.push(check("D21: open-composer at the bottom right of the surface", Boolean(opener) && opener === lowest && close(bottom(opener), bottom(surface) - 12, 2), opener ? `button bottom ${bottom(opener)}, surface bottom ${bottom(surface)}` : "open-composer not visible"));
  }
  return results;
}

async function stageDraft(text: string | null): Promise<void> {
  await page.evaluate<boolean>(`(() => { localStorage.removeItem("kintsugi:software-keyboard"); ${text === null ? `localStorage.removeItem(${JSON.stringify(draftKey)})` : `localStorage.setItem(${JSON.stringify(draftKey)}, ${JSON.stringify(text)})`}; return true; })()`);
}

const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8AARwzEcQAApjAJ+4n1yJ0AAAAASUVORK5CYII=", "base64");
const imagePaths: string[] = [];
for (const name of ["first", "second", "third", "fourth"]) {
  const path = join(out, `attachment-${name}.png`);
  await writeFile(path, tinyPng);
  imagePaths.push(path);
}

// ─── Mobile layout ──────────────────────────────────────────────────────────
await page.layout("mobile");
if (args["layout-only"]) {
  await page.navigate(terminalUrl, ".terminal-view .observable-terminal-host");
  await Bun.sleep(2000); // Establish the terminal dimensions before any scenario.
}
await page.navigate(builtinUrl, sel.transcript);

await scenario("mobile-D1-selection", "D1/G1: selecting a workspace on mobile shows the transcript with the composer closed; a saved draft shows a dot on open-composer.", async (recorder) => {
  await stageDraft("A draft from earlier");
  await page.navigate(builtinUrl, sel.transcript);
  await page.startTrace();
  await Bun.sleep(300);
  const trace = await page.takeTrace();
  await recorder.trace(trace, "after selection");
  const frame = trace.frames.at(-1)!;
  recorder.add(
    check("D1: composer closed", frame.composer === null, JSON.stringify(frame.composer)),
    check("D1: text field not focused", !frame.focus.includes("composer-input"), `focus: ${frame.focus || "body"}`),
    check("D1: draft dot on open-composer", await page.visible(sel.draftDot), "status dot inside open-composer"),
    check("G1: transcript readable straight away", frame.transcript !== null && frame.transcript[3] > 852 * 0.6, `transcript box ${JSON.stringify(frame.transcript)}`),
  );
  await recorder.file("selected.png", await page.screenshot());
  await stageDraft(null);
  await page.navigate(builtinUrl, sel.transcript);
});

await scenario("mobile-G2-D10-pinned", "G2/D10: with the transcript pinned to the bottom, opening and closing the composer pushes the transcript in one step.", async (recorder) => {
  await pinToBottom();
  const opened = await transition(recorder, "open composer", () => page.tap(sel.opener));
  const after = opened.after;
  recorder.add(
    check("D10: transcript ends where the composer starts", after.composer !== null && close(bottom(after.transcript), after.composer[1]), `transcript bottom ${bottom(after.transcript)}, composer top ${after.composer?.[1]}`),
    check("Pinned: newest content stays at the bottom edge", after.contentBottom !== null && after.contentBottom <= bottom(after.transcript) + 1 && after.contentBottom > bottom(after.transcript) - 120, `content end ${after.contentBottom}, transcript bottom ${bottom(after.transcript)}`),
    ...floatingStackChecks(after, true),
  );
  await recorder.file("open.png", await page.screenshot());
  const closed = await transition(recorder, "close composer", () => page.tap(sel.close));
  recorder.add(
    check("Composer closed", closed.after.composer === null, JSON.stringify(closed.after.composer)),
    check("Pinned: newest content stays near the bottom edge", closed.after.contentBottom !== null && closed.after.contentBottom <= bottom(closed.after.transcript) + 1 && closed.after.contentBottom > bottom(closed.after.transcript) - 160, `content end ${closed.after.contentBottom}, transcript bottom ${bottom(closed.after.transcript)}`),
    ...floatingStackChecks(closed.after, false),
  );
});

await scenario("mobile-G2-D10-partway", "G2/D10: scrolled partway up, opening and closing the composer pushes the transcript up and back without the reading position jumping.", async (recorder) => {
  await scrollPartway();
  for (const [label, control] of [["open composer", sel.opener], ["close composer", sel.close]] as const) {
    const { before, after } = await transition(recorder, label, () => page.tap(control));
    const keptBottom = before.scrollTop! + before.transcript![3];
    const nowBottom = after.scrollTop! + after.transcript![3];
    recorder.add(
      check(`${label}: content at the transcript's bottom edge stays at that edge`, close(keptBottom, nowBottom), `scrollTop+height ${keptBottom} → ${nowBottom} (scrollTop ${before.scrollTop} → ${after.scrollTop}, height ${before.transcript![3]} → ${after.transcript![3]})`),
      check(`${label}: content moves with the pushed edge`, close((after.contentBottom! - bottom(after.transcript)), (before.contentBottom! - bottom(before.transcript))), `content end − transcript bottom: ${before.contentBottom! - bottom(before.transcript)} → ${after.contentBottom! - bottom(after.transcript)}`),
      ...floatingStackChecks(after, label === "open composer"),
    );
  }
});

await scenario("mobile-H1-H7-height", "H1–H7 with the keyboard down: line-by-line growth to 40% of the screen, instant shrink, a large paste, no textarea resize handle, one sideways row of thumbnails.", async (recorder) => {
  await pinToBottom();
  await openComposer();
  await resetComposerText();
  await page.tap(sel.input);
  await Bun.sleep(300);
  const promptTemplateButtons = '.agent-composer-pane .composer-prompt-template-buttons [data-agent-prompt-template-button]';
  const hadPromptTemplateButtons = await page.visible(promptTemplateButtons);
  const buttonEdges = await page.evaluate<{ template: number; send: number; contained: boolean }>(`(() => {
    const pane = [...document.querySelectorAll(".agent-composer-pane")].find(e => e.checkVisibility());
    const buttons = [...pane.querySelectorAll(".composer-prompt-template-buttons [data-agent-prompt-template-button]")].filter(e => e.checkVisibility());
    const slot = pane.querySelector(".composer-send").getBoundingClientRect();
    const action = [...pane.querySelectorAll(".composer-send button")].find(e => e.checkVisibility()).getBoundingClientRect();
    const bounds = pane.getBoundingClientRect();
    return { template: buttons.at(-1).getBoundingClientRect().bottom, send: slot.bottom, contained: action.top >= slot.top - 1 && action.bottom <= slot.bottom + 1 && action.left >= bounds.left && action.right <= bounds.right };
  })()`);
  recorder.add(
    check("Prompt template buttons align with the send action slot", close(buttonEdges.template, buttonEdges.send, 1), `template bottom ${buttonEdges.template}, action slot bottom ${buttonEdges.send}`),
    check("Primary action stays within its slot and composer", buttonEdges.contained, JSON.stringify(buttonEdges)),
  );
  await recorder.file("empty.png", await page.screenshot());
  // The buttons set the empty composer's height, so the text field simply takes the prompt template buttons' place.
  await transition(recorder, "first letter", () => page.insertText("L"), { expectChange: false });
  recorder.add(check("Prompt template buttons hide once something is written", hadPromptTemplateButtons && !await page.visible(promptTemplateButtons), hadPromptTemplateButtons ? "shown when empty, hidden after one letter" : "no prompt template buttons staged in this workspace"));
  await page.insertText("ine 1");
  await Bun.sleep(200);
  const heights: number[] = [];
  const minimum = (await transition(recorder, "baseline", async () => {}, { waitMs: 200, expectChange: false })).after.composer![3];
  for (let line = 2; line <= 14; line++) {
    const { after } = await transition(recorder, `Enter + line ${line}`, async () => { await page.key("Enter"); await page.insertText(`Line ${line}`); }, { waitMs: 250, expectChange: false });
    heights.push(after.composer![3]);
  }
  const max = 852 * 0.4;
  const lineHeight = await page.evaluate<number>(`Number.parseFloat(getComputedStyle([...document.querySelectorAll(${JSON.stringify(sel.input)})].find((e) => e.checkVisibility())).lineHeight)`);
  const steps = heights.map((height, index) => Math.round(height - (index ? heights[index - 1]! : minimum)));
  recorder.add(
    check("H1: grows line by line, never shrinks while typing", steps.every((step) => step >= 0 && step <= lineHeight + 1), `composer heights ${[minimum, ...heights].map(Math.round).join(" → ")} (line height ${lineHeight}px)`),
    check("H3: stops at 40% of the screen", close(heights.at(-1)!, max, 2), `final ${heights.at(-1)}, 40% of 852 = ${max}`),
    check("H1: past the max, the text field scrolls", await page.evaluate<boolean>(`(() => { const i = [...document.querySelectorAll(${JSON.stringify(sel.input)})].find((e) => e.checkVisibility()); return i.scrollHeight > i.clientHeight + 2 && getComputedStyle(i).overflowY === "auto"; })()`), "scrollHeight > clientHeight with overflow-y auto"),
    check("H6: no textarea resize handle", await page.evaluate<string>(`getComputedStyle([...document.querySelectorAll(${JSON.stringify(sel.input)})].find((e) => e.checkVisibility())).resize`) === "none", "resize: none"),
  );
  const shrunk = await transition(recorder, "delete all (H4)", async () => { await page.key("a", { ctrl: true }); await page.key("Backspace"); });
  recorder.add(check("H4: back to the min height in one step", close(shrunk.after.composer![3], minimum), `${shrunk.before.composer![3]} → ${shrunk.after.composer![3]} (min ${minimum})`));
  const paste = Array.from({ length: 60 }, (_, index) => `Pasted line ${index + 1}`).join("\n");
  const pasted = await transition(recorder, "large paste (H5)", () => page.insertText(paste));
  recorder.add(
    check("H5: jumps to the max in one step", close(pasted.after.composer![3], max, 2), `${pasted.before.composer![3]} → ${pasted.after.composer![3]}`),
    check("H5: caret scrolled into view", await page.evaluate<boolean>(`(() => { const i = document.activeElement; return i.scrollTop + i.clientHeight >= i.scrollHeight - 2; })()`), "text field scrolled to the caret at the end"),
  );
  await page.key("a", { ctrl: true });
  await page.key("Backspace");
  await Bun.sleep(300);
  // H7: thumbnails take one row that scrolls sideways and count toward the height.
  const files = await page.cdp.send("Runtime.evaluate", { expression: `[...document.querySelectorAll('.agent-composer-pane input[type="file"]')].find((e) => e.closest(".agent-composer-pane").checkVisibility())` });
  await page.cdp.send("DOM.enable");
  await page.cdp.send("DOM.setFileInputFiles", { files: imagePaths, objectId: files.result.objectId! });
  await page.waitFor(".agent-composer-pane .agent-attach-row [data-draft-image-preview]", 15_000);
  await Bun.sleep(2500);
  await page.insertText(paste);
  await Bun.sleep(400);
  const row = await page.evaluate<{ rowHeight: number; chipHeight: number; scrollWidth: number; clientWidth: number; chips: number; composer: number; input: number; inputMin: number }>(`(() => {
    const pane = [...document.querySelectorAll(".agent-composer-pane")].find((e) => e.checkVisibility());
    const row = pane.querySelector(".agent-attach-row");
    const chip = row.querySelector(".agent-chip");
    const input = pane.querySelector(".composer-input");
    // The text field never gets shorter than the buttons beside it (less the prompt template buttons under it).
    const promptTemplateButtons = pane.querySelector(".composer-prompt-template-buttons");
    const beside = pane.querySelector(".composer-buttons").getBoundingClientRect().height - (promptTemplateButtons && promptTemplateButtons.checkVisibility() ? promptTemplateButtons.getBoundingClientRect().height : 0);
    return { rowHeight: row.getBoundingClientRect().height, chipHeight: chip.getBoundingClientRect().height, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, chips: row.children.length, composer: pane.querySelector(":scope > .composer").getBoundingClientRect().height, input: input.getBoundingClientRect().height, inputMin: Math.max(Number.parseFloat(getComputedStyle(input).minHeight), beside) };
  })()`);
  await recorder.file("attachments.png", await page.screenshot());
  recorder.add(
    check("H7: thumbnails sit in one row", row.rowHeight <= row.chipHeight + 12, `row ${row.rowHeight}px for chips of ${row.chipHeight}px (${row.chips} chips)`),
    check("H7: the row scrolls sideways", row.scrollWidth > row.clientWidth, `scrollWidth ${row.scrollWidth} > clientWidth ${row.clientWidth}`),
    // The text field gets what is left under the max, never less than its own min height (H2: the button column).
    check("H7: thumbnails count toward the max height; the text field gets what's left", close(row.input, Math.max(row.inputMin, max - (row.composer - row.input)), 1) && (close(row.composer, max, 2) || close(row.input, row.inputMin, 1)), `composer ${row.composer} (max ${max}); text field ${row.input}, its min ${row.inputMin}, thumbnails/prompt template buttons/footer ${Math.round(row.composer - row.input)}${row.composer > max + 2 ? " — the fixed rows plus the text field's min exceed the max, so the min wins (H2)" : ""}`),
  );
  await page.key("a", { ctrl: true });
  await page.key("Backspace");
  for (let index = 0; index < 4; index++) {
    if (!await page.visible('.agent-composer-pane .agent-attach-row .agent-chip button[data-action="agent-attachments#remove"]')) break;
    await page.tap('.agent-composer-pane .agent-attach-row .agent-chip button[data-action="agent-attachments#remove"]');
    await Bun.sleep(700);
  }
  await page.evaluate<boolean>("(document.activeElement.blur(), true)");
  await closeComposer();
});

await scenario("mobile-D2-send", "D2: sending on mobile closes the composer in one step.", async (recorder) => {
  await pinToBottom();
  await openComposer();
  await page.tap(sel.input);
  await page.insertText("Reply with just the word OK.");
  await Bun.sleep(300);
  const { after } = await transition(recorder, "send", () => page.tap(sel.send), { waitMs: 1500 });
  recorder.add(
    check("D2: composer closed after send", after.composer === null, JSON.stringify(after.composer)),
    check("D2: text field no longer focused", !after.focus.includes("composer-input"), `focus: ${after.focus || "body"}`),
    ...floatingStackChecks(after, false),
  );
  await Bun.sleep(8000);
});

if (!args["layout-only"]) {
  await page.navigate(piUrl, sel.terminal);
  await Bun.sleep(2500);
  // Selecting transcript can now queue autoswitch before Pi has a completed turn.
  await page.tap(sel.viewTranscript);
  await Bun.sleep(500);
  if (!await page.visible(sel.cliTranscript)) {
    log("giving Pi a turn");
    await openComposer();
    await resetComposerText();
    await page.tap(sel.input);
    await page.insertText("Reply with just the word OK.");
    await page.tap(".cli-agent-body .composer-send button");
    await page.waitFor(sel.cliTranscript, 120_000);
    await page.evaluate<boolean>("(document.activeElement.blur(), true)");
  }
  await page.tap(sel.showTerminal);
  await Bun.sleep(400);
}

await scenario("mobile-D14-terminal-focus", "D14: focusing the Pi terminal collapses the open composer (keeping its draft) in one step; the terminal moves, never resizes.", async (recorder) => {
  await openComposer();
  await page.tap(sel.input);
  await page.insertText("Draft that must survive");
  await Bun.sleep(300);
  await page.evaluate<boolean>("(document.activeElement.blur(), true)");
  const { before, after } = await transition(recorder, "tap terminal", () => page.tap(".cli-agent-stage", { y: -150 }));
  recorder.add(
    check("D14: composer collapsed", after.composer === null, JSON.stringify(after.composer)),
    check("D14: terminal has focus", after.focus.includes("gespenst__input"), `focus: ${after.focus}`),
    check("D19: terminal size unchanged (moved, not resized)", before.terminal !== null && after.terminal !== null && before.terminal[2] === after.terminal[2] && before.terminal[3] === after.terminal[3], `${JSON.stringify(before.terminal)} → ${JSON.stringify(after.terminal)}`),
    check("D3: draft kept", await page.evaluate<string>(`[...document.querySelectorAll(".cli-agent-body .composer-input")].find((e) => e.closest(".cli-agent-body").checkVisibility()).value`) === "Draft that must survive", "composer text unchanged"),
    check("D1: draft dot on open-composer", await page.visible(sel.draftDot), "status dot inside open-composer"),
  );
});

await scenario("mobile-D21-pi-floating", "D21: on a CLI agent the view switch sits above open-composer, and follow latest above both while reading the transcript.", async (recorder) => {
  await page.evaluate<boolean>("(document.activeElement.blur(), true)");
  const terminal = await transition(recorder, "terminal", async () => {}, { waitMs: 200, expectChange: false });
  recorder.add(
    check("D21: open composer and view switch shown on the terminal", Boolean(terminal.after.floating["Open composer"] && terminal.after.floating["View transcript"]), JSON.stringify(terminal.after.floating)),
    ...floatingStackChecks(terminal.after, false, terminal.after.terminal),
  );
  await page.tap(sel.viewTranscript);
  await page.waitFor(sel.cliTranscript, 15_000);
  await Bun.sleep(800);
  await page.wheel(".cli-transcript-view", -900);
  await Bun.sleep(900);
  const reading = await transition(recorder, "CLI transcript, scrolled up", async () => {}, { waitMs: 200, expectChange: false });
  recorder.add(...floatingStackChecks(reading.after, false));
  await recorder.file("pi-transcript.png", await page.screenshot());
  await page.tap(sel.showTerminal);
  await Bun.sleep(800);
});

await scenario("mobile-D18-frozen-send", "D18: sending while the frozen transcript shows switches to the terminal instantly, in the same frame as the composer closing.", async (recorder) => {
  await page.tap(sel.viewTranscript);
  await page.waitFor(sel.cliTranscript, 15_000);
  await Bun.sleep(800);
  await openComposer();
  await resetComposerText();
  await page.tap(sel.input);
  await page.insertText("Reply with just the word OK.");
  await Bun.sleep(300);
  const { before, after } = await transition(recorder, "send from the frozen transcript", () => page.tap(".cli-agent-body .composer-send button"), { waitMs: 1200 });
  recorder.add(
    check("D18: frozen transcript showing before send", before.transcript !== null, JSON.stringify(before.transcript)),
    check("D18: terminal showing after send", after.transcript === null && after.terminal !== null, `transcript ${JSON.stringify(after.transcript)}, terminal ${JSON.stringify(after.terminal)}`),
    check("D2: composer closed after send", after.composer === null, JSON.stringify(after.composer)),
    check("D17: terminal not focused after send", !after.focus.includes("gespenst__input"), `focus: ${after.focus || "body"}`),
    // Use the same recorded working frame as the layout checks above. A short
    // reply can finish before transition() returns and legitimately restore the switch.
    check("D18: pending autoswitch shown while the agent works", Boolean(after.floating[floatingLabel.pendingTranscript]), JSON.stringify(after.floating)),
  );
  await page.waitFor(sel.cliTranscript, 120_000);
  recorder.add(check("D18: transcript returns when the turn finishes", await page.visible(sel.showTerminal), "Back to terminal shown"));
  await recorder.file("pi-transcript-after-turn.png", await page.screenshot());
  await page.tap(sel.showTerminal);
  await Bun.sleep(800);
});

// A Terminal view gets its size the first time it is shown; the scenario starts after that.
await page.navigate(terminalUrl, ".terminal-view .observable-terminal-host");
await Bun.sleep(2000);

await scenario("mobile-terminal-tab", "D19: focusing a Terminal view and switching views never resizes it.", async (recorder) => {
  const { before, after } = await transition(recorder, "tap Terminal view", () => page.tap(".terminal-view .terminal-stage"), { expectChange: false });
  recorder.add(check("D19: terminal box unchanged", JSON.stringify(before.terminal) === JSON.stringify(after.terminal), `${JSON.stringify(before.terminal)} → ${JSON.stringify(after.terminal)}`));
  await page.navigate(builtinUrl, sel.transcript);
  await page.navigate(terminalUrl, ".terminal-view .observable-terminal-host");
  await Bun.sleep(1500);
});

await page.navigate(builtinUrl, sel.transcript);

await scenario("mobile-D24-long-press", "D24: holding open-composer for about 500ms opens the composer and starts dictation while the finger is still down; releasing does nothing else. The workspace's Chrome has no microphone, so the page gets a synthetic one.", async (recorder) => {
  await page.fakeMicrophone();
  await page.navigate(builtinUrl, sel.transcript);
  await closeComposer();
  await page.startTrace();
  await Bun.sleep(80); // Capture the pre-action arrangement before an immediate CDP edit.
  const t = await page.mark("hold open-composer");
  const release = await page.press(sel.opener);
  await Bun.sleep(800);
  const holding = await page.evaluate<{ open: boolean; state: string; label: string }>(`(() => {
    const pane = [...document.querySelectorAll(".agent-composer-pane")].find((e) => e.checkVisibility());
    const button = pane.querySelector('[data-dictation-composer-target="button"]');
    return { open: pane.classList.contains("agent-composer-open"), state: button.dataset.state, label: button.title };
  })()`);
  await release();
  await Bun.sleep(600);
  const trace = await page.takeTrace();
  await recorder.trace(trace, "hold open-composer");
  const opened = trace.frames.find((frame) => frame.composer !== null);
  const last = trace.frames.at(-1)!;
  recorder.add(
    check("D24: composer opened while holding", holding.open && opened !== undefined, `open while held: ${holding.open}, first open frame at +${opened ? Math.round(opened.t - t) : "—"}ms after the press`),
    check("D24: about 500ms", opened !== undefined && opened.t - t >= 450 && opened.t - t <= 800, `${opened ? Math.round(opened.t - t) : "—"}ms`),
    check("D24: dictation started while holding", ["loading", "recording", "finishing"].includes(holding.state), `transcribe button while held: ${holding.state} (${holding.label})`),
    check("D24: releasing changed nothing else", last.composer !== null && !last.focus.includes("composer-input"), `composer ${JSON.stringify(last.composer)}, focus ${last.focus || "body"}`),
  );
  recorder.add(...oneStepChecks(analyseTransition(trace, t, Number.POSITIVE_INFINITY, { endAtContentChange: false })).map((result) => ({ ...result, name: `hold open-composer — ${result.name}` })));
  await recorder.file("holding.png", await page.screenshot());
  // Stop dictation without sending.
  await page.tap('.agent-composer-pane [data-dictation-composer-target="button"]');
  await Bun.sleep(1500);
  await resetComposerText();
  await closeComposer();
});

await scenario("mobile-D21-D22-floating", "D21/D22: floating buttons stack bottom right; follow latest only away from the bottom; open-composer hides while the composer is open.", async (recorder) => {
  await closeComposer();
  await scrollPartway();
  const reading = await transition(recorder, "reading, scrolled up", async () => {}, { waitMs: 200, expectChange: false });
  recorder.add(...floatingStackChecks(reading.after, false));
  await page.tap(sel.followLatest);
  await Bun.sleep(1800);
  const atBottom = await transition(recorder, "at the bottom", async () => {}, { waitMs: 200, expectChange: false });
  recorder.add(check("D21: follow latest hidden at the bottom", !atBottom.after.floating[floatingLabel.followLatest], JSON.stringify(atBottom.after.floating)));
  await transition(recorder, "open composer", () => page.tap(sel.opener));
  await scrollPartway();
  const open = await transition(recorder, "composer open, scrolled up", async () => {}, { waitMs: 200, expectChange: false });
  recorder.add(...floatingStackChecks(open.after, true));
  await closeComposer();
});

// Tablet pointer review uses Chromium touch/pen input, not an iPad/WebKit keyboard.
await page.layout("desktop");
await page.cdp.send("Emulation.setDeviceMetricsOverride", {width:1024,height:900,deviceScaleFactor:2,mobile:false});
await page.cdp.send("Emulation.setTouchEmulationEnabled", {enabled:true,maxTouchPoints:5});
await page.navigate(builtinUrl,sel.transcript);
await Bun.sleep(3000);
await scenario("tablet-H6-divider", "Touch and pen dragging resize a wide tablet composer without taking focus from its text; the divider has a larger touch target.", async recorder=>{
  await openComposer();
  const state=()=>page.evaluate<{height:number;focused:boolean;target:number}>(`(() => {const input=[...document.querySelectorAll(${JSON.stringify(sel.input)})].find(e=>e.checkVisibility());const composer=input.closest(".composer");return {height:composer.getBoundingClientRect().height,focused:document.activeElement===input,target:composer.querySelector(".composer-divider").getBoundingClientRect().height};})()`);
  await page.tap(sel.input);
  const before=await state();
  await resizeComposerDivider(110,"touch");
  const touch=await state();
  recorder.add(check("finger drag expands the composer",touch.height>before.height+50,`${before.height} → ${touch.height}`),check("finger drag preserves text focus",before.focused&&touch.focused,`${before.focused} → ${touch.focused}`),check("touch divider is at least 24px tall",touch.target>=24,`${touch.target}px`));
  await page.tap(sel.input);
  await resizeComposerDivider(80,"pen");
  const pen=await state();
  recorder.add(check("pen drag expands the composer",pen.height>touch.height+30,`${touch.height} → ${pen.height}`),check("pen drag preserves text focus",pen.focused,String(pen.focused)));
  await resizeComposerDivider(-160,"touch");
  const shrunk=await state();
  recorder.add(check("finger drag can shrink again",shrunk.height<pen.height-80,`${pen.height} → ${shrunk.height}`),check("shrinking preserves text focus",shrunk.focused,String(shrunk.focused)));
  await recorder.file("tablet-resized.png",await page.screenshot());
});

// ─── Desktop layout ─────────────────────────────────────────────────────────
await page.layout("desktop");
floatingInset = 10;
await page.navigate(builtinUrl, sel.transcript);
// Terminals open beside the agent attach at the desktop size before any scenario's baseline.
await Bun.sleep(3000);

await scenario("desktop-D1-selection", "D1: on desktop the composer is open and its text field focused when the workspace is selected.", async (recorder) => {
  await page.navigate(`${setup.kintsugi}/`, "body");
  await page.navigate(builtinUrl, sel.input);
  const { after } = await transition(recorder, "after selection", async () => {}, { waitMs: 200, expectChange: false });
  const buttonColumn = await page.evaluate<NonNullable<Box>[]>(`[...document.querySelectorAll(".agent-composer-pane .composer-button")].filter((slot) => slot.checkVisibility() && [...slot.querySelectorAll("button")].some((button) => button.checkVisibility())).map((slot) => { const r = slot.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })`);
  recorder.add(
    check("D1: composer open", after.composer !== null, JSON.stringify(after.composer)),
    check("D1: text field focused", after.focus.includes("composer-input"), `focus: ${after.focus || "body"}`),
    check("D4: four buttons in one vertical column (close, attach, dictation, send)", buttonColumn.length === 4 && buttonColumn.every((box, index) => close(box[0] + box[2] / 2, buttonColumn[0]![0] + buttonColumn[0]![2] / 2) && (index === 0 || box[1] >= bottom(buttonColumn[index - 1]!))), JSON.stringify(buttonColumn)),
  );
});

await scenario("desktop-H6-divider", "Mouse and keyboard resizing still work without sending a prompt.", async recorder=>{
  const height=()=>page.evaluate<number>(`[...document.querySelectorAll(".agent-pane-composer")].find(e=>e.checkVisibility()).getBoundingClientRect().height`);
  const before=await height();await resizeComposerDivider(100);const dragged=await height();
  recorder.add(check("mouse drag expands the composer",dragged>before+50,`${before} → ${dragged}`));
  await page.cdp.send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:"ArrowUp",code:"ArrowUp",windowsVirtualKeyCode:38});
  await page.cdp.send("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowUp",code:"ArrowUp",windowsVirtualKeyCode:38});
  await Bun.sleep(300);const keyed=await height();recorder.add(check("focused divider accepts ArrowUp",close(keyed,dragged+20,1),`${dragged} → ${keyed}`));
});

await scenario("desktop-D8-D2-send", "D8/D2/H4: Enter inserts a newline; Cmd+Enter sends; the composer stays open and returns to its min height in one step.", async (recorder) => {
  await resetComposerText();
  await page.tap(sel.input);
  const minimum = (await transition(recorder, "empty", async () => {}, { waitMs: 150, expectChange: false })).after.composer![3];
  // Enough lines to fill the button column, so the next one grows the composer.
  const lines = ["Reply with just the word OK and ignore the numbered lines below.", ...Array.from({ length: 9 }, (_, index) => `${index + 1}.`)];
  await page.insertText(lines.join("\n"));
  await Bun.sleep(200);
  const entered = await transition(recorder, "Enter", () => page.key("Enter"));
  const value = await page.evaluate<string>("document.activeElement.value");
  recorder.add(
    check("D8: Enter inserted a newline", value.endsWith("\n") && value.split("\n").length === lines.length + 1, JSON.stringify(value)),
    check("D8: Enter did not send", entered.after.content === entered.before.content && value.length > 0, "text still in the composer, transcript unchanged"),
    check("H1: one line taller", entered.after.composer![3] - entered.before.composer![3] > 15, `${entered.before.composer![3]} → ${entered.after.composer![3]}`),
  );
  const sent = await transition(recorder, "Cmd+Enter", () => page.key("Enter", { meta: true }), { waitMs: 1500 });
  recorder.add(
    check("D8: Cmd+Enter sent", await page.evaluate<string>(`[...document.querySelectorAll(${JSON.stringify(sel.input)})].find((e) => e.checkVisibility()).value`) === "", "composer cleared after send"),
    check("D2: composer stays open on desktop", sent.after.composer !== null, JSON.stringify(sent.after.composer)),
    check("H4: back to the min height", close(sent.after.composer![3], minimum), `${sent.before.composer![3]} → ${sent.after.composer![3]} (min ${minimum})`),
  );
  await Bun.sleep(8000);
});

await scenario("desktop-H3-H6-resize", "H3/H6: the composer grows to 40% of the window, then can be manually resized with its controls staying packed to the bottom edge.", async (recorder) => {
  await resetComposerText();
  await page.tap(sel.input);
  const minimum = (await transition(recorder, "empty", async () => {}, { waitMs: 150, expectChange: false })).after.composer![3];
  const text = ["Reply with just the word OK and ignore the numbered lines below.", ...Array.from({ length: 50 }, (_, index) => `${index + 1}.`)].join("\n");
  const pasted = await transition(recorder, "large paste", () => page.insertText(text));
  recorder.add(check("H3: 40% of the window", close(pasted.after.composer![3], 900 * 0.4, 2), `composer ${pasted.after.composer![3]}, 40% of 900 = 360`));
  const sent = await transition(recorder, "Ctrl+Enter", () => page.key("Enter", { ctrl: true }), { waitMs: 1500 });
  recorder.add(
    check("H4: back to the min height in one step after send", close(sent.after.composer![3], minimum), `${sent.before.composer![3]} → ${sent.after.composer![3]} (min ${minimum})`),
    check("D2: composer stays open", sent.after.composer !== null, JSON.stringify(sent.after.composer)),
  );
  await resetComposerText();
  await page.insertText("Manual resize draft");
  await Bun.sleep(250);
  const beforeResize = await page.evaluate<{ input: number; buttonsBottom: number; resize: string }>(`(() => { const pane = [...document.querySelectorAll(".agent-composer-pane")].find((e) => e.checkVisibility()); const input = pane.querySelector(".composer-input"); const buttons = pane.querySelector(".composer-buttons"); return { input: input.getBoundingClientRect().height, buttonsBottom: buttons.getBoundingClientRect().bottom, resize: getComputedStyle(input).resize }; })()`);
  await resizeComposerDivider(56);
  const afterResize = await page.evaluate<{ input: number; buttonsBottom: number; overflow: string }>(`(() => { const pane = [...document.querySelectorAll(".agent-composer-pane")].find((e) => e.checkVisibility()); const input = pane.querySelector(".composer-input"); const buttons = pane.querySelector(".composer-buttons"); return { input: input.getBoundingClientRect().height, buttonsBottom: buttons.getBoundingClientRect().bottom, overflow: getComputedStyle(input).overflowY }; })()`);
  recorder.add(
    check("H6: dragging the divider expands the composer without a textarea resize handle", afterResize.input > beforeResize.input + 30 && beforeResize.resize === "none", `${beforeResize.input}px → ${afterResize.input}px (${beforeResize.resize})`),
    check("H6: action icons stay packed to the editor's bottom edge", close(afterResize.buttonsBottom, (await page.evaluate<number>(`[...document.querySelectorAll(".agent-composer-pane")].find((e) => e.checkVisibility()).querySelector(".composer-input").getBoundingClientRect().bottom`)), 2), `buttons bottom ${afterResize.buttonsBottom}, editor bottom follows after resize`),
  );
  await page.tap(sel.input);
  await page.insertText(" typed after resizing");
  const typedHeight = await page.evaluate<number>(`[...document.querySelectorAll(${JSON.stringify(sel.input)})].find((e) => e.checkVisibility()).getBoundingClientRect().height`);
  recorder.add(check("H6: typing preserves the manually chosen height", close(typedHeight, afterResize.input, 1), `${afterResize.input}px → ${typedHeight}px`));
  await resizeComposerDivider(-150);
  const smallerHeight = await page.evaluate<number>(`[...document.querySelectorAll(${JSON.stringify(sel.input)})].find((e) => e.checkVisibility()).getBoundingClientRect().height`);
  const packed = await page.evaluate<boolean>(`(() => { const pane = [...document.querySelectorAll(".agent-composer-pane")].find((e) => e.checkVisibility()); const buttons = [...pane.querySelectorAll(".composer-button")].filter((e) => e.checkVisibility()).map((e) => e.getBoundingClientRect()); return buttons.every((r) => Math.abs(r.top - buttons[0].top) < 1); })()`);
  recorder.add(check("H6: dragging down shrinks the composer and packs its icons into a row", smallerHeight < typedHeight - 20 && packed, `${typedHeight}px → ${smallerHeight}px; icons share a row: ${packed}`));
  await Bun.sleep(8000);
});

await scenario("desktop-D21-D22-floating", "D21/D22 on desktop: the floating-button stack with the composer closed and open.", async (recorder) => {
  const closed = await transition(recorder, "close composer", () => page.tap(sel.close));
  recorder.add(...floatingStackChecks(closed.after, false));
  await scrollPartway();
  const reading = await transition(recorder, "reading, scrolled up", async () => {}, { waitMs: 200, expectChange: false });
  recorder.add(...floatingStackChecks(reading.after, false));
  const opened = await transition(recorder, "open composer", () => page.tap(sel.opener));
  recorder.add(...floatingStackChecks(opened.after, true));
});

// Launch is a dialog host for the same editor, with its own height budget.
for (const layout of ["mobile", "desktop"] as const) {
  await page.layout(layout);
  await page.navigate(`${setup.kintsugi}/workspaces/new`, ".launch-composer .composer-input");
  await Bun.sleep(1000); // Navigation/layout resizing is not a launch-editor transition.
  await scenario(`${layout}-launch-editor`, "Launch opens without a mobile keyboard, grows with text, and keeps launch controls in reach.", async (recorder) => {
    const focused = await page.evaluate<boolean>('document.activeElement.matches(".launch-composer .composer-input")');
    recorder.add(check("Intentional initial focus", focused === (layout === "desktop"), `textarea focused: ${focused}`));
    recorder.add(check("Dictation available before typing", await page.visible(".launch-composer .composer-dictation button"), "dictation control visible"));
    await page.tap(".launch-composer .composer-input");
    // Launch drafts survive navigation, including the preceding mobile scenario.
    // Start empty so this action actually exercises growth on both layouts.
    await page.evaluate<boolean>(`(() => { const input = document.querySelector(".launch-composer .composer-input"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await Bun.sleep(400);
    // Transcript updates behind the dialog are unrelated to launch-editor growth.
    await transition(recorder, "large launch prompt", () => page.insertText(Array.from({ length: 80 }, (_, i) => `Launch line ${i}`).join("\n")), { endAtContentChange: false });
    const geometry = await page.evaluate<{ fits: boolean; scrolls: boolean; caret: boolean }>(`(() => {
      const dialog = document.querySelector("dialog[open]").getBoundingClientRect();
      const input = document.querySelector(".launch-composer .composer-input");
      const send = document.querySelector(".launch-composer .composer-send button").getBoundingClientRect();
      return { fits: dialog.top >= 0 && dialog.bottom <= innerHeight && send.bottom <= innerHeight, scrolls: input.scrollHeight > input.clientHeight, caret: input.scrollTop > 0 };
    })()`);
    recorder.add(check("Dialog and send stay inside the window", geometry.fits, JSON.stringify(geometry)), check("Long prompt scrolls with caret revealed", geometry.scrolls && geometry.caret, JSON.stringify(geometry)));
    await page.tap('dialog[open] .dialog__close-form button');
    recorder.add(check("Cancel closes launch", !await page.visible(".launch-composer"), "launch dismissed"));
  });
}

if (!report.scenarios.length) throw new Error("No acceptance scenarios matched the selection");
const { passed, index } = await report.write();
await page.close();
log(`${passed ? "PASS" : "FAIL"}${args["layout-only"] ? " (partial, no inference; not full acceptance)" : ""} — report: ${index}`);
process.exit(passed ? 0 : 1);
