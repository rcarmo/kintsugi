import { builtinSlashCommands } from "./builtin-slash-commands.ts";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { isNotFoundError } from "@kintsugi/core";
import { workspaceWorkHostPath } from "@kintsugi/workspace";

export interface PromptTemplate {
  name: string;
  trigger: string;
  description: string;
  argumentHint?: string;
  prompt: string;
  composerButton?: boolean;
  shortcut?: string;
  /** The body is a code mode script the builtin agent runs as its own call, instead of a prompt. */
  codemode?: boolean;
}

interface PromptFrontmatter {
  description?: string;
  argumentHint?: string;
  composerButton?: boolean;
  shortcut?: string;
  codemode?: boolean;
}

interface ParsedPromptFrontmatter {
  frontmatter: PromptFrontmatter;
  body: string;
}

const promptDirs = [".kintsugi/prompts", ".pi/prompts"] as const;

const builtinLandPrompt = "Commit and push your work, rebasing when necessary. When successful, report what was pushed.";

function parseFrontmatter(markdown: string): ParsedPromptFrontmatter {
  if (!markdown.startsWith("---\n")) return { frontmatter: {}, body: markdown };
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: markdown };
  const raw = markdown.slice(4, end).trim();
  const body = markdown.slice(end + "\n---".length).replace(/^\r?\n/, "");
  const frontmatter: PromptFrontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key === "description") frontmatter.description = value;
    if (key === "argument-hint") frontmatter.argumentHint = value;
    // Older prompt files named this setting "quick-launch".
    if ((key === "composer-button" || key === "quick-launch") && (value === "true" || value === "false")) frontmatter.composerButton = value === "true";
    // Older prompt files named this setting "hotkey".
    if ((key === "shortcut" || key === "hotkey") && /^[A-Za-z]$/.test(value)) frontmatter.shortcut = value.toLowerCase();
    if (key === "codemode" && (value === "true" || value === "false")) frontmatter.codemode = value === "true";
  }
  return { frontmatter, body };
}

function fallbackDescription(body: string): string {
  return body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Prompt template";
}

function splitArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  for (const char of text.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function expandBody(body: string, args: string[]): string {
  const all = args.join(" ");
  return body
    .replace(/\$ARGUMENTS\b/g, all)
    .replace(/\$@/g, all)
    .replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_match, startRaw: string, lengthRaw: string | undefined) => {
      const start = Number(startRaw) - 1;
      const length = lengthRaw === undefined ? undefined : Number(lengthRaw);
      return args.slice(start, length === undefined ? undefined : start + length).join(" ");
    })
    .replace(/\$\{(\d+):-([^}]*)\}/g, (_match, indexRaw: string, fallback: string) => args[Number(indexRaw) - 1] || fallback)
    .replace(/\$(\d+)\b/g, (_match, indexRaw: string) => args[Number(indexRaw) - 1] ?? "");
}

export async function loadPromptTemplatesFromRoot(root: string): Promise<PromptTemplate[]> {
  const byName = new Map<string, PromptTemplate>();
  for (const dir of promptDirs) {
    const path = join(root, dir);
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- ENOENT is validated before use.
    const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
      if (isNotFoundError(error)) return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = basename(entry.name, ".md");
      if (!name || byName.has(name)) continue;
      const markdown = await Bun.file(join(path, entry.name)).text();
      const { frontmatter, body } = parseFrontmatter(markdown);
      byName.set(name, {
        name,
        trigger: `/${name}`,
        description: frontmatter.description || fallbackDescription(body),
        argumentHint: frontmatter.argumentHint,
        prompt: body,
        composerButton: frontmatter.composerButton,
        shortcut: frontmatter.shortcut,
        codemode: frontmatter.codemode,
      });
    }
  }
  if (!byName.has("land")) {
    byName.set("land", { name: "land", trigger: "/land", description: builtinLandPrompt, prompt: builtinLandPrompt });
  }
  // Built-in Slash commands cannot be replaced by repository Prompt templates.
  for (const command of builtinSlashCommands) byName.delete(command.name);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listPromptTemplates(workspaceId: string): Promise<PromptTemplate[]> {
  return await loadPromptTemplatesFromRoot(workspaceWorkHostPath(workspaceId));
}

/** Templates for agents without code mode, which leave code mode templates out. */
export async function listPromptOnlyTemplates(workspaceId: string): Promise<PromptTemplate[]> {
  return (await listPromptTemplates(workspaceId)).filter((template) => !template.codemode);
}

function matchTemplate(text: string, templates: readonly PromptTemplate[]): { template: PromptTemplate; argumentsText: string } | undefined {
  const match = text.trim().match(/^(\/[^\s]+)(?:\s+([\s\S]*))?$/);
  const template = match && templates.find((candidate) => candidate.trigger === match[1]);
  return template ? { template, argumentsText: match[2] ?? "" } : undefined;
}

/** Code mode templates stay as typed: the builtin agent runs them when it reads the message. */
export function expandPromptTemplateText(text: string, templates: readonly PromptTemplate[]): string {
  const matched = matchTemplate(text, templates);
  if (!matched || matched.template.codemode) return text;
  return expandBody(matched.template.prompt, splitArgs(matched.argumentsText));
}

/**
 * The script a message runs when it is a code mode template's trigger, with its arguments as `args` and
 * `argumentsText`. A leading `// @options:` line stays first, where code mode reads it.
 */
export function codemodeTemplateScript(text: string, templates: readonly PromptTemplate[]): string | undefined {
  const matched = matchTemplate(text, templates);
  if (!matched?.template.codemode) return undefined;
  const preamble = `const args = ${JSON.stringify(splitArgs(matched.argumentsText))};\nconst argumentsText = ${JSON.stringify(matched.argumentsText.trim())};\n`;
  const options = matched.template.prompt.match(/^\/\/ *@options:.*\n/)?.[0] ?? "";
  return `${options}${preamble}${matched.template.prompt.slice(options.length)}`;
}
