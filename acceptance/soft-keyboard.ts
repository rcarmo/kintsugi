/**
 * Acceptance script, Tier 2: soft-keyboard behaviour on the workspace-owned
 * remote iOS simulator (iPhone 15 Pro), in the installed Kintsugi PWA.
 * Everything without a soft keyboard is Tier 1 (acceptance/composer-layout.ts).
 *
 * Run by hand or by an agent against a running Kintsugi; never part of a test suite or CI.
 * Prerequisites (see .agents/skills/ios-serve-sim/SKILL.md):
 *   - `bun tools/ios-serve-sim/cli.ts serve --model "iPhone 15 Pro" -- --fit --panes tools` running (viewer on :4101),
 *   - `bun tools/ios-serve-sim/cli.ts forward 3000 43000` running,
 *   - Kintsugi added to the simulator's Home Screen from http://localhost:43000 and open,
 *   - the simulator's soft keyboard enabled (com.apple.keyboard.preferences
 *     AutomaticMinimizationEnabled=false, HardwareKeyboardLastSeen=false).
 *
 *   bun acceptance/soft-keyboard.ts [--kintsugi http://localhost:3000] [--app http://localhost:43000]
 *     [--workspace <id>] [--model provider::model] [--out <dir>] [--only <regex>]
 *
 * The page is traced per frame through the Web Inspector (ios_webkit_debug_proxy),
 * the screen is recorded with `simctl io recordVideo`, terminal resize messages are
 * counted from the inspector's WebSocket frames, and tmux window sizes are read in
 * the workspace container.
 */
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Report, type ScenarioRecorder } from "./lib/report.ts";
import { Simulator, WebKitPage } from "./lib/simulator.ts";
import { stage, tmuxSizes, type Stage } from "./lib/stage.ts";
import { analyseTransition, check, close, oneStepChecks, settled, type Box, type Frame, type Trace } from "./lib/trace.ts";
import { analyseKeyboardVideo } from "./lib/video.ts";

const { values: args } = parseArgs({
  options: {
    kintsugi: { type: "string", default: "http://localhost:3000" },
    app: { type: "string", default: "http://localhost:43000" },
    workspace: { type: "string" },
    model: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
  },
});

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = args.out ?? `/persistent/acceptance-reports/soft-keyboard-${stamp}`;
await mkdir(out, { recursive: true });
const log = (message: string): void => console.log(`[soft-keyboard] ${message}`);

// Check the hardware prerequisite before staging Agents or generating a transcript.
const sim = await Simulator.connect();
const inspector = await sim.inspector();
const setup: Stage = await stage({ kintsugi: args.kintsugi, workspaceId: args.workspace, model: args.model, log });
if (!setup.piId) throw new Error("Soft-keyboard acceptance requires a staged Pi agent");
log(`simulator ${sim.udid}; inspector ${inspector.url}`);

async function openPwa(): Promise<WebKitPage> {
  // SAFETY: ios_webkit_debug_proxy's /json page listing.
  const pages = await (await fetch(`${inspector.url}/json`)).json() as { url: string; appId: string }[];
  for (const candidate of pages.filter((page) => page.url.startsWith(args.app))) {
    const page = await WebKitPage.open(inspector.url, (item) => item.appId === candidate.appId && item.url === candidate.url);
    if (await page.evaluate<boolean>("navigator.standalone === true")) return page;
    page.close();
  }
  throw new Error(`The Kintsugi PWA (${args.app}) is not running on the simulator. Add it to the Home Screen and open it.`);
}

let page = await openPwa();
await page.enableNetwork();
const report = new Report(out, "Soft keyboard acceptance (Tier 2, iPhone 15 Pro simulator, PWA)", {
  kintsugi: args.kintsugi, app: args.app, simulator: sim.udid, workspace: setup.workspaceId, "built-in agent": setup.builtinId, "Pi agent": setup.piId, "Terminal view": setup.terminalKey, started: new Date().toISOString(),
});

const builtinPath = `/workspaces/${setup.workspaceId}?agent=${setup.builtinId}`;
const piPath = `/workspaces/${setup.workspaceId}?agent=${setup.piId}`;
const terminalPath = `/workspaces/${setup.workspaceId}?workView=${encodeURIComponent(setup.terminalKey)}`;
const sel = {
  transcript: ".agent-pane .agent-transcript",
  opener: '.agent-composer-pane [data-agent-composer-target="opener"]',
  input: ".agent-composer-pane .composer-input",
  send: ".agent-composer-pane .composer-send button:not([data-action])",
  stage: ".cli-agent-stage",
  terminalInput: ".gespenst__input",
};
const bottom = (box: Box): number => box ? box[1] + box[3] : Number.NaN;
/** The keyboard's top edge in page coordinates, from the visual viewport. */
const keyboardTop = (frame: Frame): number => frame.viewport[0] + frame.viewport[1];

async function navigate(path: string, ready: string): Promise<void> {
  await page.evaluate<boolean>(`(location.href = ${JSON.stringify(path)}, true)`);
  await Bun.sleep(1500);
  page.close();
  page = await openPwa();
  await page.enableNetwork();
  const deadline = Date.now() + 30_000;
  while (!await page.evaluate<boolean>(`[...document.querySelectorAll(${JSON.stringify(ready)})].some((e) => e.checkVisibility())`)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${ready}`);
    await Bun.sleep(250);
  }
  await Bun.sleep(1200);
}

async function visible(selector: string): Promise<boolean> {
  return page.evaluate<boolean>(`[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => e.checkVisibility())`);
}

/** Screen point (in points) of an element's center, plus an optional offset. */
async function point(selector: string, offset: { x?: number; y?: number } = {}): Promise<{ x: number; y: number }> {
  const result = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.checkVisibility());
    if (!element) return null;
    const r = element.getBoundingClientRect();
    // The status bar sits above the standalone page.
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 + ${sim.screen.height} - document.documentElement.clientHeight };
  })()`);
  if (!result) throw new Error(`No visible element for ${selector}`);
  return { x: result.x + (offset.x ?? 0), y: result.y + (offset.y ?? 0) };
}

async function tap(selector: string, offset: { x?: number; y?: number } = {}): Promise<void> {
  const target = await point(selector, offset);
  await sim.tap(target.x, target.y);
}

/** A tap on plain transcript text: outside the text field, and not on a control. */
async function tapTranscriptText(): Promise<void> {
  const target = await page.evaluate<{ x: number; y: number }>(`(() => {
    const t = [...document.querySelectorAll(".agent-pane .agent-transcript")].find((e) => e.checkVisibility());
    const tr = t.getBoundingClientRect();
    const p = [...t.querySelectorAll(".agent-final p, .agent-final li")].reverse().find((e) => { const r = e.getBoundingClientRect(); return r.bottom > tr.top + 20 && r.top < tr.bottom - 20; });
    const r = p.getBoundingClientRect();
    return { x: r.left + 24, y: (Math.max(r.top, tr.top) + Math.min(r.bottom, tr.bottom)) / 2 + (${sim.screen.height} - document.documentElement.clientHeight) };
  })()`);
  await sim.tap(target.x, target.y);
}

/** The ✓ (Done) key on the keyboard's input accessory bar. */
async function tapDone(): Promise<void> {
  const viewport = await page.evaluate<number>("visualViewport.height + visualViewport.offsetTop");
  await sim.tap(sim.screen.width - 41, sim.screen.height - await page.evaluate<number>("innerHeight") + viewport + 33);
}

/** The soft keyboard's return key (iPhone 15 Pro, portrait, English QWERTY). */
async function tapReturn(): Promise<void> {
  await sim.tap(343, 758);
}

async function blur(): Promise<void> {
  await page.evaluate<boolean>("(document.activeElement && document.activeElement.blur(), true)");
  await Bun.sleep(900);
}

async function scenario(name: string, description: string, body: (recorder: ScenarioRecorder) => Promise<void>): Promise<void> {
  if (args.only && !new RegExp(args.only).test(name)) return;
  log(`scenario ${name}`);
  const recorder = await report.scenario(name, description);
  const resizesBefore = page.resizes.length;
  const tmuxBefore = await tmuxSizes(setup.workspaceId);
  const counted = name !== "ios-D20-rotation" && name !== "ios-launch-keyboard";
  try {
    await body(recorder);
  } catch (error) {
    recorder.add(check("Scenario completed", false, error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)));
  }
  await recorder.file("after.png", await sim.screenshot());
  if (!counted) return;
  const resizes = page.resizes.slice(resizesBefore);
  const tmuxAfter = await tmuxSizes(setup.workspaceId);
  recorder.add(check("0 terminal resize messages", resizes.length === 0, resizes.length ? resizes.map((item) => `${item.payload} on ${item.url}`).join("; ") : "no {\"type\":\"resize\"} frames sent on terminal WebSockets (Web Inspector)"));
  const changed = Object.keys({ ...tmuxBefore, ...tmuxAfter }).filter((session) => tmuxBefore[session] !== tmuxAfter[session]);
  recorder.add(check("tmux window sizes unchanged", changed.length === 0, Object.entries(tmuxAfter).map(([session, size]) => `${session}: ${tmuxBefore[session] ?? "—"} → ${size}`).join("; ")));
}

/**
 * Runs an action while tracing every frame and recording the screen, applies
 * the one-step pass criteria, and (for keyboard show/hide) the video check.
 */
async function transition(recorder: ScenarioRecorder, label: string, action: () => Promise<void>, options: { waitMs?: number; video?: boolean; correctionAllowed?: boolean; expectChange?: boolean; oneStep?: boolean; maskTerminal?: boolean } = {}): Promise<{ before: Frame; after: Frame }> {
  const stopVideo = options.video === false ? undefined : await sim.recordVideo();
  let trace: Trace;
  let t: number;
  let movie: Uint8Array | undefined;
  try {
    await page.startTrace();
    await Bun.sleep(80); // Capture the pre-action arrangement before an immediate edit.
    t = await page.mark(label);
    await action();
    await Bun.sleep(options.waitMs ?? 1600);
    trace = await page.takeTrace();
  } finally {
    movie = await stopVideo?.();
  }
  const analysis = analyseTransition(trace, t);
  await recorder.trace(trace, label);
  // Native scrolling moves content continuously; it is not a layout transition.
  const checks = options.oneStep === false ? [] : oneStepChecks(analysis, { correctionAllowed: options.correctionAllowed, expectChange: options.expectChange });
  recorder.add(...checks.map((result) => ({ ...result, name: `${label} — ${result.name}` })));
  if (movie) {
    const file = `video-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4`;
    await recorder.file(file, movie);
    const path = join(recorder.directory, file);
    // A terminal printing output is content, not layout: its settled box is left out.
    const terminal = options.maskTerminal ? settled(analysis).terminal : null;
    const offset = sim.screen.height - await page.evaluate<number>("document.documentElement.clientHeight");
    const video = await analyseKeyboardVideo(path, { masks: terminal ? [[terminal[0] * 3, (terminal[1] + offset) * 3, terminal[2] * 3, terminal[3] * 3]] : [] });
    await recorder.file(`${file}.json`, JSON.stringify(video, null, 2));
    const worst = video.worst;
    recorder.add({
      name: `${label} — Video: only the keyboard animates`,
      pass: video.pass || Boolean(options.correctionAllowed && worst && worst.differing > video.allowance && checks.every((item) => item.pass)),
      evidence: (video.masks.length ? `terminal output masked at ${JSON.stringify(video.masks)} px; ` : "") + (video.firstChanged === null
        ? `${video.frames} frames, nothing changed on screen`
        : `${video.perFrame.length} frames from the first change (frame ${video.firstChanged}); above the keyboard edge, worst frame ${worst?.index} (t=${worst?.time.toFixed(3)}s) differs from the settled frame in ${worst?.differing} px (allowance ${video.allowance} px: still-frame noise ${video.noise} px ×2, at least 600; tolerance ±${video.tolerance} luminance; status bar excluded)${worst && worst.differing > video.allowance ? `; first differing row ${worst.firstRow} px` : ""}`),
      note: options.correctionAllowed && !video.pass ? "Allowed exception: first focus without a remembered keyboard height (D12) — the one correction is visible in the video." : undefined,
    });
  }
  return { before: analysis.window[0]!, after: settled(analysis) };
}

function typingModeChecks(frame: Frame, label: string): ReturnType<typeof check>[] {
  return [
    check(`${label}: D7 only send shows while typing`, frame.buttons.join() === "send", `visible composer buttons: ${frame.buttons.join(", ") || "none"}`),
    check(`${label}: D23 floating buttons hidden`, Object.keys(frame.floating).length === 0, `visible floating buttons: ${Object.keys(frame.floating).join(", ") || "none"}`),
    check(`${label}: D10 composer sits on the keyboard, transcript above it`, frame.composer !== null && close(bottom(frame.composer), keyboardTop(frame), 2) && (frame.transcript === null || close(bottom(frame.transcript), frame.composer[1], 1)), `composer ${JSON.stringify(frame.composer)}, keyboard top ${keyboardTop(frame)}, transcript ${JSON.stringify(frame.transcript)}`),
    check(`${label}: page not scrolled`, frame.pageScroll === 0 && frame.viewport[1] === 0, `scrollY ${frame.pageScroll}, visualViewport.offsetTop ${frame.viewport[1]}`),
  ];
}

async function openComposer(): Promise<void> {
  if (await visible(sel.opener)) {
    await tap(sel.opener);
    await Bun.sleep(700);
  }
}

// ─── Built-in agent ─────────────────────────────────────────────────────────
await navigate(builtinPath, sel.transcript);

await scenario("ios-D12-first-focus", "D12: focusing the composer for the first time on this device (nothing remembered): the keyboard is detected and the page arranged; one correction is allowed.", async (recorder) => {
  // Nothing remembered: the module reads its memory when the page loads.
  await page.evaluate<boolean>('(localStorage.removeItem("kintsugi:software-keyboard"), true)');
  await navigate(builtinPath, sel.transcript);
  await openComposer();
  const { after } = await transition(recorder, "first focus", () => tap(sel.input), { correctionAllowed: true });
  recorder.add(check("Keyboard detected and arranged", after.keyboard, `software-keyboard-visible: ${after.keyboard}`), ...typingModeChecks(after, "first focus"));
  recorder.add(check("Keyboard height remembered", Boolean(await page.evaluate<string | null>('localStorage.getItem("kintsugi:software-keyboard")')), String(await page.evaluate<string | null>('localStorage.getItem("kintsugi:software-keyboard")'))));
  await recorder.file("typing.png", await sim.screenshot());
  await blur();
});

await scenario("ios-D12-remembered-focus", "D12/D7/D23: focusing the composer with a remembered keyboard height arranges everything in one step at focus, with no correction.", async (recorder) => {
  await openComposer();
  const { after } = await transition(recorder, "focus", () => tap(sel.input));
  recorder.add(...typingModeChecks(after, "focus"));
  await recorder.file("typing.png", await sim.screenshot());
});

await scenario("ios-D13-scroll-keeps-keyboard", "D13: scrolling the transcript while typing never dismisses the keyboard.", async (recorder) => {
  if (!await page.evaluate<boolean>("document.activeElement.classList.contains('composer-input')")) await tap(sel.input);
  await Bun.sleep(800);
  const area = await point(sel.transcript);
  const { before, after } = await transition(recorder, "swipe the transcript", () => sim.swipe(area.x, area.y - 60, area.y + 60), { video: false, oneStep: false });
  recorder.add(
    check("D13: keyboard still up", after.keyboard && after.focus.includes("composer-input"), `arranged: ${after.keyboard}, focus: ${after.focus}`),
    check("D13: the transcript scrolled", after.scrollTop !== before.scrollTop, `scrollTop ${before.scrollTop} → ${after.scrollTop}`),
  );
});

await scenario("ios-D12-D13-done", "D12/D13: dismissing the keyboard with Done rearranges for the hidden keyboard in one step.", async (recorder) => {
  if (!await page.evaluate<boolean>("document.activeElement.classList.contains('composer-input')")) {
    await tap(sel.input);
    await Bun.sleep(1200);
  }
  const { after } = await transition(recorder, "Done", () => tapDone());
  recorder.add(
    check("Keyboard down, composer stays open", !after.keyboard && after.composer !== null && !after.focus.includes("composer-input"), `arranged: ${after.keyboard}, composer ${JSON.stringify(after.composer)}, focus: ${after.focus || "body"}`),
    check("D4: all four composer buttons back", after.buttons.join() === "close,attach,transcribe,send", after.buttons.join(", ")),
  );
});

await scenario("ios-D12-D13-tap-outside", "D12/D13: tapping outside the text field dismisses the keyboard; the page rearranges in one step.", async (recorder) => {
  await tap(sel.input);
  await Bun.sleep(1500);
  const { after } = await transition(recorder, "tap outside", () => tapTranscriptText());
  recorder.add(check("Keyboard down", !after.keyboard && !after.focus.includes("composer-input"), `arranged: ${after.keyboard}, focus: ${after.focus || "body"}`));
});

await scenario("ios-D7-D23-typing-mode", "D7/D23: while the keyboard is up only typing UI shows: no attach, close, transcribe, prompt template buttons, footer or floating buttons; the full-width text runs under send in the bottom-right corner.", async (recorder) => {
  await openComposer();
  await tap(sel.input);
  await Bun.sleep(1500);
  const { after } = await transition(recorder, "typing", async () => {}, { video: false, expectChange: false, waitMs: 300 });
  recorder.add(...typingModeChecks(after, "typing"));
  const placement = await page.evaluate<{ send: number[]; composer: number[]; input: number[] }>(`(() => {
    const pane = [...document.querySelectorAll(".agent-composer-pane")].find((e) => e.checkVisibility());
    const box = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    return { send: box(pane.querySelector(".composer-send button")), composer: box(pane.querySelector(":scope > .composer")), input: box(pane.querySelector(".composer-input")) };
  })()`);
  recorder.add(
    check("Send sits in the composer's bottom-right corner", placement.send[1] + placement.send[3] <= placement.composer[1] + placement.composer[3] && placement.composer[1] + placement.composer[3] - (placement.send[1] + placement.send[3]) <= 12 && close(placement.send[0] + placement.send[2], placement.composer[0] + placement.composer[2] - 4, 8), `send ${JSON.stringify(placement.send.map(Math.round))}, composer ${JSON.stringify(placement.composer.map(Math.round))}`),
    check("The text takes the composer's full width", close(placement.input[2], placement.composer[2], 2), `text field ${Math.round(placement.input[2])}px wide, composer ${Math.round(placement.composer[2])}px`),
    // Two controls of 62.5px, each with its 4px inset above and below.
    check("The text field is at least two controls tall", placement.input[3] >= 2 * (62.5 + 8) - 1, `text field ${Math.round(placement.input[3])}px tall, min ${2 * (62.5 + 8)}px`),
  );
  const hidden = await page.evaluate<string[]>(`[".agent-composer-pane .composer-footer", ".agent-composer-pane .composer-prompt-template-buttons", ".agent-composer-pane .composer-attach", ".agent-composer-pane .composer-close", ".agent-composer-pane .composer-dictation"].filter((s) => [...document.querySelectorAll(s)].some((e) => e.checkVisibility()))`);
  recorder.add(check("D7: attach, close, transcribe, prompt template buttons and footer hidden", hidden.length === 0, hidden.length ? `visible: ${hidden.join(", ")}` : "all hidden"));
  await recorder.file("typing.png", await sim.screenshot());
  await tapDone();
  await Bun.sleep(1200);
});

await scenario("ios-composer-tap-and-column", "On the phone itself: a tap anywhere in the composer outside its controls focuses the text; with the keyboard down, the buttons form one column and long text grows the composer up to the 40% max.", async (recorder) => {
  await blur();
  await openComposer();
  const set = (text: string): Promise<boolean> => page.evaluate<boolean>(`(() => { const i = [...document.querySelectorAll(${JSON.stringify(sel.input)})].find((e) => e.checkVisibility()); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await set("");
  await Bun.sleep(400);
  const beside = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const pane = [...document.querySelectorAll(".agent-composer-pane")].find((e) => e.checkVisibility());
    const row = pane.querySelector(".composer-prompt-template-buttons");
    const buttons = [...row.querySelectorAll("button")];
    if (!buttons.length || !row.checkVisibility()) return null;
    const last = buttons[buttons.length - 1].getBoundingClientRect();
    return { x: last.right + 20, y: last.top + last.height / 2 + ${sim.screen.height} - document.documentElement.clientHeight };
  })()`);
  if (beside) {
    const { after } = await transition(recorder, "tap beside the prompt template buttons", () => sim.tap(beside.x, beside.y));
    recorder.add(check("A tap outside the controls focuses the text", after.focus.includes("composer-input") && after.keyboard, `focus: ${after.focus}, arranged: ${after.keyboard}`));
    await tapDone();
    await Bun.sleep(1200);
  } else recorder.add(check("Prompt template buttons staged", false, "this workspace has no prompt templates with composer buttons"));
  // The column: one button per row, all sharing the right edge.
  const measure = (): Promise<{ column: boolean; composer: number; max: number }> => page.evaluate(`(() => {
    const c = [...document.querySelectorAll(".agent-composer-pane > .composer")].find((e) => e.checkVisibility());
    const slots = [...c.querySelectorAll(".composer-button")].map((e) => e.getBoundingClientRect());
    const column = slots.length === 4 && slots.every((r, i) => Math.abs(r.right - slots[0].right) < 1 && (i === 0 || r.top >= slots[i - 1].bottom - 1));
    return { column, composer: c.getBoundingClientRect().height, max: document.documentElement.clientHeight * 0.4 };
  })()`);
  const empty = await measure();
  recorder.add(check("B: empty composer shows the button column", empty.column, `column: ${empty.column}`));
  const { after } = await transition(recorder, "dictation lands 20 lines", () => set(Array.from({ length: 20 }, (_, index) => `Dictated sentence number ${index + 1}.`).join(" ")), { video: false });
  const long = await measure();
  recorder.add(
    check("B: long text keeps the column", long.column && after.buttons.join() === "close,attach,transcribe,send", `column: ${long.column}; slots ${after.buttons.join(", ")}`),
    check("H3: the composer stays within 40%", long.composer <= long.max + 1, `composer ${Math.round(long.composer)}px, max ${Math.round(long.max)}px`),
  );
  await set("");
  await Bun.sleep(400);
  // Dictation through the real controller. The simulator has no microphone or
  // speech, so the page gets a synthetic microphone and scripted recognition.
  await page.evaluate<boolean>(`(() => {
    navigator.mediaDevices.getUserMedia = async () => { const c = new AudioContext(); const o = c.createOscillator(); const d = c.createMediaStreamDestination(); o.connect(d); o.start(); return d.stream; };
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (!String(url).includes("/dictation/realtime")) return new Real(url, protocols);
      const socket = new EventTarget(); socket.readyState = 1; let all = ""; let timer;
      const emit = (data) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
      socket.send = (data) => {
        if (typeof data !== "string") return;
        const message = JSON.parse(data);
        if (message.type === "session.update") { let n = 0; timer = setInterval(() => { const word = (n ? " " : "") + "dictated" + n++; all += word; emit({ type: "conversation.item.input_audio_transcription.delta", delta: word }); if (n >= 200) clearInterval(timer); }, 20); }
        if (message.type === "input_audio_buffer.commit") { clearInterval(timer); setTimeout(() => emit({ type: "conversation.item.input_audio_transcription.completed", transcript: all }), 50); }
      };
      socket.close = () => { clearInterval(timer); socket.readyState = 3; };
      setTimeout(() => emit({ type: "session.created" }), 50);
      return socket;
    };
    window.WebSocket.OPEN = 1;
    return true;
  })()`);
  const dictate = await point(".agent-composer-pane [data-dictation-composer-target=\"button\"]");
  await sim.tap(dictate.x, dictate.y);
  await Bun.sleep(2000);
  // First use on a fresh simulator asks for the microphone.
  if (await page.evaluate<string>(`[...document.querySelectorAll('.agent-composer-pane [data-dictation-composer-target="button"]')].find((e) => e.checkVisibility()).dataset.state`) === "loading") await sim.tap(271, 473);
  await Bun.sleep(5000);
  const dictated = await measure();
  recorder.add(check("B: dictating long text keeps the column within the max", dictated.column && dictated.composer <= dictated.max + 1, `column: ${dictated.column}, composer ${Math.round(dictated.composer)}px, max ${Math.round(dictated.max)}px`));
  await tap('.agent-composer-pane [data-dictation-composer-target="button"]');
  await Bun.sleep(1500);
  await set("");
  await Bun.sleep(300);
});

// ─── Pi CLI agent ───────────────────────────────────────────────────────────
await navigate(piPath, ".cli-agent-body .observable-terminal-host");

await scenario("ios-D12-composer-to-terminal", "D12/D14/D16: moving focus from the composer to the Pi terminal is one snap: the composer collapses, the terminal moves up above the key row and the keyboard stays.", async (recorder) => {
  await openComposer();
  await tap(sel.input);
  await Bun.sleep(1500);
  // The stage's centre is on the terminal: the typing composer covers the bottom, the floating stack is hidden.
  const { before, after } = await transition(recorder, "composer → terminal", () => tap(sel.stage));
  recorder.add(
    check("D14: composer collapsed", after.composer === null, JSON.stringify(after.composer)),
    check("Terminal focused, keyboard stayed up", after.keyboard && after.focus.includes("gespenst__input"), `arranged: ${after.keyboard}, focus: ${after.focus}`),
    check("D16: key row right above the keyboard", after.keyRow !== null && close(bottom(after.keyRow), keyboardTop(after), 2), `key row ${JSON.stringify(after.keyRow)}, keyboard top ${keyboardTop(after)}`),
    check("D19: terminal moved, not resized", before.terminal !== null && after.terminal !== null && before.terminal[2] === after.terminal[2] && before.terminal[3] === after.terminal[3], `${JSON.stringify(before.terminal)} → ${JSON.stringify(after.terminal)}`),
  );
  await recorder.file("terminal-typing.png", await sim.screenshot());
});

await scenario("ios-D15-D16-pi-key-row", "D15/D16: the key row on a focused Pi terminal; Ctrl applies to the next key on one tap and stays on after a double tap.", async (recorder) => {
  if (!await page.evaluate<boolean>("document.activeElement.classList.contains('gespenst__input')")) {
    await tap(sel.stage, { y: -80 });
    await Bun.sleep(1500);
  }
  const control = '.cli-agent-body .terminal-key-bar [data-terminal-key="control"]';
  const up = '.cli-agent-body .terminal-key-bar [data-terminal-key="up"]';
  const pressed = (): Promise<string> => page.evaluate<string>(`(() => { const b = document.querySelector(${JSON.stringify(control)}); return b.getAttribute("aria-pressed") + "|" + b.getAttribute("aria-label"); })()`);
  await tap(control);
  await Bun.sleep(300);
  const once = await pressed();
  await tap(up);
  await Bun.sleep(300);
  const afterKey = await pressed();
  const ctrl = await point(control);
  await sim.tap(ctrl.x, ctrl.y);
  await Bun.sleep(120);
  await sim.tap(ctrl.x, ctrl.y);
  await Bun.sleep(300);
  const locked = await pressed();
  await tap(up);
  await Bun.sleep(300);
  const lockedAfterKey = await pressed();
  await tap(control);
  await Bun.sleep(300);
  const off = await pressed();
  recorder.add(
    check("D16: one tap highlights Ctrl for the next key", once.startsWith("true"), once),
    check("D16: Ctrl releases after one key", afterKey.startsWith("false"), afterKey),
    check("D16: a double tap keeps Ctrl on", locked.startsWith("true") && lockedAfterKey.startsWith("true"), `${locked} → after a key: ${lockedAfterKey}`),
    check("D16: another tap turns it off", off.startsWith("false"), off),
    check("Keyboard and focus stayed on the terminal", await page.evaluate<boolean>("document.documentElement.classList.contains('software-keyboard-visible') && document.activeElement.classList.contains('gespenst__input')"), "arranged, terminal focused"),
  );
  await recorder.file("key-row.png", await sim.screenshot());
  const { after } = await transition(recorder, "dismiss from terminal", () => tapDone());
  recorder.add(check("D17: dismissing the keyboard unfocuses the terminal", !after.keyboard && !after.focus.includes("gespenst__input") && after.keyRow === null, `arranged: ${after.keyboard}, focus: ${after.focus || "body"}, key row ${JSON.stringify(after.keyRow)}`));
});

await scenario("ios-D2-D17-send", "D2/D17: sending on mobile closes the composer and the keyboard in one step; the terminal doesn't get focus.", async (recorder) => {
  await blur();
  await openComposer();
  await tap(sel.input);
  await Bun.sleep(1500);
  await page.evaluate<boolean>(`(() => { const i = document.activeElement; i.value = "Reply with just the word OK."; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await Bun.sleep(300);
  const { after } = await transition(recorder, "send", () => tap(".cli-agent-body .composer-send button"), { maskTerminal: true });
  recorder.add(
    check("D2: composer closed", after.composer === null, JSON.stringify(after.composer)),
    check("D2: keyboard down", !after.keyboard, `arranged: ${after.keyboard}, visual viewport ${after.viewport[0]}`),
    check("D17: terminal not focused", !after.focus.includes("gespenst__input"), `focus: ${after.focus || "body"}`),
  );
  await Bun.sleep(5000);
});

// ─── Terminal view ───────────────────────────────────────────────────────────
await navigate(terminalPath, ".terminal-view .observable-terminal-host");

async function terminalLines(): Promise<string[]> {
  const session = Object.keys(await tmuxSizes(setup.workspaceId)).find((name) => !name.startsWith("pi-"))!;
  const process = Bun.spawn(["docker", "exec", "-u", "kintsugi", `kintsugi-${setup.workspaceId}`, "tmux", "capture-pane", "-p", "-t", session], { stdout: "pipe" });
  return (await new Response(process.stdout).text()).split("\n").filter((line) => line.trim());
}

await scenario("ios-D15-D16-terminal-tab", "D15/D16: in a focused Terminal view the key row sits right above the keyboard, and Enter goes to the terminal without dismissing anything.", async (recorder) => {
  const { after } = await transition(recorder, "focus Terminal view", () => tap(".terminal-view .terminal-stage", { y: -100 }));
  recorder.add(
    check("D16: key row right above the keyboard", after.keyRow !== null && close(bottom(after.keyRow), keyboardTop(after), 2), `key row ${JSON.stringify(after.keyRow)}, keyboard top ${keyboardTop(after)}`),
    check("D19: terminal kept its size", after.terminal !== null, JSON.stringify(after.terminal)),
  );
  const before = await terminalLines();
  await tapReturn();
  await Bun.sleep(1200);
  const lines = await terminalLines();
  recorder.add(
    check("D15: Enter went to the terminal", lines.length > before.length, `prompt lines ${before.length} → ${lines.length}`),
    check("D15: keyboard and focus stayed", await page.evaluate<boolean>("document.documentElement.classList.contains('software-keyboard-visible') && document.activeElement.classList.contains('gespenst__input')"), "arranged, terminal focused"),
  );
  await recorder.file("terminal-tab.png", await sim.screenshot());
  await transition(recorder, "dismiss", () => tapDone());
});

// ─── Rotation (D20) ─────────────────────────────────────────────────────────
await navigate(piPath, ".cli-agent-body .observable-terminal-host");

await scenario("ios-D20-rotation", "D20: rotating with the keyboard down resizes each terminal once after rotation settles; with the keyboard up the resize waits until the keyboard goes away.", async (recorder) => {
  const pi = Object.keys(await tmuxSizes(setup.workspaceId)).find((name) => name.startsWith("pi-"))!;
  const since = (start: number) => page.resizes.slice(start);
  const describe = (resizes: typeof page.resizes): string => resizes.map((item) => `${item.payload} on ${item.url.replace(/^.*\/workspaces\/[^/]+\//, "").replace(/\?.*$/, "")}`).join(", ") || "none";
  // Every connected terminal (the Pi agent, and the Terminal view kept alive in the background) resizes at most once; Pi exactly once.
  const oncePerTerminal = (resizes: typeof page.resizes): boolean => {
    const counts = new Map<string, number>();
    for (const item of resizes) counts.set(item.url, (counts.get(item.url) ?? 0) + 1);
    return [...counts.values()].every((count) => count === 1) && [...counts.keys()].filter((url) => url.includes("pi-agents")).length === 1;
  };
  const piSize = async (): Promise<string> => (await tmuxSizes(setup.workspaceId))[pi]!;
  const portrait = await piSize();
  let start = page.resizes.length;
  await sim.rotate("landscape_left");
  await Bun.sleep(3500);
  const toLandscape = since(start);
  const landscape = await piSize();
  await recorder.file("landscape.png", await sim.screenshot());
  start = page.resizes.length;
  await sim.rotate("portrait");
  await Bun.sleep(3500);
  const back = since(start);
  recorder.add(
    check("Keyboard down: each terminal resizes once after rotating to landscape", oncePerTerminal(toLandscape) && landscape !== portrait, `${describe(toLandscape)}; Pi tmux ${portrait} → ${landscape}`),
    check("Keyboard down: each terminal resizes once after rotating back", oncePerTerminal(back) && await piSize() === portrait, `${describe(back)}; Pi tmux → ${await piSize()}`),
  );
  // Keyboard up: the resize waits until the keyboard goes away.
  await tap(sel.stage, { y: -80 });
  await Bun.sleep(1500);
  const typing = await page.evaluate<boolean>("document.documentElement.classList.contains('software-keyboard-visible')");
  start = page.resizes.length;
  await sim.rotate("landscape_left");
  await Bun.sleep(3500);
  const whileUp = since(start);
  const sizeWhileUp = await piSize();
  await recorder.file("landscape-keyboard.png", await sim.screenshot());
  start = page.resizes.length;
  await blur();
  await Bun.sleep(3000);
  const afterDown = since(start);
  recorder.add(
    check("Keyboard up before rotating", typing, `arranged: ${typing}`),
    check("Keyboard up: the Pi terminal is not resized while it is up", !whileUp.some((item) => item.url.includes("pi-agents")) && sizeWhileUp === portrait, `${describe(whileUp)}; Pi tmux ${sizeWhileUp}`),
    check("Keyboard up: one resize once it went away", afterDown.filter((item) => item.url.includes("pi-agents")).length === 1 && oncePerTerminal(afterDown.filter((item) => item.url.includes("pi-agents"))), `${describe(afterDown)}; Pi tmux → ${await piSize()}`),
  );
  start = page.resizes.length;
  await sim.rotate("portrait");
  await Bun.sleep(3500);
  recorder.add(check("Back to portrait: each terminal resizes once", oncePerTerminal(since(start)) && await piSize() === portrait, `${describe(since(start))}; Pi tmux → ${await piSize()}`));
});

await scenario("ios-launch-keyboard", "Launch starts ready for dictation, fills the space above the keyboard, and restores settings after dismissal.", async (recorder) => {
  await page.evaluate<boolean>('(localStorage.removeItem("kintsugi:software-keyboard"), true)');
  await navigate("/workspaces/new", ".launch-composer .composer-input");
  recorder.add(check("Opening launch leaves keyboard down", await page.evaluate<boolean>("!document.documentElement.classList.contains('software-keyboard-visible') && document.activeElement.tagName !== 'TEXTAREA'"), "no textarea focus on open"), check("Dictation available", await visible(".launch-composer .composer-dictation button"), "dictation visible"));
  await tap(".launch-composer .composer-input");
  await Bun.sleep(1600);
  const geometry = await page.evaluate<{ keyboard: boolean; fits: boolean; controls: boolean; fills: boolean; gap: number; inputHeight: number }>(`(() => {
    const d = document.querySelector("dialog[open]").getBoundingClientRect();
    const send = document.querySelector(".launch-composer .composer-send button").getBoundingClientRect();
    const input = document.querySelector(".launch-composer .composer-input").getBoundingClientRect();
    const top = visualViewport.offsetTop, bottom = top + visualViewport.height;
    return { keyboard: document.documentElement.classList.contains("software-keyboard-visible"), fits: d.top >= top - 1 && d.bottom <= bottom + 1 && send.bottom <= bottom, fills: d.top <= top + 10 && d.bottom >= bottom - 10, gap: bottom - input.bottom, inputHeight: input.height, controls: !document.querySelector(".launch-composer .composer-footer").checkVisibility() && !document.querySelector(".launch-composer .composer-dictation").checkVisibility() };
  })()`);
  recorder.add(check("Keyboard arranged with launch and send above it", geometry.keyboard && geometry.fits, JSON.stringify(geometry)), check("Typing mode removes settings and auxiliary controls", geometry.controls, JSON.stringify(geometry)));
  recorder.add(check("Empty launch editor fills the space above the keyboard", geometry.fills && geometry.gap >= 0 && geometry.gap <= 10, JSON.stringify(geometry)));
  await recorder.file("typing.png", await sim.screenshot());
  await blur();
  recorder.add(check("Keyboard dismissal returns to content-sized editing", await page.evaluate<number>('document.querySelector(".launch-composer .composer-input").getBoundingClientRect().height') < geometry.inputHeight, `typing height ${geometry.inputHeight}`));
  recorder.add(check("Dismissal restores settings and dictation", await visible(".launch-composer .composer-footer") && await visible(".launch-composer .composer-dictation"), "settings and dictation restored"));
  await transition(recorder, "remembered launch focus", () => tap(".launch-composer .composer-input"), { waitMs: 1600 });
  await page.evaluate<boolean>('(() => { const i = document.querySelector(".launch-composer .composer-input"); i.value = "Long launch prompt\\n".repeat(80); i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
  recorder.add(check("Long prompt leaves the end caret visible", await page.evaluate<boolean>('(() => { const i = document.querySelector(".launch-composer .composer-input"); return i.scrollTop + i.clientHeight >= i.scrollHeight - 1; })()'), "long prompt scrolled to its end"));
  await sim.rotate("landscape_left");
  await Bun.sleep(3000);
  recorder.add(check("Landscape keeps launch and send above the keyboard", await page.evaluate<boolean>('(() => { const d = document.querySelector("dialog[open]:has(.launch-composer)").getBoundingClientRect(); const s = document.querySelector(".launch-composer .composer-send button").getBoundingClientRect(); return d.top >= visualViewport.offsetTop && d.bottom <= visualViewport.offsetTop + visualViewport.height + 1 && s.top >= d.top && s.bottom <= d.bottom; })()'), "long prompt, landscape keyboard"));
  await recorder.file("landscape-typing.png", await sim.screenshot());
  await sim.rotate("portrait");
  await Bun.sleep(3000);
  await tap('dialog[open] .dialog__close-form button');
  await Bun.sleep(1000);
  recorder.add(check("Closing while typing dismisses launch and keyboard", !await visible(".launch-composer") && await page.evaluate<boolean>("!document.documentElement.classList.contains('software-keyboard-visible')"), "closed"));
});

await navigate(builtinPath, sel.transcript);
const { passed, index } = await report.write();
page.close();
sim.close();
await inspector.stop();
log(`${passed ? "PASS" : "FAIL"} — report: ${index}`);
process.exit(passed ? 0 : 1);
