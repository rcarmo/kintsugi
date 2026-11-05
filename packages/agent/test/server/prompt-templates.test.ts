import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { codemodeTemplateScript, expandPromptTemplateText, loadPromptTemplatesFromRoot } from "../../src/server/prompt-templates.ts";

describe("prompt templates", () => {
  test("loads .kintsugi and .pi prompt templates", async () => {
    const root = await mkdtemp(join(tmpdir(), "kintsugi-prompts-"));
    await mkdir(join(root, ".kintsugi/prompts"), { recursive: true });
    await mkdir(join(root, ".pi/prompts"), { recursive: true });
    await writeFile(join(root, ".kintsugi/prompts/land.md"), `---\ndescription: Land the workspace\nargument-hint: "[branch]"\ncomposer-button: true\nshortcut: L\n---\ncommit to ${"$"}{1:-main}`);
    await writeFile(join(root, ".pi/prompts/review.md"), "---\nshortcut: command-r\n---\nReview $ARGUMENTS");

    const templates = await loadPromptTemplatesFromRoot(root);
    expect(templates.map((template) => template.trigger)).toEqual(["/land", "/review"]);
    expect(templates.find((template) => template.name === "land")).toMatchObject({ argumentHint: "[branch]", composerButton: true, shortcut: "l" });
    expect(templates.find((template) => template.name === "review")?.shortcut).toBeUndefined();

  });

  test("reads settings from older prompt files", async () => {
    const root = await mkdtemp(join(tmpdir(), "kintsugi-prompts-"));
    await mkdir(join(root, ".kintsugi/prompts"), { recursive: true });
    await writeFile(join(root, ".kintsugi/prompts/legacy.md"), "---\nhotkey: L\nquick-launch: true\n---\nLegacy prompt");

    const templates = await loadPromptTemplatesFromRoot(root);
    const template = templates.find((template) => template.name === "legacy");
    expect(template).toMatchObject({ shortcut: "l", composerButton: true });
    expect(template).not.toHaveProperty("quickLaunch");
    expect(template).not.toHaveProperty("hotkey");
  });

  test("composer buttons are opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "kintsugi-prompts-"));
    await mkdir(join(root, ".kintsugi/prompts"), { recursive: true });
    await writeFile(join(root, ".kintsugi/prompts/disabled.md"), "---\ncomposer-button: false\n---\nDisabled button");
    await writeFile(join(root, ".kintsugi/prompts/plain.md"), "No button setting");

    const templates = await loadPromptTemplatesFromRoot(root);
    expect(templates.find((template) => template.name === "disabled")?.composerButton).toBe(false);
    expect(templates.find((template) => template.name === "plain")?.composerButton).toBeUndefined();
  });

  test("includes builtin land template when repository does not provide one", async () => {
    const root = await mkdtemp(join(tmpdir(), "kintsugi-prompts-"));

    const templates = await loadPromptTemplatesFromRoot(root);
    expect(templates.map((template) => template.trigger)).toEqual(["/land"]);
    expect(templates[0]?.prompt).toBe("Commit and push your work, rebasing when necessary. When successful, delete this workspace.");
  });

  test("keeps built-in Slash commands out of the template loader", async () => {
    const root = await mkdtemp(join(tmpdir(), "kintsugi-prompts-"));
    await mkdir(join(root, ".kintsugi/prompts"), { recursive: true });
    await writeFile(join(root, ".kintsugi/prompts/new.md"), "Do not replace the built-in action");
    const templates = await loadPromptTemplatesFromRoot(root);
    expect(templates.map((template) => template.trigger)).toEqual(["/land"]);
  });

  test("expands triggers with arguments", () => {
    const templates = [{ name: "land", trigger: "/land", description: "Land", argumentHint: "[branch]", prompt: 'push to ${1:-main}: $@' }];
    expect(expandPromptTemplateText("/land", templates)).toBe("push to main: ");
    expect(expandPromptTemplateText("/land release candidate", templates)).toBe("push to release: release candidate");
  });

  test("leaves normal prompts unchanged", () => {
    expect(expandPromptTemplateText("please run tests", [])).toBe("please run tests");
  });

  test("code mode templates keep their trigger and run their script with the arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "kintsugi-prompts-"));
    await mkdir(join(root, ".kintsugi/prompts"), { recursive: true });
    await writeFile(join(root, ".kintsugi/prompts/status.md"), "---\ndescription: Show status\ncodemode: true\ncomposer-button: true\n---\nreturn args;\n");
    const templates = await loadPromptTemplatesFromRoot(root);
    expect(templates.find((template) => template.name === "status")).toMatchObject({ codemode: true, composerButton: true, description: "Show status" });

    expect(expandPromptTemplateText("/status one", templates)).toBe("/status one");
    expect(codemodeTemplateScript('/status one "two words" $1', templates)).toBe('const args = ["one","two words","$1"];\nconst argumentsText = "one \\"two words\\" $1";\nreturn args;\n');
    expect(codemodeTemplateScript("/land", templates)).toBeUndefined();
    expect(codemodeTemplateScript("please /status", templates)).toBeUndefined();
  });

  test("a code mode template's options line stays first", () => {
    const templates = [{ name: "slow", trigger: "/slow", description: "Slow", prompt: '// @options: {"timeout_ms": 1000}\nreturn 1;', codemode: true }];
    expect(codemodeTemplateScript("/slow", templates)).toBe('// @options: {"timeout_ms": 1000}\nconst args = [];\nconst argumentsText = "";\nreturn 1;');
  });
});
