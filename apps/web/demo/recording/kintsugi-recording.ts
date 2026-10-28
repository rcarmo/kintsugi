import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;
export const DEFAULT_FRAME_RATE = 25;
export const CHROMIUM_PATH = process.platform === "darwin"
	? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	: chromium.executablePath();
export const FFMPEG_PATH = "/usr/bin/ffmpeg";
export const FFPROBE_PATH = "/usr/bin/ffprobe";
export const DEFAULT_ARTIFACT_ROOT = "/work/artifacts";

export interface HumanTimingOptions {
	beforeClickMs: number;
	afterClickMs: number;
	beforeTypeMs: number;
	keyDelayMs: number;
	afterTypeMs: number;
	afterActionMs: number;
}

export const DEFAULT_HUMAN_TIMINGS: HumanTimingOptions = {
	beforeClickMs: 300,
	afterClickMs: 500,
	beforeTypeMs: 250,
	keyDelayMs: 65,
	afterTypeMs: 450,
	afterActionMs: 700,
};

export interface RecordingPaths {
	artifactRoot: string;
	outputPath: string;
	rawVideoPath: string;
	failureScreenshotPath: string;
}

export interface KintsugiRecordingOptions {
	name: string;
	viewport?: { width: number; height: number };
	frameRate?: number;
	timings?: Partial<HumanTimingOptions>;
	artifactRoot?: string;
	headless?: boolean;
}

export interface ClickTimingOptions {
	beforeMs?: number;
	afterMs?: number;
}

export interface TypeTimingOptions {
	beforeMs?: number;
	keyDelayMs?: number;
	afterMs?: number;
}

export interface VideoReport {
	outputPath: string;
	rawVideoPath: string;
	durationSeconds: number;
	width: number;
	height: number;
	frameRate: number;
	fileSizeBytes: number;
}

const ffprobeReportSchema = Type.Object({
	streams: Type.Array(Type.Object({
		width: Type.Number(),
		height: Type.Number(),
		avg_frame_rate: Type.String(),
	})),
	format: Type.Object({ duration: Type.String() }),
});

export interface KintsugiRecording {
	readonly page: Page;
	readonly paths: RecordingPaths;
	readonly timings: HumanTimingOptions;
	humanClick(locator: Locator, options?: ClickTimingOptions): Promise<void>;
	humanType(locator: Locator, text: string, options?: TypeTimingOptions): Promise<void>;
	pauseAfterAction(milliseconds?: number): Promise<void>;
	finish(outputPath?: string): Promise<VideoReport>;
	captureFailureArtifacts(): Promise<void>;
}

export function normalizeTimings(overrides: Partial<HumanTimingOptions> = {}): HumanTimingOptions {
	const timings = { ...DEFAULT_HUMAN_TIMINGS, ...overrides };
	for (const [name, value] of Object.entries(timings)) {
		assertNonNegativeNumber(value, `timings.${name}`);
	}
	return timings;
}

export function recordingPaths(name: string, artifactRoot = DEFAULT_ARTIFACT_ROOT): RecordingPaths {
	assertRecordingName(name);
	if (!isAbsolute(artifactRoot)) throw new Error(`artifactRoot must be absolute: ${artifactRoot}`);
	const root = resolve(artifactRoot);
	return {
		artifactRoot: root,
		outputPath: join(root, `${name}.mp4`),
		rawVideoPath: join(root, `${name}.raw.webm`),
		failureScreenshotPath: join(root, `${name}.failure.png`),
	};
}

export function buildFfmpegArgs(inputPath: string, outputPath: string, frameRate = DEFAULT_FRAME_RATE): string[] {
	assertAbsoluteFile(inputPath, ".webm", "FFmpeg input");
	assertOutputPath(outputPath);
	assertPositiveNumber(frameRate, "frameRate");
	return [
		"-y",
		"-nostdin",
		"-i",
		inputPath,
		"-an",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-r",
		String(frameRate),
		"-movflags",
		"+faststart",
		outputPath,
	];
}

/** Recording-only overlay: normal Playwright pointer events drive it too. */
function installRecordingPointer(): void {
	if (window !== window.top) return;
	const mount = () => {
		if (document.querySelector("[data-kintsugi-recording-pointer]")) return;
		const host = document.createElement("div");
		host.setAttribute("data-kintsugi-recording-pointer", "");
		host.setAttribute("aria-hidden", "true");
		host.setAttribute("popover", "manual");
		host.style.cssText = "all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;pointer-events:none;overflow:visible;z-index:2147483647";
		const shadow = host.attachShadow({ mode: "closed" });
		shadow.innerHTML = `<style>
			:host, * { pointer-events: none !important; }
			.pointer { position:absolute; top:0; left:0; width:44px; height:56px; transform:translate(-2px,-2px); filter:drop-shadow(0 2px 3px #0009); }
			.pulse { position:absolute; width:48px; height:48px; margin:-24px; border:4px solid #ffcc33; border-radius:50%; box-sizing:border-box; opacity:0; }
		</style>
		<div class="pulse"></div>
		<svg class="pointer" viewBox="0 0 44 56" xmlns="http://www.w3.org/2000/svg">
			<path d="M3 3 L3 42 L13 32 L23 52 L32 47 L22 28 L38 28 Z" fill="#151515" stroke="white" stroke-width="3" stroke-linejoin="round"/>
		</svg>`;
		const pointer = shadow.querySelector<SVGElement>(".pointer")!;
		const pulse = shadow.querySelector<HTMLElement>(".pulse")!;
		const move = (x: number, y: number) => {
			host.dataset.x = String(x);
			host.dataset.y = String(y);
			pointer.style.left = `${x}px`;
			pointer.style.top = `${y}px`;
		};
		move(32, 72);
		document.documentElement.append(host);
		host.showPopover();
		document.addEventListener("pointermove", event => move(event.clientX, event.clientY), true);
		document.addEventListener("pointerdown", event => {
			move(event.clientX, event.clientY);
			// Keep the pointer above application dialogs and popovers.
			host.hidePopover();
			host.showPopover();
			pulse.style.left = `${event.clientX}px`;
			pulse.style.top = `${event.clientY}px`;
			pulse.getAnimations().forEach(animation => animation.cancel());
			pulse.animate([
				{ opacity: 1, transform: "scale(0.5)" },
				{ opacity: 0, transform: "scale(1.5)" },
			], { duration: 550, easing: "ease-out" });
		}, true);
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
	else mount();
}

async function movePointerTo(locator: Locator): Promise<void> {
	// A trial click moves the mouse too, which would snap the visible pointer
	// before animation. Prepare without clicking; locator.click() still performs
	// its full actionability checks after the approach.
	await locator.waitFor({ state: "visible" });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("Recording click target has no visible bounding box");
	const page = locator.page();
	const from = await page.evaluate(() => {
		const pointer = document.querySelector<HTMLElement>("[data-kintsugi-recording-pointer]")!;
		return { x: Number(pointer.dataset.x), y: Number(pointer.dataset.y) };
	});
	const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	for (let step = 1; step <= 24; step++) {
		const progress = step / 24;
		const eased = progress * progress * (3 - 2 * progress);
		await page.mouse.move(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased);
		await delay(16);
	}
}

export async function createKintsugiRecording(options: KintsugiRecordingOptions): Promise<KintsugiRecording> {
	const paths = recordingPaths(options.name, options.artifactRoot);
	const viewport = normalizeViewport(options.viewport);
	const frameRate = options.frameRate ?? DEFAULT_FRAME_RATE;
	assertPositiveNumber(frameRate, "frameRate");
	const timings = normalizeTimings(options.timings);
	await mkdir(paths.artifactRoot, { recursive: true });

	const captureDirectory = join(paths.artifactRoot, `.recording-${options.name}-${process.pid}-${Date.now()}`);
	await mkdir(captureDirectory, { recursive: true });
	// Playwright selects its bundled headless shell on Linux. Forcing the full
	// Chrome binary bypasses that selection; macOS keeps its installed Chrome.
	const browser = await chromium.launch({
		executablePath: process.platform === "darwin" ? CHROMIUM_PATH : undefined,
		headless: options.headless ?? true,
	});
	let context: BrowserContext;
	let page: Page;
	let playwrightVideoPath: string;
	try {
		context = await browser.newContext({ viewport, recordVideo: { dir: captureDirectory, size: viewport } });
		await context.addInitScript(installRecordingPointer);
		page = await context.newPage();
		// setContent also replaces the document, without running init scripts.
		page.on("domcontentloaded", () => page.evaluate(installRecordingPointer));
		playwrightVideoPath = await page.video()!.path();
	} catch (error) {
		await browser.close();
		await rm(captureDirectory, { recursive: true, force: true });
		throw error;
	}
	let finalized = false;

	async function finalizeRawRecording(): Promise<void> {
		if (finalized) return;
		await context.close();
		await browser.close();
		await moveFile(playwrightVideoPath, paths.rawVideoPath);
		await rm(captureDirectory, { recursive: true, force: true });
		finalized = true;
	}

	return {
		page,
		paths,
		timings,
		async humanClick(locator, actionOptions = {}) {
			const beforeMs = actionOptions.beforeMs ?? timings.beforeClickMs;
			const afterMs = actionOptions.afterMs ?? timings.afterClickMs;
			assertNonNegativeNumber(beforeMs, "click beforeMs");
			assertNonNegativeNumber(afterMs, "click afterMs");
			await movePointerTo(locator);
			await delay(beforeMs);
			await locator.click();
			await delay(afterMs);
		},
		async humanType(locator, text, actionOptions = {}) {
			const beforeMs = actionOptions.beforeMs ?? timings.beforeTypeMs;
			const keyDelayMs = actionOptions.keyDelayMs ?? timings.keyDelayMs;
			const afterMs = actionOptions.afterMs ?? timings.afterTypeMs;
			assertNonNegativeNumber(beforeMs, "type beforeMs");
			assertNonNegativeNumber(keyDelayMs, "type keyDelayMs");
			assertNonNegativeNumber(afterMs, "type afterMs");
			await movePointerTo(locator);
			await delay(beforeMs);
			await locator.pressSequentially(text, { delay: keyDelayMs });
			await delay(afterMs);
		},
		async pauseAfterAction(milliseconds = timings.afterActionMs) {
			assertNonNegativeNumber(milliseconds, "pause milliseconds");
			await delay(milliseconds);
		},
		async finish(outputPath = paths.outputPath) {
			assertOutputPath(outputPath);
			if (finalized) throw new Error("recording has already been finalized");
			await finalizeRawRecording();
			await mkdir(dirname(outputPath), { recursive: true });
			await runProcess(FFMPEG_PATH, buildFfmpegArgs(paths.rawVideoPath, outputPath, frameRate));
			return inspectVideo(outputPath, paths.rawVideoPath);
		},
		async captureFailureArtifacts() {
			if (finalized) return;
			try {
				await page.screenshot({ path: paths.failureScreenshotPath, fullPage: true });
			} catch (diagnosticError) {
				console.warn(`Could not save failure screenshot: ${String(diagnosticError)}`);
			}
			try {
				await finalizeRawRecording();
			} catch (diagnosticError) {
				console.warn(`Could not finalize failure recording: ${String(diagnosticError)}`);
			}
		},
	};
}

export async function recordKintsugiDemo(
	options: KintsugiRecordingOptions & { outputPath?: string },
	scenario: (recording: KintsugiRecording) => Promise<void>,
): Promise<VideoReport> {
	if (options.outputPath !== undefined) assertOutputPath(options.outputPath);
	const recording = await createKintsugiRecording(options);
	try {
		await scenario(recording);
		return await recording.finish(options.outputPath);
	} catch (error) {
		await recording.captureFailureArtifacts();
		throw error;
	}
}

async function inspectVideo(outputPath: string, rawVideoPath: string): Promise<VideoReport> {
	const { stdout } = await runProcess(FFPROBE_PATH, [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=width,height,avg_frame_rate:format=duration",
		"-of",
		"json",
		outputPath,
	]);
	const encoded: unknown = JSON.parse(stdout);
	const data = Value.Parse(ffprobeReportSchema, encoded);
	const stream = data.streams[0];
	if (!stream) throw new Error(`No video stream found in ${outputPath}`);
	const [numerator, denominator] = stream.avg_frame_rate.split("/").map(Number);
	const file = await stat(outputPath);
	return {
		outputPath,
		rawVideoPath,
		durationSeconds: Number(data.format.duration),
		width: stream.width,
		height: stream.height,
		frameRate: numerator / denominator,
		fileSizeBytes: file.size,
	};
}

async function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) resolvePromise({ stdout, stderr });
			else reject(new Error(`${command} failed (${code === null ? `signal ${signal}` : `exit ${code}`}): ${stderr}`));
		});
	});
}

async function moveFile(from: string, to: string): Promise<void> {
	await mkdir(dirname(to), { recursive: true });
	await rm(to, { force: true });
	try {
		await rename(from, to);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EXDEV") throw error;
		await copyFile(from, to);
		await rm(from);
	}
}

function assertRecordingName(name: string): void {
	if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(name)) {
		throw new Error("recording name must use lowercase letters, numbers, hyphens, or underscores without path separators");
	}
}

function assertOutputPath(path: string): void {
	assertAbsoluteFile(path, ".mp4", "output path");
}

function assertAbsoluteFile(path: string, extension: string, label: string): void {
	if (!isAbsolute(path) || extname(path).toLowerCase() !== extension) {
		throw new Error(`${label} must be an absolute ${extension} path: ${String(path)}`);
	}
}

interface NormalizedViewport {
	width: number;
	height: number;
}

function normalizeViewport(viewport: KintsugiRecordingOptions["viewport"]): NormalizedViewport {
	const value = viewport ?? DEFAULT_VIEWPORT;
	assertPositiveNumber(value.width, "viewport.width");
	assertPositiveNumber(value.height, "viewport.height");
	return { width: Math.round(value.width), height: Math.round(value.height) };
}

function assertNonNegativeNumber(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
}

function assertPositiveNumber(value: number, label: string): void {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a finite positive number`);
}
